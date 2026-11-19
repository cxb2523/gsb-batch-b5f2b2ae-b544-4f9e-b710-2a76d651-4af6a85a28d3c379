// Pending-merge consistency. While a combine is in flight the workbench is frozen:
// no new merges, no drags, no undo/redo, no clear/tidy/spawn — so the layout, the undo
// stack and the persisted snapshot stay self-consistent. Failure restores the inputs
// exactly (no extra undo record); success records exactly one undoable step; only the
// stable layout ever reaches localStorage.
//
// Each test loads fresh modules over in-memory Web Storage, a hand-controlled combine
// transport and fake timers (the merge has a minimum pending beat + debounced persist).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CombineResponse, ElementDTO } from "../../../shared/api.ts";

type Mods = {
  api: typeof import("../../lib/api.ts");
  canvas: typeof import("../../state/canvas.ts");
  actions: typeof import("./actions.ts");
  drag: typeof import("./drag.ts");
  layout: typeof import("./layout.ts");
  game: typeof import("../../state/game.ts");
  ui: typeof import("../../state/ui.ts");
};

interface Call {
  path: string;
  body: { ids: string[] };
  reply(status: number, body: unknown): void;
  fail(): void;
}

let m: Mods;
let calls: Call[];
let localMap: Map<string, string>;
let sessionMap: Map<string, string>;

function memoryStorage(s: Map<string, string>): Storage {
  return {
    get length() {
      return s.size;
    },
    clear: () => s.clear(),
    getItem: (k) => s.get(k) ?? null,
    key: (i) => [...s.keys()][i] ?? null,
    removeItem: (k) => void s.delete(k),
    setItem: (k, v) => void s.set(k, String(v)),
  };
}

const fakeResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "", headers: new Headers(), json: async () => body }) as unknown as Response;

async function load(init: { local?: Record<string, string>; session?: Record<string, string> } = {}): Promise<void> {
  vi.useFakeTimers();
  vi.resetModules();
  calls = [];
  localMap = new Map(Object.entries(init.local ?? {}));
  sessionMap = new Map(Object.entries(init.session ?? {}));
  vi.stubGlobal("window", {
    localStorage: memoryStorage(localMap),
    sessionStorage: memoryStorage(sessionMap),
    addEventListener: () => {},
    removeEventListener: () => {},
    gtag: vi.fn(),
  });
  const api = await import("../../lib/api.ts");
  m = {
    api,
    canvas: await import("../../state/canvas.ts"),
    actions: await import("./actions.ts"),
    drag: await import("./drag.ts"),
    layout: await import("./layout.ts"),
    game: await import("../../state/game.ts"),
    ui: await import("../../state/ui.ts"),
  };
  api.setTransport(
    (path, req) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({
          path,
          body: JSON.parse(String(req.body)) as { ids: string[] },
          reply: (status, body) => resolve(fakeResponse(status, body)),
          fail: () => reject(new TypeError("Failed to fetch")),
        });
      }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function el(id: string): ElementDTO {
  return { id, name: `El${id}`, emoji: null, img: null, art: "missing", description: null, notable: false, depth: 2, rarity: "common", starter: false };
}

function boot(ids: string[]): void {
  m.game.useGame.setState({
    status: "ready",
    player: { id: "p1", createdAt: "", legacy: false },
    elements: Object.fromEntries(ids.map((id) => [id, el(id)])),
    owned: Object.fromEntries(ids.map((id) => [id, { discoveredAt: new Date().toISOString(), first: false }])),
  });
  m.canvas.setBounds({ w: 800, h: 600, left: 8, right: 8, top: 8, bottom: 8 }, 76, []);
}

function combineRes(id: string): CombineResponse {
  const e = el(id);
  return {
    result: e,
    newForPlayer: true,
    firstEver: false,
    recipeNew: true,
    completed: [],
    entry: { ...e, discoveredAt: new Date().toISOString(), first: false },
  };
}

/** Let timers (pending beat, persist debounce) run and promise chains settle. */
async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const st = () => m.canvas.useCanvas.getState();
const settled = () => st().tiles.filter(m.canvas.isSettled);
const settledIds = () => settled().map((t) => t.elementId).sort();
const combineCalls = () => calls.filter((c) => c.path === "/api/combine");
const persistedCanvas = () => JSON.parse(localMap.get("ia:canvas") ?? "null") as { w: number; h: number; tiles: { e: string; x: number; y: number }[] } | null;

describe("pending-merge consistency", () => {
  it("success: canvas settles to the result alone, one undo step restores the inputs", async () => {
    await load();
    boot(["1", "2", "3"]);
    const u1 = m.canvas.addTile({ elementId: "1", x: 100, y: 100 });
    const u2 = m.canvas.addTile({ elementId: "2", x: 200, y: 100 });
    const undoBefore = st().undo.length;

    const p = m.actions.mergeTiles([u1, u2], { x: 150, y: 100 });
    expect(m.canvas.mergePending()).toBe(true);
    expect(combineCalls()).toHaveLength(1);
    expect(combineCalls()[0]!.body.ids).toEqual(["1", "2"]);

    combineCalls()[0]!.reply(200, combineRes("3"));
    await tick(400);
    await p;

    // Only the result remains on the canvas; exactly one undo entry was recorded.
    expect(m.canvas.mergePending()).toBe(false);
    expect(settledIds()).toEqual(["3"]);
    expect(st().undo.length).toBe(undoBefore + 1);
    expect(st().undo.at(-1)).toEqual([
      { uid: u1, elementId: "1", x: 100, y: 100 },
      { uid: u2, elementId: "2", x: 200, y: 100 },
    ]);

    // Undo returns to the exact pre-merge layout; redo replays the merge.
    expect(m.canvas.undo()).toBe(true);
    expect(settledIds()).toEqual(["1", "2"]);
    const byId = new Map(settled().map((t) => [t.elementId, t]));
    expect([byId.get("1")!.x, byId.get("1")!.y]).toEqual([100, 100]);
    expect([byId.get("2")!.x, byId.get("2")!.y]).toEqual([200, 100]);
    expect(m.canvas.redo()).toBe(true);
    expect(settledIds()).toEqual(["3"]);
  });

  it("failure: inputs come back exactly where they were and the undo stack is untouched", async () => {
    await load();
    boot(["1", "2", "3"]);
    // A prior committed action, so the undo stack is non-empty when the merge starts.
    m.actions.dropNewTile("3", { x: 400, y: 400 }, { x: 0, y: 0 });
    const u1 = m.canvas.addTile({ elementId: "1", x: 100, y: 100 });
    const u2 = m.canvas.addTile({ elementId: "2", x: 200, y: 100 });
    const undoBefore = structuredClone(st().undo);
    expect(undoBefore.length).toBe(1);

    const p = m.actions.mergeTiles([u1, u2], { x: 150, y: 100 });
    expect(m.canvas.mergePending()).toBe(true);
    expect(st().undo.length).toBe(2); // the merge's own snapshot

    combineCalls()[0]!.reply(422, { error: "fizzled", message: "That mix fizzled." });
    await p;

    expect(m.canvas.mergePending()).toBe(false);
    expect(settledIds()).toEqual(["1", "2", "3"]);
    const byId = new Map(settled().map((t) => [t.elementId, t]));
    expect([byId.get("1")!.x, byId.get("1")!.y]).toEqual([100, 100]);
    expect([byId.get("2")!.x, byId.get("2")!.y]).toEqual([200, 100]);
    // The merge's undo snapshot is forgotten: the stack is byte-identical to before.
    expect(st().undo).toEqual(undoBefore);
    // The failure was announced as an error toast.
    expect(m.ui.useUi.getState().toasts.some((t) => t.kind === "error")).toBe(true);
  });

  it("while pending: drags, merges, undo/redo, clear, tidy, remove and spawn are all rejected", async () => {
    await load();
    boot(["1", "2", "3", "4", "5"]);
    const u1 = m.canvas.addTile({ elementId: "1", x: 100, y: 100 });
    const u2 = m.canvas.addTile({ elementId: "2", x: 200, y: 100 });
    const u3 = m.canvas.addTile({ elementId: "3", x: 300, y: 300 });
    const u4 = m.canvas.addTile({ elementId: "4", x: 400, y: 300 });

    const p = m.actions.mergeTiles([u1, u2], { x: 150, y: 100 });
    expect(m.canvas.mergePending()).toBe(true);
    const layoutBefore = st().tiles.map((t) => ({ uid: t.uid, x: t.x, y: t.y }));
    const undoBefore = st().undo.length;

    // No second merge (from any path).
    await m.actions.mergeTiles([u3, u4], { x: 350, y: 300 });
    m.actions.combineSelection();
    expect(combineCalls()).toHaveLength(1);
    expect(st().tiles.filter((t) => t.pending)).toHaveLength(1);

    // Undo/redo stay unavailable.
    expect(m.canvas.canUndo()).toBe(false);
    expect(m.canvas.canRedo()).toBe(false);
    expect(m.canvas.undo()).toBe(false);
    expect(m.canvas.redo()).toBe(false);

    // Layout-changing actions are rejected.
    m.actions.clearCanvas();
    m.actions.tidyCanvas();
    m.actions.removeTile(u3);
    expect(m.actions.spawnElement("5")).toBeNull();
    expect(m.actions.dropNewTile("5", { x: 500, y: 500 }, { x: 0, y: 0 })).toBeNull();
    m.canvas.placeTile(u3, { x: 600, y: 600 });
    expect(m.ui.useUi.getState().toasts.some((t) => t.kind === "info")).toBe(true);

    // Nothing moved, nothing was added or removed, no undo entries appeared.
    expect(st().tiles.map((t) => ({ uid: t.uid, x: t.x, y: t.y }))).toEqual(layoutBefore);
    expect(st().undo.length).toBe(undoBefore);

    // Drag presses do not start a session (the press feedback attribute is never set).
    m.layout.layoutEls.canvas = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    } as unknown as HTMLElement;
    const pressEl = { setAttribute: vi.fn(), removeAttribute: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 76, height: 76 }) };
    const ev = { pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100, shiftKey: false, currentTarget: pressEl };
    m.drag.pressCanvasTile(ev as never, u3);
    m.drag.pressLibraryTile(ev as never, "5", "canvas");
    expect(pressEl.setAttribute).not.toHaveBeenCalled();

    // The combine lands: the freeze lifts and presses work again.
    combineCalls()[0]!.reply(200, combineRes("5"));
    await tick(400);
    await p;
    expect(m.canvas.mergePending()).toBe(false);
    m.drag.pressCanvasTile(ev as never, u3);
    expect(pressEl.setAttribute).toHaveBeenCalledWith("data-pressed", "");
  });

  it("rapid successive merges are serialized and their undo entries do not interleave", async () => {
    await load();
    boot(["1", "2", "3", "4", "5", "6"]);
    const u1 = m.canvas.addTile({ elementId: "1", x: 100, y: 100 });
    const u2 = m.canvas.addTile({ elementId: "2", x: 200, y: 100 });
    const u3 = m.canvas.addTile({ elementId: "3", x: 300, y: 100 });
    const u4 = m.canvas.addTile({ elementId: "4", x: 400, y: 100 });

    // The second merge is issued while the first is still in flight: rejected.
    const pA = m.actions.mergeTiles([u1, u2], { x: 150, y: 100 });
    await m.actions.mergeTiles([u3, u4], { x: 350, y: 100 });
    expect(combineCalls()).toHaveLength(1);

    combineCalls()[0]!.reply(200, combineRes("5"));
    await tick(400);
    await pA;
    expect(settledIds()).toEqual(["3", "4", "5"]);
    expect(st().undo.length).toBe(1);

    // Once the first landed, the second merge goes through.
    const pB = m.actions.mergeTiles([u3, u4], { x: 350, y: 100 });
    expect(combineCalls()).toHaveLength(2);
    combineCalls()[1]!.reply(200, combineRes("6"));
    await tick(400);
    await pB;
    expect(settledIds()).toEqual(["5", "6"]);
    expect(st().undo.length).toBe(2);

    // Undo walks back one merge at a time, in order.
    expect(m.canvas.undo()).toBe(true);
    expect(settledIds()).toEqual(["3", "4", "5"]);
    expect(m.canvas.undo()).toBe(true);
    expect(settledIds()).toEqual(["1", "2", "3", "4"]);
    expect(m.canvas.undo()).toBe(false);
  });

  it("only the stable layout is persisted while pending, and a reload restores it", async () => {
    await load();
    boot(["1", "2", "3"]);
    m.canvas.addTile({ elementId: "1", x: 100, y: 100 });
    m.canvas.addTile({ elementId: "2", x: 200, y: 100 });
    await tick(400); // persist debounce
    expect(persistedCanvas()!.tiles).toEqual([
      { e: "1", x: 100, y: 100 },
      { e: "2", x: 200, y: 100 },
    ]);

    const uids = st().tiles.map((t) => t.uid);
    const p = m.actions.mergeTiles(uids, { x: 150, y: 100 });
    expect(m.canvas.mergePending()).toBe(true);
    await tick(400); // the pending intermediate state must NOT reach localStorage

    // The persisted layout is still the stable pre-merge one (inputs, no crucible).
    const saved = persistedCanvas()!;
    expect(saved.tiles).toEqual([
      { e: "1", x: 100, y: 100 },
      { e: "2", x: 200, y: 100 },
    ]);

    // A reload over that storage comes back with the two inputs and no pending tile.
    vi.resetModules();
    const canvas2 = await import("../../state/canvas.ts");
    const tiles = canvas2.useCanvas.getState().tiles;
    expect(tiles.map((t) => t.elementId).sort()).toEqual(["1", "2"]);
    expect(tiles.some((t) => t.pending || !t.elementId)).toBe(false);

    // (The in-flight merge of the previous "tab" settles or not — the stored layout
    //  was already stable either way.)
    combineCalls()[0]!.reply(200, combineRes("3"));
    await p.catch(() => {});
  });

  it("the result is persisted once the merge lands", async () => {
    await load();
    boot(["1", "2", "3"]);
    const u1 = m.canvas.addTile({ elementId: "1", x: 100, y: 100 });
    const u2 = m.canvas.addTile({ elementId: "2", x: 200, y: 100 });

    const p = m.actions.mergeTiles([u1, u2], { x: 150, y: 100 });
    combineCalls()[0]!.reply(200, combineRes("3"));
    await tick(400);
    await p;
    await tick(400); // persist debounce

    const saved = persistedCanvas()!;
    expect(saved.tiles).toHaveLength(1);
    expect(saved.tiles[0]!.e).toBe("3");
    expect([saved.tiles[0]!.x, saved.tiles[0]!.y]).toEqual([150, 100]);
  });
});
