"use client"

import { useEffect, useRef } from "react"
import {
  acquireVideoPlaybackManager,
  MIN_VIDEO_NODE_DIMENSION,
  releaseVideoPlaybackManager,
  type VideoPlaybackManager,
  type VideoSlot,
} from "../lib/video-playback"

interface UseVideoPlaybackOptions {
  /** Node this video belongs to; the node and its focus overlay share one manager per id. */
  nodeId: string
  /** Which surface this element is. The focus surface takes over playback while bound. */
  slot: VideoSlot
  videoUrl?: string
  /**
   * Node slot only: pause and release the decoder while the rendered node is
   * smaller than MIN_VIDEO_NODE_DIMENSION or scrolled out of the viewport.
   */
  suspendWhenHidden?: boolean
}

/**
 * Wires a <video> element into the shared VideoPlaybackManager for its node.
 * The element's `src` is owned by the manager — do not set it from JSX.
 */
export function useVideoPlayback({
  nodeId,
  slot,
  videoUrl,
  suspendWhenHidden = false,
}: UseVideoPlaybackOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const managerRef = useRef<VideoPlaybackManager | null>(null)
  // The <video> element only exists when a URL is set (placeholder otherwise),
  // so rebinding must also happen when that changes.
  const hasVideo = Boolean(videoUrl)

  // Acquire the shared manager and bind this surface's element to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasVideo rebinds when the <video> element mounts or unmounts with the URL.
  useEffect(() => {
    const manager = acquireVideoPlaybackManager(nodeId)
    managerRef.current = manager
    const element = videoRef.current
    const unbind = element ? manager.bindElement(slot, element) : undefined
    return () => {
      unbind?.()
      managerRef.current = null
      releaseVideoPlaybackManager(nodeId)
    }
  }, [nodeId, slot, hasVideo])

  // Keep the shared URL in sync. A change stops the old video and restarts at 0.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeId/slot re-sync the URL onto the freshly acquired manager after a rebind.
  useEffect(() => {
    managerRef.current?.setVideoUrl(videoUrl)
  }, [videoUrl, nodeId, slot])

  // Node slot only: suspend decoding while too small or off-screen, resume when
  // visible and large enough again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeId/hasVideo re-attach the observers to the current element after a rebind.
  useEffect(() => {
    if (!suspendWhenHidden || slot !== "node") return
    const element = videoRef.current
    if (!element || typeof IntersectionObserver === "undefined") return

    let intersecting = true
    const update = () => {
      const rect = element.getBoundingClientRect()
      const largeEnough =
        rect.width >= MIN_VIDEO_NODE_DIMENSION && rect.height >= MIN_VIDEO_NODE_DIMENSION
      managerRef.current?.setNodeAvailable(intersecting && largeEnough)
    }

    const intersectionObserver = new IntersectionObserver((entries) => {
      intersecting = entries[0]?.isIntersecting ?? true
      update()
    })
    intersectionObserver.observe(element)

    // Node resizes and viewport zoom both change the rendered box.
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(update)
      resizeObserver.observe(element)
    }

    update()

    return () => {
      intersectionObserver.disconnect()
      resizeObserver?.disconnect()
      managerRef.current?.setNodeAvailable(true)
    }
  }, [nodeId, slot, suspendWhenHidden, hasVideo])

  return { videoRef }
}
