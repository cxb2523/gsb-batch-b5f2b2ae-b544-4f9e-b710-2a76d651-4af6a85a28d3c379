import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setStatusA: vi.fn() }));

vi.mock("../src/lib/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/queue")>();
  return {
    ...actual,
    addToQueue: (item: Parameters<typeof actual.addToQueue>[0], callback?: Parameters<typeof actual.addToQueue>[1]) => {
      if (item.text === "A") actual.addToQueue({ ...item, setSpeechStatus: mocks.setStatusA }, callback);
      else actual.addToQueue(item, callback);
    },
  };
});

import { useQueue, useSpeech } from "../src/hooks";
import { endCurrentSpeech, flushMicrotasks, fakeSynth } from "../../vitest.setup";

type Status = "started" | "paused" | "stopped" | "queued";

function Speaker({
  label,
  preserveUtteranceQueue = true,
  rate = 1,
  onQueueChange,
}: {
  label: string;
  preserveUtteranceQueue?: boolean;
  rate?: number;
  onQueueChange?: (queue: unknown[]) => void;
}) {
  const { Text, speechStatus, start, pause, stop } = useSpeech({
    text: label,
    preserveUtteranceQueue,
    rate,
    onQueueChange,
  });
  return (
    <div>
      <Text />
      <span data-testid={`${label}-status`}>{speechStatus}</span>
      <button onClick={start}>{`${label}-start`}</button>
      <button onClick={pause}>{`${label}-pause`}</button>
      <button onClick={stop}>{`${label}-stop`}</button>
    </div>
  );
}

function QueueProbe() {
  const { queue, clearQueue, dequeue } = useQueue();
  return (
    <div>
      <span data-testid="queue-length">{queue.length}</span>
      <span data-testid="queue-snapshot">{JSON.stringify(queue.map(({ text }) => text))}</span>
      <button onClick={() => clearQueue()}>clear</button>
      <button onClick={() => dequeue(1)}>dequeue-1</button>
    </div>
  );
}

function statusOf(label: string): Status {
  return screen.getByTestId(`${label}-status`).textContent as Status;
}

describe("useSpeech queue coordination", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.setStatusA.mockClear();
  });

  afterEach(async () => {
    // Ensure every test starts with an empty global queue.
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
      await Promise.resolve();
    });
    fakeSynth.spoken = [];
    fakeSynth.speaking = false;
  });

  it("keeps waiting items queued when the speaking item changes rate mid-speech", async () => {
    function App({ rateA }: { rateA: number }) {
      return (
        <>
          <Speaker label="A" rate={rateA} />
          <Speaker label="B" />
          <QueueProbe />
        </>
      );
    }

    const { rerender } = render(<App rateA={1} />);

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();

    expect(statusOf("A")).toBe("started");
    expect(statusOf("B")).toBe("queued");
    expect(screen.getByTestId("queue-length").textContent).toBe("2");

    // Change the rate of the currently speaking instance A.
    await act(async () => {
      rerender(<App rateA={1.5} />);
      // The hook debounces prop-change restarts by 500 ms.
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    await flushMicrotasks();

    // The interruption restarts only A; B must remain queued.
    expect(statusOf("A")).toBe("started");
    expect(statusOf("B")).toBe("queued");
    expect(screen.getByTestId("queue-length").textContent).toBe("2");
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify(["A", "B"]));
  });

  it("removes an unmounted instance from the queue snapshot and resets its status to stopped", async () => {
    // The hoisted module mock wraps instance A's status updater (see vi.mock above).
    function TrackedSpeaker({ label }: { label: string }) {
      const { Text, speechStatus, start } = useSpeech({ text: label, preserveUtteranceQueue: true });
      return (
        <div>
          <Text />
          <span data-testid={`${label}-status`}>{speechStatus}</span>
          <button onClick={start}>{`${label}-start`}</button>
        </div>
      );
    }

    function App({ showA }: { showA: boolean }) {
      return (
        <>
          {showA && <TrackedSpeaker label="A" />}
          <TrackedSpeaker label="B" />
          <QueueProbe />
        </>
      );
    }

    const { rerender } = render(<App showA={true} />);

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();

    expect(screen.getByTestId("queue-length").textContent).toBe("2");

    await act(async () => rerender(<App showA={false} />));
    await flushMicrotasks();

    // The unmounted A entry must be gone from the snapshot...
    expect(screen.getByTestId("queue-length").textContent).toBe("1");
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify(["B"]));
    // ...and its own status updater must have been reset to "stopped" on cleanup.
    expect(mocks.setStatusA).toHaveBeenCalledWith("stopped");
    // B is promoted from the queue to become the active speaker.
    expect(statusOf("B")).toBe("started");
  });

  it("empties the queue on beforeunload and resets every entry to stopped", async () => {
    const statuses: Record<string, Status> = {};

    function TrackedSpeaker({ label }: { label: string }) {
      const { Text, speechStatus, start } = useSpeech({ text: label, preserveUtteranceQueue: true });
      statuses[label] = speechStatus;
      return (
        <div>
          <Text />
          <button onClick={start}>{`${label}-start`}</button>
        </div>
      );
    }

    render(
      <>
        <TrackedSpeaker label="A" />
        <TrackedSpeaker label="B" />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();
    expect(screen.getByTestId("queue-length").textContent).toBe("2");

    await act(async () => window.dispatchEvent(new Event("beforeunload")));
    await flushMicrotasks();

    expect(screen.getByTestId("queue-length").textContent).toBe("0");
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify([]));
    expect(statuses["A"]).toBe("stopped");
    expect(statuses["B"]).toBe("stopped");
  });

  it("resets the speaking entry to stopped on explicit stop and promotes the next entry", async () => {
    render(
      <>
        <Speaker label="A" />
        <Speaker label="B" />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();

    await act(async () => screen.getByRole("button", { name: "A-stop" }).click());
    await flushMicrotasks();

    expect(statusOf("A")).toBe("stopped");
    expect(screen.getByTestId("queue-length").textContent).toBe("1");
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify(["B"]));
    // B gets spoken next and moves to started.
    expect(statusOf("B")).toBe("started");
  });

  it("stops a queued (not yet speaking) entry without disturbing the speaker", async () => {
    render(
      <>
        <Speaker label="A" />
        <Speaker label="B" />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();
    expect(statusOf("B")).toBe("queued");

    await act(async () => screen.getByRole("button", { name: "B-stop" }).click());
    await flushMicrotasks();

    expect(statusOf("B")).toBe("stopped");
    expect(statusOf("A")).toBe("started");
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify(["A"]));
  });

  it("marks a paused entry stopped when stopped, and removes it from the snapshot", async () => {
    render(
      <>
        <Speaker label="A" />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "A-pause" }).click());
    expect(statusOf("A")).toBe("paused");

    await act(async () => screen.getByRole("button", { name: "A-stop" }).click());
    await flushMicrotasks();

    expect(statusOf("A")).toBe("stopped");
    expect(screen.getByTestId("queue-length").textContent).toBe("0");
  });

  it("clearQueue emits a snapshot consistent with the queue length", async () => {
    const snapshots: unknown[][] = [];
    render(
      <>
        <Speaker label="A" onQueueChange={(q) => snapshots.push(q)} />
        <Speaker label="B" />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();

    await act(async () => screen.getByRole("button", { name: "clear" }).click());
    await flushMicrotasks();

    expect(screen.getByTestId("queue-length").textContent).toBe("0");
    const lastSnapshot = snapshots.at(-1)!;
    expect(lastSnapshot).toHaveLength(0);
  });

  it("removeFromQueue emits only after the item is removed, so snapshot length matches the queue", async () => {
    const snapshots: unknown[][] = [];
    render(
      <>
        <Speaker label="A" onQueueChange={(q) => snapshots.push(q)} />
        <Speaker label="B" />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();
    snapshots.length = 0;

    // Remove the waiting item at index 1.
    await act(async () => screen.getByRole("button", { name: "dequeue-1" }).click());
    await flushMicrotasks();

    expect(screen.getByTestId("queue-length").textContent).toBe("1");
    for (const snapshot of snapshots) expect(snapshot).toHaveLength(1);
  });

  it("preserves preserveUtteranceQueue=false semantics: starting a new instance clears the old one", async () => {
    render(
      <>
        <Speaker label="A" preserveUtteranceQueue={false} />
        <Speaker label="C" preserveUtteranceQueue={false} />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify(["A"]));

    await act(async () => screen.getByRole("button", { name: "C-start" }).click());
    await flushMicrotasks();

    // A is cleared and stopped; only C remains.
    expect(statusOf("A")).toBe("stopped");
    expect(statusOf("C")).toBe("started");
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify(["C"]));
  });

  it("naturally completes a speaking item, removes it and promotes the queued one", async () => {
    render(
      <>
        <Speaker label="A" />
        <Speaker label="B" />
        <QueueProbe />
      </>,
    );

    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();
    await act(async () => screen.getByRole("button", { name: "B-start" }).click());
    await flushMicrotasks();

    await act(endCurrentSpeech);

    expect(statusOf("A")).toBe("stopped");
    expect(statusOf("B")).toBe("started");
    expect(screen.getByTestId("queue-snapshot").textContent).toBe(JSON.stringify(["B"]));
  });
});

describe("clearQueueUnload export", () => {
  it("is registered on beforeunload while speech is active", async () => {
    const listener = vi.fn();
    window.addEventListener("beforeunload", listener);

    render(<Speaker label="A" />);
    await act(async () => screen.getByRole("button", { name: "A-start" }).click());
    await flushMicrotasks();

    // Internal listener plus ours both run; just assert the internal cleanup path
    // empties the queue through the real event.
    await act(async () => window.dispatchEvent(new Event("beforeunload")));
    await flushMicrotasks();

    expect(listener).toHaveBeenCalled();
    expect(fakeSynth.speaking).toBe(false);
    window.removeEventListener("beforeunload", listener);
  });
});
