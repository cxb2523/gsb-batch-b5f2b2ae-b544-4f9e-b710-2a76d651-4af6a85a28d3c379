// State convergence after an office rebuild (headcount change, resize).
// Pure module (no three): the 3D world, tests and (potentially) the server all import it.
// A rebuild replaces furniture and the solid grid; every role, idle-point claim, visitor queue
// and position cache has to be re-derived against the NEW grid so nothing stays tied to the old layout.
import type { OfficeItem } from '../../../shared/catalog.ts';
import { solidGrid } from '../../../shared/catalog.ts';
import { nearestFree } from './pathfinding.ts';

/** A moving role (agent, visitor or the player) at one floor point in grid space. */
export interface Relocatable { id: string; x: number; z: number }

export interface RelocationResult<T extends Relocatable> {
  /** Roles whose old cell was solid/out of bounds; each got the nearest free cell. */
  moved: { id: string; from: [number, number]; to: [number, number] }[];
  /** Roles already standing on a walkable cell; untouched. */
  untouched: T[];
  /** Ids for which no walkable cell exists at all (an office always has free cells, so this stays empty). */
  trapped: string[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Moves every role that the new furniture/walls cover (or that ended up outside the new office)
 * onto the nearest walkable cell. Roles already on a free cell stay exactly where they are.
 * `apply` performs the actual move so the caller owns the three.js object mutation.
 */
export function convergeOnGrid<T extends Relocatable>(
  people: T[],
  items: OfficeItem[],
  W: number,
  D: number,
  apply: (person: T, x: number, z: number) => void,
): RelocationResult<T> {
  const grid = solidGrid(items, W, D);
  const moved: RelocationResult<T>['moved'] = [];
  const untouched: T[] = [];
  const trapped: string[] = [];
  for (const person of people) {
    const cx = Math.floor(person.x), cz = Math.floor(person.z);
    const inside = cx >= 0 && cz >= 0 && cx < W && cz < D;
    if (inside && !grid[cz * W + cx]) {
      untouched.push(person);
      continue;
    }
    // BFS from the covered cell (clamped when the office shrank) keeps the walk to the closest free cell short.
    const sx = Math.max(0, Math.min(W - 1, cx)), sz = Math.max(0, Math.min(D - 1, cz));
    const free = nearestFree(grid, W, D, sx, sz);
    if (!free) {
      trapped.push(person.id);
      continue;
    }
    const to: [number, number] = [free[0] + 0.5, free[1] + 0.5];
    moved.push({ id: person.id, from: [round2(person.x), round2(person.z)], to });
    apply(person, to[0], to[1]);
  }
  return { moved, untouched, trapped };
}

/** The door cell column: visitors queue just inside the front edge, whose center column is the entrance. */
export const entranceColumn = (W: number) => Math.floor(W / 2);

/** A waiting visitor's queue slot beside the entrance: pairs alternate sides, the rest line up behind. */
export function doorSlot(W: number, D: number, index: number): { x: number; z: number } {
  const side = index % 2 ? -1 : 1;
  const slot = Math.floor(index / 2);
  return { x: entranceColumn(W) + side * (2.2 + slot * 0.8), z: D - 0.7 };
}

/** Where a newly arrived or re-queued visitor first appears: just outside the front edge. */
export function doorArrival(W: number, D: number, jitter = 0): { x: number; z: number } {
  return { x: entranceColumn(W) + jitter, z: D - 0.4 };
}

/**
 * Rebuilds the floor-position cache for the new layout. Only roles still present and standing on a
 * walkable cell of the NEW office are kept, so the cache can never hold an old coordinate or a role
 * that has left. Returns a fresh object; the caller decides when to persist it.
 */
export function convergePositions(
  present: Relocatable[],
  items: OfficeItem[],
  W: number,
  D: number,
): Record<string, [number, number]> {
  const grid = solidGrid(items, W, D);
  const out: Record<string, [number, number]> = {};
  for (const p of present) {
    const cx = Math.floor(p.x), cz = Math.floor(p.z);
    if (cx < 0 || cz < 0 || cx >= W || cz >= D || grid[cz * W + cx]) continue;
    out[p.id] = [round2(p.x), round2(p.z)];
  }
  return out;
}
