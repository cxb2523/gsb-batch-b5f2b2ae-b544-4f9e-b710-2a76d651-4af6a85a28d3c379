// Shared, DOM-free types for the bunny-hop simulation.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Input sampled once per rendered frame. */
export interface FrameInput {
  /** Forward/backward axis in [-1, 1] (W/S). */
  forward?: number;
  /** Left/right axis in [-1, 1] (A/D). */
  side?: number;
  /** Jump key/wheel held during the frame. */
  jump?: boolean;
  /** Horizontal mouse motion, in pixels, since the previous frame. */
  mouseDX?: number;
}

export interface SimulationOptions {
  /** Physics ticks per second. Defaults to 128 (dt = 1/128 s). */
  tickRate?: number;
  /** Downward acceleration in u/s². Defaults to 800. */
  gravity?: number;
  /** Peak height of a jump, in units. Defaults to 45. */
  jumpHeight?: number;
  /** Ground wish-speed cap (walk speed). Defaults to 250. */
  groundMaxSpeed?: number;
  /** Ground acceleration. Defaults to 10. */
  groundAccelerate?: number;
  /** Air acceleration. Defaults to 10 (Source-style). */
  airAccelerate?: number;
  /** Maximum wish speed in the air. Defaults to 30 u/s. */
  airWishSpeedCap?: number;
  /** Ground friction. Defaults to 4. */
  friction?: number;
  /** Speed below which friction hard-stops the body. Defaults to 100. */
  stopSpeed?: number;
  /** Radians of yaw per mouse pixel. Defaults to 0.0022. */
  mouseSensitivity?: number;
  /** Re-jump automatically on the tick the player lands. Defaults to true. */
  autoHop?: boolean;
  /**
   * Anti-spiral guard: the largest slice of real time a single frame() call
   * may simulate. Defaults to Infinity (simulate all of it).
   */
  maxFrameSeconds?: number;
  /** Height of the flat floor. Defaults to 0. */
  groundLevel?: number;
  /** Start position, also used by restart(). Defaults to (0, groundLevel, 0). */
  spawn?: Vec3;
}

export type TickEventType = 'jump' | 'land';

export interface TickEvent {
  type: TickEventType;
  /** 1-based tick number on which the event happened. */
  tick: number;
  /** True when the jump was produced by auto-hop rather than the jump key. */
  auto: boolean;
  position: Vec3;
  velocity: Vec3;
  /** Horizontal speed after the event, in u/s. */
  speed: number;
}

/** Plain, copy-safe snapshot of everything a HUD or test needs to observe. */
export interface SimulationState {
  position: Vec3;
  velocity: Vec3;
  /** Horizontal speed (u/s): what the speedometer shows. */
  speed: number;
  verticalSpeed: number;
  yaw: number;
  grounded: boolean;
  /** Number of fixed physics ticks simulated since the last restart. */
  tickCount: number;
  /** Simulated time: tickCount / tickRate. Excludes paused time. */
  simulatedTime: number;
  jumpCount: number;
  landingCount: number;
  /** Tick of the most recent jump, or -1. */
  lastJumpTick: number;
  /** Tick of the most recent landing, or -1. */
  lastLandingTick: number;
  /** Real seconds accumulated but not yet turned into a tick. */
  accumulator: number;
  /** Mouse yaw (radians) accumulated but not yet applied to a tick. */
  pendingMouseYaw: number;
  paused: boolean;
  autoHop: boolean;
  /** Per-frame mouse pixels absorbed, useful for interpolating the camera. */
  lastFrameMouseDX: number;
}

export interface FrameResult {
  /** Number of fixed physics ticks executed by this frame. */
  ticks: number;
  /** Events produced inside those ticks, in order. */
  events: TickEvent[];
  /** State after the frame (a copy). */
  state: SimulationState;
}
