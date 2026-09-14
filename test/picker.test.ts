import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { isRecord, parseConfig } from "../src/config.ts";
import {
  automaticImageDefault,
  effectiveMediaDefaults,
  MEDIA_DEFAULTS_ENTRY,
  OPENAI_IMAGE_DEFAULT,
  readMediaDefaults,
  resolveMediaModel,
} from "../src/media-defaults.ts";
import { ModelPicker, pickerCatalog, registerModelPicker, searchPickerItems } from "../src/picker.ts";
import { builtinCatalog } from "../src/provider.ts";

const image = "gemini-3.1-flash-image";
const video = "grok-imagine-video";
const chat = builtinCatalog()[0];
const catalog = {
  data: [
    { id: image, owned_by: "antigravity" },
    { id: video, owned_by: "xai" },
    { id: chat.id, owned_by: chat.provider },
    { id: "unknown-image", owned_by: "team" },
    { id: "gemini-3.1-flash-lite-image", visibility: "hide" },
  ],
};
const theme = { fg: (_color: string, text: string) => text } as ExtensionContext["ui"]["theme"];

test("picker catalog labels verified purposes, friendly names and owners without guessing unknowns", () => {
  const rows = pickerCatalog(catalog, parseConfig({}));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, "Nano Banana 2 · Automatic (proxy routing)");
  assert.equal(rows[0].owner, "antigravity");
  assert.equal(rows[0].purpose, "image");
  assert.equal(rows[1].name, "Grok Imagine Video · Automatic (proxy routing)");
  assert.equal(rows[2].purpose, "chat");
  assert.equal(rows[3].purpose, "unknown / unsupported");
  assert.equal(rows[3].supported, false);
  const items = rows.map((row) => ({
    value: row.id,
    label: row.name,
    description: `${row.owner} ${row.purpose}`,
    supported: row.supported,
  }));
  for (const query of ["nano", "BANANA", "flash-image", "antigravity image", "nano banana 2"])
    assert.deepEqual(
      searchPickerItems(items, query).map((item) => item.value),
      [image],
    );
  assert.equal(searchPickerItems(items, "team unsupported")[0].value, "unknown-image");
  assert.deepEqual(searchPickerItems(items, "veo"), []);
});

test("retired Imagen rows remain visible with reasons but cannot be selected or restored as defaults", async (t) => {
  const ids = [
    "imagen-3.0-generate-002",
    "imagen-3.0-fast-generate-001",
    "imagen-4.0-generate-001",
    "imagen-4.0-fast-generate-001",
    "imagen-4.0-ultra-generate-001",
  ].flatMap((id) => [id, `vertex/${id}`, `antigravity/${id}`]);
  const advertised = { data: [...catalog.data, ...ids.map((id) => ({ id, owned_by: "google" }))] };
  const config = parseConfig({});
  const rows = pickerCatalog(advertised, config).filter((row) => ids.includes(row.id));
  assert.equal(rows.length, ids.length);
  for (const row of rows) {
    assert.match(row.name, /^Imagen [34]/);
    assert.equal(row.purpose, "image");
    assert.equal(row.supported, false);
    assert.match(row.disabledReason ?? "", /Retired on Vertex.*Nano Banana/);
    assert.equal(row.model, undefined);
  }
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    assert.equal(init?.method, undefined);
    requests++;
    return new Response(JSON.stringify(advertised));
  });
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const notifications: string[] = [];
  const pi: Pick<ExtensionAPI, "on" | "registerCommand" | "appendEntry" | "setModel"> = {
    on() {},
    registerCommand(_name, options) {
      command = options;
    },
    appendEntry() {
      assert.fail("Retired selection must not save defaults");
    },
    async setModel() {
      assert.fail("Retired selection must not change chat");
    },
  };
  const ctx = {
    mode: "rpc",
    hasUI: true,
    sessionManager: SessionManager.inMemory(),
    ui: { notify: (text: string) => notifications.push(text), custom: async () => ids[0] },
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "fixture" } }) },
  } as unknown as ExtensionCommandContext;
  registerModelPicker(pi as ExtensionAPI, config);
  assert.ok(command);
  await command.handler("search imagen", ctx);
  for (const id of ids) assert.ok(notifications.at(-1)?.includes(id));
  assert.match(notifications.at(-1) ?? "", /Retired on Vertex.*Nano Banana/);
  for (const id of ids) {
    await command.handler(`select ${id}`, ctx);
    assert.match(notifications.at(-1) ?? "", /Retired on Vertex.*Nano Banana/);
    assert.deepEqual(
      readMediaDefaults(config, {
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: MEDIA_DEFAULTS_ENTRY,
              id: "fixture",
              parentId: null,
              timestamp: "fixture",
              data: { version: 1, endpoint: config.baseUrl, defaults: { image: id, video } },
            },
          ],
        },
      }),
      { image: null, video },
    );
  }
  assert.equal(requests, 1);
  await command.handler("", { ...ctx, mode: "tui" });
  assert.equal(requests, 2);
  assert.match(notifications.at(-1) ?? "", /unsupported/);
  assert.deepEqual(ctx.sessionManager.getBranch(), []);
});

test("ModelPicker handles search, injected keys, paging, unsupported selection, cancel, IME focus and bounded resizing", () => {
  const items = [
    { value: "unknown", label: "Unsupported", description: "unknown / unsupported", supported: false },
    { value: image, label: "Nano Banana 2", description: "antigravity image", supported: true },
    ...Array.from({ length: 40 }, (_, i) => ({
      value: `video-${i}`,
      label: `Video ${i}`,
      description: "xai video",
      supported: true,
    })),
  ];
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+y",
  });
  const selections: (string | undefined)[] = [];
  let height = 14;
  let renders = 0;
  const picker = new ModelPicker(
    items,
    "",
    "Image: none | Video: none",
    theme,
    kb,
    () => height,
    () => renders++,
    (value) => selections.push(value),
  );
  picker.focused = true;
  assert.ok(picker.render(80).join("\n").includes(CURSOR_MARKER));
  picker.handleInput("\x19");
  assert.equal(selections.length, 0);
  picker.handleInput("\x0e");
  picker.handleInput("\x19");
  assert.equal(selections.length, 1);
  assert.equal(selections[0], image);
  picker.handleInput("banana");
  assert.match(picker.render(80).join("\n"), /Nano Banana/);
  picker.handleInput("\x19");
  assert.equal(selections.at(-1), image);
  picker.handleInput("zzz");
  picker.handleInput("\x19");
  assert.equal(selections.length, 2);
  picker.handleInput("\x1b");
  assert.equal(selections.at(-1), undefined);
  picker.focused = false;
  assert.ok(!picker.render(80).join("\n").includes(CURSOR_MARKER));
  for (const width of [0, 1, 10, 40, 80])
    for (const rows of [1, 5, 12, 30]) {
      height = rows;
      const lines = picker.render(width);
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  const paging = new ModelPicker(
    items,
    "video",
    "",
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => 14,
    () => {},
    (value) => selections.push(value),
  );
  paging.render(80);
  paging.handleInput("\x1b[6~");
  paging.handleInput("\r");
  assert.equal(selections.at(-1), "video-7");
  paging.handleInput("\x1b[5~");
  paging.handleInput("\r");
  assert.equal(selections.at(-1), "video-0");
  assert.ok(renders > 0);
});

test("Nano Banana backend labels remain visible in narrow picker rows", () => {
  const rows = pickerCatalog(
    { data: [{ id: "vertex/gemini-2.5-flash-image" }, { id: "antigravity/gemini-3.1-flash-image" }] },
    parseConfig({}),
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Nano Banana · Vertex", "Nano Banana 2 · Antigravity"],
  );
  const picker = new ModelPicker(
    rows.map((row) => ({
      value: row.id,
      label: `${row.name} (${row.id})`,
      description: row.purpose,
      supported: row.supported,
    })),
    "",
    "",
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => 14,
    () => {},
    () => {},
  );
  const lines = picker.render(40);
  assert.ok(lines.some((line) => line.startsWith("→ Nano Banana · Vertex")));
  assert.ok(lines.some((line) => line.startsWith("  Nano Banana 2 · Antigravity")));
});

test("ModelPicker ignores wheel and clicks so Enter always selects the keyboard-highlighted model", () => {
  const selections: (string | undefined)[] = [];
  const picker = new ModelPicker(
    [image, video].map((value) => ({ value, label: value, description: "supported", supported: true })),
    "",
    "",
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => 14,
    () => {},
    (value) => selections.push(value),
  );
  for (const expected of [image, video]) {
    const before = picker.render(100);
    assert.match(before[0], /keyboard only/);
    assert.ok(before.some((line) => line.startsWith(`→ ${expected}`)));
    for (const type of ["wheel", "press", "click"] as const) {
      for (let y = 0; y < before.length; y++) {
        picker.handleMouse({
          type,
          button: type === "wheel" ? "none" : "left",
          x: 3,
          y,
          screenX: 3,
          screenY: y,
          width: 100,
          height: 14,
          shift: false,
          alt: false,
          ctrl: false,
          wheelDelta: type === "wheel" ? 1 : undefined,
        });
        assert.deepEqual(picker.render(100), before);
        picker.handleInput("\r");
        assert.equal(selections.at(-1), expected);
      }
    }
    picker.handleInput("\x1b[B");
  }
});

test("defaults restore only current branch and endpoint, survive reload/fork and never bleed into a new session", () => {
  const config = parseConfig({});
  const sessionManager = SessionManager.inMemory();
  const ctx = { sessionManager };
  const first = sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: { image },
  });
  const second = sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: { image, video },
  });
  assert.deepEqual(readMediaDefaults(config, ctx), { image, video });
  sessionManager.branch(first);
  assert.deepEqual(readMediaDefaults(config, ctx), { image });
  sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: {},
  });
  assert.deepEqual(readMediaDefaults(config, ctx), {});
  sessionManager.branch(second);
  const header = sessionManager.getHeader();
  assert.ok(header);
  const restored = SessionManager.inMemory(undefined, undefined, [header, ...sessionManager.getBranch()]);
  const forked = SessionManager.inMemory(undefined, undefined, [header, ...sessionManager.getBranch(first)]);
  assert.deepEqual(readMediaDefaults(config, { sessionManager: restored }), { image, video });
  assert.deepEqual(readMediaDefaults(config, { sessionManager: forked }), { image });
  assert.deepEqual(readMediaDefaults(parseConfig({ baseUrl: "https://other.example" }), ctx), {});
  assert.deepEqual(readMediaDefaults(config, { sessionManager: SessionManager.inMemory() }), {});
  for (const defaults of [
    null,
    [],
    { image: video, video: image },
    { image: "bad\nvalue" },
    { image: "unknown-image" },
  ]) {
    sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
      version: 1,
      endpoint: config.baseUrl,
      defaults,
    });
    assert.deepEqual(
      readMediaDefaults(config, ctx),
      defaults === null || Array.isArray(defaults) || "video" in defaults
        ? { image: null, video: null }
        : { image: null },
    );
    assert.throws(() => resolveMediaModel(config, ctx, "image"), /No image default/);
  }
  sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 2,
    endpoint: config.baseUrl,
    defaults: { image },
  });
  assert.deepEqual(readMediaDefaults(config, ctx), { image: null, video: null });
});

test("picker listing and selection do only GETs, chat uses setModel, and lifecycle restoration reads the branch", async (t) => {
  let gets = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal(url, "http://localhost:8317/v1/models");
    assert.equal(init?.method, undefined);
    gets++;
    return new Response(JSON.stringify(catalog));
  });
  const config = parseConfig({});
  const sessionManager = SessionManager.inMemory();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const selected: Model<Api>[] = [];
  const notifications: string[] = [];
  t.mock.method(console, "error", (text: string) => notifications.push(text));
  const statuses: string[] = [];
  const pi = {
    registerCommand(name, options) {
      assert.equal(name, "cli:model");
      command = options;
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      hooks.set(event, handler);
    },
    appendEntry(type, data) {
      sessionManager.appendCustomEntry(type, data);
    },
    async setModel(model) {
      selected.push(model);
      return true;
    },
    sendMessage(message, options) {
      assert.equal(options?.triggerTurn, false);
      notifications.push(String(message.content));
    },
  } as ExtensionAPI;
  const registryModel = {
    ...pickerCatalog(catalog, config)[2].model,
    name: "Registry override",
    contextWindow: 42,
  } as Model<Api>;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    sessionManager,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text: string) => statuses.push(text),
      custom: () => assert.fail("RPC must not open a TUI"),
    },
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "fixture" } }),
      find: () => registryModel,
      refresh: () => assert.fail("Existing registry models need no refresh"),
    },
  } as unknown as ExtensionCommandContext;
  registerModelPicker(pi, config);
  assert.equal(gets, 0);
  assert.ok(command);
  await command.handler("", ctx);
  assert.match(notifications.at(-1) ?? "", /Nano Banana.*antigravity.*image/);
  assert.match(notifications.at(-1) ?? "", /unknown \/ unsupported/);
  assert.deepEqual(readMediaDefaults(config, ctx), {});
  await command.handler(`select ${image}`, ctx);
  const imageLeaf = sessionManager.getLeafId();
  assert.ok(imageLeaf);
  await command.handler(`select ${video}`, ctx);
  assert.deepEqual(readMediaDefaults(config, ctx), { image, video });
  assert.equal(selected.length, 0);
  await command.handler(`select ${chat.id}`, ctx);
  assert.equal(selected[0], registryModel);
  let published = false;
  let refreshes = 0;
  t.mock.method(ctx.modelRegistry, "find", () => (published ? registryModel : undefined));
  t.mock.method(
    ctx.modelRegistry,
    "refresh",
    async (options: { providers: string[]; force: boolean; signal: AbortSignal }) => {
      assert.deepEqual(options.providers, ["cliproxyapi"]);
      assert.equal(options.force, true);
      assert.ok(options.signal instanceof AbortSignal);
      refreshes++;
      published = true;
      return { errors: new Map(), aborted: false };
    },
  );
  await command.handler(`select ${chat.id}`, ctx);
  assert.equal(refreshes, 1);
  assert.equal(selected[1], registryModel);
  await command.handler("select unknown-image", ctx);
  assert.match(notifications.at(-1) ?? "", /unsupported/);
  assert.equal(selected.length, 2);
  await command.handler("clear image", ctx);
  assert.deepEqual(readMediaDefaults(config, ctx), { video });
  sessionManager.branch(imageLeaf);
  hooks.get("session_tree")?.({}, ctx);
  assert.match(statuses.at(-1) ?? "", /Video: none/);
  hooks.get("session_start")?.({ reason: "reload" }, ctx);
  assert.match(statuses.at(-1) ?? "", /Image: gemini-3.1-flash-image/);
  for (const mode of ["print", "json"] as const) {
    await command.handler("search banana", { ...ctx, mode, hasUI: false });
    assert.match(notifications.at(-1) ?? "", /Nano Banana/);
  }
  assert.equal(gets, 8);
});

test("chat refresh gets a fresh deadline after browsing and retains caller cancellation", async (t) => {
  const deadlines: { milliseconds: number; controller: AbortController }[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(catalog)));
  for (const cancellation of ["none", "browsing", "refresh"] as const) {
    const caller = new AbortController();
    const selected: Model<Api>[] = [];
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    let refreshSignal: AbortSignal | undefined;
    let discoveryDeadlineCount = 0;
    let published = false;
    const pi: Pick<ExtensionAPI, "on" | "registerCommand" | "setModel"> = {
      on() {},
      registerCommand(_name, options) {
        command = options;
      },
      async setModel(model) {
        selected.push(model);
        return true;
      },
    };
    const ctx = {
      mode: "tui",
      hasUI: true,
      signal: caller.signal,
      sessionManager: SessionManager.inMemory(),
      ui: {
        notify() {},
        async custom() {
          discoveryDeadlineCount = deadlines.length;
          for (const deadline of deadlines) deadline.controller.abort();
          if (cancellation === "browsing") caller.abort();
          return chat.id;
        },
      },
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: "fixture" } }),
        find: () => (published ? chat : undefined),
        async refresh(options: { signal: AbortSignal }) {
          refreshSignal = options.signal;
          if (cancellation === "refresh") caller.abort();
          published = !options.signal.aborted;
          return { errors: new Map(), aborted: options.signal.aborted };
        },
      },
    } as unknown as ExtensionCommandContext;
    registerModelPicker(pi as ExtensionAPI, parseConfig({}));
    assert.ok(command);
    await command.handler("", ctx);
    assert.equal(deadlines.length, discoveryDeadlineCount + 1);
    assert.equal(deadlines.at(-1)?.milliseconds, 15000);
    assert.ok(refreshSignal);
    assert.equal(refreshSignal.aborted, cancellation !== "none");
    assert.equal(selected.length, cancellation === "none" ? 1 : 0);
    if (cancellation === "none") assert.equal(selected[0], chat);
  }
});

test("Pi loads and dispatches the colon command in RPC, print and JSON without inference or generation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-picker-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v1/models");
    res.end(JSON.stringify(catalog));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(join(cwd, "settings.json"), JSON.stringify({ packages: [resolve(".")] }));
  await writeFile(
    join(cwd, "models.json"),
    JSON.stringify({
      providers: {
        fixture: { baseUrl, api: "openai-completions", apiKey: "fixture", models: [{ id: "bootstrap" }] },
      },
    }),
  );
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const options = {
    cwd,
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      PI_CODING_AGENT_DIR: cwd,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      CLIPROXYAPI_BASE_URL: baseUrl,
      CLIPROXYAPI_API_KEY: "fixture",
    },
  };
  const rpc = spawn(
    process.execPath,
    [cli, "--mode", "rpc", "--no-session", "--model", "fixture/bootstrap"],
    options,
  );
  const closed = once(rpc, "close");
  let diagnostics = "";
  rpc.stderr.setEncoding("utf8").on("data", (chunk) => {
    diagnostics += chunk;
  });
  let buffer = "";
  const replies = new Map<string, ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>>();
  const notifications: string[] = [];
  rpc.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const event: unknown = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!isRecord(event)) continue;
      if (event.method === "notify" && typeof event.message === "string") notifications.push(event.message);
      if (event.type === "response" && typeof event.id === "string") replies.get(event.id)?.resolve(event);
    }
  });
  const call = async (id: string, payload: object) => {
    const reply = Promise.withResolvers<Record<string, unknown>>();
    replies.set(id, reply);
    rpc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    const result = await Promise.race([
      reply.promise,
      closed.then(() => {
        throw new Error(`RPC exited: ${diagnostics}`);
      }),
    ]);
    assert.equal(result.success, true, JSON.stringify(result));
    return result;
  };
  try {
    const commands = await call("commands", { type: "get_commands" });
    assert.match(JSON.stringify(commands), /cli:model/);
    await call("list", { type: "prompt", message: "/cli:model search banana" });
    await call("image", { type: "prompt", message: `/cli:model select ${image}` });
    await call("video", { type: "prompt", message: `/cli:model select ${video}` });
    const state = await call("state", { type: "get_state" });
    assert.match(JSON.stringify(state), /bootstrap/);
    await call("clear", { type: "prompt", message: "/cli:model clear image" });
    assert.ok(notifications.some((text) => text.includes("Nano Banana")));
    assert.ok(notifications.some((text) => text.includes(`Image: none | Video: ${video}`)));
    await call("chat", { type: "prompt", message: `/cli:model select ${chat.id}` });
    const chatState = await call("chat-state", { type: "get_state" });
    assert.ok(JSON.stringify(chatState).includes(chat.id));
    assert.match(JSON.stringify(chatState), /cliproxyapi/);
  } finally {
    rpc.kill();
    await closed;
  }
  for (const args of [["-p"], ["--mode", "json", "-p"]]) {
    const run = promisify(execFile)(
      process.execPath,
      [cli, "--offline", "--no-session", "--model", "fixture/bootstrap", ...args, "/cli:model search banana"],
      options,
    );
    run.child.stdin?.end();
    const { stdout, stderr } = await run;
    if (args.includes("json")) {
      const events = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.match(JSON.stringify(events), /Nano Banana/);
      assert.ok(!stderr.includes("Nano Banana"));
    } else {
      assert.equal(stdout, "");
      assert.match(stderr, /Nano Banana/);
    }
    assert.ok(!stderr.includes("Failed to load extension"), stderr);
  }
  const cached = await promisify(execFile)(
    process.execPath,
    [cli, "--offline", "--list-models", "cliproxyapi"],
    options,
  );
  assert.ok(cached.stdout.includes(chat.id), cached.stderr);
  assert.ok(!cached.stdout.includes(image));
  assert.ok(!cached.stdout.includes(video));
  assert.equal(requests.length, 7);
});

test("picker labels backend routes across every purpose, selects exact effective chat IDs and restores qualified defaults", async (t) => {
  const config = parseConfig({});
  const ids = [chat.id, image, video, "future-model"].flatMap((id) => [
    id,
    `vertex/${id}`,
    `antigravity/${id}`,
  ]);
  let advertised = [...ids, `custom/${image}`];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    assert.equal(init?.method, undefined);
    return new Response(JSON.stringify({ data: advertised.map((id) => ({ id, owned_by: "google" })) }));
  });
  const rows = pickerCatalog({ data: advertised.map((id) => ({ id, owned_by: "google" })) }, config);
  assert.deepEqual(
    rows.map((row) => row.id),
    advertised,
  );
  for (const row of rows) {
    const backend = row.id.startsWith("vertex/")
      ? "Vertex"
      : row.id.startsWith("antigravity/")
        ? "Antigravity"
        : row.id.startsWith("custom/")
          ? "Unknown backend"
          : "Automatic (proxy routing)";
    assert.equal(row.backend, backend);
    assert.ok(row.name.endsWith(` · ${backend}`));
    assert.equal(row.owner, "google");
    if (row.id.endsWith(video) && row.id.includes("/")) {
      assert.equal(row.purpose, "video");
      assert.equal(row.supported, false);
    }
  }
  const sessionManager = SessionManager.inMemory();
  const notifications: string[] = [];
  const statuses: string[] = [];
  const selected: Model<Api>[] = [];
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const registry = new Map(
    rows.flatMap((row) => (row.model ? [[row.id, { ...row.model, contextWindow: 42 }] as const] : [])),
  );
  let refreshes = 0;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      hooks.set(event, handler);
    },
    registerCommand(_name, options) {
      command = options;
    },
    appendEntry(type, data) {
      sessionManager.appendCustomEntry(type, data);
    },
    async setModel(model) {
      selected.push(model);
      return true;
    },
    sendMessage(message) {
      notifications.push(String(message.content));
    },
  } as ExtensionAPI;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    sessionManager,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text: string) => statuses.push(text),
    },
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "fixture" } }),
      find(provider: string, id: string) {
        assert.equal(provider, "cliproxyapi");
        return registry.get(id);
      },
      async refresh() {
        refreshes++;
        return { errors: new Map(), aborted: false };
      },
    },
  } as unknown as ExtensionCommandContext;
  t.mock.method(console, "error", (text: string) => notifications.push(text));
  registerModelPicker(pi, config);
  assert.ok(command);
  for (const mode of ["rpc", "print", "json"] as const) {
    await command.handler("list", { ...ctx, mode, hasUI: mode === "rpc" });
    for (const label of [
      "Vertex",
      "Antigravity",
      "Automatic (proxy routing)",
      "Unknown backend",
      "unknown / unsupported",
    ])
      assert.ok(notifications.at(-1)?.includes(label));
    await command.handler("search antigravity banana", { ...ctx, mode, hasUI: mode === "rpc" });
    assert.ok(notifications.at(-1)?.includes(`antigravity/${image}`));
    assert.ok(!notifications.at(-1)?.includes(`vertex/${image}`));
  }
  for (const prefix of ["vertex", "antigravity"]) {
    const id = `${prefix}/${chat.id}`;
    await command.handler(`select ${id}`, ctx);
    assert.equal(selected.at(-1), registry.get(id));
  }
  await command.handler(`select vertex/${image}`, ctx);
  assert.equal(selected.length, 2);
  const header = sessionManager.getHeader();
  assert.ok(header);
  const restored = SessionManager.inMemory(undefined, undefined, [header, ...sessionManager.getBranch()]);
  assert.deepEqual(readMediaDefaults(config, { sessionManager: restored }), { image: `vertex/${image}` });
  for (const hook of ["session_start", "session_tree"]) {
    hooks.get(hook)?.({}, { ...ctx, sessionManager: restored });
    assert.ok(statuses.at(-1)?.includes(`vertex/${image} · Vertex`));
  }
  registry.delete(`vertex/${chat.id}`);
  await command.handler(`select vertex/${chat.id}`, ctx);
  assert.equal(refreshes, 1);
  assert.equal(selected.length, 2);
  advertised = advertised.filter((id) => id !== `vertex/${chat.id}` && id !== `antigravity/${image}`);
  await command.handler(`select vertex/${chat.id}`, ctx);
  await command.handler(`select antigravity/${image}`, ctx);
  assert.equal(selected.length, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(readMediaDefaults(config, ctx), { image: `vertex/${image}` });
});

test("automatic image default detects OpenAI/GPT families and explicit metadata aliases, not compatible APIs", () => {
  const config = parseConfig({
    aliases: {
      "team-chat": "openai-codex/gpt-5",
      "gpt-alias": "anthropic/claude-fixture",
      "vertex/team-chat": "google/gemini-fixture",
    },
  });
  for (const [provider, id] of [
    ["openai", "o3"],
    ["openai-codex", "codex-fixture"],
    ["cliproxyapi", "gpt-5"],
    ["other", "gpt-5.4"],
    ["other", "openai/gpt-5"],
    ["other", "chatgpt-4o-latest"],
    ["other", "o3-mini"],
    ["cliproxyapi", "vertex/gpt-5"],
    ["cliproxyapi", "team-chat"],
    ["cliproxyapi", "antigravity/team-chat"],
  ]) {
    const ctx = { model: { ...chat, provider, id } };
    assert.equal(automaticImageDefault(config, ctx), OPENAI_IMAGE_DEFAULT, `${provider}/${id}`);
    assert.equal(resolveMediaModel(config, ctx, "image"), OPENAI_IMAGE_DEFAULT);
    assert.throws(() => resolveMediaModel(config, ctx, "video"), /No video default/);
    assert.deepEqual(readMediaDefaults(config, ctx), {});
  }
  for (const id of [
    "claude-fixture",
    "gemini-fixture",
    "llama-4",
    "grok-4",
    "deepseek",
    "unknown",
    "custom/gpt-5",
    "gpt-image-2.5",
  ]) {
    for (const api of ["openai-completions", "openai-responses"] as const) {
      const ctx = { model: { ...chat, provider: "other", id, api } };
      assert.equal(automaticImageDefault(config, ctx), undefined, id);
      assert.throws(() => resolveMediaModel(config, ctx, "image"), /No image default/);
    }
  }
  for (const id of ["gpt-alias", "vertex/team-chat"])
    assert.equal(
      automaticImageDefault(config, { model: { ...chat, provider: "cliproxyapi", id } }),
      undefined,
    );
  assert.equal(automaticImageDefault(config, {}), undefined);
});

test("effective defaults preserve invalid selection barriers, explicit precedence, endpoint and branch isolation", () => {
  const config = parseConfig({});
  const sessionManager = SessionManager.inMemory();
  const ctx = { sessionManager, model: { ...chat, provider: "openai-codex" } };
  const save = (defaults: unknown, version = 1) =>
    sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, { version, endpoint: config.baseUrl, defaults });
  const empty = save({});
  assert.equal(resolveMediaModel(config, ctx, "image"), OPENAI_IMAGE_DEFAULT);
  const explicit = save({ image, video });
  assert.equal(resolveMediaModel(config, ctx, "image"), image);
  assert.equal(resolveMediaModel(config, ctx, "image", "gpt-image-2.5"), "gpt-image-2.5");
  assert.throws(() => resolveMediaModel(config, ctx, "image", ""), /supported image model/);
  for (const defaults of [
    null,
    [],
    { image: null },
    { image: 42 },
    { image: "bad\nvalue" },
    { image: video },
    { image: "missing-image" },
    { image: "imagen-4.0-generate-001" },
    { image: "vertex/gpt-image-2.5" },
  ]) {
    save(defaults);
    assert.equal(effectiveMediaDefaults(config, ctx).automatic, undefined);
    assert.throws(() => resolveMediaModel(config, ctx, "image"), /No image default/);
    assert.equal(resolveMediaModel(config, ctx, "image", "gpt-image-2.5-flare"), "gpt-image-2.5-flare");
  }
  save({}, 2);
  assert.throws(() => resolveMediaModel(config, ctx, "image"), /No image default/);
  sessionManager.branch(explicit);
  assert.equal(resolveMediaModel(config, ctx, "image"), image);
  assert.equal(
    resolveMediaModel(parseConfig({ baseUrl: "https://other.example" }), ctx, "image"),
    OPENAI_IMAGE_DEFAULT,
  );
  sessionManager.branch(empty);
  assert.equal(resolveMediaModel(config, ctx, "image"), OPENAI_IMAGE_DEFAULT);
  assert.deepEqual(effectiveMediaDefaults(config, { ...ctx, model: chat }).defaults, {});
  const header = sessionManager.getHeader();
  assert.ok(header);
  const forked = SessionManager.inMemory(undefined, undefined, [
    header,
    ...sessionManager.getBranch(explicit),
  ]);
  assert.equal(resolveMediaModel(config, { ...ctx, sessionManager: forked }, "image"), image);
});

test("picker, listings and lifecycle status show derived defaults without generation or unrelated persistence", async (t) => {
  const config = parseConfig({});
  const sessionManager = SessionManager.inMemory();
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const output: string[] = [];
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let gets = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    assert.equal(init?.method, undefined, "Selection must not generate");
    gets++;
    return Response.json({ data: [...catalog.data, { id: OPENAI_IMAGE_DEFAULT, owned_by: "openai" }] });
  });
  t.mock.method(console, "error", (text: string) => output.push(text));
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      hooks.set(event, handler);
    },
    registerCommand(_name, options) {
      command = options;
    },
    appendEntry(type, data) {
      sessionManager.appendCustomEntry(type, data);
    },
    sendMessage(message, options) {
      assert.equal(options?.triggerTurn, false);
      output.push(String(message.content));
    },
  } as ExtensionAPI;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: { ...chat, provider: "openai-codex" },
    sessionManager,
    ui: {
      notify: (text: string) => output.push(text),
      setStatus: (_key: string, text: string) => output.push(text),
      async custom(factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) {
        const picker = await factory(
          { terminal: { rows: 14 }, requestRender() {} } as never,
          theme,
          new KeybindingsManager(TUI_KEYBINDINGS) as never,
          () => {},
        );
        const rendered = picker.render(200).join("\n");
        assert.match(rendered, /gpt-image-2.5-sunburst.*automatic default/);
        assert.match(rendered, /gpt-image-2.5-sunburst.*selected/);
        return undefined;
      },
    },
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "fixture" } }) },
  } as unknown as ExtensionCommandContext;
  registerModelPicker(pi, config);
  assert.ok(command);
  for (const hook of ["session_start", "session_tree"]) {
    hooks.get(hook)?.({}, ctx);
    assert.match(output.at(-1) ?? "", /gpt-image-2.5-sunburst.*automatic default/);
  }
  hooks.get("model_select")?.({ model: chat }, ctx);
  assert.match(output.at(-1) ?? "", /Image: none/);
  hooks.get("model_select")?.({ model: ctx.model }, { ...ctx, model: chat });
  assert.match(output.at(-1) ?? "", /automatic default/);
  assert.equal(gets, 0);
  assert.deepEqual(sessionManager.getBranch(), []);
  for (const mode of ["rpc", "json", "print"] as const) {
    await command.handler("list", { ...ctx, mode, hasUI: mode === "rpc" });
    assert.match(output.at(-1) ?? "", /gpt-image-2.5-sunburst.*automatic default/);
  }
  await command.handler("", { ...ctx, mode: "tui" });
  await command.handler(`select ${video}`, ctx);
  assert.deepEqual(readMediaDefaults(config, ctx), { video });
  await command.handler("clear video", ctx);
  assert.deepEqual(readMediaDefaults(config, ctx), {});
  await command.handler(`select ${image}`, ctx);
  assert.equal(effectiveMediaDefaults(config, ctx).automatic, undefined);
  await command.handler("clear image", ctx);
  assert.match(output.at(-1) ?? "", /automatic default/);
  sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: { image: "invalid" },
  });
  await command.handler(`select ${video}`, ctx);
  assert.deepEqual(readMediaDefaults(config, ctx), { image: null, video });
  assert.throws(() => resolveMediaModel(config, ctx, "image"), /No image default/);
  await command.handler("clear image", ctx);
  assert.equal(resolveMediaModel(config, ctx, "image"), OPENAI_IMAGE_DEFAULT);
  assert.deepEqual(effectiveMediaDefaults(config, { ...ctx, model: chat }).defaults, { video });
  assert.equal(gets, 7);
});
