import {
  describe,
  expect,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { leaderboard, type Run } from "./lib/leaderboard";

// These tests drive full runs of the game with fake timers. jsdom reports
// zero-sized rects for every element, so the collision/scoring loop is
// scripted by mocking getBoundingClientRect: pillar divs (div.absolute.w-16)
// get a configurable "left" offset, everything else (in practice only the
// player, whose rect the game queries) sits at a fixed position.
const PLAYER_LEFT = 100;
const RECT_SIZE = 64;
const PILLAR_BEHIND = -500; // already passed by the player
const PILLAR_AHEAD = 100_000; // still ahead of the player, no overlap
const PILLAR_ON_PLAYER = PLAYER_LEFT; // overlapping the player -> crash

/** "left" offset per pillar div, indexed by DOM order. */
let pillarLefts: number[] = [];

const makeRect = (left: number): DOMRect =>
  ({
    left,
    right: left + RECT_SIZE,
    top: 100,
    bottom: 100 + RECT_SIZE,
    width: RECT_SIZE,
    height: RECT_SIZE,
    x: left,
    y: 100,
    toJSON: () => ({}),
  }) as DOMRect;

const mockGeometry = () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const cls = typeof this.className === "string" ? this.className : "";
      if (cls.includes("absolute") && cls.includes("w-16")) {
        const pillars = Array.from(
          document.querySelectorAll("div.absolute.w-16"),
        );
        return makeRect(pillarLefts[pillars.indexOf(this)] ?? PILLAR_AHEAD);
      }
      return makeRect(PLAYER_LEFT);
    },
  );
};

const flush = () => act(async () => {});

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

/** Clicks the full-screen veil that starts a run from the idle phase. */
const clickIdleVeil = (container: HTMLElement) => {
  const veil = Array.from(container.querySelectorAll(".veil")).find(
    (el) => el.textContent?.trim() === "",
  );
  if (!veil) throw new Error("idle veil not found — game is not idle");
  fireEvent.click(veil);
};

const press = () => fireEvent(window, new Event("pointerdown"));
const release = () => fireEvent(window, new Event("pointerup"));

/** From idle: play a run that scores 1 point and then crashes into a pillar. */
const playScoringRunThenCrash = async (container: HTMLElement) => {
  // One pillar pair behind the player (scores 1), the rest still ahead.
  pillarLefts = [PILLAR_BEHIND, PILLAR_BEHIND, ...Array(16).fill(PILLAR_AHEAD)];
  clickIdleVeil(container);
  await advance(50); // pass the first pair -> score 1
  pillarLefts = Array(18).fill(PILLAR_ON_PLAYER);
  await advance(50); // crash
  await advance(3000); // crash animation -> gameOver
};

let uuidSeq = 0;

beforeAll(() => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    vi.stubGlobal("crypto", {
      ...(globalThis.crypto ?? {}),
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`,
    });
  }
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
      "Date",
    ],
  });
  localStorage.clear();
  pillarLefts = [];
  mockGeometry();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("run-scoped recording, ghost and submission state", () => {
  it("resets the recording clock and tape for every run, including after a level transition", async () => {
    const submitSpy = vi.spyOn(leaderboard, "submitRun");
    const { container } = render(<App />);
    await flush();
    fireEvent.click(screen.getByText(/tap to play/i));

    // --- Run 1 (level 1): record two edges, then finish the level.
    pillarLefts = Array(18).fill(PILLAR_BEHIND);
    clickIdleVeil(container);
    press();
    release();
    await advance(50); // all pillars passed -> levelEnding
    await advance(3000); // -> levelTransition
    fireEvent.animationEnd(screen.getByText(/level 2/i)); // -> idle at level 2

    // A long pause before the next run starts; the next run's clock must
    // not inherit any of this elapsed time.
    await advance(5000);

    // --- Run 2 (level 2): record two edges, then crash.
    pillarLefts = Array(18).fill(PILLAR_AHEAD);
    clickIdleVeil(container);
    press();
    await advance(50);
    release();
    pillarLefts = Array(18).fill(PILLAR_ON_PLAYER);
    await advance(50); // crash
    await advance(3000); // -> gameOver

    // Submit the run and inspect the tape sent to the leaderboard.
    fireEvent.change(screen.getByPlaceholderText(/your name/i), {
      target: { value: "AB" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save score/i }));
    await flush();

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const recording = submitSpy.mock.calls[0][0].recording;
    // Only run 2's edges, timed from run 2's start — no events carried over
    // from level 1 and no offset inherited from the previous run's clock.
    expect(recording).toEqual([
      [0, false],
      [0, true],
      [50, false],
    ]);
  });

  it("clears submission state on restart and ignores late submission results", async () => {
    let resolveSubmit: ((run: Run) => void) | undefined;
    const submitSpy = vi.spyOn(leaderboard, "submitRun").mockImplementation(
      () =>
        new Promise<Run>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    const { container } = render(<App />);
    await flush();
    fireEvent.click(screen.getByText(/tap to play/i));

    // First run ends in a crash with a score on the board.
    await playScoringRunThenCrash(container);
    expect(screen.getByText(/game over/i)).toBeInTheDocument();

    // Start a submission, then restart before it resolves.
    fireEvent.change(screen.getByPlaceholderText(/your name/i), {
      target: { value: "AB" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save score/i }));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // A new run begins and ends while the old submission is still in flight.
    await playScoringRunThenCrash(container);
    expect(screen.getByText(/game over/i)).toBeInTheDocument();

    // The late result must not mark the new run as submitted.
    await act(async () => {
      resolveSubmit?.({
        id: "late",
        name: "AB",
        score: 1,
        level: 1,
        createdAt: 1,
      });
    });
    expect(screen.queryByText(/saved as/i)).not.toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: /save score/i });
    expect(saveButton).toBeEnabled();

    // The new run can be submitted again.
    submitSpy.mockRestore();
    fireEvent.click(saveButton);
    await flush();
    expect(screen.getByText(/saved as/i)).toBeInTheDocument();
  });

  it("restarts the ghost replay clock from zero for every run", async () => {
    // Seed a previous best run whose ghost only moves up after 10 seconds.
    localStorage.setItem(
      "flappin-ufo:runs",
      JSON.stringify([
        {
          id: "g1",
          name: "G",
          score: 5,
          level: 1,
          createdAt: 1,
          recording: [
            [0, false],
            [10_000, true],
          ],
        },
      ]),
    );

    const { container } = render(<App />);
    await flush(); // load the ghost run
    fireEvent.click(screen.getByText(/tap to play/i));

    const ghost = () => container.querySelector(".opacity-40") as HTMLElement;
    const upTransform = `translateY(${window.innerHeight * -1}px)`;
    const downTransform = `translateY(${window.innerHeight * 2}px)`;

    // Run 1: keep playing (no scoring, no crash) past the ghost's 10s mark.
    pillarLefts = Array(18).fill(PILLAR_AHEAD);
    clickIdleVeil(container);
    await advance(20_000);
    expect(ghost().style.transform).toBe(upTransform);

    // Finish level 1 and start the next run on level 2.
    pillarLefts = Array(18).fill(PILLAR_BEHIND);
    await advance(50); // -> levelEnding
    await advance(3000); // -> levelTransition
    fireEvent.animationEnd(screen.getByText(/level 2/i)); // -> idle at level 2
    pillarLefts = Array(18).fill(PILLAR_AHEAD);
    clickIdleVeil(container);
    await advance(100);

    // The ghost replays from the beginning of the tape, not from where the
    // previous level left off.
    expect(ghost().style.transform).toBe(downTransform);
  });
});
