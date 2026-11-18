"use client"

import type { Node, NodeProps } from "@xyflow/react"
import { memo } from "react"
import { useVideoPlayback } from "../../../hooks/use-video-playback"
import { BaseNodeWrapper } from "../base-node-wrapper"
import { VideoContent } from "./video-content"

interface VideoNodeData extends Record<string, unknown> {
  label?: string
  videoUrl?: string
}

function VideoNodeComponent({ id, data, selected, width, height }: NodeProps<Node<VideoNodeData>>) {
  const { videoRef } = useVideoPlayback({
    nodeId: id,
    slot: "node",
    videoUrl: data.videoUrl,
    suspendWhenHidden: true,
  })

  return (
    <BaseNodeWrapper
      nodeId={id}
      selected={selected}
      label={data.label}
      width={width}
      height={height}
      containerClassName="bg-black"
    >
      <VideoContent videoUrl={data.videoUrl} videoRef={videoRef} />
    </BaseNodeWrapper>
  )
}

export const VideoNode = memo(VideoNodeComponent)
