import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeProviderId } from "./model-selection.js";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  const baseUrl = model.baseUrl ?? "";
  const openaiModel = model;
  const compat = openaiModel.compat ?? undefined;

  // z.ai doesn't support developer role
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  if (isZai && compat?.supportsDeveloperRole !== false) {
    openaiModel.compat = compat
      ? { ...compat, supportsDeveloperRole: false }
      : { supportsDeveloperRole: false };
  }

  // Bedrock (via LiteLLM or other proxies) doesn't support the `store` parameter.
  // The pi-ai library sends `store: false` when supportsStore is true, but Bedrock
  // rejects this with "store: Extra inputs are not permitted".
  const normalizedProvider = normalizeProviderId(model.provider);
  const isBedrock =
    normalizedProvider === "amazon-bedrock" ||
    baseUrl.includes("bedrock") ||
    baseUrl.includes("litellm");
  if (isBedrock && compat?.supportsStore !== false) {
    openaiModel.compat = openaiModel.compat
      ? { ...openaiModel.compat, supportsStore: false }
      : { supportsStore: false };
  }

  return openaiModel;
}
