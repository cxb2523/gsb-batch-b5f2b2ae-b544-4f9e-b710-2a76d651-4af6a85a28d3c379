import { cancel } from "@/lib/utils";
import type { CleanupHandler, QueueChangeEventHandler, SpeechQueue, SpeechQueueItem } from "@/types";

const queue: SpeechQueue = [];

const queueListeners: QueueChangeEventHandler[] = [];

/**
 * Cancels the underlying speech without changing the global stopReason.
 * Used when an item is already being removed from the queue, so a synchronous
 * onend/onerror dispatched by the browser (or a mock) cannot re-enter the queue
 * mutation logic with a stale stop reason.
 */
function silentCancel() {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

export function addToQueue(item: SpeechQueueItem, callback?: QueueChangeEventHandler) {
  queue.push(item);
  emit(callback);
}

export function clearQueue(cancelSpeech = false, start = 0, emitEvent = false) {
  if (cancelSpeech) silentCancel();
  queue.slice(start).forEach(({ setSpeechStatus }) => setSpeechStatus("stopped"));
  queue.length = start;
  if (emitEvent) emit();
}

export const clearQueueHook = () => clearQueue(true, 0, true);

export const clearQueueUnload = () => clearQueue(true, 0, true);

export function dequeue(index: number = 0) {
  removeFromQueue(index);
}

export function emit(callback?: QueueChangeEventHandler) {
  const utteranceQueue = queue.map(({ text, utterance: { pitch, rate, volume, lang, voice } }) => ({ text, pitch, rate, volume, lang, voice }));
  queueListeners.forEach((listener) => listener(utteranceQueue));
  callback?.(utteranceQueue);
}

export function isQueued(utterance: SpeechSynthesisUtterance) {
  return queue.some((item) => item.utterance === utterance);
}

export function removeFromQueue(utterance: SpeechSynthesisUtterance, callback?: QueueChangeEventHandler): number;
export function removeFromQueue(utterance: number): number;
export function removeFromQueue(utterance: SpeechSynthesisUtterance | number, callback?: QueueChangeEventHandler): number {
  const index = typeof utterance === "number" ? utterance : queue.findIndex((item) => item.utterance === utterance);
  if (index === -1) return -1;
  const [item] = queue.splice(index, 1);
  if (!item) return -1;
  // Only the head item is the active utterance; removing a waiting item must not
  // interrupt the current speaker.
  if (index === 0) silentCancel();
  item.setSpeechStatus("stopped");
  emit(callback);
  if (index === 0) speakFromQueue();
  return index;
}

/**
 * Interrupts and restarts only the utterance at the head of the queue (e.g. when
 * pitch/rate/volume/lang/voiceURI change mid-speech). Every other queued item is
 * left untouched, both in the queue and in its speechStatus.
 */
export function restartQueueHead(utterance: SpeechSynthesisUtterance, callback?: QueueChangeEventHandler) {
  if (queue[0]?.utterance !== utterance) return;
  cancel("change");
  emit(callback);
}

export function speakFromQueue() {
  const item = queue[0];
  if (!item) return;
  // The next waiting entry becomes the active one. Keeping this transition inside
  // the queue module guarantees the status can never drift from the actual head.
  item.setSpeechStatus("started");
  window.speechSynthesis.speak(item.utterance);
}

export function subscribe(callback: QueueChangeEventHandler): CleanupHandler {
  queueListeners.push(callback);
  return () => {
    const index = queueListeners.indexOf(callback);
    if (index !== -1) queueListeners.splice(index, 1);
  };
}
