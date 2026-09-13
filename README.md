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

Pi owns catalog persistence and cancellation. Cached entries are scoped to the connection and alias configuration; credentials are excluded. A saved catalog does not guarantee current upstream access.

## Model picker

Run `/cli:model` for a searchable live catalog of chat, image, and video models. Rows show friendly names, exact IDs, upstream owners, and capabilities. Search by name (including `nano` or `banana`), ID, owner, or purpose. Unknown models remain visible as unsupported and cannot run.

Selecting a chat model uses Pi's session model selection. Selecting an image or video model sets a separate session default; it does not change chat or generate anything. The picker and footer show the media defaults. Use the clear rows to remove either default.

```text
/cli:model search banana
/cli:model list
/cli:model select gemini-2.5-flash-image
/cli:model clear image
/cli:model clear video
```

The terminal picker is keyboard-only; mouse clicks and wheel events do not change its selection. Type to search, use selection keys to navigate, Enter to select, and Escape to cancel. Custom selection keybindings also work. RPC, print, and JSON modes return results without opening a picker; use `select <exact ID>` to choose a model. Print mode writes command results to stderr. JSON mode emits custom-message events; RPC sends notifications. Text listings show at most 100 matches; narrow the query for larger catalogs.

Pi stores media defaults in custom session entries, scoped to the configured proxy endpoint. Reload, resume, and tree navigation restore the current branch's defaults. Forks inherit defaults from their copied branch; new sessions start without them. The extension keeps defaults separate for each endpoint and creates no global media settings or disk cache.

Explicit picker and media calls contact the proxy, including in offline chat mode. The picker fetches `/v1/models` on demand. Selecting a chat ID missing from Pi's registry refreshes the native chat catalog first, then uses the effective registry model, including overrides. Listing and media selection do not refresh the chat cache. A post-selection chat refresh has its own 15-second deadline; time spent browsing does not count toward it.

## Metadata and aliases

Discovery determines availability; Pi's built-in catalogs supply context limits, pricing, input types, and thinking capabilities. Exact IDs are matched against Anthropic, OpenAI, Codex, and Google metadata. Recognized catalog ownership resolves duplicate IDs; ambiguous cross-family matches are skipped.

The chat catalog skips unknown IDs without guessing capabilities. `/cli:model` shows them as unsupported. To describe a proxy alias, add its canonical reference to `pi-cliproxyapi.json`:

```json
{
  "aliases": {
    "team-chat": "anthropic/<canonical-model-id>"
  }
}
```

Replace `<canonical-model-id>` with an ID in Pi's Anthropic catalog. References may also start with `openai/`, `openai-codex/`, or `google/`. The proxy still receives `team-chat` as the request ID; aliases change metadata, not routing names.

Pi's adapters also use IDs for some model-specific behavior. Prefer canonical Gemini IDs for thinking controls; an arbitrary alias does not reproduce every ID-specific adapter feature.

Use Pi's `models.json` `modelOverrides` for per-model limits, pricing, or compatibility changes. Use its `models` array for a model that has no built-in metadata at all. Updating Pi updates the metadata available to this extension.

Catalog prices are estimates, not the proxy's bill. Verify limits against the upstream account before increasing them.

## Images and videos

Use the media tools from any chat model after `/login cliproxyapi`. Media models do not appear in `/model`; these tools leave your chat selection unchanged.

| Tool | Arguments | Result |
|------|-----------|--------|
| `cliproxyapi_media_models` | None | Supported image/video IDs available now and session defaults |
| `cliproxyapi_generate_image` | `prompt`, optional `model` | Saved images and paths; image content for vision-capable chat models |
| `cliproxyapi_generate_video` | `prompt`, optional `model`, optional `duration` (integer, 1–15 seconds) | `request_id` for a submitted video |
| `cliproxyapi_video_status` | `request_id` | One status check: pending, completed with a URL, or failed |

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

Google's March 24, 2026 [Vertex release notes](https://docs.cloud.google.com/vertex-ai/docs/release-notes) direct migration from all five Imagen IDs before June 30, 2026. The extension marks these IDs as retired on Vertex and disables them even if a proxy still advertises them. This conservative policy does not assert that every custom gateway rejects these IDs.

`/cli:model` shows their image purpose and retirement reason; `cliproxyapi_media_models` excludes them. Explicit generation fails before network access. The extension discards stored Imagen defaults without a fallback. Select an available Nano Banana model instead.

Choose a model with `/cli:model` or pass an explicit ID from `cliproxyapi_media_models`. Omit `model` only when that purpose has a session default. An explicit ID takes precedence. Generation rechecks `/v1/models` and rejects missing or hidden IDs, including stale defaults. It does not choose a replacement model or fall back to a more expensive one.

Media discovery runs on demand and has no saved catalog. Google image IDs stay out of the chat catalog even if mapped to a chat alias. Vision input support does not imply image output. Routing prefixes, media aliases, unknown media IDs, Google Veo, and editing endpoints are unsupported.

Example requests to Pi:

```text
List available CLIProxyAPI media models.
Generate an image of a red circle with grok-imagine-image.
Generate a 1-second video of a red circle moving left with grok-imagine-video.
Check video status for request_id <returned-id>.
```

xAI images request `b64_json` with `n=1` through `/v1/images/generations`. Google images use the proxy's `/v1beta/models/{id}:generateContent` route and read inline image data from the Gemini JSON response. Requests contain only the prompt and image-generation options, without chat history, system instructions, or tools.

For Google images, the extension rejects explicit safety/refusal signals, incomplete responses, text-only results, malformed data, and MIME/signature mismatches before saving any images. It skips `thought: true` parts and saves all final image parts from a single completed candidate, up to 16 images and 256 parts per response. Responses beyond those limits fail rather than drop final images.

The extension checks base64 and file signatures, then saves JPEG, PNG, or WebP under a new `.pi/cliproxyapi-image-*/` directory in the working directory. Files use private permissions and do not overwrite existing files. Keep `.pi/` out of version control. Inline previews require a vision-capable chat model and share a 4 MiB base64 budget per tool result; images that exceed the remaining budget return paths without previews. Use Pi's `read` tool to inspect saved images. URL-only image responses fail without downloading anything.

Video submission returns after the proxy accepts the request, without waiting for generation to finish. Use the returned ID for each later status check, rather than submitting again. The extension reports native `done` as completed and `failed` or `expired` as failed. The extension marks moderation-rejected results as failed and omits their URLs. Tool details retain request IDs, file paths, and final video URLs; the extension does not download videos or send proxy credentials to media URLs. xAI video URLs are temporary.

Media tools use Pi's resolved `cliproxyapi` key and the configured proxy endpoint. Deadlines cover auth and network waits: 15 seconds for listing/status, 60 seconds for video submission, and 180 seconds for images. Catalog fetches retain their ten-second deadline and 4 MiB limit; image responses allow 32 MiB and video responses 64 KiB. Requests reject redirects and report HTTP errors by status, without upstream response bodies. Generation has no automatic retries. Cancellation or a timeout can leave a generation running upstream; check a known video ID before considering another submission.

The wire formats follow CLIProxyAPI v7.2.158's [image handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/openai/openai_images_handlers.go) and [native video handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/openai/openai_videos_handlers.go), with duration/status semantics from [xAI's video documentation](https://docs.x.ai/developers/model-capabilities/video/generation). Google routing follows the [Gemini handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/gemini/gemini_handlers.go) and [Vertex executor](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/internal/runtime/executor/gemini_vertex_executor.go). The Gemini, image, and video handlers, Vertex executor, and Antigravity execution code are unchanged between v7.2.158 and v7.3.1. Availability still depends on your proxy and upstream account.

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

GitHub Actions runs type checking, formatting/lint checks, and tests on Node.js 22.19, 24, and 26. Tests use loopback mock servers and temporary Pi directories. They cover catalog discovery, authentication, offline restoration, failure retention, cancellation, native streaming routes, optional tool arguments, Google and xAI media artifacts/status, searchable selection, session defaults, and package/tool/colon-command loading through Pi. They require no upstream credentials.

## License

[MIT](LICENSE)
