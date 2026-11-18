"use client"

import { useNodesData } from "@xyflow/react"
import { useVideoPlayback } from "../../../hooks/use-video-playback"
import { VideoContent } from "./video-content"

interface FocusVideoContentProps {
  /** Id of the focused node, provided by the focus overlay. */
  nodeId: string
}

export function FocusVideoContent({ nodeId }: FocusVideoContentProps) {
  // Subscribe to the node's data so a videoUrl change (e.g. via a command)
  // switches the focus layer to the new video while it is open.
  const nodeData = useNodesData(nodeId)
  const videoUrl = nodeData?.data.videoUrl as string | undefined

  const { videoRef } = useVideoPlayback({ nodeId, slot: "focus", videoUrl })

  return <VideoContent videoUrl={videoUrl} variant="focus" videoRef={videoRef} />
}
