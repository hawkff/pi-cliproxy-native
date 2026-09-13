import type { Api, Model } from "@earendil-works/pi-ai";
import { type Config, isModelId, isRecord, PROVIDER_ID } from "./config.ts";

export type CpaApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "google-generative-ai";

function isCpaApi(api: string): api is CpaApi {
  return ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"].includes(
    api,
  );
}

export function endpoint(baseUrl: string, api: string) {
  if (api === "anthropic-messages") return baseUrl;
  return `${baseUrl}/${api === "google-generative-ai" ? "v1beta" : "v1"}`;
}

export function parseCatalog(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > 10000) {
    throw new Error("Invalid CLIProxyAPI model catalog: expected a data array.");
  }
  return value.data.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isModelId(entry.id) ||
      (entry.owned_by !== undefined && !isModelId(entry.owned_by))
    ) {
      throw new Error("Invalid CLIProxyAPI model catalog entry.");
    }
    return { id: entry.id, owner: entry.owned_by, hidden: entry.visibility === "hide" };
  });
}

// CLIProxyAPI v7.2.158 routes these IDs through its image and native video handlers.
const mediaPurposes = new Map<string, "image" | "video">([
  ["grok-imagine-image", "image"],
  ["grok-imagine-image-quality", "image"],
  ["grok-imagine-image-2.0", "image"],
  ["grok-imagine-video", "video"],
  ["grok-imagine-video-1.5", "video"],
  ["grok-imagine-video-1.5-preview", "video"],
]);

export function mediaPurpose(id: string) {
  return mediaPurposes.get(id);
}

export function mapMediaCatalog(value: unknown) {
  const models = new Map<string, { id: string; purpose: "image" | "video" }>();
  for (const entry of parseCatalog(value)) {
    const purpose = mediaPurpose(entry.id);
    if (!entry.hidden && purpose) models.set(entry.id, { id: entry.id, purpose });
  }
  return [...models.values()];
}

const owners: Readonly<Record<string, string>> = {
  claude: "anthropic",
  anthropic: "anthropic",
  openai: "openai",
  codex: "openai-codex",
  "openai-codex": "openai-codex",
  google: "google",
  gemini: "google",
  "gemini-cli": "google",
};

export function mapCatalog(value: unknown, config: Config, known: readonly Model<Api>[]) {
  const models = new Map<string, Model<CpaApi>>();
  const skipped = new Set<string>();
  for (const entry of parseCatalog(value)) {
    if (entry.hidden || models.has(entry.id)) continue;
    if (mediaPurpose(entry.id)) {
      skipped.add(entry.id);
      continue;
    }
    const alias = Object.hasOwn(config.aliases, entry.id) ? config.aliases[entry.id] : undefined;
    const candidates = known.filter((model) =>
      alias ? `${model.provider}/${model.id}` === alias : model.id === entry.id,
    );
    const families = new Set(
      candidates.map((model) => (model.provider === "openai-codex" ? "openai" : model.provider)),
    );
    const preferred = entry.owner ? owners[entry.owner.toLowerCase()] : undefined;
    const reference =
      candidates.find((model) => model.provider === preferred) ??
      (families.size === 1 ? candidates[0] : undefined);
    if (!reference) {
      skipped.add(entry.id);
      continue;
    }
    const api = reference.api === "openai-codex-responses" ? "openai-responses" : reference.api;
    if (!isCpaApi(api)) {
      skipped.add(entry.id);
      continue;
    }
    const model: Model<CpaApi> = {
      ...structuredClone(reference),
      id: entry.id,
      name: alias ? `${entry.id} (${reference.name})` : reference.name,
      provider: PROVIDER_ID,
      api,
      baseUrl: endpoint(config.baseUrl, api),
      headers: undefined,
      compat:
        api === "anthropic-messages"
          ? {
              ...reference.compat,
              supportsEagerToolInputStreaming: false,
              supportsStrictTools: false,
              supportsToolReferences: false,
              supportsMidConvoEffort: false,
            }
          : api === "google-generative-ai"
            ? reference.compat
            : {
                ...reference.compat,
                supportsStrictMode: false,
                supportsOpenAIGrammarTools: false,
                supportsToolSearch: false,
                supportsAdditionalTools: false,
              },
    };
    models.set(model.id, model);
    skipped.delete(model.id);
  }
  return { models: [...models.values()], skipped: [...skipped] };
}
