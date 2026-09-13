import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { mapCatalog, mapMediaCatalog } from "../src/catalog.ts";
import { PROVIDER_ID, parseConfig } from "../src/config.ts";
import { generateImage, generateVideo, listMediaModels, videoStatus } from "../src/media.ts";
import { builtinCatalog } from "../src/provider.ts";

const key = "fixture-media-key";
const imageModel = "grok-imagine-image";
const videoModel = "grok-imagine-video-1.5-preview";
const ids = [
  imageModel,
  "grok-imagine-image-quality",
  "grok-imagine-image-2.0",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  videoModel,
];
const catalog = { data: ids.map((id) => ({ id, owned_by: "xai" })) };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
const jpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAr/2Q==";
const webp = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

async function home(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-media-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function context(cwd: string) {
  return {
    cwd,
    model: builtinCatalog().find((model) => model.input.includes("image")),
    modelRegistry: {
      async getProviderAuth(provider: string) {
        assert.equal(provider, PROVIDER_ID);
        return {
          auth: {
            apiKey: key,
            baseUrl: "https://must-not-contact.example",
            headers: { "x-extra": "not-forwarded" },
          },
        };
      },
    },
  };
}

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

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value;
}

test("media catalog maps six exact IDs, excludes hidden and unknown IDs, and cannot seed chat aliases", () => {
  assert.deepEqual(
    mapMediaCatalog(catalog),
    ids.map((id, index) => ({ id, purpose: index < 3 ? "image" : "video" })),
  );
  assert.deepEqual(
    mapMediaCatalog({
      data: [
        { id: imageModel, visibility: "hide" },
        { id: videoModel },
        { id: videoModel },
        { id: "grok-imagine-image-future" },
        { id: "gpt-image-1" },
        ...["xai", "x-ai", "grok", "team"].map((prefix) => ({ id: `${prefix}/${imageModel}` })),
      ],
    }),
    [{ id: videoModel, purpose: "video" }],
  );
  const known = builtinCatalog();
  const chat = known[0];
  const config = parseConfig({
    aliases: Object.fromEntries(ids.map((id) => [id, `${chat.provider}/${chat.id}`])),
  });
  assert.deepEqual(mapCatalog(catalog, config, known).models, []);
  assert.throws(() => mapMediaCatalog({ data: [{ id: imageModel, owned_by: 1 }] }));
});

test("media discovery stays live and generation requires an explicit available model and valid purpose", async (t) => {
  let data: unknown = catalog;
  let gets = 0;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      gets++;
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/v1/models");
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      res.end(JSON.stringify(data));
    }),
  });
  const ctx = context(await home(t));
  assert.equal((await listMediaModels(config, ctx)).length, 6);
  for (const model of ["", "gpt-image-1", videoModel, `xai/${imageModel}`, "team-image"]) {
    await assert.rejects(
      generateImage(config, { model, prompt: "fixture" }, ctx),
      /explicit supported image model/,
    );
  }
  await assert.rejects(
    generateVideo(config, { model: imageModel, prompt: "fixture" }, ctx),
    /explicit supported video model/,
  );
  await assert.rejects(generateImage(config, { model: imageModel, prompt: "  " }, ctx), /non-empty prompt/);
  for (const duration of [0, 16, 1.5, Number.NaN]) {
    await assert.rejects(
      generateVideo(config, { model: videoModel, prompt: "fixture", duration }, ctx),
      /integer from 1 to 15/,
    );
  }
  assert.equal(gets, 1);
  data = { data: [{ id: imageModel, visibility: "hide" }] };
  await assert.rejects(generateImage(config, { model: imageModel, prompt: "fixture" }, ctx), /not available/);
  data = { data: [] };
  assert.deepEqual(await listMediaModels(config, ctx), []);
  await assert.rejects(generateVideo(config, { model: videoModel, prompt: "fixture" }, ctx), /not available/);
  assert.equal(gets, 4);
});

test("image generation pins paths/auth, requests b64_json, and saves private unique JPEG/PNG/WebP artifacts", async (t) => {
  let encoded = png;
  let posts = 0;
  const requests: string[] = [];
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers["x-extra"], undefined);
      if (req.method === "GET") return void res.end(JSON.stringify(catalog));
      posts++;
      void body(req).then((value) => {
        assert.deepEqual(value, { model: imageModel, prompt: "fixture", n: 1, response_format: "b64_json" });
        res.end(JSON.stringify({ data: [{ b64_json: encoded }] }));
      });
    })}/gateway/v1`,
  });
  const cwd = await home(t);
  await writeFile(join(cwd, "image.png"), "keep");
  const ctx = context(cwd);
  const selected = ctx.model;
  const paths = new Set<string>();
  for (const [data, mimeType, extension] of [
    [png, "image/png", "png"],
    [jpeg, "image/jpeg", "jpg"],
    [webp, "image/webp", "webp"],
  ]) {
    encoded = data;
    const result = await generateImage(config, { model: imageModel, prompt: "fixture" }, ctx);
    const file = result.details.files[0];
    assert.equal(file.mimeType, mimeType);
    assert.ok(file.path.startsWith(join(cwd, ".pi", "cliproxyapi-image-")));
    assert.ok(file.path.endsWith(`image.${extension}`));
    paths.add(file.path);
    assert.equal((await readFile(file.path)).toString("base64"), data);
    assert.equal((await stat(file.path)).mode & 0o777, 0o600);
    assert.deepEqual(result.content[1], { type: "image", data, mimeType });
  }
  encoded = png;
  const textOnly = await generateImage(
    config,
    { model: imageModel, prompt: "fixture" },
    { ...ctx, model: undefined },
  );
  assert.equal(textOnly.content.length, 1);
  assert.match(JSON.stringify(textOnly.content), /Preview omitted.*does not support images/);
  encoded = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(3 * 1024 * 1024)]).toString("base64");
  const large = await generateImage(config, { model: imageModel, prompt: "fixture" }, ctx);
  assert.equal(large.content.length, 1);
  assert.match(JSON.stringify(large.content), /Preview omitted.*4 MiB inline budget/);
  assert.equal((await readFile(large.details.files[0].path)).toString("base64"), encoded);
  assert.equal(paths.size, 3);
  assert.equal(await readFile(join(cwd, "image.png"), "utf8"), "keep");
  assert.equal(ctx.model, selected);
  assert.equal(posts, 5);
  assert.deepEqual(
    requests,
    Array.from({ length: 5 }, () => ["GET /gateway/v1/models", "POST /gateway/v1/images/generations"]).flat(),
  );
});

test("image responses reject malformed base64, unsupported bytes and URL-only results without downloads or artifacts", async (t) => {
  let result: unknown;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      res.end(JSON.stringify(req.method === "GET" ? catalog : result));
    }),
  });
  const ctx = context(await home(t));
  for (const value of [
    null,
    {},
    { data: [] },
    { data: [null] },
    { data: [{ url: "https://must-not-contact.example/image" }] },
    { data: [{ b64_json: "" }] },
    { data: [{ b64_json: "!!!!" }] },
    { data: [{ b64_json: "aGVsbG8=" }] },
    { data: [{ b64_json: png }, { b64_json: png }] },
  ]) {
    result = value;
    await assert.rejects(generateImage(config, { model: imageModel, prompt: "fixture" }, ctx), /CLIProxyAPI/);
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("native video submission preserves the preview ID and polls once for pending, done, failed, expired and moderation failures", async (t) => {
  let response: unknown = { status: "pending" };
  const requests: string[] = [];
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      if (req.url === "/gateway/v1/models") return void res.end(JSON.stringify(catalog));
      if (req.method === "POST") {
        void body(req).then((value) => {
          assert.deepEqual(value, { model: videoModel, prompt: "fixture", duration: 1 });
          res.end(JSON.stringify({ request_id: "video_fixture-1" }));
        });
        return;
      }
      assert.equal(req.url, "/gateway/v1/videos/video_fixture-1");
      res.end(JSON.stringify(response));
    })}/gateway`,
  });
  const ctx = context(await home(t));
  const submitted = await generateVideo(config, { model: videoModel, prompt: "fixture", duration: 1 }, ctx);
  assert.deepEqual(submitted, { model: videoModel, request_id: "video_fixture-1", status: "pending" });
  assert.equal((await videoStatus(config, submitted.request_id, ctx)).status, "pending");
  response = {
    status: "done",
    video: { url: "https://media.example/video.mp4?token=fixture", respect_moderation: true },
  };
  assert.deepEqual(await videoStatus(config, submitted.request_id, ctx), {
    request_id: submitted.request_id,
    status: "completed",
    upstream_status: "done",
    url: "https://media.example/video.mp4?token=fixture",
  });
  for (const status of ["failed", "expired"]) {
    response = { status, error: { message: key } };
    const result = await videoStatus(config, submitted.request_id, ctx);
    assert.equal(result.status, "failed");
    assert.equal(result.upstream_status, status);
    assert.ok(!JSON.stringify(result).includes(key));
  }
  response = {
    status: "done",
    video: { url: "https://media.example/blocked.mp4", respect_moderation: false },
  };
  const blocked = await videoStatus(config, submitted.request_id, ctx);
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.url, undefined);
  assert.deepEqual(requests, [
    "GET /gateway/v1/models",
    "POST /gateway/v1/videos",
    ...Array(5).fill("GET /gateway/v1/videos/video_fixture-1"),
  ]);
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("video rejects invalid IDs, submission responses, unknown states and unsafe final URLs", async (t) => {
  let response: unknown = {};
  let requests = 0;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      requests++;
      res.end(JSON.stringify(req.url === "/v1/models" ? catalog : response));
    }),
  });
  const ctx = context(await home(t));
  for (const id of ["", "..", "a/b", "a?key=secret", "https://elsewhere", "bad\nvalue"]) {
    await assert.rejects(videoStatus(config, id, ctx), /valid request_id/);
  }
  assert.equal(requests, 0);
  for (const value of [null, {}, { request_id: "../models" }]) {
    response = value;
    await assert.rejects(generateVideo(config, { model: videoModel, prompt: "fixture" }, ctx), /CLIProxyAPI/);
  }
  for (const value of [
    null,
    {},
    { status: "future" },
    { status: "done" },
    { status: "done", video: {} },
    { status: "done", video: { url: "https://media.example/video.mp4", respect_moderation: "false" } },
    ...[
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:secret@example.com/video",
      "not a url",
    ].map((url) => ({ status: "done", video: { url } })),
  ]) {
    response = value;
    await assert.rejects(videoStatus(config, "fixture", ctx), /CLIProxyAPI/);
  }
});

test("media HTTP failures suppress upstream bodies, block redirects, bound responses and never retry POSTs", async (t) => {
  let mode = "http";
  let posts = 0;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.url === "/v1/models") return void res.end(JSON.stringify(catalog));
      if (req.method === "POST") posts++;
      if (mode === "http") res.writeHead(401).end(key);
      else if (mode === "redirect")
        res.writeHead(307, { location: "https://must-not-contact.example" }).end();
      else if (mode === "oversized")
        res.end("x".repeat(req.url === "/v1/images/generations" ? 32 * 1024 * 1024 + 1 : 64 * 1024 + 1));
      else res.end(`invalid-json-${key}`);
    }),
  });
  const ctx = context(await home(t));
  for (const nextMode of ["http", "redirect", "malformed", "oversized"]) {
    mode = nextMode;
    for (const operation of [
      () => generateImage(config, { model: imageModel, prompt: "fixture" }, ctx),
      () => generateVideo(config, { model: videoModel, prompt: "fixture" }, ctx),
      () => videoStatus(config, "fixture", ctx),
    ]) {
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key));
        if (mode === "http") assert.match(error.message, /HTTP 401/);
        if (mode === "redirect") assert.match(error.message, /redirect error/);
        return true;
      });
    }
  }
  assert.equal(posts, 8);
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("media cancellation bounds auth, discovery, submission and response-body waits", async (t) => {
  const ctx = context(await home(t));
  const config = parseConfig({});
  const noAuth = { ...ctx, modelRegistry: { getProviderAuth: async () => undefined } };
  await assert.rejects(listMediaModels(config, noAuth), /authentication failed/);
  const waitingAuth = { ...ctx, modelRegistry: { getProviderAuth: () => new Promise<never>(() => {}) } };
  await assert.rejects(
    listMediaModels(config, waitingAuth, AbortSignal.timeout(20)),
    /cancelled or timed out/,
  );
  await assert.rejects(listMediaModels(config, ctx, AbortSignal.abort()));
  for (const phase of ["catalog", "post", "body", "status"]) {
    const arrived = Promise.withResolvers<void>();
    let posts = 0;
    const config = parseConfig({
      baseUrl: await server(t, (req, res) => {
        if (req.method === "POST") posts++;
        if (req.url === "/v1/models" && phase !== "catalog") return void res.end(JSON.stringify(catalog));
        if (phase === "body") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"data":[');
        }
        arrived.resolve();
      }),
    });
    const controller = new AbortController();
    const running =
      phase === "status"
        ? videoStatus(config, "fixture", ctx, controller.signal)
        : generateImage(config, { model: imageModel, prompt: "fixture" }, ctx, controller.signal);
    const rejected = assert.rejects(running);
    await arrived.promise;
    controller.abort();
    await rejected;
    assert.equal(posts, phase === "catalog" || phase === "status" ? 0 : 1);
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("Pi loads and executes all four media tools with registry auth without chat selection or startup discovery", async (t) => {
  const requests: string[] = [];
  const baseUrl = await server(t, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (req.url === "/v1/models") res.end(JSON.stringify(catalog));
    else if (req.url === "/v1/images/generations") res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    else if (req.url === "/v1/videos") res.end(JSON.stringify({ request_id: "fixture" }));
    else if (req.url === "/v1/videos/fixture")
      res.end(
        JSON.stringify({
          status: "done",
          video: { url: "https://media.example/video.mp4", respect_moderation: true },
        }),
      );
    else assert.fail(`Unexpected route: ${req.url}`);
  });
  const cwd = await home(t);
  const agentImport = pathToFileURL(
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  ).href;
  const aiImport = pathToFileURL(resolve("node_modules/@earendil-works/pi-ai/dist/index.js")).href;
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const { DefaultResourceLoader, ModelRuntime, ModelRegistry } = await import(${JSON.stringify(agentImport)});
    const { InMemoryCredentialStore } = await import(${JSON.stringify(aiImport)});
    const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), noExtensions: true, noSkills: true, noContextFiles: true, additionalExtensionPaths: [${JSON.stringify(resolve("extensions/index.ts"))}] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 1);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('cliproxyapi', async () => ({ type: 'api_key', key: ${JSON.stringify(key)} }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
    for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations) {
      assert.deepEqual(provider.getModels(), []);
      runtime.registerNativeProvider(provider);
    }
    const tools = loaded.extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
    assert.deepEqual(tools.map(tool => tool.name), ['cliproxyapi_media_models', 'cliproxyapi_generate_image', 'cliproxyapi_generate_video', 'cliproxyapi_video_status']);
    const ctx = { cwd: process.cwd(), model: undefined, modelRegistry: new ModelRegistry(runtime) };
    const call = (index, params) => tools[index].execute('fixture', params, AbortSignal.timeout(5000), undefined, ctx);
    const listed = await call(0, {});
    assert.equal(listed.details.models.length, 6);
    const image = await call(1, { model: ${JSON.stringify(imageModel)}, prompt: 'fixture' });
    assert.equal(image.details.files[0].mimeType, 'image/png');
    const video = await call(2, { model: ${JSON.stringify(videoModel)}, prompt: 'fixture', duration: 1 });
    assert.equal(video.details.request_id, 'fixture');
    const status = await call(3, { request_id: video.details.request_id });
    assert.equal(status.details.status, 'completed');
    assert.equal(ctx.model, undefined);
    assert.deepEqual(ctx.modelRegistry.getAll().filter(model => model.provider === 'cliproxyapi'), []);
  `,
    ],
    {
      cwd,
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        PI_CODING_AGENT_DIR: cwd,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        CLIPROXYAPI_BASE_URL: baseUrl,
      },
    },
  );
  assert.deepEqual(requests, [
    "GET /v1/models",
    "GET /v1/models",
    "POST /v1/images/generations",
    "GET /v1/models",
    "POST /v1/videos",
    "GET /v1/videos/fixture",
  ]);
});
