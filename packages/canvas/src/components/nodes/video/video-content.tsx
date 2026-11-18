"use client"

import type { Ref } from "react"
import { cn } from "../../../lib/utils"

interface VideoContentProps {
  videoUrl?: string
  variant?: "node" | "focus"
  /**
   * Ref through which the shared playback manager drives this element.
   * The `src` attribute is intentionally not set from JSX — the manager
   * assigns and releases it so only one surface decodes at a time.
   */
  videoRef?: Ref<HTMLVideoElement>
}

const EmptyPlaceholder = (
  <div className="flex h-full w-full items-center justify-center bg-secondary text-muted-foreground">
    No video
  </div>
)

export function VideoContent({ videoUrl, variant = "node", videoRef }: VideoContentProps) {
  if (!videoUrl) {
    return EmptyPlaceholder
  }

  const isFocus = variant === "focus"

  return (
    <video
      ref={videoRef}
      className={cn(
        "h-full w-full",
        isFocus ? "object-contain" : "object-cover",
        !isFocus && "pointer-events-none"
      )}
      controls={isFocus}
      autoPlay
      muted
      loop
      playsInline
    />
  )
}
