import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  SelectList,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { mapCatalog, mediaCapability, parseCatalog } from "./catalog.ts";
import { type Config, PROVIDER_ID } from "./config.ts";
import { mediaKey } from "./media.ts";
import { MEDIA_DEFAULTS_ENTRY, type MediaDefaults, readMediaDefaults } from "./media-defaults.ts";
import { builtinCatalog, fetchCatalog } from "./provider.ts";

export function pickerCatalog(
  value: unknown,
  config: Config,
  known: readonly Model<Api>[] = builtinCatalog(),
) {
  const chat = new Map(mapCatalog(value, config, known).models.map((model) => [model.id, model]));
  const rows = new Map<
    string,
    {
      id: string;
      name: string;
      owner: string;
      purpose: string;
      model?: Model<Api>;
      supported: boolean;
      disabledReason?: string;
    }
  >();
  for (const entry of parseCatalog(value)) {
    if (entry.hidden || rows.has(entry.id)) continue;
    const media = mediaCapability(entry.id);
    const model = chat.get(entry.id);
    rows.set(entry.id, {
      id: entry.id,
      name: media?.name ?? model?.name ?? entry.id,
      owner: entry.owner ?? "unknown owner",
      purpose: media?.purpose ?? (model ? "chat" : "unknown / unsupported"),
      model,
      supported: !!(media || model) && !media?.disabledReason,
      disabledReason: media?.disabledReason,
    });
  }
  return [...rows.values()];
}

type PickerRow = ReturnType<typeof pickerCatalog>[number];
type PickerItem = { value: string; label: string; description: string; supported: boolean };

export function searchPickerItems(items: readonly PickerItem[], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter((item) =>
    terms.every((term) => `${item.label} ${item.value} ${item.description}`.toLowerCase().includes(term)),
  );
}

function defaultsLabel(defaults: MediaDefaults) {
  return `Image: ${defaults.image ?? "none"} | Video: ${defaults.video ?? "none"}`;
}

function pickerItems(rows: PickerRow[], defaults: MediaDefaults, chatId?: string) {
  return [
    ...rows.map((row) => ({
      value: row.id,
      label: `${row.name} (${row.id})`,
      description: `${row.owner} | ${row.purpose}${row.disabledReason ? ` | ${row.disabledReason}` : ""}${defaults.image === row.id || defaults.video === row.id || chatId === row.id ? " | selected" : ""}`,
      supported: row.supported,
    })),
    ...(["image", "video"] as const).map((purpose) => ({
      value: `clear ${purpose}`,
      label: `Clear ${purpose} default`,
      description: defaults[purpose] ?? "none",
      supported: true,
    })),
  ];
}

export class ModelPicker extends Container implements Focusable {
  private input = new Input({ prompt: "Search: ", placeholder: "name, ID, owner, chat/image/video" });
  private items: PickerItem[];
  private selected = 0;
  private list: SelectList;
  private visible = 1;
  private allItems: PickerItem[];
  private summary: string;
  private theme: ExtensionContext["ui"]["theme"];
  private kb: Pick<KeybindingsManager, "matches" | "getKeys">;
  private height: () => number;
  private rerender: () => void;
  private done: (value: string | undefined) => void;
  get focused() {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    allItems: PickerItem[],
    query: string,
    summary: string,
    theme: ExtensionContext["ui"]["theme"],
    kb: Pick<KeybindingsManager, "matches" | "getKeys">,
    height: () => number,
    rerender: () => void,
    done: (value: string | undefined) => void,
  ) {
    super();
    this.allItems = allItems;
    this.summary = summary;
    this.theme = theme;
    this.kb = kb;
    this.height = height;
    this.rerender = rerender;
    this.done = done;
    this.input.setValue(query);
    this.items = searchPickerItems(allItems, query);
    this.list = this.createList();
    this.addChild(this.input);
    this.addChild(this.list);
  }

  private createList() {
    const list = new SelectList(
      this.items,
      this.visible,
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
      { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 80 },
    );
    list.setSelectedIndex(this.selected);
    return list;
  }

  private rebuild() {
    this.removeChild(this.list);
    this.list = this.createList();
    this.addChild(this.list);
  }

  override handleMouse(_event: TuiMouseEvent) {
    return undefined;
  }

  handleInput(data: string) {
    if (this.kb.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.kb.matches(data, "tui.select.confirm")) {
      const item = this.items[this.selected];
      if (item?.supported) this.done(item.value);
      return;
    }
    if (this.kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (this.kb.matches(data, "tui.select.down"))
      this.selected = Math.min(this.items.length - 1, this.selected + 1);
    else if (this.kb.matches(data, "tui.select.pageUp"))
      this.selected = Math.max(0, this.selected - this.visible);
    else if (this.kb.matches(data, "tui.select.pageDown"))
      this.selected = Math.min(this.items.length - 1, this.selected + this.visible);
    else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (before !== this.input.getValue()) {
        this.items = searchPickerItems(this.allItems, this.input.getValue());
        this.selected = 0;
      }
    }
    this.rebuild();
    this.rerender();
  }

  override render(width: number) {
    const height = Math.max(1, this.height());
    const visible = Math.max(1, Math.min(10, height - 7));
    if (visible !== this.visible) {
      this.visible = visible;
      this.rebuild();
    }
    const item = this.items[this.selected];
    const hint = `${this.kb.getKeys("tui.select.confirm").join("/")} select | ${this.kb.getKeys("tui.select.cancel").join("/")} cancel`;
    return [
      this.theme.fg("accent", "CLIProxyAPI models (keyboard only; selection does not generate)"),
      this.summary,
      ...super.render(Math.max(4, width)),
      item ? `ID: ${item.value}` : "No matching models",
      item?.description ?? "",
      this.theme.fg("dim", hint),
    ]
      .slice(0, height)
      .map((line) => truncateToWidth(line, Math.max(0, width)));
  }
}

export function registerModelPicker(pi: ExtensionAPI, config: Config) {
  const status = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("cliproxyapi-media", defaultsLabel(readMediaDefaults(config, ctx)));
  };
  pi.on("session_start", (_event, ctx) => status(ctx));
  pi.on("session_tree", (_event, ctx) => status(ctx));

  pi.registerCommand("cli:model", {
    description: "Search CLIProxyAPI chat/image/video models; select a chat model or session media default",
    getArgumentCompletions: (prefix) =>
      ["list", "search ", "select ", "clear image", "clear video"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      const report = (content: string, error = false) => {
        if (ctx.hasUI) ctx.ui.notify(content, error ? "error" : "info");
        else if (ctx.mode === "print") console.error(content);
        else
          pi.sendMessage(
            { customType: "cliproxyapi-models", content, display: true },
            { triggerTurn: false },
          );
      };
      try {
        const input = args.trim();
        const clear = input === "clear image" ? "image" : input === "clear video" ? "video" : undefined;
        const save = (choice: string) => {
          const defaults = readMediaDefaults(config, ctx);
          if (choice === "clear image") delete defaults.image;
          else if (choice === "clear video") delete defaults.video;
          else {
            const capability = mediaCapability(choice);
            if (!capability || capability.disabledReason)
              throw new Error("Unsupported CLIProxyAPI media selection.");
            defaults[capability.purpose] = choice;
          }
          pi.appendEntry(MEDIA_DEFAULTS_ENTRY, { version: 1, endpoint: config.baseUrl, defaults });
          status(ctx);
          report(defaultsLabel(defaults));
        };
        if (clear) {
          save(`clear ${clear}`);
          return;
        }
        if (input.startsWith("clear")) throw new Error("Usage: /cli:model clear image|video");
        const disabledReason = input.startsWith("select ")
          ? mediaCapability(input.slice(7).trim())?.disabledReason
          : undefined;
        if (disabledReason) {
          report(disabledReason, true);
          return;
        }
        const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(15000)]);
        const key = await mediaKey(ctx, signal);
        const rows = pickerCatalog(await fetchCatalog(config, key, signal), config);
        const defaults = readMediaDefaults(config, ctx);
        const items = pickerItems(
          rows,
          defaults,
          ctx.model?.provider === PROVIDER_ID ? ctx.model.id : undefined,
        );
        const explicit = input.startsWith("select ") ? input.slice(7).trim() : undefined;
        const query = input === "list" ? "" : input.startsWith("search ") ? input.slice(7) : input;
        let choice = explicit;
        if (choice === undefined) {
          if (ctx.mode === "tui" && input !== "list") {
            choice = await ctx.ui.custom<string | undefined>(
              (tui, theme, kb, done) =>
                new ModelPicker(
                  items,
                  query,
                  defaultsLabel(defaults),
                  theme,
                  kb,
                  () => tui.terminal.rows,
                  () => tui.requestRender(),
                  done,
                ),
            );
          } else {
            const matches = searchPickerItems(items, query);
            report(
              [
                defaultsLabel(defaults),
                ...matches.slice(0, 100).map((item) => `${item.label} | ${item.description}`),
                ...(matches.length > 100
                  ? [`Showing 100 of ${matches.length}; narrow with /cli:model search <query>.`]
                  : []),
                "Use /cli:model select <exact ID> or /cli:model clear image|video. Selection does not generate.",
              ].join("\n"),
            );
            return;
          }
        }
        if (choice === undefined) return;
        if (choice === "clear image" || choice === "clear video") {
          save(choice);
          return;
        }
        const row = rows.find((row) => row.id === choice);
        if (!row?.supported)
          throw new Error("Model unavailable or unsupported. Use /cli:model to list supported IDs.");
        if (row.model) {
          let model = ctx.modelRegistry.find(PROVIDER_ID, row.id);
          if (!model) {
            const refreshed = await ctx.modelRegistry.refresh({
              providers: [PROVIDER_ID],
              force: true,
              signal: AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(15000)]),
            });
            if (refreshed.aborted || refreshed.errors.has(PROVIDER_ID))
              throw new Error("CLIProxyAPI chat refresh failed.");
            model = ctx.modelRegistry.find(PROVIDER_ID, row.id);
          }
          if (!model || !(await pi.setModel(model)))
            throw new Error("CLIProxyAPI chat selection failed. Check /login cliproxyapi.");
          report(`Chat: ${row.name} (${row.id})`);
        } else save(row.id);
      } catch {
        report(
          "CLIProxyAPI model selection failed: unavailable/unsupported model, invalid command, authentication, or connection error. Check /login cliproxyapi. Use /cli:model list, select <exact ID>, or clear image|video.",
          true,
        );
      }
    },
  });
}
