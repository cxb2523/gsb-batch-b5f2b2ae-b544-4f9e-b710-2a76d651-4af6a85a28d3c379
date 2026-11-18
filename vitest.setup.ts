/**
 * Minimal but realistic SpeechSynthesis mock.
 *
 * Key behaviour that mirrors real browsers and matters for the queue tests:
 * - speak() dispatches "start" asynchronously (microtask), never synchronously.
 * - cancel() dispatches onend asynchronously for the currently spoken utterance
 *   (real browsers fire onend/onerror after cancel()), and silently drops it
 *   afterwards. Nothing is fired for utterances that were never spoken.
 * - Each utterance keeps its own onstart/onend/onerror/onboundary handlers.
 */
class FakeSpeechSynthesisUtterance {
  text = "";
  lang = "";
  pitch = 1;
  rate = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((event: SpeechSynthesisEvent) => void) | null = null;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisEvent) => void) | null = null;
  onboundary: ((event: SpeechSynthesisEvent) => void) | null = null;

  constructor(text?: string) {
    if (text !== undefined) this.text = text;
  }
}

class FakeSpeechSynthesis {
  speaking = false;
  paused = false;
  /** Utterances currently handed to the synth, oldest first. */
  spoken: SpeechSynthesisUtterance[] = [];

  speak(utterance: SpeechSynthesisUtterance) {
    this.spoken.push(utterance);
    this.speaking = true;
    this.paused = false;
    queueMicrotask(() => {
      if (!this.speaking || !this.spoken.includes(utterance)) return;
      utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
    });
  }

  cancel() {
    const current = this.spoken;
    this.spoken = [];
    this.speaking = false;
    this.paused = false;
    current.forEach((utterance) =>
      queueMicrotask(() => {
        utterance.onend?.(new Event("end") as SpeechSynthesisEvent);
      }),
    );
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  getVoices(): SpeechSynthesisVoice[] {
    return [];
  }

  addEventListener() {}

  removeEventListener() {}
}

const fakeSynth = new FakeSpeechSynthesis();

Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
  value: FakeSpeechSynthesisUtterance,
  configurable: true,
  writable: true,
});
Object.defineProperty(window, "SpeechSynthesisUtterance", {
  value: FakeSpeechSynthesisUtterance,
  configurable: true,
  writable: true,
});

Object.defineProperty(window, "speechSynthesis", {
  value: fakeSynth,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "speechSynthesis", {
  value: fakeSynth,
  configurable: true,
  writable: true,
});

if (!window.crypto?.randomUUID) {
  Object.defineProperty(window, "crypto", {
    value: { randomUUID: () => "test-uuid" },
    configurable: true,
  });
}

import { act } from "@testing-library/react";

/**
 * Finishes the currently spoken utterance as if the browser reached its natural
 * end, then flushes the resulting microtask queue.
 */
export async function endCurrentSpeech() {
  const utterance = fakeSynth.spoken.shift();
  if (!utterance) return flushMicrotasks();
  if (!fakeSynth.spoken.length) fakeSynth.speaking = false;
  await act(async () => {
    await Promise.resolve();
    utterance.onend?.(new Event("end") as SpeechSynthesisEvent);
    await Promise.resolve();
  });
}

/** Flushes all queued microtasks (asynchronous synth event dispatch). */
export async function flushMicrotasks() {
  // Wrapped in act() so React state updates triggered by the mock synth's
  // asynchronous onstart/onend dispatch are flushed together with the test step.
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

export { fakeSynth };
