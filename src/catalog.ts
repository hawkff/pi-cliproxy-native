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

export type MediaPurpose = "image" | "video";

// Exact IDs supported by CLIProxyAPI v7.2.158; input vision alone does not imply image output.
const mediaModels = new Map<
  string,
  { name: string; purpose: MediaPurpose; route: "xai" | "gemini" | "imagen" }
>([
  ["grok-imagine-image", { name: "Grok Imagine Image", purpose: "image", route: "xai" }],
  ["grok-imagine-image-quality", { name: "Grok Imagine Image Quality", purpose: "image", route: "xai" }],
  ["grok-imagine-image-2.0", { name: "Grok Imagine Image 2.0", purpose: "image", route: "xai" }],
  ["grok-imagine-video", { name: "Grok Imagine Video", purpose: "video", route: "xai" }],
  ["grok-imagine-video-1.5", { name: "Grok Imagine Video 1.5", purpose: "video", route: "xai" }],
  [
    "grok-imagine-video-1.5-preview",
    { name: "Grok Imagine Video 1.5 Preview", purpose: "video", route: "xai" },
  ],
  [
    "gemini-2.5-flash-image",
    { name: "Nano Banana (Gemini 2.5 Flash Image)", purpose: "image", route: "gemini" },
  ],
  [
    "gemini-3.1-flash-image",
    { name: "Nano Banana 2 (Gemini 3.1 Flash Image)", purpose: "image", route: "gemini" },
  ],
  ["gemini-3-pro-image", { name: "Nano Banana Pro (Gemini 3 Pro Image)", purpose: "image", route: "gemini" }],
  [
    "gemini-3.1-flash-lite-image",
    { name: "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)", purpose: "image", route: "gemini" },
  ],
  ["imagen-3.0-generate-002", { name: "Imagen 3", purpose: "image", route: "imagen" }],
  ["imagen-3.0-fast-generate-001", { name: "Imagen 3 Fast", purpose: "image", route: "imagen" }],
  ["imagen-4.0-generate-001", { name: "Imagen 4", purpose: "image", route: "imagen" }],
  ["imagen-4.0-fast-generate-001", { name: "Imagen 4 Fast", purpose: "image", route: "imagen" }],
  ["imagen-4.0-ultra-generate-001", { name: "Imagen 4 Ultra", purpose: "image", route: "imagen" }],
]);

export function mediaCapability(id: string) {
  return mediaModels.get(id);
}

export function mediaPurpose(id: string) {
  return mediaCapability(id)?.purpose;
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
