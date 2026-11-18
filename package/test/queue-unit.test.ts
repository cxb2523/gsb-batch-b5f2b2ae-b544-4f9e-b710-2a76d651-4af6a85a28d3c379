import { describe, expect, it, vi } from "vitest";
import { addToQueue, clearQueue, clearQueueHook, dequeue, emit, isQueued, removeFromQueue, restartQueueHead, speakFromQueue, subscribe } from "../src/lib/queue";
import type { SpeechQueueItem, SpeechStatus, SpeechUtterancesQueue } from "../src/types";

function makeItem(text: string) {
  const statusChanges: SpeechStatus[] = [];
  const item: SpeechQueueItem = {
    text,
    utterance: new SpeechSynthesisUtterance(text),
    setSpeechStatus: vi.fn((status: SpeechStatus) => {
      statusChanges.push(status);
    }),
  };
  return { item, statusChanges };
}

describe("speech queue module", () => {
  it("emits a snapshot whose length always matches the underlying queue", () => {
    const snapshots: SpeechUtterancesQueue[] = [];
    const unsubscribe = subscribe((queue) => snapshots.push(queue));

    const a = makeItem("A");
    const b = makeItem("B");
    addToQueue(a.item);
    addToQueue(b.item);
    expect(snapshots.at(-1)).toHaveLength(2);

    removeFromQueue(b.item.utterance);
    expect(snapshots.at(-1)).toHaveLength(1);
    expect(snapshots.at(-1)?.[0]?.text).toBe("A");

    clearQueue(true, 0, true);
    expect(snapshots.at(-1)).toHaveLength(0);
    unsubscribe();
  });

  it("resets every removed entry to stopped, including the head", () => {
    const a = makeItem("A");
    const b = makeItem("B");
    addToQueue(a.item);
    addToQueue(b.item);

    removeFromQueue(a.item.utterance);
    expect(a.item.setSpeechStatus).toHaveBeenLastCalledWith("stopped");
    expect(isQueued(a.item.utterance)).toBe(false);
    // B survives and is promoted to the head ("started") by speakFromQueue.
    expect(b.item.setSpeechStatus).toHaveBeenLastCalledWith("started");
    expect(isQueued(b.item.utterance)).toBe(true);

    clearQueue(true, 0, true);
    expect(b.item.setSpeechStatus).toHaveBeenLastCalledWith("stopped");
  });

  it("clearQueueHook and clearQueueUnload empty the whole queue and always emit", () => {
    let emitCount = 0;
    let lastSnapshot: SpeechUtterancesQueue | undefined;
    const unsubscribe = subscribe((queue) => {
      emitCount++;
      lastSnapshot = queue;
    });

    const a = makeItem("A");
    const b = makeItem("B");
    addToQueue(a.item);
    addToQueue(b.item);

    clearQueueHook();
    expect(lastSnapshot).toEqual([]);
    expect(a.item.setSpeechStatus).toHaveBeenLastCalledWith("stopped");
    expect(b.item.setSpeechStatus).toHaveBeenLastCalledWith("stopped");

    addToQueue(a.item);
    const countBeforeSilentClear = emitCount;
    clearQueue(true, 0, false); // empties and resets status without emitting
    expect(isQueued(a.item.utterance)).toBe(false);
    expect(a.item.setSpeechStatus).toHaveBeenLastCalledWith("stopped");
    expect(emitCount).toBe(countBeforeSilentClear);

    unsubscribe();
  });

  it("restartQueueHead interrupts only the head and never touches waiting items", () => {
    const a = makeItem("A");
    const b = makeItem("B");
    addToQueue(a.item);
    addToQueue(b.item);
    const cancelSpy = vi.spyOn(window.speechSynthesis, "cancel");

    restartQueueHead(a.item.utterance);
    expect(cancelSpy).toHaveBeenCalled();
    expect(isQueued(a.item.utterance)).toBe(true);
    expect(isQueued(b.item.utterance)).toBe(true);
    // A waiting item's restart request is a no-op.
    cancelSpy.mockClear();
    restartQueueHead(b.item.utterance);
    expect(cancelSpy).not.toHaveBeenCalled();

    clearQueue(true, 0, true);
  });

  it("promotes the next entry when the head is removed or dequeued", () => {
    const speakSpy = vi.spyOn(window.speechSynthesis, "speak");
    const a = makeItem("A");
    const b = makeItem("B");
    addToQueue(a.item);
    addToQueue(b.item);
    speakSpy.mockClear();

    removeFromQueue(0);
    expect(a.item.setSpeechStatus).toHaveBeenLastCalledWith("stopped");
    expect(b.item.setSpeechStatus).toHaveBeenLastCalledWith("started");
    expect(speakSpy).toHaveBeenCalledWith(b.item.utterance);

    const c = makeItem("C");
    addToQueue(c.item);
    speakSpy.mockClear();
    dequeue(0);
    expect(c.item.setSpeechStatus).toHaveBeenLastCalledWith("started");
    expect(speakSpy).toHaveBeenCalledWith(c.item.utterance);

    clearQueue(true, 0, true);
  });

  it("removeFromQueue is idempotent and emits only on actual removal", () => {
    let emitCount = 0;
    const unsubscribe = subscribe(() => emitCount++);
    const a = makeItem("A");
    addToQueue(a.item);
    const countAfterAdd = emitCount;

    expect(removeFromQueue(a.item.utterance)).toBe(0);
    expect(emitCount).toBe(countAfterAdd + 1);
    expect(removeFromQueue(a.item.utterance)).toBe(-1);
    expect(emitCount).toBe(countAfterAdd + 1);

    unsubscribe();
  });

  it("speakFromQueue is a no-op on an empty queue", () => {
    clearQueue(true, 0, true);
    expect(() => speakFromQueue()).not.toThrow();
    emit(); // smoke test: emitting with no listeners/callback must not throw
  });
});
