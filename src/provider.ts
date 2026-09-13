import { createHash } from "node:crypto";
import {
  type Api,
  createProvider,
  envApiKeyAuth,
  type Model,
  type ProviderStreams,
  type RefreshModelsContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Pi's SDK loader aliases these entry points; deep pi-ai imports resolve to invalid paths.
import {
  anthropicMessagesApi,
  googleGenerativeAIApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type CpaApi, endpoint, mapCatalog } from "./catalog.ts";
import { type Config, isRecord, PROVIDER_ID } from "./config.ts";

export function builtinCatalog() {
  return [
    ...getBuiltinModels("anthropic"),
    ...getBuiltinModels("openai"),
    ...getBuiltinModels("openai-codex"),
    ...getBuiltinModels("google"),
  ];
}

function validateKey(key: string) {
  if (!/^[!-~]{1,4096}$/.test(key)) {
    throw new Error("CLIProxyAPI requires a non-empty API key without whitespace or control characters.");
  }
  return key;
}

export async function discover(
  config: Config,
  key: string,
  signal: AbortSignal,
  known: readonly Model<Api>[],
) {
  validateKey(key);
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: boundedSignal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("CLIProxyAPI discovery failed: connection, timeout, or redirect error.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CLIProxyAPI discovery failed (HTTP ${response.status}).`);
  }
  let payload: unknown;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CLIProxyAPI discovery returned an empty response.");
  try {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Catalog too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    payload = JSON.parse(text + decoder.decode());
  } catch {
    signal.throwIfAborted();
    throw new Error("CLIProxyAPI catalog is invalid, incomplete, or larger than 4 MiB.");
  } finally {
    reader.releaseLock();
  }
  return mapCatalog(payload, config, known);
}

export function nonStrictTools(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
  return {
    ...payload,
    tools: payload.tools.map((tool: unknown) =>
      isRecord(tool) && tool.type === "function" && tool.strict === undefined
        ? { ...tool, strict: null }
        : tool,
    ),
  };
}

function route(streams: ProviderStreams, baseUrl: string): ProviderStreams {
  const atEndpoint = (model: Model<Api>) => ({ ...model, baseUrl: endpoint(baseUrl, model.api) });
  const payloadHook =
    (next?: SimpleStreamOptions["onPayload"]) => async (payload: unknown, model: Model<Api>) => {
      // Responses defaults omitted strictness to strict; preserve optional tool arguments.
      const adapted = model.api === "openai-responses" ? nonStrictTools(payload) : payload;
      const result = await next?.(adapted, model);
      return result === undefined ? adapted : result;
    };
  return {
    // A resumed selection must not send the current key to an old endpoint.
    stream: (model, context, options) =>
      streams.stream(atEndpoint(model), context, {
        ...options,
        onPayload: payloadHook(options?.onPayload),
      }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(atEndpoint(model), context, {
        ...options,
        onPayload: payloadHook(options?.onPayload),
      }),
  };
}

export function createCliproxyProvider(config: Config, known: readonly Model<Api>[] = builtinCatalog()) {
  const standardAuth = envApiKeyAuth("CLIProxyAPI API key", ["CLIPROXYAPI_API_KEY"]);
  const scope = createHash("sha256")
    .update(JSON.stringify([1, config]))
    .digest("hex");
  const provider = createProvider<CpaApi>({
    id: PROVIDER_ID,
    name: "CLIProxyAPI",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        ...standardAuth,
        async login(interaction) {
          const credential = await standardAuth.login?.(interaction);
          if (!credential?.key) throw new Error("CLIProxyAPI requires an API key.");
          validateKey(credential.key);
          await discover(config, credential.key, interaction.signal, known);
          return credential;
        },
        async resolve(input) {
          const result = await standardAuth.resolve(input);
          if (!result?.auth.apiKey) return undefined;
          const key = validateKey(result.auth.apiKey);
          return { ...result, auth: { apiKey: key, headers: { Authorization: `Bearer ${key}` } } };
        },
      },
    },
    models: [],
    async fetchModels(context) {
      if (context.credential?.type !== "api_key" || !context.credential.key) {
        throw new Error("Use /login cliproxyapi or set CLIPROXYAPI_API_KEY before refreshing.");
      }
      return (await discover(config, context.credential.key, context.signal, known)).models;
    },
    api: {
      "anthropic-messages": route(anthropicMessagesApi(), config.baseUrl),
      "openai-responses": route(openAIResponsesApi(), config.baseUrl),
      "openai-completions": route(openAICompletionsApi(), config.baseUrl),
      "google-generative-ai": route(googleGenerativeAIApi(), config.baseUrl),
    },
  });
  const refresh = provider.refreshModels;
  return {
    ...provider,
    async refreshModels(context: RefreshModelsContext) {
      await refresh?.({
        ...context,
        // Pi owns storage and publication; the validator isolates endpoint/config changes.
        stored: context.stored?.etag === scope ? context.stored : { models: [] },
        publish: (publication) =>
          context.publish({
            ...publication,
            persist: publication.persist ? { ...publication.persist, etag: scope } : publication.persist,
          }),
      });
    },
  };
}
