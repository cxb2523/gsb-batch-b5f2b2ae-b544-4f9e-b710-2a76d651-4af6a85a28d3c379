import { easeInOutSine, easeTapZ } from "./Easings";

const DEFAULT_DURATION = 2500;
const DEFAULT_DROP_DEPTH = 30;
const DEFAULT_HORIZONTAL_OFFSET = 25;
const DEFAULT_BANKING_OFFSET = 0.35;

interface TapState {
    /** Animation progress in the 0..1 range. */
    timer: number;
    /** Current offsets added to the plane position. */
    offsetX: number;
    offsetY: number;
    offsetZ: number;
    /** Current random roll added to the plane banking. */
    offsetBanking: number;
    /** Random horizontal displacement and banking of the current animation. */
    randomX: number;
    randomY: number;
    randomBanking: number;
}

/**
 * Animated tap offsets keyed by plane identity.
 *
 * Offsets and timers are stored per plane key, not per draw order index: a
 * formation switch changes the draw order (and the number of drawn planes),
 * but a tap animation always follows the plane it was started for. If that
 * plane is no longer part of the formation, its animation is discarded
 * cleanly by `retain()`, so it can never be shown on a different plane.
 */
export class PlaneTapAnimator {
    private readonly duration: number;
    private readonly dropDepth: number;
    private readonly horizontalOffset: number;
    private readonly bankingOffset: number;

    /** Running and settled animations, keyed by plane identity. */
    private readonly states = new Map<string, TapState>();

    constructor(
        duration = DEFAULT_DURATION,
        dropDepth = DEFAULT_DROP_DEPTH,
        horizontalOffset = DEFAULT_HORIZONTAL_OFFSET,
        bankingOffset = DEFAULT_BANKING_OFFSET
    ) {
        this.duration = duration;
        this.dropDepth = dropDepth;
        this.horizontalOffset = horizontalOffset;
        this.bankingOffset = bankingOffset;
    }

    /**
     * Starts the tap animation for the plane with the given identity key.
     * Does nothing while that plane's animation is already running.
     */
    tap(key: string): void {
        if (this.states.has(key)) {
            return;
        }

        // Random direction, with a visible amount of roll.
        const bankingDirection = Math.random() > 0.5 ? 1 : -1;

        this.states.set(key, {
            timer: 0,
            offsetX: 0,
            offsetY: 0,
            offsetZ: 0,
            offsetBanking: 0,
            randomX: (Math.random() * 2 - 1) * this.horizontalOffset,
            randomY: (Math.random() * 2 - 1) * this.horizontalOffset,
            randomBanking: bankingDirection * (0.5 + Math.random() * 0.5) * this.bankingOffset
        });
    }

    /**
     * Drops animations of planes which are not in the given set of keys.
     *
     * Called when the formation changes. Animations of planes which are still
     * part of the formation keep playing, keyed by their identity; animations
     * of planes which left the formation end immediately and cannot leak onto
     * another plane.
     */
    retain(keys: Iterable<string>): void {
        const keep = new Set(keys);
        for (const key of Array.from(this.states.keys())) {
            if (!keep.has(key)) {
                this.states.delete(key);
            }
        }
    }

    /** Stops and clears all animations. */
    clear(): void {
        this.states.clear();
    }

    /** Whether the plane with the given key currently plays the tap animation. */
    isAnimating(key: string): boolean {
        return this.states.has(key);
    }

    /** Advances all running animations by the given number of milliseconds. */
    update(deltaMs: number): void {
        for (const [key, state] of Array.from(this.states.entries())) {
            state.timer += deltaMs / this.duration;
            if (state.timer >= 1) {
                // The animation has fully settled: forget it, offsets read as zero.
                this.states.delete(key);
                continue;
            }

            const t = state.timer;

            // Fast drop, small wobble, slow return to the original height.
            state.offsetZ = easeTapZ(t) * this.dropDepth;

            // Smooth in-out displacement and roll to the random position and back.
            const horizontalProgress = t < 0.5 ? t * 2 : (1 - t) * 2;
            const horizontalEase = easeInOutSine(horizontalProgress);
            state.offsetX = state.randomX * horizontalEase;
            state.offsetY = state.randomY * horizontalEase;
            state.offsetBanking = state.randomBanking * horizontalEase;
        }
    }

    getOffsetX(key: string): number {
        return this.states.get(key)?.offsetX ?? 0;
    }

    getOffsetY(key: string): number {
        return this.states.get(key)?.offsetY ?? 0;
    }

    getOffsetZ(key: string): number {
        return this.states.get(key)?.offsetZ ?? 0;
    }

    getBankingOffset(key: string): number {
        return this.states.get(key)?.offsetBanking ?? 0;
    }
}
