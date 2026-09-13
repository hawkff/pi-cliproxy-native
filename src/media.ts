import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ImageContent, type Static, type TextContent, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mapMediaCatalog, mediaPurpose } from "./catalog.ts";
import { type Config, isRecord, PROVIDER_ID } from "./config.ts";
import { fetchCatalog, validateKey } from "./provider.ts";

type MediaContext = Pick<ExtensionContext, "cwd" | "model"> & {
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;
};

const MAX_INLINE_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;

const generationParameters = Type.Object({
  model: Type.String({ description: "Exact canonical ID from cliproxyapi_media_models; required." }),
  prompt: Type.String({ minLength: 1 }),
});

const videoParameters = Type.Object({
  ...generationParameters.properties,
  duration: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 15, description: "Video length in seconds (1–15)." }),
  ),
});

function deadline(signal: AbortSignal | undefined, milliseconds: number) {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(milliseconds)]);
}

async function mediaKey(ctx: MediaContext, signal: AbortSignal) {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(new Error("CLIProxyAPI media operation cancelled or timed out."));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // Pi's provider-auth facade has no signal argument; bound the wait without reading its store.
    const resolved = await Promise.race([ctx.modelRegistry.getProviderAuth(PROVIDER_ID), cancelled.promise]);
    signal.throwIfAborted();
    if (!resolved?.auth.apiKey) {
      throw new Error("Use /login cliproxyapi or set CLIPROXYAPI_API_KEY before using media tools.");
    }
    return validateKey(resolved.auth.apiKey);
  } catch {
    if (signal.aborted) throw new Error("CLIProxyAPI media operation cancelled or timed out.");
    throw new Error(
      "CLIProxyAPI media authentication failed. Use /login cliproxyapi or check CLIPROXYAPI_API_KEY.",
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function mediaRequest(
  config: Config,
  key: string,
  path: string,
  signal: AbortSignal,
  maxBytes: number,
  body?: object,
) {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error(
      "CLIProxyAPI media request failed: connection, cancellation, timeout, or redirect error. Generation was not retried.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CLIProxyAPI media request failed (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CLIProxyAPI media returned an empty response.");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Response too large.");
      }
      chunks.push(chunk.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return result;
  } catch {
    throw new Error(
      "CLIProxyAPI media response is invalid, incomplete, cancelled, or exceeds the response size limit.",
    );
  } finally {
    reader.releaseLock();
  }
}

export async function listMediaModels(config: Config, ctx: MediaContext, signal?: AbortSignal) {
  const bounded = deadline(signal, 15000);
  const key = await mediaKey(ctx, bounded);
  return mapMediaCatalog(await fetchCatalog(config, key, bounded));
}

async function generationKey(
  config: Config,
  params: Static<typeof generationParameters>,
  purpose: "image" | "video",
  ctx: MediaContext,
  signal: AbortSignal,
) {
  if (mediaPurpose(params.model) !== purpose) {
    throw new Error(`Choose an explicit supported ${purpose} model from cliproxyapi_media_models.`);
  }
  if (typeof params.prompt !== "string" || !params.prompt.trim()) {
    throw new Error("CLIProxyAPI media requires a non-empty prompt.");
  }
  const key = await mediaKey(ctx, signal);
  const available = mapMediaCatalog(await fetchCatalog(config, key, signal));
  if (!available.some(({ id }) => id === params.model)) {
    throw new Error("The selected media model is not available in the live CLIProxyAPI catalog.");
  }
  return key;
}

function parseImage(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== 1) {
    throw new Error("CLIProxyAPI image response must contain one image.");
  }
  const entry: unknown = value.data[0];
  if (!isRecord(entry) || typeof entry.b64_json !== "string") {
    throw new Error("CLIProxyAPI did not return b64_json image data. URL-only images are not downloaded.");
  }
  const encoded = entry.b64_json;
  const bytes = Buffer.from(encoded, "base64");
  if (!encoded || bytes.toString("base64") !== encoded) {
    throw new Error("CLIProxyAPI returned invalid base64 image data.");
  }
  let extension: string;
  let mimeType: string;
  if (
    bytes.length > 24 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    extension = "png";
    mimeType = "image/png";
  } else if (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    extension = "jpg";
    mimeType = "image/jpeg";
  } else if (
    bytes.length > 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    extension = "webp";
    mimeType = "image/webp";
  } else {
    throw new Error("CLIProxyAPI returned an unsupported or malformed image; expected JPEG, PNG, or WebP.");
  }
  const image: ImageContent = { type: "image", data: encoded, mimeType };
  return { bytes, extension, image };
}

export async function generateImage(
  config: Config,
  params: Static<typeof generationParameters>,
  ctx: MediaContext,
  signal?: AbortSignal,
) {
  const bounded = deadline(signal, 180000);
  const key = await generationKey(config, params, "image", ctx, bounded);
  const result = await mediaRequest(config, key, "images/generations", bounded, 32 * 1024 * 1024, {
    model: params.model,
    prompt: params.prompt,
    n: 1,
    response_format: "b64_json",
  });
  const { bytes, extension, image } = parseImage(result);
  bounded.throwIfAborted();
  const artifacts = join(ctx.cwd, ".pi");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(artifacts, "cliproxyapi-image-"));
  const path = join(directory, `image.${extension}`);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600, signal: bounded });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("CLIProxyAPI generated an image but could not save the artifact.");
  }
  const previewOmitted = !ctx.model?.input.includes("image")
    ? "Preview omitted: the current chat model does not support images."
    : image.data.length > MAX_INLINE_IMAGE_BASE64_BYTES
      ? "Preview omitted: image base64 exceeds the 4 MiB inline budget. Use read on the saved file."
      : undefined;
  const content: (TextContent | ImageContent)[] = [
    { type: "text", text: `Saved image: ${path}${previewOmitted ? `\n${previewOmitted}` : ""}` },
  ];
  if (!previewOmitted) content.push(image);
  return { content, details: { model: params.model, files: [{ path, mimeType: image.mimeType }] } };
}

function requestId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error(
      "CLIProxyAPI video requires a valid request_id (letters, digits, underscore, or hyphen).",
    );
  }
  return value;
}

export async function generateVideo(
  config: Config,
  params: Static<typeof videoParameters>,
  ctx: MediaContext,
  signal?: AbortSignal,
) {
  if (
    params.duration !== undefined &&
    (!Number.isInteger(params.duration) || params.duration < 1 || params.duration > 15)
  ) {
    throw new Error("CLIProxyAPI video duration must be an integer from 1 to 15 seconds.");
  }
  const bounded = deadline(signal, 60000);
  const key = await generationKey(config, params, "video", ctx, bounded);
  const result = await mediaRequest(config, key, "videos", bounded, 64 * 1024, {
    model: params.model,
    prompt: params.prompt,
    duration: params.duration,
  });
  if (!isRecord(result)) throw new Error("CLIProxyAPI returned an invalid video submission.");
  return { model: params.model, request_id: requestId(result.request_id), status: "pending" };
}

export async function videoStatus(config: Config, id: string, ctx: MediaContext, signal?: AbortSignal) {
  const request_id = requestId(id);
  const bounded = deadline(signal, 15000);
  const key = await mediaKey(ctx, bounded);
  const result = await mediaRequest(config, key, `videos/${request_id}`, bounded, 64 * 1024);
  if (!isRecord(result)) throw new Error("CLIProxyAPI returned an invalid video status.");
  if (result.status === "pending") return { request_id, status: "pending" };
  if (result.status === "failed" || result.status === "expired") {
    return { request_id, status: "failed", upstream_status: result.status };
  }
  if (result.status === "done" && isRecord(result.video) && result.video.respect_moderation === false) {
    return { request_id, status: "failed", upstream_status: "done", respect_moderation: false };
  }
  if (
    result.status !== "done" ||
    !isRecord(result.video) ||
    typeof result.video.url !== "string" ||
    (result.video.respect_moderation !== undefined && typeof result.video.respect_moderation !== "boolean")
  ) {
    throw new Error("CLIProxyAPI returned an unknown or malformed video status.");
  }
  let url: URL;
  try {
    url = new URL(result.video.url);
  } catch {
    throw new Error("CLIProxyAPI returned an invalid video URL.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192) {
    throw new Error("CLIProxyAPI returned an unsafe video URL.");
  }
  return { request_id, status: "completed", upstream_status: "done", url: url.href };
}

export function registerMediaTools(pi: ExtensionAPI, config: Config) {
  pi.registerTool({
    name: "cliproxyapi_media_models",
    label: "CLIProxyAPI media models",
    description:
      "List supported image and video models available through CLIProxyAPI. Does not change the chat model.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const models = await listMediaModels(config, ctx, signal);
      return { content: [{ type: "text", text: JSON.stringify({ models }) }], details: { models } };
    },
  });
  pi.registerTool({
    name: "cliproxyapi_generate_image",
    label: "CLIProxyAPI image",
    description:
      "Generate one image using an explicit available image model. Saves a new artifact under .pi/ in the working directory and returns its path and an image preview for vision-capable chat models. Maximum response: 32 MiB; inline image base64: 4 MiB. Larger images return paths without previews. No automatic retries.",
    parameters: generationParameters,
    async execute(_id, params, signal, _update, ctx) {
      return generateImage(config, params, ctx, signal);
    },
  });
  pi.registerTool({
    name: "cliproxyapi_generate_video",
    label: "CLIProxyAPI video",
    description:
      "Submit one video generation using an explicit available video model and optional duration (1–15 seconds). Returns request_id; use cliproxyapi_video_status to check it. Do not submit again to poll. No automatic retries.",
    parameters: videoParameters,
    async execute(_id, params, signal, _update, ctx) {
      const details = await generateVideo(config, params, ctx, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "cliproxyapi_video_status",
    label: "CLIProxyAPI video status",
    description:
      "Check one video request_id once. Returns pending, completed with a video URL, or failed. Does not download the video or submit generation.",
    parameters: Type.Object({ request_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await videoStatus(config, params.request_id, ctx, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
