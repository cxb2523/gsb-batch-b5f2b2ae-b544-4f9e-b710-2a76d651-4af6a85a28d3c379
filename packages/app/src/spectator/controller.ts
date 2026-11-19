// Owns spectator camera policy: which survivor to follow (or free
// overview), cycling between survivors, and handing the render package's
// SmoothedCamera a fresh target every frame so motion is eased rather
// than snapped. This is the "client side" of spectate-on-death: it reads
// a MatchAdapter and a live fighter-position list, and produces a
// CameraView the renderer paints verbatim via RenderFrame.cameraOverride.
import {
  computeFollowCamera,
  computeOverviewCamera,
  SmoothedCamera,
  type ArenaBounds,
  type CameraView,
} from '@bash-fighter/render';
import type { MatchAdapter } from './types.ts';

export type SpectatorMode = 'follow' | 'overview';

export interface SpectatorFrameInput {
  positions: readonly { x: number; y: number }[]; // indexed like the sim
  viewWidth: number;
  viewHeight: number;
  arena: ArenaBounds;
  dtSeconds: number;
}

const FOLLOW_SCALE = 4.5;
const FOLLOW_VERTICAL_OFFSET = 8;
const OVERVIEW_MIN_SCALE = 1.6;
const OVERVIEW_MAX_SCALE = 5.5;
const OVERVIEW_PADDING = 20;

export class SpectatorController {
  private mode: SpectatorMode = 'follow';
  private followIndex: number | null = null;
  private readonly camera: SmoothedCamera;
  private active = false;
  private readonly adapter: MatchAdapter;
  private readonly localIndex: number;
  /** Set whenever the camera's subject changes discontinuously -- entering
   * spectate, TAB-cycling to a different survivor, toggling overview, or
   * the tab coming back from the background. The next update() snaps
   * straight onto the new target instead of gliding over from the old
   * one (a long, wrong slide across the arena). */
  private snapNextFrame = false;

  // Not a TS parameter-property constructor: this class is imported
  // directly (not through vite) by plain `node --test` regression tests,
  // and Node's built-in type-stripping loader does not support parameter
  // properties (same constraint net-match.ts documents).
  constructor(
    adapter: MatchAdapter,
    /** The local slot spectating (excluded from follow/cycle targets). */
    localIndex: number,
    initialView: CameraView,
  ) {
    this.adapter = adapter;
    this.localIndex = localIndex;
    this.camera = new SmoothedCamera(initialView);
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentMode(): SpectatorMode {
    return this.mode;
  }

  get followedIndex(): number | null {
    return this.followIndex;
  }

  /** Called once, the frame the local player is eliminated. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.mode = 'follow';
    this.followIndex = this.pickInitialTarget();
    // The camera was constructed at match start (its initial view is a
    // static arena-centre guess) and has been idle all match -- gliding
    // from that stale spot to the first follow target would be a long,
    // wrong slide. Land on the target instead.
    this.snapNextFrame = true;
  }

  deactivate(): void {
    this.active = false;
    this.followIndex = null;
  }

  toggleOverview(): void {
    this.mode = this.mode === 'overview' ? 'follow' : 'overview';
    if (this.mode === 'follow' && this.followIndex === null) {
      this.followIndex = this.pickInitialTarget();
    }
    // Overview <-> follow is a cut between two different framings, not a
    // move within one.
    this.snapNextFrame = true;
  }

  /** Cycle to the next surviving fighter (wraps around). */
  cycleNext(): void {
    const survivors = this.adapter.survivorIndices().filter((i) => i !== this.localIndex);
    if (survivors.length === 0) {
      this.followIndex = null;
      return;
    }
    this.mode = 'follow';
    const currentPos = this.followIndex === null ? -1 : survivors.indexOf(this.followIndex);
    const next = survivors[(currentPos + 1 + survivors.length) % survivors.length];
    const changed = next !== this.followIndex;
    this.followIndex = next ?? null;
    // TAB retargets whom we watch: the camera (and, on a narrow screen,
    // the min-fighter-size follow framing derived from it) must land on
    // the new survivor, not ease over from the previous one.
    if (changed) this.snapNextFrame = true;
  }

  /** External "the world changed discontinuously" signal (e.g. the tab
   * came back from the background): snap to the current target on the
   * next update instead of easing across the gap. */
  snapToNextTarget(): void {
    this.snapNextFrame = true;
  }

  private pickInitialTarget(): number | null {
    const survivors = this.adapter.survivorIndices().filter((i) => i !== this.localIndex);
    return survivors.length > 0 ? (survivors[0] as number) : null;
  }

  /** Compute this frame's smoothed camera. Safe to call with zero
   * survivors (falls back to framing the whole arena). */
  update(input: SpectatorFrameInput): CameraView {
    // Keep the follow target valid if it was eliminated since last frame.
    if (this.followIndex !== null && this.adapter.status(this.followIndex).eliminated) {
      this.followIndex = this.pickInitialTarget();
    }

    let target: CameraView;
    if (this.mode === 'follow' && this.followIndex !== null && input.positions[this.followIndex]) {
      target = computeFollowCamera(input.positions[this.followIndex] as { x: number; y: number }, {
        viewWidth: input.viewWidth,
        viewHeight: input.viewHeight,
        scale: FOLLOW_SCALE,
        verticalOffset: FOLLOW_VERTICAL_OFFSET,
      });
    } else {
      const survivorPositions = this.adapter
        .survivorIndices()
        .map((i) => input.positions[i])
        .filter((p): p is { x: number; y: number } => p !== undefined);
      target = computeOverviewCamera(
        survivorPositions,
        input.arena,
        input.viewWidth,
        input.viewHeight,
        OVERVIEW_MIN_SCALE,
        OVERVIEW_MAX_SCALE,
        OVERVIEW_PADDING,
      );
    }
    if (this.snapNextFrame) {
      this.snapNextFrame = false;
      this.camera.snapTo(target);
      return this.camera.current;
    }
    return this.camera.update(target, input.dtSeconds);
  }
}
