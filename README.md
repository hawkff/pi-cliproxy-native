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

For non-interactive use, supply the client key through `CLIPROXYAPI_API_KEY`. First populate the catalog with `/cliproxyapi-refresh` in an interactive Pi session. Pi's `--list-models` and print modes read saved catalogs without startup network discovery.

Stored `/login` credentials take precedence over the environment variable. The extension stores no credentials itself; Pi manages them in its auth store. `/logout` removes the stored key but does not unset environment variables.

## Refresh

Pi restores the last successful catalog before network access. Interactive startup refreshes it in the background through Pi's native provider lifecycle. Force a refresh inside Pi:

```text
/cliproxyapi-refresh
```

In Pi 0.85.1, `pi update --models` does not load package extensions and cannot refresh this provider. Use `/cliproxyapi-refresh` instead.

Discovery calls `/v1/models` with a ten-second deadline. Failed requests and malformed responses leave the previous catalog intact. A successful empty catalog removes the discovered entries. Offline mode uses the saved catalog without contacting the proxy.

Pi owns catalog persistence and cancellation. Cached entries are scoped to the connection and alias configuration; credentials are excluded. A saved catalog does not guarantee current upstream access.

## Metadata and aliases

Discovery determines availability; Pi's built-in catalogs supply context limits, pricing, input types, and thinking capabilities. Exact IDs are matched against Anthropic, OpenAI, Codex, and Google metadata. Recognized catalog ownership resolves duplicate IDs; ambiguous cross-family matches are skipped.

Unknown IDs are skipped with a warning rather than assigned guessed capabilities. To describe a proxy alias, add its canonical reference to `pi-cliproxyapi.json`:

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

## Compatibility

Claude requests retain native thinking metadata and use the legacy fine-grained tool-streaming header instead of eager tool fields. Provider-specific deferred tools and strict-tool capabilities are disabled by default where the proxy's support is unverified. Responses function tools include `strict: null` when Pi omits strictness, preserving optional arguments. Explicit payload hooks retain final control.

Codex entries use `/v1/responses` with the proxy key. They do not use ChatGPT OAuth, patch Pi's source, or require its Codex WebSocket transport.

The extension registers a separate `cliproxyapi` provider. It does not edit existing custom providers or their hand-written model lists. Enable only one extension that registers this provider ID.

## Development

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm format
pnpm check
```

GitHub Actions runs type checking, formatting/lint checks, and tests on Node.js 22.19, 24, and 26. Tests use loopback mock servers and temporary Pi directories. They cover catalog discovery, authentication, offline restoration, failure retention, cancellation, native streaming routes, optional tool arguments, and package loading through Pi's CLI. They require no upstream credentials.

## License

[MIT](LICENSE)
