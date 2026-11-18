/**
 * Shared playback coordinator for video nodes.
 *
 * A video node and its focus overlay each render their own <video> element, but
 * they must behave like a single player: same position, never decoding (or
 * sounding) at the same time. This module owns that shared state. It is
 * framework-agnostic so it can be unit-tested without a DOM; React components
 * wire real elements to it through `useVideoPlayback`.
 *
 * Core rules enforced here:
 * - Exactly one surface ("node" or "focus") holds `src` at a time. The focus
 *   surface owns playback while it is open; the node owns it otherwise.
 * - The shared position follows whichever surface is currently decoding, so
 *   entering/exiting focus continues playback instead of restarting it.
 * - A node that is hidden or too small releases its decoder (src removed +
 *   load()) and resumes at the same position when it becomes usable again.
 * - Changing the URL stops and releases the old video and restarts at 0.
 */

export type VideoSlot = "node" | "focus"

/** Rendered size (either dimension, px) below which a node video stops decoding. */
export const MIN_VIDEO_NODE_DIMENSION = 48

/** Position drift (seconds) tolerated before forcing an element back to the shared position. */
const SEEK_EPSILON = 0.25

const SLOT_ORDER: VideoSlot[] = ["node", "focus"]

/**
 * Minimal surface of HTMLVideoElement the manager drives. Structural, so a real
 * element satisfies it directly and tests can substitute a fake.
 */
export interface VideoElementLike {
  src: string
  currentTime: number
  paused: boolean
  play: () => unknown
  pause: () => void
  load: () => void
  removeAttribute: (qualifiedName: string) => void
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

interface SlotBinding {
  element: VideoElementLike
  /** URL currently loaded into the element; null while the decoder is released. */
  appliedUrl: string | null
  removeListeners: () => void
}

export class VideoPlaybackManager {
  readonly nodeId: string
  private videoUrl: string | null = null
  private position = 0
  private nodeAvailable = true
  private bindings: Partial<Record<VideoSlot, SlotBinding>> = {}
  private refs = 0
  private destroyed = false

  constructor(nodeId: string) {
    this.nodeId = nodeId
  }

  get currentPosition(): number {
    return this.position
  }

  get currentUrl(): string | null {
    return this.videoUrl
  }

  /** The slot allowed to decode right now: focus while open, otherwise the node. */
  get owner(): VideoSlot {
    return this.bindings.focus ? "focus" : "node"
  }

  get refCount(): number {
    return this.refs
  }

  retain(): void {
    this.refs += 1
  }

  release(): void {
    this.refs = Math.max(0, this.refs - 1)
  }

  /** True while the slot should hold `src` and play. */
  isDecoding(slot: VideoSlot): boolean {
    if (!this.bindings[slot] || !this.videoUrl) return false
    if (slot !== this.owner) return false
    return slot === "focus" || this.nodeAvailable
  }

  /**
   * Point the shared player at a new URL. The old video is stopped and released
   * on every surface and playback restarts from 0. No-op for redundant updates.
   */
  setVideoUrl(url: string | null | undefined): void {
    const next = url ? url : null
    if (next === this.videoUrl) return
    this.videoUrl = next
    this.position = 0
    for (const slot of SLOT_ORDER) {
      const binding = this.bindings[slot]
      if (binding) this.releaseBinding(binding, { capture: false })
    }
    this.sync()
  }

  /** Node slot only: false while the node is hidden or below the size threshold. */
  setNodeAvailable(available: boolean): void {
    if (available === this.nodeAvailable) return
    this.nodeAvailable = available
    this.sync()
  }

  /**
   * Attach a surface's <video> element. Applies the current shared state to it
   * and returns an idempotent unbind function that removes listeners and
   * releases the element.
   */
  bindElement(slot: VideoSlot, element: VideoElementLike): () => void {
    this.unbindSlot(slot)

    const handleTimeUpdate = () => {
      if (slot === this.owner) this.position = element.currentTime
    }
    const handleLoadedMetadata = () => {
      // A seek issued before metadata was available lands here.
      this.seek(element, this.position)
      if (this.isDecoding(slot)) this.tryPlay(element)
    }
    element.addEventListener("timeupdate", handleTimeUpdate)
    element.addEventListener("loadedmetadata", handleLoadedMetadata)

    const binding: SlotBinding = {
      element,
      appliedUrl: null,
      removeListeners: () => {
        element.removeEventListener("timeupdate", handleTimeUpdate)
        element.removeEventListener("loadedmetadata", handleLoadedMetadata)
      },
    }
    this.bindings[slot] = binding
    this.sync()

    let unbound = false
    return () => {
      if (unbound) return
      unbound = true
      // Guard against a stale closure unbinding a newer binding for this slot.
      if (this.bindings[slot] === binding) this.unbindSlot(slot)
    }
  }

  /** Release every bound surface and stop tracking state. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const slot of SLOT_ORDER) this.unbindSlot(slot)
  }

  private unbindSlot(slot: VideoSlot): void {
    const binding = this.bindings[slot]
    if (!binding) return
    delete this.bindings[slot]
    binding.removeListeners()
    this.releaseBinding(binding, { capture: true })
    this.sync()
  }

  /**
   * Stop decoding on a binding: pause, drop `src` and call load() so the
   * browser frees the decoder. Captures the element's position first unless
   * told otherwise (URL switches must not leak the old video's position).
   */
  private releaseBinding(binding: SlotBinding, options: { capture: boolean }): void {
    if (binding.appliedUrl === null) return
    if (options.capture) this.position = binding.element.currentTime
    binding.element.pause()
    binding.element.removeAttribute("src")
    binding.element.load()
    binding.appliedUrl = null
  }

  private sync(): void {
    if (this.destroyed) return
    for (const slot of SLOT_ORDER) this.syncSlot(slot)
  }

  private syncSlot(slot: VideoSlot): void {
    const binding = this.bindings[slot]
    if (!binding) return
    if (this.isDecoding(slot) && this.videoUrl) {
      if (binding.appliedUrl !== this.videoUrl) {
        binding.element.src = this.videoUrl
        binding.appliedUrl = this.videoUrl
        this.seek(binding.element, this.position)
      }
      this.tryPlay(binding.element)
    } else {
      this.releaseBinding(binding, { capture: true })
    }
  }

  private seek(element: VideoElementLike, time: number): void {
    if (Math.abs(element.currentTime - time) <= SEEK_EPSILON) return
    try {
      element.currentTime = time
    } catch {
      // Metadata not ready yet; the loadedmetadata listener retries the seek.
    }
  }

  private tryPlay(element: VideoElementLike): void {
    if (!element.paused) return
    try {
      const result: unknown = element.play()
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => {
          // Autoplay restrictions and friends: leave the element paused.
        })
      }
    } catch {
      // Ignore synchronous play() failures.
    }
  }
}

const registry = new Map<string, VideoPlaybackManager>()

/** Acquire the shared manager for a node. Pair every call with `releaseVideoPlaybackManager`. */
export function acquireVideoPlaybackManager(nodeId: string): VideoPlaybackManager {
  const existing = registry.get(nodeId)
  if (existing) {
    existing.retain()
    return existing
  }
  const manager = new VideoPlaybackManager(nodeId)
  manager.retain()
  registry.set(nodeId, manager)
  return manager
}

export function releaseVideoPlaybackManager(nodeId: string): void {
  const manager = registry.get(nodeId)
  if (!manager) return
  manager.release()
  if (manager.refCount === 0) {
    manager.destroy()
    registry.delete(nodeId)
  }
}

/** Visible for tests: how many node ids currently have a live manager. */
export function getVideoPlaybackManagerCount(): number {
  return registry.size
}
