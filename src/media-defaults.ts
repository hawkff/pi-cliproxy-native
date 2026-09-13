import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MediaPurpose, mediaCapability, mediaPurpose } from "./catalog.ts";
import { type Config, isModelId, isRecord } from "./config.ts";

export const MEDIA_DEFAULTS_ENTRY = "cliproxyapi-media-defaults";
export type MediaDefaults = Partial<Record<MediaPurpose, string>>;
export type DefaultsContext = { sessionManager?: Pick<ExtensionContext["sessionManager"], "getBranch"> };

export function readMediaDefaults(config: Config, ctx: DefaultsContext) {
  let defaults: MediaDefaults = {};
  for (const entry of ctx.sessionManager?.getBranch() ?? []) {
    if (entry.type !== "custom" || entry.customType !== MEDIA_DEFAULTS_ENTRY) continue;
    const data: unknown = entry.data;
    if (!isRecord(data) || data.endpoint !== config.baseUrl) continue;
    // An invalid latest snapshot must not resurrect an older default.
    defaults = {};
    if (data.version !== 1 || !isRecord(data.defaults)) continue;
    for (const purpose of ["image", "video"] as const) {
      const id = data.defaults[purpose];
      if (isModelId(id) && mediaPurpose(id) === purpose && !mediaCapability(id)?.disabledReason)
        defaults[purpose] = id;
    }
  }
  return defaults;
}

export function resolveMediaModel(
  config: Config,
  ctx: DefaultsContext,
  purpose: MediaPurpose,
  explicit?: string,
) {
  const model = explicit === undefined ? readMediaDefaults(config, ctx)[purpose] : explicit;
  if (model === undefined) {
    throw new Error(
      `No ${purpose} default. Use /cli:model to select one, or pass an explicit model ID from cliproxyapi_media_models.`,
    );
  }
  const disabledReason = mediaCapability(model)?.disabledReason;
  if (disabledReason) throw new Error(disabledReason);
  if (mediaPurpose(model) !== purpose) {
    throw new Error(`Choose an explicit supported ${purpose} model from cliproxyapi_media_models.`);
  }
  return model;
}
