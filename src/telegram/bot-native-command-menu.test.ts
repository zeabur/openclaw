import { HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

/** Create a grammY-style HttpError that wraps a network failure. */
function makeNetworkHttpError(method: string): HttpError {
  const inner = new TypeError("fetch failed");
  return new HttpError(`Network request for '${method}' failed!`, inner);
}

describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(100);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(100);
    expect(result.overflowCount).toBe(5);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[99]).toEqual({
      command: "cmd_99",
      description: "Command 99",
    });
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("normalizes hyphenated plugin command names", () => {
    const result = buildPluginTelegramMenuCommands({
      specs: [{ name: "agent-run", description: "Run agent" }],
      existingCommands: new Set<string>(),
    });

    expect(result.commands).toEqual([{ command: "agent_run", description: "Run agent" }]);
    expect(result.issues).toEqual([]);
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async () => {
      callOrder.push("delete");
    });
    const setMyCommands = vi.fn(async () => {
      callOrder.push("set");
    });

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands,
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {} as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual(["delete", "set"]);
  });

  it("retries on transient network errors then succeeds", async () => {
    let callCount = 0;
    const setMyCommands = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw makeNetworkHttpError("setMyCommands");
      }
    });
    const deleteMyCommands = vi.fn(async () => {});
    const errorLog = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorLog } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      _maxRetries: 3,
      _backoff: { initialMs: 1, maxMs: 5, factor: 1, jitter: 0 },
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalledTimes(3);
    });

    // Should have logged retry messages for attempts 1 and 2
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("command sync attempt 1 failed"));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("command sync attempt 2 failed"));
    // Should NOT have logged a final "command sync failed" since attempt 3 succeeded
    expect(errorLog).not.toHaveBeenCalledWith(
      expect.stringContaining("[telegram] command sync failed:"),
    );
  });

  it("gives up after exhausting retries on persistent network errors", async () => {
    const setMyCommands = vi.fn(async () => {
      throw makeNetworkHttpError("setMyCommands");
    });
    const deleteMyCommands = vi.fn(async () => {});
    const errorLog = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorLog } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      _maxRetries: 2,
      _backoff: { initialMs: 1, maxMs: 5, factor: 1, jitter: 0 },
    });

    await vi.waitFor(() => {
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("[telegram] command sync failed:"),
      );
    });

    // Initial attempt + 2 retries = 3 calls total
    expect(setMyCommands).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-recoverable errors", async () => {
    const setMyCommands = vi.fn(async () => {
      throw new Error("Unauthorized: bot token is invalid");
    });
    const deleteMyCommands = vi.fn(async () => {});
    const errorLog = vi.fn();

    syncTelegramMenuCommands({
      bot: {
        api: { deleteMyCommands, setMyCommands },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: { error: errorLog } as unknown as Parameters<
        typeof syncTelegramMenuCommands
      >[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
      _maxRetries: 3,
      _backoff: { initialMs: 1, maxMs: 5, factor: 1, jitter: 0 },
    });

    await vi.waitFor(() => {
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("[telegram] command sync failed:"),
      );
    });

    // Only called once — no retries for non-recoverable errors
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });
});
