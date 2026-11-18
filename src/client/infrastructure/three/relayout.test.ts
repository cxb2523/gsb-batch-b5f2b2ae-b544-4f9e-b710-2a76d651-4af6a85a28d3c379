// State convergence after an office rebuild: `npm test`
// Pure functions only (no three.js): they decide where every role, claim and cache entry ends up
// once the furniture and the solid grid have been regenerated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OfficeItem } from '../../../shared/catalog.ts';
import { solidGrid } from '../../../shared/catalog.ts';
import { convergeOnGrid, convergePositions, doorArrival, doorSlot, entranceColumn, type Relocatable } from './relayout.ts';

// A 6x4 office with a solid 2x1 block covering cells (2,1)-(3,1), plus a wall column at x=5.
const items: OfficeItem[] = [
  { id: 'desk-1', type: 'desk', x: 2, z: 1, rot: 0 },
  { id: 'wall-1', type: 'wall', x: 5, z: 0, rot: 0 },
  { id: 'wall-2', type: 'wall', x: 5, z: 1, rot: 0 },
  { id: 'wall-3', type: 'wall', x: 5, z: 2, rot: 0 },
  { id: 'wall-4', type: 'wall', x: 5, z: 3, rot: 0 },
];
const W = 6, D = 4;
const isSolid = (x: number, z: number) => solidGrid(items, W, D)[Math.floor(z) * W + Math.floor(x)] === 1;

const person = (id: string, x: number, z: number): Relocatable => ({ id, x, z });
const mutable = (id: string, x: number, z: number) => ({ id, x, z });

test('roles already on a walkable cell are never moved', () => {
  const people = [mutable('a', 0.5, 0.5), mutable('b', 4.5, 2.5)];
  const res = convergeOnGrid(people, items, W, D, (p, x, z) => { p.x = x; p.z = z; });
  assert.equal(res.moved.length, 0);
  assert.deepEqual(res.untouched.map(p => p.id), ['a', 'b']);
  assert.deepEqual([people[0]!.x, people[0]!.z], [0.5, 0.5]);
  assert.deepEqual([people[1]!.x, people[1]!.z], [4.5, 2.5]);
});

test('a role covered by new furniture walks to the nearest free cell center', () => {
  const stuck = mutable('a', 2.5, 1.5); // center of the desk footprint
  const res = convergeOnGrid([stuck], items, W, D, (p, x, z) => { p.x = x; p.z = z; });
  assert.equal(res.moved.length, 1);
  assert.deepEqual(res.moved[0]!.from, [2.5, 1.5]);
  assert.equal(isSolid(stuck.x, stuck.z), false, 'moved off the solid cell');
  // Nearest free cells to (2,1) are one step away; the destination must be a cell center (+0.5).
  assert.ok(Math.abs(stuck.x - Math.round(stuck.x - 0.5) - 0.5) < 1e-9);
  assert.ok(Math.hypot(stuck.x - 2.5, stuck.z - 1.5) <= Math.SQRT2 + 1e-9);
});

test('after convergence every role stands on a walkable cell of the new grid', () => {
  const people = [mutable('a', 2.5, 1.5), mutable('b', 5.5, 2.5), mutable('c', 0.5, 3.5), mutable('d', 4.5, 0.5)];
  convergeOnGrid(people, items, W, D, (p, x, z) => { p.x = x; p.z = z; });
  for (const p of people) assert.equal(isSolid(p.x, p.z), false, `${p.id} must not be in a solid cell`);
});

test('a role left outside a shrunken office is brought back inside, onto a free cell', () => {
  const outside = mutable('a', 9.5, 7.5); // beyond both new dimensions
  const res = convergeOnGrid([outside], items, W, D, (p, x, z) => { p.x = x; p.z = z; });
  assert.equal(res.moved.length, 1);
  assert.ok(outside.x >= 0 && outside.x < W && outside.z >= 0 && outside.z < D);
  assert.equal(isSolid(outside.x, outside.z), false);
});

test('door slots follow the new office width and depth, alternating sides', () => {
  const W2 = 10, D2 = 7;
  assert.equal(entranceColumn(W2), 5);
  assert.deepEqual(doorSlot(W2, D2, 0), { x: 5 + 2.2, z: D2 - 0.7 });
  assert.deepEqual(doorSlot(W2, D2, 1), { x: 5 - 2.2, z: D2 - 0.7 });
  assert.deepEqual(doorSlot(W2, D2, 2), { x: 5 + 3.0, z: D2 - 0.7 });
  assert.deepEqual(doorSlot(W2, D2, 3), { x: 5 - 3.0, z: D2 - 0.7 });
  // A smaller office recomputes the whole queue: nobody keeps the old depth.
  assert.equal(doorSlot(6, 4, 0).z, 4 - 0.7);
  const arrival = doorArrival(W2, D2, 0.2);
  assert.equal(arrival.z, D2 - 0.4);
  assert.equal(arrival.x, 5.2);
});

test('the position cache keeps only present roles on walkable cells, with rebuilt coordinates', () => {
  const present: Relocatable[] = [
    person('a', 0.5, 0.5), // free
    person('b', 2.5, 1.5), // currently still inside the desk (must be dropped, not cached)
    person('c', 4.5, 2.5), // free
  ];
  const cache = convergePositions(present, items, W, D);
  assert.deepEqual(Object.keys(cache).sort(), ['a', 'c']);
  assert.deepEqual(cache['a'], [0.5, 0.5]);
  assert.deepEqual(cache['c'], [4.5, 2.5]);
  assert.equal(cache['b'], undefined);
});

test('the rebuilt cache drops roles that have left, even with a stale entry', () => {
  // Same role ids as before, but the fired agent is absent from `present`; their old id cannot survive.
  const present: Relocatable[] = [person('a', 1.5, 0.5)];
  const cache = convergePositions(present, items, W, D);
  assert.deepEqual(Object.keys(cache), ['a']);
  assert.equal(cache['fired'], undefined);
});

test('coordinates are rounded to the hundredth so cache writes are stable', () => {
  const cache = convergePositions([person('a', 1.23456, 3.98765)], items, W, D);
  assert.deepEqual(cache['a'], [1.23, 3.99]);
});
