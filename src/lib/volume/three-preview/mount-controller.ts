import type { PreparedVolumeFor3D } from '../../../types';
import type { ThreePreviewInstance } from '../types';

/** Hosts smaller than this on either axis are not ready for a WebGL canvas. */
export const MIN_HOST_EDGE = 32;
/** Number of creation retries after the initial attempt (5 attempts total). */
export const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 120;

export type MountState =
  | 'idle'
  | 'waiting-size'
  | 'creating'
  | 'retry-wait'
  | 'ready'
  | 'error'
  | 'aborted';

/**
 * Timing and observation primitives used by the mount controller. The
 * defaults bind to the browser globals; tests inject deterministic fakes.
 */
export interface MountScheduler {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
  createResizeObserver: (callback: () => void) => {
    observe: (target: Element) => void;
    disconnect: () => void;
  };
}

export type PreviewFactory = (
  host: HTMLDivElement,
  volume: PreparedVolumeFor3D,
  options: { signal: AbortSignal },
) => Promise<ThreePreviewInstance>;

export interface MountControllerOptions {
  host: HTMLDivElement;
  volume: PreparedVolumeFor3D;
  createPreview: PreviewFactory;
  onStateChange?: (state: MountState) => void;
  onInstance?: (instance: ThreePreviewInstance | null) => void;
  scheduler?: MountScheduler;
}

export const defaultScheduler: MountScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
  createResizeObserver: (callback) => {
    const observer = new ResizeObserver(callback);
    return {
      observe: (target) => observer.observe(target),
      disconnect: () => observer.disconnect(),
    };
  },
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: string } | null)?.name === 'AbortError';
}

/**
 * Owns the full lifecycle of a single preview mount: waiting for the host to
 * gain real dimensions, creating the Three.js preview, retrying transient
 * WebGL failures with bounded backoff, and cancelling every in-flight frame,
 * timer, observer and preview instance on abort.
 *
 * A controller is single-use: every volume switch creates a fresh one, so
 * retry counters and error states can never leak across volumes.
 */
export class PreviewMountController {
  private readonly host: HTMLDivElement;
  private readonly volume: PreparedVolumeFor3D;
  private readonly createPreview: PreviewFactory;
  private readonly onStateChange?: (state: MountState) => void;
  private readonly onInstance?: (instance: ThreePreviewInstance | null) => void;
  private readonly scheduler: MountScheduler;

  private state: MountState = 'idle';
  private abortController: AbortController | null = null;
  private frameHandle = 0;
  private framePending = false;
  private retryTimer = 0;
  private sizeObserver: ReturnType<
    MountScheduler['createResizeObserver']
  > | null = null;
  private sizeObserverConnected = false;
  private instance: ThreePreviewInstance | null = null;
  private attempts = 0;
  private settled = false;

  constructor(options: MountControllerOptions) {
    this.host = options.host;
    this.volume = options.volume;
    this.createPreview = options.createPreview;
    this.onStateChange = options.onStateChange;
    this.onInstance = options.onInstance;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  getState(): MountState {
    return this.state;
  }

  /** Schedules the first size check on the next animation frame. */
  start(): void {
    if (this.state !== 'idle' || this.framePending) return;
    this.framePending = true;
    this.abortController = new AbortController();
    this.frameHandle = this.scheduler.requestFrame(() => {
      this.framePending = false;
      this.frameHandle = 0;
      this.tick();
    });
  }

  /**
   * Cancels every pending operation and releases the live preview. After
   * abort the controller never emits another state or instance callback.
   */
  abort(): void {
    if (this.settled) return;
    this.settled = true;
    this.framePending = false;
    // Abort is terminal: force the state even when start() never progressed
    // past 'idle' (e.g. cancelled before the first frame fired).
    if (this.state !== 'aborted') {
      this.state = 'aborted';
      this.onStateChange?.('aborted');
    }

    this.scheduler.cancelFrame(this.frameHandle);
    this.scheduler.clearTimeout(this.retryTimer);
    this.disconnectSizeObserver();
    this.abortController?.abort();

    if (this.instance) {
      this.instance.dispose();
      this.instance = null;
      this.onInstance?.(null);
    }
  }

  private setState(next: MountState): void {
    if (this.settled || this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  private hostIsReady(): boolean {
    return (
      this.host.clientWidth >= MIN_HOST_EDGE &&
      this.host.clientHeight >= MIN_HOST_EDGE
    );
  }

  private ensureSizeObserver(): void {
    if (this.sizeObserverConnected) return;
    if (!this.sizeObserver) {
      this.sizeObserver = this.scheduler.createResizeObserver(() => {
        this.tick();
      });
    }
    this.sizeObserver.observe(this.host);
    this.sizeObserverConnected = true;
  }

  private disconnectSizeObserver(): void {
    if (!this.sizeObserverConnected) return;
    this.sizeObserverConnected = false;
    this.sizeObserver?.disconnect();
  }

  /**
   * Single decision point for size-driven (re)evaluation. Mounting is guarded
   * so any number of rAF, timer and ResizeObserver ticks create at most one
   * in-flight preview. Only the pre-creation states may (re)trigger a build;
   * 'ready' and the terminal 'error' state never revive on a stray tick
   * (recovery from error starts a fresh controller on the next volume).
   */
  private tick(): void {
    if (this.settled) return;
    if (
      this.state === 'creating' ||
      this.state === 'ready' ||
      this.state === 'error'
    ) {
      return;
    }

    if (!this.hostIsReady()) {
      // Size waiting is free: it never consumes a retry attempt, and the
      // observer stays armed so a hide -> show cycle resumes on its own.
      // Any pending failure backoff is cancelled until the host is usable.
      this.scheduler.clearTimeout(this.retryTimer);
      this.retryTimer = 0;
      this.ensureSizeObserver();
      this.setState('waiting-size');
      return;
    }

    this.beginCreate();
  }

  private beginCreate(): void {
    if (this.settled) return;
    if (
      this.state === 'creating' ||
      this.state === 'ready' ||
      this.state === 'error' ||
      this.instance
    ) {
      return;
    }

    this.attempts += 1;
    this.setState('creating');
    const signal = this.abortController?.signal;
    if (!signal) {
      return;
    }

    void this.createPreview(this.host, this.volume, { signal })
      .then((preview) => {
        if (this.settled) {
          // The mount was superseded by a volume switch or unmounted while
          // the async build was in flight. The build itself may not have
          // observed the abort, so dispose here and never publish it.
          preview.dispose();
          return;
        }

        this.instance = preview;
        this.disconnectSizeObserver();
        this.scheduler.clearTimeout(this.retryTimer);
        this.onInstance?.(preview);
        this.setState('ready');
      })
      .catch((error: unknown) => {
        if (this.settled || isAbortError(error)) {
          // Aborts are normal lifecycle events, not failures to surface.
          return;
        }
        this.handleCreationFailure();
      });
  }

  private handleCreationFailure(): void {
    if (this.attempts > MAX_RETRIES) {
      this.disconnectSizeObserver();
      this.setState('error');
      return;
    }

    // Backoff retries only for creation failures; if the host shrinks in the
    // meantime the observer re-arms and size waiting does not burn attempts.
    this.setState('retry-wait');
    this.ensureSizeObserver();
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = 0;
      if (this.settled) return;
      this.tick();
    }, RETRY_BASE_DELAY_MS * this.attempts);
  }
}
