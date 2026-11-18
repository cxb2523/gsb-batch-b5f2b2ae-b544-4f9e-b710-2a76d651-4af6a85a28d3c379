// End-to-end convergence of the 3D World across an office rebuild: `npm test`.
// Runs headless with the DOM/WebGL stubs in domStubs.ts (no real rendering, only world logic).
// domStubs installs its globals at module load, before world.ts (and furniture.ts) are imported.
import './domStubs.ts';
import { makeElement, noopCallbacks } from './domStubs.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, POSITIONS_KEY } from './world.ts';
import { planOffice } from '../../../shared/layout.ts';
import type { Office, PublicAgent, Visitor } from '../../../shared/types.ts';
import { solidGrid } from '../../../shared/catalog.ts';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return { map, storage: { get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) } };
};

const makeAgents = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: 'a' + i, hiredAt: i, team: '' }));

const publicAgent = (a: { id: string; hiredAt: number; team: string }, deskId?: string | null): PublicAgent => ({
  ...a,
  name: 'Agent ' + a.id,
  kind: 'agent',
  role: '',
  provider: '',
  color: '#3b82f6',
  prompt: '',
  model: '',
  cwd: '',
  permissionMode: '',
  allowedTools: '',
  sessionId: null,
  totalCost: 0,
  status: 'idle',
  activity: '',
  currentTaskId: null,
  queued: 0,
  deskId: deskId ?? null,
});

const officeOf = (n: number): Office => {
  const plan = planOffice(makeAgents(n));
  return { name: 'Office', width: plan.width, depth: plan.depth, floorColor: '#eeeeee', wallColor: '#cccccc', items: plan.items };
};

const solidAt = (world: World, x: number, z: number) =>
  world.grid[Math.floor(z) * world.office.width + Math.floor(x)] === 1;

/** Builds a World whose GPU draw calls are inert: the headless stub drives the logic but cannot render. */
const headlessWorld = (storage?: { get: (k: string) => string | null; set: (k: string, v: string) => void }) => {
  const world = new World(makeElement() as unknown as HTMLElement, { ...noopCallbacks, ...(storage ? { storage } : {}) });
  world.composer.render = () => {};
  world.labels.render = () => {};
  return world;
};

/**
 * Runs one logic tick without the real GPU pipeline (which the headless stub cannot provide):
 * avatar decisions, movement and separation all still run; only the final draw calls are skipped.
 */
const tick = (world: World) => world.frame();

const visitor = (id: string, status: Visitor['status'] = 'waiting'): Visitor => ({
  id, kind: id.startsWith('pr') ? 'pr' : 'issue', number: Number(id.split('-')[1]), title: 'T ' + id,
  url: '', author: '', body: '', status, agentId: null, createdAt: 0, decidedAt: null,
});

test('after a rebuild no avatar is left on a solid cell, and the move lands on a walkable cell center', () => {
  const { storage } = memoryStorage();
  const world = headlessWorld(storage);

  world.setOffice(officeOf(3));
  const plan3 = planOffice(makeAgents(3));
  world.setAgents(makeAgents(3).map(a => publicAgent(a, plan3.desks[a.id])));
  assert.equal(world.avatars.size, 3);

  // Force every avatar onto cells that the larger office fills with furniture, then rebuild.
  const big = officeOf(12);
  const grid = solidGrid(big.items, big.width, big.depth);
  const solidCell = big.items
    .flatMap(i => {
      const out: [number, number][] = [];
      for (let x = i.x; x < i.x + (i.w ?? 1); x++) for (let z = i.z; z < i.z + (i.d ?? 1); z++) out.push([x, z]);
      return out;
    })
    .find(([x, z]) => grid[z * big.width + x]);
  assert.ok(solidCell);
  for (const av of world.avatars.values()) av.group.position.set(solidCell![0] + 0.5, 0, solidCell![1] + 0.5);

  world.setOffice(big);

  assert.equal(world.avatars.size, 3, 'headcount unchanged: nobody is added or removed by the rebuild');
  for (const av of world.avatars.values()) {
    assert.equal(solidAt(world, av.x, av.z), false, `${av.id} must not stand inside furniture or a wall`);
    assert.ok(av.x >= 0 && av.x < world.office.width && av.z >= 0 && av.z < world.office.depth);
    assert.equal(av.path.length, 0, 'old paths are discarded');
  }
});

test('rebuild clears idle-spot claims: a spot freed by the rebuild can be claimed again and is never double-held', () => {
  const { storage } = memoryStorage();
  const world = headlessWorld(storage);
  world.setOffice(officeOf(10));
  const plan = planOffice(makeAgents(10));
  world.setAgents(makeAgents(10).map(a => publicAgent(a, plan.desks[a.id])));

  // Simulate the pre-rebuild world: two avatars hold idle spots of the old layout.
  const [first, second] = [...world.avatars.values()];
  world.spotClaims.set('sofa-9#0', first.id);
  world.claimedPoints.set('sofa-9#0', { x: 1, z: 1 });
  first.spot = 'sofa-9#0';
  world.spotClaims.set('bed-3#1', second.id);
  world.claimedPoints.set('bed-3#1', { x: 2, z: 2 });
  second.spot = 'bed-3#1';
  assert.equal(world.spotClaims.size, 2);

  world.setOffice(officeOf(4));

  assert.equal(world.spotClaims.size, 0, 'all old spot claims are cleared by the rebuild');
  assert.equal(world.claimedPoints.size, 0);
  for (const av of world.avatars.values()) assert.equal(av.spot, null, 'no avatar keeps holding an old spot');
  assert.equal(world.contacts.size, 0, 'old contact records are cleared');

  // The new layout's spots are all claimable: drive several decision cycles so every idle avatar re-chooses.
  for (let i = 0; i < 5; i++) tick(world);
  const held = [...world.spotClaims.values()];
  assert.equal(new Set(held).size, held.length, 'an idle spot is held by at most one avatar');
  // Every claim points at a spot that still exists in the new furniture and is held by its avatar alone.
  for (const [key, holderId] of world.spotClaims) {
    const [itemId] = key.split('#');
    assert.ok(world.office.items.some(i => i.id === itemId), `claimed spot ${key} belongs to an item that exists`);
    const holder = world.avatars.get(holderId);
    assert.ok(holder && holder.spot === key, 'the claim and the avatar’s held spot agree');
    assert.equal([...world.spotClaims.values()].filter(id => id === holderId).length, 1, 'an avatar holds at most one spot');
  }
});

test('an idle goal pointing at a spot that no longer exists is re-decided after the rebuild', () => {
  const { storage } = memoryStorage();
  const world = headlessWorld(storage);
  world.setOffice(officeOf(10));
  const plan = planOffice(makeAgents(10));
  world.setAgents(makeAgents(10).map(a => publicAgent(a, plan.desks[a.id])));
  const av = [...world.avatars.values()][0]!;
  av.idleGoal = { x: 99, z: 99, pose: 'stand', key: 'poi:old-item#2' };
  av.idleUntil = Number.POSITIVE_INFINITY; // without the reset, decide() would keep this stale goal forever

  world.setOffice(officeOf(3));
  tick(world);

  assert.notEqual(av.idleGoal?.key, 'poi:old-item#2');
  assert.ok(av.idleGoal === null || typeof av.idleGoal.key === 'string');
  if (av.idleGoal && 'x' in av.idleGoal) {
    assert.equal(solidAt(world, av.idleGoal.x, av.idleGoal.z), false, 'the new goal is walkable');
  }
});

test('visitors added and removed around a rebuild leave the right scene objects, queued by the new entrance', async () => {
  const { storage } = memoryStorage();
  const world = headlessWorld(storage);
  world.setOffice(officeOf(5));
  world.setVisitors([visitor('issue-1'), visitor('pr-2')]);
  assert.equal(world.visitors.size, 2);
  assert.equal(world.agentGroup.children.filter(o => o.userData.agentId?.startsWith('visitor:')).length, 2);

  // Rebuild at a different size; the same visitors re-queue against the new door.
  const small = officeOf(3);
  world.setOffice(small);
  assert.equal(world.visitors.size, 2);
  for (const av of world.visitors.values()) {
    assert.ok(av.home, 'every waiting visitor gets a door slot');
    assert.equal(solidAt(world, av.x, av.z), false, 'no visitor starts inside a new wall');
    assert.ok(av.home!.z === small.depth - 0.7, 'the queue follows the new depth');
  }

  // One leaves (rejected), a new one arrives: the leaver walks out while the newcomer enters.
  world.setVisitors([visitor('issue-1'), visitor('issue-3')]);
  assert.equal(world.visitors.size, 3); // issue-1 + issue-3 + pr-2 (still dismissing until its exit timer)
  const labelsNow = () => world.agentGroup.children.filter(o => o.userData.agentId?.startsWith('visitor:')).map(o => o.userData.agentId);
  assert.ok(labelsNow().includes('visitor:issue-1'));
  assert.ok(labelsNow().includes('visitor:issue-3'));
  assert.ok(labelsNow().includes('visitor:pr-2'), 'the leaving visitor is still walking out');

  // The dismissal finishes on its timer: then its tag and scene object are gone, no residue.
  await new Promise(resolve => setTimeout(resolve, 3800));
  const labels = labelsNow();
  assert.equal(world.visitors.size, 2);
  assert.ok(!labels.includes('visitor:pr-2'), 'the removed visitor is taken out of the scene');
  assert.deepEqual(labels.sort(), ['visitor:issue-1', 'visitor:issue-3']);

  // Everybody leaves: no visitor objects remain.
  world.setVisitors([]);
  await new Promise(resolve => setTimeout(resolve, 3800));
  assert.equal(world.visitors.size, 0);
  assert.equal(world.agentGroup.children.filter(o => o.userData.agentId?.startsWith('visitor:')).length, 0);
});

test('the position cache is rebuilt from post-rebuild coordinates and never keeps a solid-cell or stale entry', () => {
  const { map, storage } = memoryStorage();
  const world = headlessWorld(storage);
  world.setOffice(officeOf(5));
  const plan = planOffice(makeAgents(5));
  world.setAgents(makeAgents(5).map(a => publicAgent(a, plan.desks[a.id])));
  tick(world);
  world.savePositions();
  assert.ok(map.has(POSITIONS_KEY));

  // Plant an avatar on a cell the new office fills, and poison the cache with an old coordinate.
  const big = officeOf(12);
  const grid = solidGrid(big.items, big.width, big.depth);
  const solidCell = big.items
    .flatMap(i => {
      const out: [number, number][] = [];
      for (let x = i.x; x < i.x + (i.w ?? 1); x++) for (let z = i.z; z < i.z + (i.d ?? 1); z++) out.push([x, z]);
      return out;
    })
    .find(([x, z]) => grid[z * big.width + x])!;
  const target = [...world.avatars.values()][0]!;
  target.group.position.set(solidCell[0] + 0.5, 0, solidCell[1] + 0.5);
  map.set(POSITIONS_KEY, JSON.stringify({ ...JSON.parse(map.get(POSITIONS_KEY)!), gone: [99, 99] }));

  world.setOffice(big);

  const cached = JSON.parse(map.get(POSITIONS_KEY)!) as Record<string, [number, number]>;
  // The cache holds exactly the roles on stage after the rebuild (agents + the player), nobody else.
  const expectedIds = [...world.allAvatars().map(av => av.id)].sort();
  assert.deepEqual(Object.keys(cached).sort(), expectedIds, 'only roles present after the rebuild are cached');
  assert.equal(cached['gone'], undefined, 'a removed role cannot survive in the cache');
  for (const av of world.allAvatars()) {
    assert.deepEqual(cached[av.id], [Math.round(av.x * 100) / 100, Math.round(av.z * 100) / 100], 'cache matches the current position');
    assert.equal(solidAt(world, cached[av.id]![0], cached[av.id]![1]), false, 'cached coordinates are walkable');
  }
});

test('the very first office build keeps the persisted cache until agents attach and restore their spots', () => {
  const persisted = { a0: [1.5, 2.5], a1: [3.25, 4.75] };
  const { storage } = memoryStorage();
  storage.set(POSITIONS_KEY, JSON.stringify(persisted));
  const world = headlessWorld(storage);

  // In applySnapshot() the office arrives before the agent list: setOffice must not wipe their saved coordinates.
  world.setOffice(officeOf(5));
  assert.deepEqual(JSON.parse(storage.get(POSITIONS_KEY)!), persisted, 'the first build leaves the restored cache untouched');

  // An agent attaching afterwards is placed on its remembered (walkable) coordinate.
  const plan = planOffice(makeAgents(5));
  world.upsertAgent(publicAgent({ id: 'a0', hiredAt: 0, team: '' }, plan.desks['a0']));
  const a0 = world.avatars.get('a0')!;
  assert.deepEqual([Math.round(a0.x * 100) / 100, Math.round(a0.z * 100) / 100], persisted.a0);
});

test('a size change shifts the camera without dropping its target into a solid cell', () => {
  const { storage } = memoryStorage();
  const world = headlessWorld(storage);
  world.setOffice(officeOf(3));
  const before = world.controls.target.clone();

  world.setOffice(officeOf(20)); // much larger office: root is re-centered

  const target = world.root.worldToLocal(world.controls.target.clone());
  assert.equal(solidAt(world, target.x, target.z), false, 'the orbit target stays on a walkable cell');
  assert.notDeepEqual(world.controls.target, before, 'the camera followed the re-centering');
  assert.ok(Number.isFinite(world.camera.position.x) && Number.isFinite(world.camera.position.z));
});
