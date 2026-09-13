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
import { MEDIA_DEFAULTS_ENTRY, readMediaDefaults, resolveMediaModel } from "../src/media-defaults.ts";
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
  assert.equal(rows[0].name, "Nano Banana 2 (Gemini 3.1 Flash Image)");
  assert.equal(rows[0].owner, "antigravity");
  assert.equal(rows[0].purpose, "image");
  assert.equal(rows[1].name, "Grok Imagine Video");
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
    assert.deepEqual(readMediaDefaults(config, ctx), {});
    assert.throws(() => resolveMediaModel(config, ctx, "image"), /No image default/);
  }
  sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 2,
    endpoint: config.baseUrl,
    defaults: { image },
  });
  assert.deepEqual(readMediaDefaults(config, ctx), {});
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
