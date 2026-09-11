import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import {
  type Api,
  createModels,
  hasApi,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  Type,
} from "@earendil-works/pi-ai";
import { mapCatalog, parseCatalog } from "../src/catalog.ts";
import { isRecord, normalizeBaseUrl, PROVIDER_ID, parseConfig } from "../src/config.ts";
import { builtinCatalog, createCliproxyProvider, discover, nonStrictTools } from "../src/provider.ts";

const key = "fixture-api-key";
const known: Model<Api>[] = [
  ["anthropic", "anthropic-messages", "claude-fixture"],
  ["openai", "openai-responses", "gpt-fixture"],
  ["openai-codex", "openai-codex-responses", "codex-fixture"],
  ["google", "google-generative-ai", "gemini-fixture"],
  ["openai", "openai-completions", "chat-fixture"],
].map(([provider, api, id]) => ({
  id,
  provider,
  api,
  name: id,
  baseUrl: "https://upstream.example/v1",
  headers: { "x-upstream-only": "must-not-forward" },
  reasoning: true,
  thinkingLevelMap: { off: null, high: "high", xhigh: "max" },
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  compat: { forceAdaptiveThinking: true },
}));
const catalog = { data: known.map(({ id, provider }) => ({ id, owned_by: provider })) };
const noEnvironment = { env: async () => undefined, fileExists: async () => false };

async function server(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(async () => {
    const closed = once(instance, "close");
    instance.close();
    instance.closeAllConnections();
    await closed;
  });
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function collection(baseUrl: string, store = new InMemoryModelsStore(), authenticated = true) {
  const credentials = new InMemoryCredentialStore();
  if (authenticated) await credentials.modify(PROVIDER_ID, async () => ({ type: "api_key", key }));
  const models = createModels({ credentials, modelsStore: store, authContext: noEnvironment });
  const provider = createCliproxyProvider(parseConfig({ baseUrl }), known);
  models.setProvider(provider);
  return { models, provider, store };
}

test("configuration normalizes prefixes and rejects unsafe or invalid values", () => {
  assert.equal(normalizeBaseUrl("http://localhost:8317/v1/"), "http://localhost:8317");
  assert.equal(normalizeBaseUrl("https://proxy.example/gateway/v1beta"), "https://proxy.example/gateway");
  assert.equal(normalizeBaseUrl("http://[::1]:8317"), "http://[::1]:8317");
  for (const value of [
    "ftp://proxy.example",
    "http://proxy.example",
    "https://x:y@proxy.example",
    "https://proxy.example?key=fixture",
    "https://proxy.example#fragment",
    "not-a-url",
  ]) {
    assert.throws(() => normalizeBaseUrl(value));
  }
  for (const value of [
    null,
    [],
    { apiKey: "fixture" },
    { baseUrl: 7 },
    { aliases: null },
    { aliases: [] },
    { aliases: { alias: 7 } },
    { aliases: { alias: "unsupported/example" } },
    { aliases: { alias: "anthropicX" } },
    { aliases: { alias: "anthropic/" } },
  ]) {
    assert.throws(() => parseConfig(value));
  }
  assert.equal(
    parseConfig({ baseUrl: "https://old.example" }, "https://new.example").baseUrl,
    "https://new.example",
  );
});

test("mapping keeps native metadata and routes every supported family to the proxy", () => {
  const before = structuredClone(known);
  const result = mapCatalog(catalog, parseConfig({}), known);
  assert.equal(result.models.length, 5);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(
    result.models.map((model) => model.api),
    [
      "anthropic-messages",
      "openai-responses",
      "openai-responses",
      "google-generative-ai",
      "openai-completions",
    ],
  );
  assert.deepEqual(
    result.models.map((model) => model.baseUrl),
    [
      "http://localhost:8317",
      "http://localhost:8317/v1",
      "http://localhost:8317/v1",
      "http://localhost:8317/v1beta",
      "http://localhost:8317/v1",
    ],
  );
  for (const model of result.models) {
    assert.equal(model.provider, PROVIDER_ID);
    assert.equal(model.headers, undefined);
    assert.deepEqual(model.cost, known[0].cost);
    assert.deepEqual(model.thinkingLevelMap, known[0].thinkingLevelMap);
    assert.equal(model.contextWindow, 128000);
  }
  assert.deepEqual(known, before);
  const claude = result.models[0];
  assert.ok(hasApi(claude, "anthropic-messages"));
  assert.equal(claude.compat?.forceAdaptiveThinking, true);
  assert.equal(claude.compat?.supportsEagerToolInputStreaming, false);
});

test("aliases keep wire IDs, hidden entries disappear, and unknowns are not guessed", () => {
  const config = parseConfig({ aliases: { "team-chat": "anthropic/claude-fixture" } });
  const result = mapCatalog(
    {
      data: [
        { id: "team-chat" },
        { id: "team-chat" },
        { id: "future-fixture" },
        { id: "gpt-fixture", visibility: "hide" },
      ],
    },
    config,
    known,
  );
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["team-chat"],
  );
  assert.deepEqual(result.skipped, ["future-fixture"]);
  const ambiguous = [...known, { ...known[1], id: known[0].id }];
  assert.equal(mapCatalog({ data: [{ id: known[0].id }] }, config, ambiguous).models.length, 0);
  assert.equal(
    mapCatalog({ data: [{ id: known[0].id, owned_by: "claude" }] }, config, ambiguous).models[0].api,
    "anthropic-messages",
  );
});

test("malformed catalogs fail rather than replacing a working list", () => {
  for (const value of [
    null,
    {},
    { data: null },
    { data: [null] },
    { data: [{}] },
    { data: [{ id: "bad\nvalue" }] },
    { data: [{ id: "valid", owned_by: {} }] },
    { data: Array(10001).fill({ id: "fixture" }) },
  ]) {
    assert.throws(() => parseCatalog(value));
  }
  assert.deepEqual(parseCatalog({ data: [] }), []);
});

test("native refresh persists metadata, restores offline, keeps failures, and accepts an empty catalog", async (t) => {
  let body: unknown = catalog;
  let status = 200;
  let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests++;
    assert.equal(req.url, "/gateway/v1/models");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const first = await collection(`${baseUrl}/gateway`);
  assert.equal((await first.models.refresh()).errors.size, 0);
  assert.equal(first.provider.getModels().length, 5);
  const stored = await first.store.read(PROVIDER_ID);
  assert.ok(stored?.etag);
  assert.ok(!JSON.stringify(stored).includes(key));
  assert.ok(!JSON.stringify(stored).includes("must-not-forward"));
  const second = await collection(`${baseUrl}/gateway`, first.store);
  await second.models.refresh({ allowNetwork: false });
  assert.equal(requests, 1);
  assert.equal(second.provider.getModels().length, 5);
  status = 401;
  body = { error: key };
  const failed = await second.models.refresh({ force: true });
  assert.match(failed.errors.get(PROVIDER_ID)?.message ?? "", /HTTP 401/);
  assert.ok(!failed.errors.get(PROVIDER_ID)?.message.includes(key));
  assert.equal(second.provider.getModels().length, 5);
  status = 200;
  body = { broken: true };
  assert.equal((await second.models.refresh()).errors.size, 1);
  assert.equal(second.provider.getModels().length, 5);
  body = { data: [] };
  await second.models.refresh();
  assert.equal(second.provider.getModels().length, 0);
  assert.equal((await second.store.read(PROVIDER_ID))?.models.length, 0);
});

test("cache cannot cross endpoints or alias configurations", async (t) => {
  const baseUrl = await server(t, (_req, res) => res.end(JSON.stringify(catalog)));
  const first = await collection(baseUrl);
  await first.models.refresh();
  const changed = await collection(`${baseUrl}/different`, first.store);
  await changed.models.refresh({ allowNetwork: false });
  assert.equal(changed.provider.getModels().length, 0);
  const aliasProvider = createCliproxyProvider(
    parseConfig({ baseUrl, aliases: { alias: "anthropic/claude-fixture" } }),
    known,
  );
  first.models.setProvider(aliasProvider);
  await first.models.refresh({ allowNetwork: false });
  assert.equal(aliasProvider.getModels().length, 0);
});

test("unconfigured providers and offline refreshes do not access the network", async (t) => {
  let requests = 0;
  const baseUrl = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify(catalog));
  });
  const { models } = await collection(baseUrl, undefined, false);
  await models.refresh();
  await models.refresh({ allowNetwork: false });
  assert.equal(requests, 0);
  assert.equal(await models.getAuth(PROVIDER_ID), undefined);
});

test("stored keys win over ambient keys, and login validates without publishing credentials", async (t) => {
  const baseUrl = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.end(JSON.stringify(catalog));
  });
  const { provider } = await collection(baseUrl);
  const auth = provider.auth.apiKey;
  assert.ok(auth?.login);
  const result = await auth.resolve({
    credential: { type: "api_key", key },
    ctx: { ...noEnvironment, env: async () => "wrong-fixture-key" },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(result?.auth.apiKey, key);
  assert.equal(result?.auth.headers?.Authorization, `Bearer ${key}`);
  const credential = await auth.login({
    prompt: async () => key,
    notify() {},
    signal: AbortSignal.timeout(5000),
  });
  assert.deepEqual(credential, { type: "api_key", key });
  assert.deepEqual(provider.getModels(), []);
  await assert.rejects(
    auth.resolve({
      ctx: { ...noEnvironment, env: async () => "bad\nkey" },
      signal: AbortSignal.timeout(5000),
    }),
    /without whitespace/,
  );
});

test("discovery rejects redirects, oversized bodies, and raw error content", async (t) => {
  let mode = "redirect";
  const baseUrl = await server(t, (_req, res) => {
    if (mode === "redirect") res.writeHead(302, { location: "https://must-not-contact.example" }).end();
    else if (mode === "oversized") res.end("x".repeat(4 * 1024 * 1024 + 1));
    else res.end(`invalid-json-${key}`);
  });
  const run = () => discover(parseConfig({ baseUrl }), key, AbortSignal.timeout(5000), known);
  await assert.rejects(run(), /redirect error/);
  mode = "oversized";
  await assert.rejects(run(), /larger than 4 MiB/);
  mode = "malformed";
  await assert.rejects(run(), (error: unknown) => error instanceof Error && !error.message.includes(key));
});

test("cancelled and superseded refreshes cannot overwrite the latest catalog", async (t) => {
  let count = 0;
  const waiting = Promise.withResolvers<void>();
  const baseUrl = await server(t, (_req, res) => {
    count++;
    if (count === 1) {
      waiting.resolve();
      return;
    }
    res.end(JSON.stringify({ data: [{ id: "gpt-fixture" }] }));
  });
  const { models, provider } = await collection(baseUrl);
  const first = models.refresh();
  await waiting.promise;
  const second = models.refresh({ force: true });
  await Promise.all([first, second]);
  assert.deepEqual(
    provider.getModels().map((model) => model.id),
    ["gpt-fixture"],
  );
  const signal = AbortSignal.abort();
  assert.equal((await models.refresh({ signal })).aborted, true);
  assert.equal(count, 2);
});

test("non-strict Responses tools retain optional arguments and explicit strictness", () => {
  const input = {
    tools: [
      {
        type: "function",
        name: "optional",
        parameters: { type: "object", properties: { optional: { type: "string" } } },
      },
      { type: "function", strict: true },
      { type: "custom", name: "grammar" },
    ],
  };
  const output = nonStrictTools(input);
  assert.ok(isRecord(output) && Array.isArray(output.tools));
  assert.equal(output.tools[0].strict, null);
  assert.equal(output.tools[1].strict, true);
  assert.equal(output.tools[2].strict, undefined);
  assert.ok(!("strict" in input.tools[0]));
});

function sse(res: ServerResponse, events: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    if (isRecord(event) && typeof event.type === "string") res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function respond(res: ServerResponse, api: string) {
  if (api === "anthropic-messages") {
    sse(res, [
      {
        type: "message_start",
        message: {
          id: "fixture-message",
          type: "message",
          role: "assistant",
          content: [],
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
  } else if (api === "google-generative-ai") {
    sse(res, [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      },
    ]);
  } else if (api === "openai-completions") {
    sse(res, [
      {
        id: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      },
      {
        id: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    ]);
  } else {
    const item = {
      type: "message",
      id: "msg_fixture",
      role: "assistant",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    sse(res, [
      { type: "response.created", response: { id: "resp_fixture" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          output: [item],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        },
      },
    ]);
  }
}

test("native adapters stream each family through the right endpoint with the proxy key", async (t) => {
  for (const source of known) {
    await t.test(source.api, async (t) => {
      const actualApi = source.api === "openai-codex-responses" ? "openai-responses" : source.api;
      let seenPath = "";
      let seenBody: unknown;
      const baseUrl = await server(t, (req, res) => {
        assert.equal(req.headers.authorization, `Bearer ${key}`);
        assert.equal(req.headers["x-upstream-only"], undefined);
        if (req.method === "GET") {
          res.end(JSON.stringify(catalog));
          return;
        }
        seenPath = req.url ?? "";
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          seenBody = JSON.parse(body);
          respond(res, actualApi);
        });
      });
      const { models } = await collection(`${baseUrl}/gateway`);
      await models.refresh();
      const model = models.getModel(PROVIDER_ID, source.id);
      assert.ok(model);
      const result = await models.completeSimple(
        { ...model, baseUrl: "https://must-not-contact.example" },
        {
          messages: [{ role: "user", content: "Return ok.", timestamp: 0 }],
          tools: [
            {
              name: "fixture_tool",
              description: "Fixture tool",
              parameters: Type.Object({ optional: Type.Optional(Type.String()) }),
            },
          ],
        },
        { maxTokens: 32, maxRetries: 0, signal: AbortSignal.timeout(10000) },
      );
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(
        result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
        "ok",
      );
      assert.equal(result.usage.output, 1);
      const expected =
        actualApi === "anthropic-messages"
          ? "/gateway/v1/messages"
          : actualApi === "google-generative-ai"
            ? `/gateway/v1beta/models/${source.id}:streamGenerateContent`
            : actualApi === "openai-completions"
              ? "/gateway/v1/chat/completions"
              : "/gateway/v1/responses";
      const requestUrl = new URL(seenPath, baseUrl);
      assert.equal(requestUrl.pathname, expected);
      if (actualApi === "google-generative-ai") assert.equal(requestUrl.searchParams.get("alt"), "sse");
      assert.ok(isRecord(seenBody));
      if (actualApi !== "google-generative-ai") assert.equal(seenBody.model, source.id);
      if (actualApi === "openai-responses") {
        assert.ok(Array.isArray(seenBody.tools));
        assert.equal(seenBody.tools[0].strict, null);
        assert.ok(!seenBody.tools[0].parameters.required?.includes("optional"));
      }
    });
  }
});

test("Pi loads the package, refreshes through its command, and lists the catalog offline", async (t) => {
  const fixture = builtinCatalog()[0];
  assert.ok(fixture);
  let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests++;
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.end(JSON.stringify({ data: [{ id: fixture.id, owned_by: fixture.provider }] }));
  });
  const home = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ packages: [resolve(".")] }));
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const options = {
    cwd: home,
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: home,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      CLIPROXYAPI_BASE_URL: baseUrl,
      CLIPROXYAPI_API_KEY: key,
    },
  };
  const run = promisify(execFile);
  const cold = await run(process.execPath, [cli, "--list-models", PROVIDER_ID], options);
  assert.ok(!cold.stdout.includes(fixture.id));
  assert.equal(requests, 0);
  // Pi needs an available model to enter RPC, even for extension-only commands.
  // This unrelated fixture never runs inference and does not seed the proxy catalog.
  await writeFile(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        fixture: { baseUrl, api: "openai-completions", apiKey: key, models: [{ id: "bootstrap" }] },
      },
    }),
  );
  const rpc = spawn(
    process.execPath,
    [cli, "--mode", "rpc", "--no-session", "--model", "fixture/bootstrap"],
    options,
  );
  const closed = once(rpc, "close");
  const refreshed = Promise.withResolvers<void>();
  let buffer = "";
  let diagnostics = "";
  let notified = false;
  let accepted = false;
  rpc.stderr.setEncoding("utf8");
  rpc.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  rpc.stdout.setEncoding("utf8");
  rpc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event: unknown = JSON.parse(line);
        if (isRecord(event)) {
          if (
            event.type === "extension_ui_request" &&
            event.method === "notify" &&
            event.message === "CLIProxyAPI: 1 models." &&
            event.notifyType === "info"
          )
            notified = true;
          if (event.type === "response" && event.id === "refresh") {
            if (event.success === true) accepted = true;
            else refreshed.reject(new Error("Refresh command failed."));
          }
          if (accepted && notified) refreshed.resolve();
        }
      } catch (error) {
        refreshed.reject(error);
      }
      newline = buffer.indexOf("\n");
    }
  });
  rpc.stdin.write(`${JSON.stringify({ id: "refresh", type: "prompt", message: "/cliproxyapi-refresh" })}\n`);
  try {
    await Promise.race([
      refreshed.promise,
      closed.then(() => {
        throw new Error(`RPC exited before refresh completed: ${diagnostics}`);
      }),
    ]);
  } finally {
    rpc.kill();
    await closed;
  }
  assert.ok(notified, diagnostics);
  assert.ok(requests > 0);
  await rm(join(home, "models.json"));
  const afterRefresh = requests;
  const { stdout, stderr } = await run(
    process.execPath,
    [cli, "--offline", "--list-models", PROVIDER_ID],
    options,
  );
  assert.ok(stdout.includes(fixture.id), `${stdout}\n${stderr}`);
  assert.ok(stdout.includes(PROVIDER_ID));
  assert.ok(!stderr.includes("Failed to load extension"));
  assert.equal(requests, afterRefresh);
});
