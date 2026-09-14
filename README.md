# pi-cliproxyapi

Discover [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) models in [Pi](https://pi.dev) without maintaining a static model list.

The extension uses Pi's existing API adapters:

- Claude: Anthropic Messages.
- OpenAI and Codex: OpenAI Responses, or Chat Completions for catalog entries that use it.
- Gemini: Google Generative AI.

Requires Pi 0.85.x (at least 0.85.1) and Node.js 22.19 or newer. No additional runtime dependencies or compilation step.

## Install

```sh
pi install git:github.com/hawkff/pi-cliproxyapi
```

For a local checkout:

```sh
pi install /path/to/pi-cliproxyapi
```

Restart Pi, then enter your **CLIProxyAPI client key**:

```text
/login cliproxyapi
/cliproxyapi-refresh
/model
```

Choose a `cliproxyapi/` entry. Login validates the key against the proxy before Pi saves it. Upstream account authentication stays in CLIProxyAPI.

## Connection

The default address is `http://localhost:8317`. Set `CLIPROXYAPI_BASE_URL` or create `~/.pi/agent/pi-cliproxyapi.json`:

```json
{
  "baseUrl": "http://localhost:8317"
}
```

Root URLs and URLs ending in `/v1` or `/v1beta` are accepted. Path prefixes are preserved. Remote endpoints require HTTPS; HTTP is allowed on loopback addresses. Credentials, query strings, and fragments are not allowed in the URL.

The environment variable takes precedence over the file. Configuration is global; project-local files cannot change the destination of your proxy key. Run `/reload` after changing the connection or aliases.

For non-interactive use, supply the client key through `CLIPROXYAPI_API_KEY`. For chat, first populate the catalog with `/cliproxyapi-refresh` in an interactive Pi session. Pi's `--list-models` and print modes read saved chat catalogs without startup network discovery.

Stored `/login` credentials take precedence over the environment variable. The extension stores no credentials itself; Pi manages them in its auth store. `/logout` removes the stored key but does not unset environment variables.

## Refresh

Pi restores the last successful catalog before network access. Interactive startup refreshes it in the background through Pi's native provider lifecycle. Force a refresh inside Pi:

```text
/cliproxyapi-refresh
```

In Pi 0.85.1, `pi update --models` does not load package extensions and cannot refresh this provider. Use `/cliproxyapi-refresh` instead.

Discovery calls `/v1/models` with a ten-second deadline. Failed requests and malformed responses leave the previous catalog intact. A successful empty catalog removes the discovered entries. Offline chat discovery uses the saved catalog without contacting the proxy.

Pi owns catalog persistence and cancellation. Cached entries are scoped to the connection, alias configuration, and mapping policy; credentials are excluded. An upgrade can invalidate saved entries; run `/cliproxyapi-refresh` before offline chat. A saved catalog does not guarantee current upstream access.

## Media picker

Run `/cli:model` for a searchable live catalog of image and video models. Chat models belong in Pi's `/model` menu. Rows show friendly names, exact IDs, backends, upstream owners, and capabilities. Search by name (including `nano` or `banana`), ID, backend, owner, or purpose. The picker omits chat models and IDs without a known media capability.

Selecting an image or video model sets a separate session default; it does not change chat or generate anything. The picker shows the effective media defaults. OpenAI/GPT chats use `gpt-image-2.5-sunburst` automatically unless you select an image default. Clearing that selection restores automatic behavior.

```text
/cli:model search banana
/cli:model list
/cli:model select gemini-2.5-flash-image
/cli:model clear image
/cli:model clear video
```

The terminal picker is keyboard-only; mouse clicks and wheel events do not change its selection. Type to search, use selection keys to navigate, Enter to select, and Escape to cancel. Custom selection keybindings also work. RPC, print, and JSON modes return results without opening a picker; use `select <exact ID>` to choose a model. Print mode writes command results to stderr. JSON mode emits custom-message events; RPC sends notifications. Text listings show at most 100 matches; narrow the query for larger catalogs.

Pi stores media defaults in custom session entries, scoped to the configured proxy endpoint. Reload, resume, and tree navigation restore the current branch's defaults. Forks inherit selected defaults from their copied branch; new sessions start without explicit selections. Automatic image defaults follow the current chat model without network access or persistence. The extension keeps defaults separate for each endpoint and creates no global media settings or disk cache.

Explicit picker and media calls contact the proxy, including in offline chat mode. The picker fetches `/v1/models` on demand without refreshing Pi's chat catalog.

## Backend routing

Set the top-level `prefix` field to `vertex` on Vertex auth records and `antigravity` on Antigravity auth records in CLIProxyAPI. Version 7.3.1 advertises these routes as `vertex/<canonical-id>` and `antigravity/<canonical-id>` through `/v1/models`. With `force-model-prefix: false`, it also retains bare IDs. The extension does not change proxy configuration or restart the proxy.

The media picker and Pi's chat registry keep each advertised route separate. For example, select `vertex/gemini-2.5-flash-image` for Nano Banana through Vertex or `antigravity/gemini-3.1-flash-image` for Nano Banana 2 through Antigravity. Backend labels identify routes in both menus. Bare IDs show **Automatic (proxy routing)**; `owned_by: google` identifies an owner, not a Vertex route. Custom chat prefixes show **Unknown backend**.

Keep the full ID in selections and media `model` arguments. The registry, defaults, requests, and results retain it. Prefix stripping serves metadata and Gemini adapter capability checks.

Exact `/cli:model select <ID>` and media calls, including stored media defaults, reject missing routes without choosing another model or backend. Pi's native CLI fuzzy matching and saved-chat fallback remain unchanged and can select a different model or route. Confirm the active chat route after startup, or select it with `/cli:model`.

## Metadata and aliases

Discovery determines availability; Pi's built-in catalogs supply context limits, pricing, input types, and thinking capabilities. The extension matches bare IDs and the canonical part of `vertex/` and `antigravity/` IDs against Anthropic, OpenAI, Codex, and Google metadata. Recognized catalog ownership resolves duplicate metadata IDs, not backend routing; ambiguous cross-family matches are skipped.

The chat catalog skips unknown IDs without guessing capabilities. To describe a proxy chat alias, add its canonical reference to `pi-cliproxyapi.json`:

```json
{
  "aliases": {
    "team-chat": "anthropic/<canonical-model-id>"
  }
}
```

Replace `<canonical-model-id>` with an ID in Pi's Anthropic catalog. References may also start with `openai/`, `openai-codex/`, or `google/`. The proxy still receives `team-chat` as the request ID; aliases change metadata, not routing names. Qualified routes can reuse a canonical ID's alias when its reference resolves to one metadata entry. An exact qualified-ID alias takes precedence. Custom prefixes require an explicit chat alias; the extension does not guess their canonical IDs.

Pi's adapters also use IDs for some model-specific behavior. Canonical Gemini IDs, including the two recognized routing prefixes, retain native thinking and tool-turn behavior. An arbitrary alias does not reproduce every ID-specific adapter feature.

Use Pi's `models.json` `modelOverrides` for per-model limits, pricing, or compatibility changes. Use its `models` array for a model that has no built-in metadata at all. Updating Pi updates the metadata available to this extension.

Catalog prices are estimates, not the proxy's bill. Verify limits against the upstream account before increasing them.

## Images and videos

Use the media tools from any chat model after `/login cliproxyapi`. Media models do not appear in `/model`; these tools leave your chat selection unchanged.

| Tool | Arguments | Result |
|------|-----------|--------|
| `cliproxyapi_media_models` | None | Supported image/video IDs available now and effective defaults |
| `cliproxyapi_generate_image` | `prompt`, optional `model` | Saved images and paths; image content for vision-capable chat models |
| `cliproxyapi_generate_video` | `prompt`, optional `model`, optional `duration` (integer, 1–15 seconds) | `request_id` for a submitted video |
| `cliproxyapi_video_status` | `request_id` | One status check: pending, completed with a URL, or failed |

OpenAI image models: `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.5`, `gpt-image-2`, and `gpt-image-1.5`. Each ID stays unchanged on the wire, including bare `gpt-image-2.5`. Availability requires an exact live catalog entry.

xAI models:

- Image: `grok-imagine-image`, `grok-imagine-image-quality`, `grok-imagine-image-2.0`.
- Video: `grok-imagine-video`, `grok-imagine-video-1.5`, `grok-imagine-video-1.5-preview`.

Google image models:

| Friendly name | Exact ID |
|---------------|----------|
| Nano Banana | `gemini-2.5-flash-image` |
| Nano Banana 2 | `gemini-3.1-flash-image` |
| Nano Banana Pro | `gemini-3-pro-image` |
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` (only when advertised by the proxy) |

Retired Imagen entries (disabled):

| Friendly name | Exact ID |
|---------------|----------|
| Imagen 3 | `imagen-3.0-generate-002` |
| Imagen 3 Fast | `imagen-3.0-fast-generate-001` |
| Imagen 4 | `imagen-4.0-generate-001` |
| Imagen 4 Fast | `imagen-4.0-fast-generate-001` |
| Imagen 4 Ultra | `imagen-4.0-ultra-generate-001` |

Google's March 24, 2026 [Vertex release notes](https://docs.cloud.google.com/vertex-ai/docs/release-notes) direct migration from all five Imagen IDs before June 30, 2026. The extension marks these IDs as retired on Vertex and disables bare IDs and their `vertex/` and `antigravity/` forms even if a proxy still advertises them. This conservative policy does not assert that every custom gateway rejects these IDs.

`/cli:model` shows their image purpose and retirement reason; `cliproxyapi_media_models` excludes them. Explicit generation fails before network access. The extension marks stored Imagen defaults invalid without a fallback. Select an available Nano Banana model instead.

For requested raster images, use `cliproxyapi_generate_image` with `prompt` and omit `model` to use the effective default. This keeps your chat model unchanged. Selection and discovery do not generate images.

An explicit `model` argument takes precedence over a selected session default, which takes precedence over the automatic image default. Native OpenAI/Codex chats and GPT chat IDs through CLIProxyAPI or other providers use `gpt-image-2.5-sunburst` automatically. Configured OpenAI metadata aliases also qualify; an OpenAI-compatible API alone does not. Other chats require an image selection or explicit ID, and videos require a video selection or explicit ID.

Invalid or disabled saved selections block automatic fallback until you clear or replace them. Generation rechecks `/v1/models` and rejects missing or hidden IDs, including stale defaults. It does not choose a replacement model or fall back to a more expensive one.

Media discovery runs on demand and has no saved catalog. Supported image IDs stay out of the chat catalog even if mapped to a chat alias. Vision input support does not imply image output. Both recognized backends support the listed Gemini image models when advertised. Qualified OpenAI images and xAI image/video entries remain visible but disabled: these prefixes do not establish execution support for them. Other prefixes, media aliases, unknown media IDs, Google Veo, and editing endpoints are unsupported.

Example requests to Pi:

```text
List available CLIProxyAPI media models.
Generate an image of a red circle with grok-imagine-image.
Generate a 1-second video of a red circle moving left with grok-imagine-video.
Check video status for request_id <returned-id>.
```

OpenAI images send `model`, `prompt`, and `n=1` to `/v1/images/generations` and read `data[].b64_json`; they omit `response_format`. xAI images use the same route with `response_format: "b64_json"` and `n=1`. Google images use the proxy's `/v1beta/models/{id}:generateContent` route and read inline image data from the Gemini JSON response. Requests contain only the prompt and image-generation options, without chat history, system instructions, or tools.

For Google images, the extension rejects explicit safety/refusal signals, incomplete responses, text-only results, malformed data, and MIME/signature mismatches before saving any images. It skips `thought: true` parts and saves all final image parts from a single completed candidate, up to 16 images and 256 parts per response. Responses beyond those limits fail rather than drop final images.

The extension checks base64 and file signatures, then saves JPEG, PNG, or WebP under a new `.pi/cliproxyapi-image-*/` directory in the working directory. Files use private permissions and do not overwrite existing files. Keep `.pi/` out of version control. Inline previews require a vision-capable chat model and share a 4 MiB base64 budget per tool result; images that exceed the remaining budget return paths without previews. Use Pi's `read` tool to inspect saved images. URL-only image responses fail without downloading anything.

Video submission returns after the proxy accepts the request, without waiting for generation to finish. Use the returned ID for each later status check, rather than submitting again. The extension reports native `done` as completed and `failed` or `expired` as failed. The extension marks moderation-rejected results as failed and omits their URLs. Tool details retain request IDs, file paths, and final video URLs; the extension does not download videos or send proxy credentials to media URLs. xAI video URLs are temporary.

Media tools use Pi's resolved `cliproxyapi` key and the configured proxy endpoint. Deadlines cover auth and network waits: 15 seconds for listing/status, 60 seconds for video submission, 600 seconds for OpenAI images, and 180 seconds for other images. Image tools report generating and saving progress. Catalog fetches retain their ten-second deadline and 4 MiB limit; image responses allow 32 MiB and video responses 64 KiB. Requests reject redirects and report HTTP errors by status, without upstream response bodies. Generation has no automatic retries. Cancellation or a timeout can leave a generation running upstream; check a known video ID before considering another submission.

OpenAI image POSTs use a separate HTTP connection without shorter transport timeouts; the overall ten-minute deadline covers both headers and body. These requests ask for identity encoding and reject compressed responses.

OpenAI image routing follows CLIProxyAPI v7.3.1's [image handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.1/sdk/api/handlers/openai/openai_images_handlers.go) and [Codex image executor](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.1/internal/runtime/executor/codex_openai_images.go).

The xAI wire formats follow CLIProxyAPI v7.2.158's [image handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/openai/openai_images_handlers.go) and [native video handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/openai/openai_videos_handlers.go), with duration/status semantics from [xAI's video documentation](https://docs.x.ai/developers/model-capabilities/video/generation). Google routing follows the [Gemini handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/gemini/gemini_handlers.go) and [Vertex executor](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/internal/runtime/executor/gemini_vertex_executor.go). The Gemini, image, and video handlers, Vertex executor, and Antigravity execution code are unchanged between v7.2.158 and v7.3.1. Availability still depends on your proxy and upstream account.

## Thinking and subagents

Use `cliproxyapi/<model-id>:high` as the model reference in Pi or pi-subagents. Pi separates the thinking suffix from the model ID; the proxy receives the original ID and native thinking parameters. Keep thinking suffixes out of metadata alias mappings.

Supported levels come from the model's metadata. `xhigh` and `max` require explicit support, and Pi clamps unsupported levels. A model that requires thinking cannot use `off`.

pi-subagents gives children a separate model registry. Foreground children skip ambient extensions; background children can also exclude them through an extension allowlist. A saved catalog alone does not register this provider.

Add the installed extension path to `subagentOnlyExtensions` for each native role that needs it. Merge this example into `~/.pi/agent/settings.json`, replacing the path and role name:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "subagentOnlyExtensions": ["/path/to/pi-cliproxyapi/extensions/index.ts"]
      }
    }
  }
}
```

Preserve existing list entries. This setting adds child loading without replacing background extension discovery; it does not bypass a policy that denies extensions. Run `/reload` after changing settings.

If the base model ID still fails to resolve, check child extension loading, authentication, and the saved catalog. Run `/cliproxyapi-refresh` in the parent before starting new children. Changing the thinking suffix cannot restore a missing provider.

## Compatibility

Claude requests retain native thinking metadata and use the legacy fine-grained tool-streaming header instead of eager tool fields. Provider-specific deferred tools and strict-tool capabilities are disabled by default where the proxy's support is unverified. Responses function tools include `strict: null` when Pi omits strictness, preserving optional arguments. Explicit payload hooks retain final control.

Codex entries use `/v1/responses` with the proxy key. They do not use ChatGPT OAuth, patch Pi's source, or require its Codex WebSocket transport.

The extension registers a separate `cliproxyapi` provider. It does not edit existing custom providers or their hand-written model lists. Enable only one extension that registers this provider ID.

## Development

```sh
pnpm install --frozen-lockfile --ignore-scripts
export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=error
pnpm --config.verifyDepsBeforeRun=error run format
pnpm --config.verifyDepsBeforeRun=error run check
```

GitHub Actions runs type checking, formatting/lint checks, and tests on Node.js 22.19, 24, and 26. Tests use loopback mock servers and temporary Pi directories. They cover catalog discovery, authentication, offline restoration, failure retention, cancellation, native streaming routes, optional tool arguments, OpenAI/Google/xAI media artifacts and status, searchable selection, automatic and selected defaults, and package/tool/colon-command loading through Pi. They require no upstream credentials.

## License

[MIT](LICENSE)
