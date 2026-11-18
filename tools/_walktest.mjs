/* Walks the wash, in Node, against the real path and the real height field.
 *
 * The question the corridor has to answer is not "does it stop you" — that is
 * easy and a hard clamp would do it — but "can you feel it while walking the
 * walk". That is a question about a trajectory, so it needs one driven, and
 * driving it in the page costs a six-minute SwiftShader boot per attempt.
 *
 * `src/corridor.js` is pure JavaScript over the height field and the velocity
 * model in `src/main.js`'s `step` is eight lines, so the whole thing runs here
 * in a second. The model below is copied from `step` deliberately rather than
 * imported: `main.js` owns the canvas and cannot be loaded without a document.
 * If the two ever drift the walk test is measuring a game nobody is playing, so
 * keep them together.
 *
 *   node tools/_walktest.mjs
 */
import { WashPath } from '../src/path.js';
import { Terrain } from '../src/terrain.js';
import { buildCorridor, confine, corridorAt, corridorState, projectInside, BAND } from '../src/corridor.js';

const path = new WashPath();
const terrain = new Terrain(path);
const corridor = buildCorridor(path, terrain);

const DT = 1 / 120;
const _q = {};
const groundAt = (x, z) => terrain.heightAtQ(x, z, path.atZ(z, _q));

/* Jump constants, mirroring src/main.js. */
const G = 9.81, JUMP_H = 0.45, JUMP_V = Math.sqrt(2 * G * JUMP_H);

function spawn(d) {
  const p = path.posAt(d);
  return { x: p.x, y: groundAt(p.x, p.z), z: p.z, vx: 0, vz: 0,
           vy: 0, air: false, settle: 0, settleV: 0,
           yaw: path.headingAt(d), pitch: 0, bob: 0, bob0: 0 };
}

/* The landing spring, mirrored from `src/main.js`. It is the one piece of the
   frame whose absence would make the fixed point look better than it is: a
   walker with no spring would never have to prove that the spring returns to
   zero after a projected landing. */
const SETTLE_W = 8;
function settleStep(pl) {
  if (!pl.settle && !pl.settleV) return;
  const a = -SETTLE_W * SETTLE_W * pl.settle - 2 * SETTLE_W * pl.settleV;
  pl.settleV += a * DT;
  pl.settle += pl.settleV * DT;
  if (Math.abs(pl.settle) < 1e-4 && Math.abs(pl.settleV) < 1e-4) {
    pl.settle = 0; pl.settleV = 0;
  }
}

/** One frame of src/main.js's `step`, with the keys given as f/r in [-1, 1].
 *  `sp` is the Space key: it jumps only from the ground, as in the page. */
function step(pl, f, r, speed, sp) {
  let ax = 0, az = 0;
  if (f || r) {
    const s = Math.sin(pl.yaw), c = Math.cos(pl.yaw);
    ax = s * f + c * r;
    az = -c * f + s * r;
    const l = Math.hypot(ax, az) || 1;
    ax = ax / l * speed; az = az / l * speed;
  }
  if (!pl.air) {
    const k = 1 - Math.exp(-12 * DT);
    pl.vx += (ax - pl.vx) * k;
    pl.vz += (az - pl.vz) * k;
    if (!f && !r && Math.hypot(pl.vx, pl.vz) < 0.004) { pl.vx = 0; pl.vz = 0; }
  }

  /* The jump, after the ground acceleration, with the same push-off as the page. */
  if (sp && !pl.air) {
    pl.air = true; pl.vy = JUMP_V;
    const l = Math.hypot(ax, az);
    if (l) {
      const v = Math.max(Math.hypot(pl.vx, pl.vz), 1.55);
      pl.vx = ax / l * v; pl.vz = az / l * v;
    }
  }

  /* Confinement runs airborne too, which is the reason a jump cannot be used to
     cross the corridor: the limit is on lateral velocity and the arc has no
     steering of its own to spend. */
  const hit = confine(corridor, path, pl, path.atZ(pl.z, _q), DT);

  pl.x += pl.vx * DT;
  pl.z += pl.vz * DT;

  /* The position invariant, exactly as src/main.js applies it: after
     integration, before the ground is read. */
  projectInside(corridor, path, pl);

  const g0 = groundAt(pl.x, pl.z);
  if (pl.air) {
    pl.vy -= G * DT;
    pl.y += pl.vy * DT;
    if (pl.y <= g0) {
      pl.y = g0; pl.air = false;
      /* The impact hands the spring a downward velocity; `arrest`, mirrored. */
      pl.settleV += Math.min(-pl.vy, 1.5 / 0.25) * 0.25;
      pl.vy = 0;
    }
  } else {
    pl.y = g0;
  }
  settleStep(pl);
  return hit;
}

function state(pl) {
  const q = path.atZ(pl.z, _q);
  const u = (pl.x - q.x) * Math.cos(q.th);
  return { s: q.s, u, lim: corridorAt(corridor, q.s, u >= 0 ? 1 : -1) };
}

/* The invariant under test, in one place: on *every* frame, of *every* path —
 * walking, jumping, turbo strafing, and both ends of the walk — the player's
 * lateral distance from the centreline must not exceed the corridor width there.
 * This is the assertion the soft band alone could not make: it bounded velocity,
 * and the position could still be up to a frame of travel outside. */
const INVARIANT_EPS = 1e-6;
function invariant(pl) {
  const st = state(pl);
  const over = Math.abs(st.u) - st.lim;
  const endOver = Math.max(corridor.sMin - st.s, st.s - corridor.sMax);
  return { ...st, over, endOver, ok: over <= INVARIANT_EPS && endOver <= INVARIANT_EPS };
}

let fails = 0;
const check = (ok, name, detail) => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
};

console.log('\nwalk test — the corridor, driven\n');

/* ── 1. the walk itself ────────────────────────────────────────────────────
 * A walker who follows the wash but does not follow it perfectly. The steer
 * holds a wandering lateral target rather than the centreline, because nobody
 * walks a line: this one drifts up to about four metres either side, which is
 * more than a person following a channel actually does. */
{
  const pl = spawn(0);
  let side = 0, ends = 0, endFrom = Infinity, maxU = 0, minHead = Infinity;
  let t = 0, worstS = 0, far = -Infinity;
  for (let n = 0; n < 120 * 400; n++) {
    t += DT;
    const st = state(pl);
    if (st.s > far) far = st.s;
    if (st.s > corridor.sMax - 0.05) break;
    const want = 4.0 * Math.sin(t * 0.11) + 2.0 * Math.sin(t * 0.037 + 1.3);
    /* Steer toward the wandering target: heading, plus a correction bounded at
       thirty degrees so it is a walk and not a slalom. */
    const corr = Math.max(-0.52, Math.min(0.52, (want - st.u) * 0.25));
    pl.yaw = path.headingAt(st.s) + corr;
    const hit = step(pl, 1, 0, 1.55);
    if (hit & 1) side++;
    if (hit & 2) { ends++; endFrom = Math.min(endFrom, corridor.sMax - st.s); }
    const au = Math.abs(st.u);
    if (au > maxU) maxU = au;
    if (st.lim - au < minHead) { minHead = st.lim - au; worstS = st.s; }
  }
  check(far > corridor.sMax - 0.5, 'the whole route is walkable',
        `reached s=${far.toFixed(1)} of ${corridor.sMax.toFixed(1)} in ${(t / 60).toFixed(1)} min`);
  check(side === 0, 'never nudged sideways while walking the walk',
        `${side} frames touched, |u| peaked at ${maxU.toFixed(2)} m`);
  check(minHead > BAND, 'never even entered the lateral soft band',
        `closest approach ${minHead.toFixed(2)} m of clearance at s=${worstS.toFixed(0)}`);
  /* The other limit is *supposed* to be felt, once, at the head of the walk —
     that is what arriving somewhere is. What must not happen is meeting it
     early, so what is checked is where it first engages and not whether. */
  check(!ends || endFrom <= BAND + 0.05, 'the head of the wash is the only stop',
        ends ? `first felt ${endFrom.toFixed(2)} m short of the head` : 'never reached');
}

/* ── 2. walking straight at a wall ───────────────────────────────────────── */
for (const d of [8, 46, 120, 220, 300]) {
  for (const r of [1, -1]) {
    const pl = spawn(d);
    /* Turbo, which is the 12 m/s cheat and the fastest anything can arrive at
       the limit. Sixty seconds of it is 720 m of shoving. */
    let over = 0, maxOver = 0;
    for (let n = 0; n < 120 * 60; n++) {
      step(pl, 0, r, 12);
      const st = invariant(pl);
      if (!st.ok) { over++; if (st.over > maxOver) maxOver = st.over; }
    }
    const st = state(pl);
    /* The invariant, on every frame rather than on the last one. This is what
       the velocity band could not guarantee: it bounded how fast the player
       left, and turbo still ran a frame's travel past the limit. */
    check(over === 0,
          `held at d=${d} strafing ${r > 0 ? 'right' : 'left '}`,
          `|u|=${Math.abs(st.u).toFixed(2)} against a limit of ${st.lim.toFixed(2)}` +
          (over ? `  (${over} frames up to ${maxOver.toFixed(3)} m outside)` : ''));
  }
}

/* ── 2b. the same while jumping, which is where the frame of overshoot was ── */
for (const d of [8, 46, 120, 220, 300]) {
  for (const r of [1, -1]) {
    const pl = spawn(d);
    let over = 0, maxOver = 0, air = 0, airFrames = 0;
    for (let n = 0; n < 120 * 60; n++) {
      const wasAir = pl.air;
      step(pl, 0, r, 12, !pl.air);
      const st = invariant(pl);
      airFrames++;
      if (pl.air) air++;
      if (!st.ok) {
        over++;
        if (wasAir) air++;             // count the airborne violations apart
        if (st.over > maxOver) maxOver = st.over;
      }
    }
    check(over === 0,
          `jumping at the wall d=${d} ${r > 0 ? 'right' : 'left '}`,
          `${(100 * air / airFrames).toFixed(0)}% airborne, worst over ` +
          `${over ? maxOver.toFixed(4) + ' m on ' + over + ' frames' : 'none'}`);
  }
}

/* ── 2c. a jump that is projected keeps its momentum and its landing ────────
 * The projection moves the position only. What must not happen is what a
 * velocity clamp would do if it were used as the fix: zero the speed, or change
 * the height the landing test compares against. So the check is that an airborne
 * frame which was pushed back still arrives at the ground height under its final
 * position, and that the spring then settles to exactly zero. */
{
  let bad = 0, worstLand = 0, unsettled = 0, tested = 0;
  for (let s = 8; s <= 320; s += 4) {
    for (const side of [1, -1]) {
      const lim = corridorAt(corridor, s, side);
      const p = path.posAt(s), th = path.headingAt(s);
      /* Start one stride inside the limit and jump outward at turbo, which is
         the case that reaches the projection airborne. */
      const pl = spawn(s);
      pl.x = p.x + Math.cos(th) * side * (lim - 1.0);
      pl.z = p.z + Math.sin(th) * side * (lim - 1.0);
      pl.y = groundAt(pl.x, pl.z);
      pl.yaw = path.headingAt(s) + side * Math.PI / 2;
      step(pl, 0, 1, 12, true);
      /* Give the settle the same step the page does, so "the spring finished"
         means the same thing in both places. */
      pl.settle = 0; pl.settleV = 0;
      let air = 0;
      while (pl.air && air < 120 * 2) { step(pl, 0, 1, 12, false); air++; }
      tested++;
      const g = groundAt(pl.x, pl.z);
      const d = Math.abs(pl.y - g);
      if (d > worstLand) worstLand = d;
      if (d > 1e-9) bad++;
      /* The settle settles: an airborne projection that handed the spring a
         velocity has to come back to zero, not stay dipped. */
      for (let n = 0; n < 120 * 3; n++) step(pl, 0, 0, 1.55, false);
      if (pl.settle !== 0 || pl.settleV !== 0) unsettled++;
    }
  }
  check(bad === 0, 'landing height is the height under the final position',
        `${tested} outward turbo jumps, worst off-surface ${worstLand.toExponential(1)} m`);
  check(unsettled === 0, 'and the landing spring still returns to zero',
        `${unsettled} of ${tested} left a settle residue`);
}

/* A jump into the projection must not have zeroed the speed: the arc is
   unchanged. Measured as the along-wall speed after the first constrained frame,
   which a velocity clamp would have cut. */
{
  const s = 46, side = 1;
  const lim = corridorAt(corridor, s, side);
  const p = path.posAt(s), th = path.headingAt(s);
  const pl = spawn(s);
  pl.x = p.x + Math.cos(th) * side * (lim - 0.6);
  pl.z = p.z + Math.sin(th) * side * (lim - 0.6);
  pl.y = groundAt(pl.x, pl.z);
  const v0 = 12;
  pl.vx = Math.cos(th) * side * v0; pl.vz = Math.sin(th) * side * v0;
  pl.air = true; pl.vy = JUMP_V;
  step(pl, 0, 0, 1.55, false);
  const speed = Math.hypot(pl.vx, pl.vz);
  check(speed > 0 && pl.vy !== 0,
        'a constrained jump keeps its speed and its vy',
        `speed ${speed.toFixed(2)} m/s, vy ${pl.vy.toFixed(2)} m/s after one projected frame`);
}

/* ── 3. the two ends of the walk ─────────────────────────────────────────── */
{
  const pl = spawn(0);
  pl.yaw = path.headingAt(0) + Math.PI;      // turned round at the start
  for (let n = 0; n < 120 * 60; n++) step(pl, 1, 0, 12);
  const st = state(pl);
  check(st.s >= corridor.sMin - 0.01 && pl.z < 30, 'turned round and walked back',
        `s=${st.s.toFixed(2)} against a floor of ${corridor.sMin}, z=${pl.z.toFixed(1)}`);
}
{
  const pl = spawn(300);
  for (let n = 0; n < 120 * 60; n++) step(pl, 1, 0, 12);
  const st = state(pl);
  check(st.s <= corridor.sMax + 0.01, 'ran at the head of the wash',
        `s=${st.s.toFixed(2)} against a ceiling of ${corridor.sMax.toFixed(2)}`);
}

/* ── 4. the fixed point ──────────────────────────────────────────────────── */
{
  const pl = spawn(46);
  for (let n = 0; n < 600; n++) step(pl, 0, 0, 1.55);
  const p = path.posAt(46);
  check(pl.x === p.x && pl.z === p.z && pl.vx === 0 && pl.vz === 0,
        'standing still is still a fixed point',
        `dx=${(pl.x - p.x).toExponential(1)} dz=${(pl.z - p.z).toExponential(1)}`);
}

/* ── 5. the height field, everywhere the player can now reach ────────────── */
{
  let bad = 0, lo = Infinity, hi = -Infinity;
  for (let s = corridor.sMin; s <= corridor.sMax; s += 0.5) {
    const p = path.posAt(s);
    const th = path.headingAt(s);
    for (const side of [1, -1]) {
      const lim = corridorAt(corridor, s, side);
      for (let a = 0; a <= lim; a += 0.5) {
        const x = p.x + Math.cos(th) * side * a, z = p.z + Math.sin(th) * side * a;
        const h = terrain.heightAt(x, z);
        if (!Number.isFinite(h)) bad++;
        if (h < lo) lo = h; if (h > hi) hi = h;
      }
    }
  }
  check(bad === 0, 'ground is finite over the whole reachable set',
        `y ${lo.toFixed(1)} .. ${hi.toFixed(1)} m`);
}

/* ── 6. jumping ──────────────────────────────────────────────────────────── */

/* The whole walk again, jumping the entire way — the key held down would only
   jump once, so this presses it fresh the instant it lands, which is the most a
   player can do and considerably more than one would. The corridor must be no
   more felt than it was on foot. */
{
  const pl = spawn(0);
  let side = 0, jumps = 0, maxU = 0, minHead = Infinity, worstS = 0;
  let bodyHead = Infinity, bodyS = 0;
  let t = 0, far = -Infinity, maxAir = 0, airFrom = 0;
  for (let n = 0; n < 120 * 400; n++) {
    t += DT;
    const st = state(pl);
    if (st.s > far) far = st.s;
    if (st.s > corridor.sMax - 0.05) break;
    const want = 4.0 * Math.sin(t * 0.11) + 2.0 * Math.sin(t * 0.037 + 1.3);
    const corr = Math.max(-0.52, Math.min(0.52, (want - st.u) * 0.25));
    if (!pl.air) pl.yaw = path.headingAt(st.s) + corr;   // no steering in the air
    const wasAir = pl.air;
    const hit = step(pl, 1, 0, 1.55, !pl.air);
    if (!wasAir && pl.air) { jumps++; airFrom = pl.y; }
    if (wasAir && !pl.air) maxAir = Math.max(maxAir, 0);
    if (hit & 1) side++;
    const au = Math.abs(st.u);
    if (au > maxU) maxU = au;
    if (st.lim - au < minHead) { minHead = st.lim - au; worstS = st.s; }
    /* The body of the wash, on the six-metre inset rock.js uses for the same
       reason. The head is where the walk ends and where the corridor is already
       sanctioned to be felt — the longitudinal check below has always exempted
       it — so a margin measured across the head is measuring the exception. */
    if (st.s < corridor.sMax - 6 && st.lim - au < bodyHead) {
      bodyHead = st.lim - au; bodyS = st.s;
    }
  }
  check(far > corridor.sMax - 0.5 && jumps > 100, 'the whole route is jumpable',
        `reached s=${far.toFixed(1)} in ${(t / 60).toFixed(1)} min over ${jumps} jumps`);
  check(side === 0, 'jumping the whole way never touches the corridor',
        `${side} frames touched, |u| peaked at ${maxU.toFixed(2)} m`);
  /* Two claims, deliberately separated. In the body of the wash the requirement
     is a real margin and it is asserted at three band widths. At the head the
     requirement is only that the band is not actually entered, because arriving
     somewhere is allowed to be felt — and reporting the head figure keeps it
     visible rather than hidden inside a pass. */
  check(bodyHead > 3 * BAND, 'jumping keeps a real margin through the wash',
        `closest approach ${bodyHead.toFixed(2)} m at s=${bodyS.toFixed(0)}, ` +
        `against a band of ${BAND}`);
  check(minHead > BAND, 'and never enters the band even at the head',
        `closest approach ${minHead.toFixed(2)} m at s=${worstS.toFixed(0)}`);
}

/* Jumping *at* the limit, at turbo, from both sides and at five stations. The
   question is whether the arc buys any ground the walk could not reach: it must
   not, because confinement runs airborne and the arc carries no steering. */
for (const d of [8, 46, 120, 220, 300]) {
  for (const r of [1, -1]) {
    const pl = spawn(d);
    let over = 0, maxOver = 0;
    for (let n = 0; n < 120 * 60; n++) {
      step(pl, 0, r, 12, !pl.air);
      const st = state(pl);
      const x = Math.abs(st.u) - st.lim;
      if (x > 1e-3) { over++; if (x > maxOver) maxOver = x; }
    }
    const st = state(pl);
    /* The reached-the-limit clause is not decoration. The first version of this
       test passed at |u| = 0.00 because the walker never left the spot, which is
       a check reporting success about a thing it never did. Requiring that the
       walker actually arrive at the wall is what makes the bound mean anything. */
    check(Math.abs(st.u) <= st.lim + 0.01 && Math.abs(st.u) > st.lim - 0.5,
          `jumped at the wall, d=${d} ${r > 0 ? 'right' : 'left '}`,
          `|u|=${Math.abs(st.u).toFixed(2)} against a limit of ${st.lim.toFixed(2)}` +
          (over ? `  (${over} frames up to ${maxOver.toFixed(3)} m outside)` : ''));
  }
}

/* Landing has to reseat on the field at any slope, so jump from every half metre
   of the route and from the full width of the corridor either side — the talus,
   the cut banks and the steep flanks at the head included — and require that the
   walker is back on the ground, exactly on it, within a second and a half. */
{
  let bad = 0, stuck = 0, worst = 0, deepest = 0, tested = 0;
  for (let s = corridor.sMin; s <= corridor.sMax; s += 2) {
    for (const side of [1, -1]) {
      const lim = corridorAt(corridor, s, side);
      for (let a = 0; a <= lim; a += Math.max(1, lim / 6)) {
        const p = path.posAt(s), th = path.headingAt(s);
        const pl = spawn(s);
        pl.x = p.x + Math.cos(th) * side * a;
        pl.z = p.z + Math.sin(th) * side * a;
        pl.y = groundAt(pl.x, pl.z);
        if (!Number.isFinite(pl.y)) { bad++; continue; }
        tested++;
        step(pl, 1, 0, 4.2, true);           // jog, jumping
        let air = 0;
        while (pl.air && air < 120 * 1.5) { step(pl, 1, 0, 4.2, false); air++; }
        if (pl.air) stuck++;
        worst = Math.max(worst, air / 120);
        const g = groundAt(pl.x, pl.z);
        if (!Number.isFinite(pl.y) || Math.abs(pl.y - g) > 1e-9) deepest++;
      }
    }
  }
  check(bad === 0 && stuck === 0, 'every landing reseats on the height field',
        `${tested} jumps from the whole corridor, longest airtime ${worst.toFixed(2)} s`);
  check(deepest === 0, 'and lands exactly on it, never in it or above it',
        `${deepest} of ${tested} off the surface`);
}

/* And the fixed point again, because the jump added a branch to the integrator
   and a capture is a still frame of a player who is not pressing anything. */
{
  const pl = spawn(46);
  for (let n = 0; n < 600; n++) step(pl, 0, 0, 1.55, false);
  const p = path.posAt(46);
  check(pl.x === p.x && pl.z === p.z && pl.vx === 0 && pl.vz === 0 &&
        pl.vy === 0 && pl.air === false,
        'standing still is a fixed point with jump in the loop',
        `dx=${(pl.x - p.x).toExponential(1)} vy=${pl.vy} air=${pl.air}`);
}

/* ── 7. teleport ───────────────────────────────────────────────────────────
 *
 * `placeAt` is `src/main.js`'s teleport and is copied here for the same reason
 * `step` is: main.js owns the canvas. What this pins down is that the three
 * arrival paths — bare spawn, first `walkTo`, second `walkTo` — all land on the
 * same state, and that a teleport taken mid-flight or mid-settle leaves nothing
 * behind. The fields a teleport must clear are the ones the task names: the
 * airborne flag and vertical speed, both settle terms, the bob and its phase,
 * and the lift budget. */
function teleport(pl, d) {
  const p = path.posAt(d);
  pl.x = p.x; pl.z = p.z;
  pl.vx = 0; pl.vz = 0; pl.bob = 0; pl.bob0 = 0;
  pl.vy = 0; pl.air = false;
  pl.settle = 0; pl.settleV = 0;
  projectInside(corridor, path, pl);
  pl.y = groundAt(pl.x, pl.z);
  pl.lifted = 0;
  return pl;
}

{
  /* Mid-flight: airborne, moving outward at turbo, with a settle just handed a
     velocity and head-bob phase accumulated. The worst case a player can hand
     `walkTo`. */
  const a = spawn(46);
  a.yaw = path.headingAt(46) + Math.PI / 2;
  for (let n = 0; n < 40; n++) step(a, 0, 1, 12, n === 0);
  a.settle = 0.02; a.settleV = 0.5; a.bob0 = 7.3; a.bob = 0.031; a.lifted = 0.1;
  teleport(a, 120);
  teleport(a, 8);

  const b = teleport(spawn(8), 8);          // what a direct walkTo(8) gives

  const same = a.x === b.x && a.z === b.z && a.y === b.y &&
    a.vx === 0 && a.vz === 0 && a.vy === 0 && a.air === false &&
    a.settle === 0 && a.settleV === 0 && a.bob === 0 && a.bob0 === 0 &&
    (a.lifted || 0) === 0;
  check(same, 'two teleports leave one teleport\'s state',
        `air=${a.air} vy=${a.vy} settle=${a.settle} settleV=${a.settleV} ` +
        `bob=${a.bob} bob0=${a.bob0} lift=${a.lifted || 0}`);
  check(a.x === b.x && a.z === b.z && a.y === b.y,
        'and land on the same point as a direct teleport',
        `dx=${(a.x - b.x).toExponential(1)} dz=${(a.z - b.z).toExponential(1)} ` +
        `dy=${(a.y - b.y).toExponential(1)}`);
}

{
  /* And the invariant survives the teleport itself, including the one place it
     could not without `placeAt` doing it: a `d` whose centreline is inside the
     corridor at one end and outside it at the other is impossible on this path,
     but a teleport taken while the player is outside — which the narrow head can
     produce if the walk is ever changed — has to be projected. Simulated by
     handing `placeAt` a position that is laterally out by the limit, then
     stepping, and requiring the corridor holds one frame later. */
  const pl = spawn(46);
  pl.x += 40;                        // 40 m out, well into the rock
  pl.vx = 9; pl.vz = 0;              // still carrying turbo speed
  teleport(pl, 46);
  const st = invariant(pl);
  /* The bound is the arc-length table's own precision, not a metre. `posAt` is
     a linear interpolation between resampled points, so "on the centreline"
     reads back as a fraction of a millimetre even when it is exact. */
  check(st.ok && Math.abs(st.u) < 1e-3,
        'a teleport resets a player who was outside the corridor',
        `|u|=${Math.abs(st.u).toExponential(1)} against a limit of ${st.lim.toFixed(2)}`);
}

{
  /* The last invariant: every teleport destination, from the keyboard's table
     and beyond, must be inside the corridor by at least the frame that follows,
     and a teleport followed by no keys held must be a fixed point. */
  let bad = 0, moved = 0;
  for (const d of [0, 8, 30, 46, 62, 92, 120, 160, 170, 220, 270, 300, 320, 330]) {
    const pl = spawn(46);
    pl.air = true; pl.vy = 3; pl.settleV = 1;
    teleport(pl, d);
    if (!invariant(pl).ok) bad++;
    const x0 = pl.x, z0 = pl.z, y0 = pl.y;
    for (let n = 0; n < 240; n++) step(pl, 0, 0, 1.55, false);
    if (pl.x !== x0 || pl.z !== z0 || pl.y !== y0) moved++;
  }
  check(bad === 0, 'every teleport destination is inside the corridor',
        `${bad} of 14 destinations outside on arrival`);
  check(moved === 0, 'and every teleport destination is a fixed point',
        `${moved} of 14 drifted over two seconds at rest`);
}

console.log(`\n  ${fails ? `${fails} FAILED` : 'all ok'}\n`);
process.exit(fails ? 1 : 0);
