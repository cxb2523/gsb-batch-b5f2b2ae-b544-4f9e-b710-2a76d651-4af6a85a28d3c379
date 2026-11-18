import { CanvasView, RenderContext, ThreeScene } from "@astralarium/pixi-three";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { FadeIn } from "#components/fade-in";
import { HoverCube } from "#components/hover-cube";
import { Button } from "#components/ui/button";

import { Frame } from "./-frame";

export const Route = createFileRoute("/example/scene-resize")({
  component: SceneResize,
});

const CONTAINER_SIZES = [
  { label: "Small", width: 240, height: 180 },
  { label: "Wide", width: 480, height: 200 },
  { label: "Tall", width: 240, height: 360 },
  { label: "Large", width: 480, height: 360 },
] as const;

const RESOLUTIONS = [1, 1.5, 2] as const;

function SceneResize() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sizeIndex, setSizeIndex] = useState(0);
  const [resolutionIndex, setResolutionIndex] = useState(2);
  const [frameloop, setFrameloop] = useState<"always" | "demand">("always");

  const container = CONTAINER_SIZES[sizeIndex];
  const resolution = RESOLUTIONS[resolutionIndex];

  return (
    <Frame
      title="Scene Resize"
      subtitle="Sprite, texture and hit area stay in sync on resize"
      sourceUrl="https://github.com/astralarium/pixi-three/blob/main/examples/routes/example/scene-resize.tsx"
      canvasRef={canvasRef}
    >
      <div className="flex flex-wrap items-center gap-2 p-4">
        <span className="text-muted-foreground text-sm">Container</span>
        {CONTAINER_SIZES.map((option, index) => (
          <Button
            key={option.label}
            size="sm"
            variant={index === sizeIndex ? "default" : "outline"}
            onClick={() => setSizeIndex(index)}
          >
            {option.label} {option.width}×{option.height}
          </Button>
        ))}
        <span className="text-muted-foreground ml-2 text-sm">Resolution</span>
        {RESOLUTIONS.map((value, index) => (
          <Button
            key={value}
            size="sm"
            variant={index === resolutionIndex ? "default" : "outline"}
            onClick={() => setResolutionIndex(index)}
          >
            {value}×
          </Button>
        ))}
        <span className="text-muted-foreground ml-2 text-sm">Frameloop</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setFrameloop((mode) => (mode === "always" ? "demand" : "always"))
          }
        >
          {frameloop}
        </Button>
        <span className="text-muted-foreground ml-auto text-sm">
          {container.width}×{container.height} @ {resolution}× ={" "}
          {Math.round(container.width * resolution)}×
          {Math.round(container.height * resolution)} px
        </span>
      </div>
      <div className="flex flex-1 items-start justify-center p-4">
        <div style={{ width: container.width, height: container.height }}>
          <RenderContext>
            <CanvasView alpha frameloop={frameloop} canvasRef={canvasRef}>
              <FadeIn>
                <ThreeScene frameloop={frameloop} resolution={resolution}>
                  <ambientLight intensity={0.5} />
                  <directionalLight position={[5, 5, 5]} intensity={1} />
                  <HoverCube position={[0, 0, 0]} />
                </ThreeScene>
              </FadeIn>
            </CanvasView>
          </RenderContext>
        </div>
      </div>
    </Frame>
  );
}
