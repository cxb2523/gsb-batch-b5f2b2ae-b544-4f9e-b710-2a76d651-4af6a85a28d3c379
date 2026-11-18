/* Sedona Sunset — lateral confinement of the walk.
 *
 * The brief is a walk *up a wash between canyon walls*, and until this existed
 * the walls were scenery you passed through. Twenty-five metres of strafing —
 * sixteen seconds — put you inside the cliff, looking at its unlit maroon
 * interior; fifty put you on top of it on a bald plain; eighty out of the mouth
 * ran off the end of the built world entirely. A curious player reached the
 * first of those in under a minute.
 *
 * ── why a corridor and not mesh collision ─────────────────────────────────
 *
 * The wash already has a centreline and a width, and both are authored data
 * rather than something that has to be recovered: `WashPath` is the authority
 * for (s, u), and `Terrain.frame().ws` is the cross-section's talus toe, i.e.
 * the exact place the floor stops being floor. Confining |u| against that is a
 * table read and two multiplies per frame, against a BVH over a couple of
 * million triangles for the mesh alternative — and it has three properties the
 * mesh version does not:
 *
 *   - It cannot be climbed. A wall you collide with is a wall you can walk up
 *     if it has a talus pile against it, and this one has aprons all the way
 *     along both sides.
 *   - It cannot leak. There is no tunnelling case, no missing back face, and
 *     nothing to go wrong at the seam between the wall curtain and the apron.
 *   - It degrades softly. Velocity is bled off over the last metre and a half
 *     instead of being stopped dead against a plane, so what a player feels at
 *     the edge is the ground refusing rather than a box.
 *
 * ── where the limit sits ──────────────────────────────────────────────────
 *
 * Per side, per metre of arc length, the lesser of two readings:
 *
 *   - `frame().ws` plus a metre and a half. This is the wash's own width and it
 *     is what makes the corridor open out where the wash opens out and close
 *     down to a few metres at the head, without a hard-coded number anywhere.
 *   - Where the height field first stands `WALL_RISE` above the floor, less a
 *     clearance. This is the same question `rock.js` asks to seat the foot of
 *     the cliff, so it tracks the actual rock. It is a cap and not the primary
 *     reading, because `ws` can run past the toe on one side where the wall has
 *     been eaten into a bay.
 *
 * `WALL_RISE` is 4.5 m and that number is doing real work. Cut banks in this
 * wash reach 3.0 m, so a threshold anywhere below about 3.5 finds the bank
 * crest instead of the wall and pulls the corridor in to five or six metres in
 * places the wash is genuinely thirty across — which is the "invisible wall in
 * the playable middle" failure, arrived at from the cautious direction.
 *
 * ── what a player is allowed to feel ──────────────────────────────────────
 *
 * Nothing, while walking the walk. The player walks the centreline, where |u|
 * is zero and the nearest limit is the better part of ten metres away; measured
 * over the whole route the narrowest headroom is printed by
 * `tools/_corridor.mjs`. The limit is only reachable by deliberately walking at
 * a wall, which is exactly the population it is for.
 *
 * Determinism is preserved because the correction is applied to *velocity*, and
 * velocity is rebuilt from the key state every frame. At rest it is identically
 * zero, so the render loop is still a fixed point; `walkTo` places the player on
 * the centreline, so no capture ever touches this code path.
 *
 * ── and then the invariant, which velocity alone cannot give ──────────────
 *
 * Confining velocity is what makes the limit *feel* like ground rather than a
 * box, but it does not bound the position. Between the pre-integration bleed
 * and the integrated step there is one frame of travel — 0.6 m at the 12 m/s
 * turbo, and up to a metre if the frame runs to the 50 ms dt ceiling — plus the
 * `RESTORE` nudge back, which is deliberately slow (1.4 m/s) because it is meant
 * to be felt as being eased in when the corridor narrows ahead. Turbo strafing
 * measurably ran up to 0.25 m outside the limit, and the same gap is what let an
 * airborne player who was pushed sideways end up inside the rock for a frame
 * before the nudge began. `walkTo` was the third route in: anything that places
 * a position has to be checked against the same bound, or the invariant depends
 * on which of the three ways the player arrived.
 *
 * `projectInside` is the backstop. It runs *after* integration, on the position
 * that is about to be rendered, and moves the player exactly back onto the limit
 * along the local normal — no easing, no accumulation, because it is a
 * projection and not a correction: a point already inside is untouched, so it is
 * the identity at rest and the render loop stays a fixed point. Velocity is
 * deliberately **not** touched. The soft band is what decides how a body feels
 * at the wall, and a jump that is projected back has to keep its vertical speed
 * and its along-wall component — the landing arc and the settle that follows are
 * unchanged; only the position is clamped.
 *
 * It iterates because the normal it moves along is read at the *new* z, and the
 * wash curves; one pass leaves a residue of `u sin θ` — up to 1.3 mm at the far
 * side of a 17 m corridor where the wash turns through eighteen degrees. Twelve
 * passes drive that to the last bit of a double, and the overwhelmingly common
 * case (inside the corridor) costs one table read and leaves on the first test.
 */
import * as THREE from 'three';

/* Table spacing. One metre is far finer than anything in the cross-section —
   the narrowest term in `frame()` has a 30 m wavelength — so the table is a
   faithful sampling of the limit rather than an approximation of it. */
const STEP = 1.0;

/* Ground standing this far above the wash floor is the foot of a wall. Above
   the 3.0 m the cut banks reach; see the note at the top of the file. */
const WALL_RISE = 4.5;
/* How far short of that ground the limit sits, so the player is stopped on the
   floor rather than with their face in the slope. */
const CLEAR = 1.5;
/* Slack on the cross-section's own talus toe. The toe is where the floor ends,
   and standing on the very bottom of the apron is still standing in the wash. */
const SLACK = 1.5;

/* The march only has to answer "is there rock closer than the cross-section
   says", so it stops at the reading it is capping and never walks the full
   width of the corridor. That is most of the cost of building these tables. */
const MARCH_DS = 0.5;
const R_MIN = 5.0, R_MAX = 26.0;
/* Box radius in table cells. The two readings above are both noisy at the metre
   scale — one is an fbm sum, the other a threshold crossing on a rough surface
   — and an unsmoothed limit would catch and release as you slid along it. */
const SMOOTH = 3;

/* Width of the soft zone, in metres. Walk into it and the outward half of your
   velocity is bled off across it, reaching zero at the limit itself. */
export const BAND = 1.6;
/* Tried and rejected: a wider band while airborne, on the reasoning that a
   player in flight cannot steer away and so the band has to do its whole job
   against a fixed velocity. It works as arithmetic — the closest approach on a
   route jumped end to end goes from 1.63 m to 3.11 m — and it is wrong as
   design. Bleeding velocity 4 m out means jumping anywhere near a wall curves
   your arc, and the walker felt it on 1940 frames where it had felt nothing at
   all before. It also put the limit permanently out of reach, stopping the
   turbo tests 1.5 m short. Trading "3 cm from a threshold" for "the corridor
   now steers you in mid-air" is the wrong way round: the first is a thin margin
   on a benign outcome, the second is the exact intrusion this file exists to
   avoid. The margin was addressed in the test instead. */
/* How fast the player is returned if they are somehow already outside — the
   corridor narrowing ahead of them as they walk up-wash is the ordinary way
   that happens. Slow enough to read as being eased back rather than shoved. */
const RESTORE = 1.4;

/* How far behind the start of the walk a player may go. The path table itself
   runs out at z = 20, about twelve metres back, and the wall curtain's columns
   are stacked on the axis behind that — so the mouth has a real back to it and
   this stops short of where it stops being real. */
const S_BACK = -8.0;
/* And how far up. `WashPath.length` is 332.3 m and the head of the walk is the
   drainage col at about 330; `rock.js` ends its curtain six metres inside the
   same length for the same reason. */
const S_HEAD_MARGIN = 2.0;

function march(terrain, px, pz, nx, nz, want, max) {
  for (let a = MARCH_DS; a < max; a += MARCH_DS) {
    if (terrain.heightAt(px + nx * a, pz + nz * a) >= want) return a;
  }
  return max;
}

function boxSmooth(a) {
  const n = a.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0, w = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) {
      const j = i + k < 0 ? 0 : i + k > n - 1 ? n - 1 : i + k;
      acc += a[j]; w++;
    }
    out[i] = acc / w;
  }
  return out;
}

/**
 * Build the corridor tables. Pure JavaScript over the height field, so it runs
 * headless in `tools/_corridor.mjs` and in `tools/_bootprobe.mjs` exactly as it
 * runs in the page.
 */
export function buildCorridor(path, terrain) {
  const sMin = S_BACK;
  const sMax = path.length - S_HEAD_MARGIN;
  const n = Math.ceil((sMax + 6 - sMin) / STEP) + 1;
  const rawL = new Float32Array(n), rawR = new Float32Array(n);

  const p = new THREE.Vector3(), q = {}, f = {};
  for (let i = 0; i < n; i++) {
    const s = sMin + i * STEP;
    path.posAt(s, p);
    path.atZ(p.z, q);
    terrain.frame(p.x, p.z, q, f);
    const th = path.headingAt(s);
    /* The wash's right-hand normal at this station, which is the +u direction
       `WashPath.uOf` measures against. */
    const nx = Math.cos(th), nz = Math.sin(th);
    const want = terrain.heightAt(p.x, p.z) + WALL_RISE;
    const wide = f.ws + SLACK;
    const reach = wide + CLEAR;
    const clampR = (d) => {
      const v = Math.min(wide, d - CLEAR);
      return v < R_MIN ? R_MIN : v > R_MAX ? R_MAX : v;
    };
    rawR[i] = clampR(march(terrain, p.x, p.z, nx, nz, want, reach));
    rawL[i] = clampR(march(terrain, p.x, p.z, -nx, -nz, want, reach));
  }

  /* The two ends' world z, resolved here rather than per frame. `atZ` is a
     table read of z that saturates outside the table, so the along-wash
     position is recovered from z and the ends have to be held in z. */
  const zMin = path.posAt(sMax).z, zMax = path.posAt(sMin).z;

  return { sMin, sMax, step: STEP, n, L: boxSmooth(rawL), R: boxSmooth(rawR),
           zMin, zMax };
}

/** Half-width of the corridor at arc length `s`, on `side` (+1 right, −1 left). */
export function corridorAt(cor, s, side) {
  const a = side > 0 ? cor.R : cor.L;
  let f = (s - cor.sMin) / cor.step;
  f = f < 0 ? 0 : f > cor.n - 1.001 ? cor.n - 1.001 : f;
  const i = f | 0, t = f - i;
  return a[i] + (a[i + 1] - a[i]) * t;
}

/**
 * One frame of confinement, applied to the player's velocity before it is
 * integrated. `q` is the path frame already looked up for this position, so
 * this costs no extra table read.
 *
 * Mutates `player.vx`, `player.vz`, `player.x`, `player.z`, and returns a mask
 * of which limits engaged — 1 lateral, 2 along the wash. The game ignores it;
 * `tools/_walktest.mjs` needs the two apart, because a nudge at the head of the
 * walk is the walk ending and a nudge in the middle of it is a defect.
 */
export function confine(cor, path, player, q, dt) {
  let hit = 0;
  const sin = Math.sin(q.th), cos = Math.cos(q.th);
  /* The wash's own frame at the player: right is +u, forward is +s. */
  const rx = cos, rz = sin;
  const fx = sin, fz = -cos;

  const u = (player.x - q.x) * cos;
  const side = u >= 0 ? 1 : -1;

  /* ── lateral ── */
  const lim = corridorAt(cor, q.s, side);
  const au = u < 0 ? -u : u;
  const t = (au - (lim - BAND)) / BAND;
  if (t > 0) {
    const g = t > 1 ? 1 : t;
    /* Outward-signed component of the velocity, in the corridor's own frame. */
    const vOut = (player.vx * rx + player.vz * rz) * side;
    if (vOut > 0) {
      const cut = vOut * g;
      player.vx -= cut * side * rx;
      player.vz -= cut * side * rz;
      hit |= 1;
    }
    if (au > lim) {
      const back = Math.min(au - lim, RESTORE * dt);
      player.x -= back * side * rx;
      player.z -= back * side * rz;
      hit |= 1;
    }
  }

  /* ── along the wash ───────────────────────────────────────────────────────
   * The same treatment at both ends of the walk. Without it, turning round at
   * the start and walking gets you out of the mouth and onto ground the scene
   * never intended to be stood on — the walls simply end — and it is the
   * cheaper of the two failures to fix because there is nothing to collide
   * with there at all. */
  for (const [edge, dir] of [[cor.sMin, -1], [cor.sMax, 1]]) {
    const d = (q.s - edge) * dir;          // positive = past the edge
    const ts = (d + BAND) / BAND;
    if (ts <= 0) continue;
    const g = ts > 1 ? 1 : ts;
    const vOut = (player.vx * fx + player.vz * fz) * dir;
    if (vOut > 0) {
      const cut = vOut * g;
      player.vx -= cut * dir * fx;
      player.vz -= cut * dir * fz;
      hit |= 2;
    }
    if (d > 0) {
      const back = Math.min(d, RESTORE * dt);
      player.x -= back * dir * fx;
      player.z -= back * dir * fz;
      hit |= 2;
    }
  }
  return hit;
}

/* Working scratch for the projection, so the per-frame path allocates nothing. */
const _pq = {};
/* The invariant is stated in metres and enforced in floating point, so it is
 * held to the resolution of the arithmetic rather than to a millimetre. A hair
 * of slack so `au - lim` landing one ulp positive on a player already on the
 * limit cannot trigger a correction that then oscillates; anything a viewer
 * could measure is many orders of magnitude above this. */
const OVER_EPS = 1e-9;

/**
 * The invariant, applied to the position rather than to the velocity.
 *
 * `u` is measured the way `WashPath.uOf` measures it — against the centreline
 * at the player's z, with `cos(th)` — and is the quantity the corridor's width
 * is defined in. Anything outside is moved back along the local right-hand
 * normal (the same `(cos th, sin th)` the table was built with) until it is on
 * the limit. Then the along-wash ends are held the same way.
 *
 * The loop is what makes it exact rather than nearly exact. The normal is read
 * at the post-move z, and z changes under the correction, so a single pass on
 * an eighteen-degree bend leaves a residual of `u sin θ` — 1.3 mm at the far
 * side of a 17 m corridor. Twelve passes drive it to the last bit of a double,
 * and a position already inside leaves on the first test, which is the case
 * every frame of ordinary walking and every `walkTo` framing falls into.
 *
 * Returns the mask, like `confine`. Momentum is untouched by design: this is a
 * position projection, so a body pushed back by it keeps the speed it had —
 * including its `vy` — and the ground is then read under the returned position,
 * which is what keeps the landing test and the spring on the same footing they
 * had. Call it *before* the ground clamp so the height is that of the place the
 * player is actually rendered at.
 */
export function projectInside(cor, path, player) {
  let hit = 0;
  for (let pass = 0; pass < 12; pass++) {
    const q = path.atZ(player.z, _pq);
    const cos = Math.cos(q.th), sin = Math.sin(q.th);
    const u = (player.x - q.x) * cos;
    const au = u < 0 ? -u : u;
    const side = u >= 0 ? 1 : -1;
    const lim = corridorAt(cor, q.s, side);
    const over = au - lim;
    let moved = false;
    if (over > OVER_EPS) {
      player.x -= over * side * cos;
      player.z -= over * side * sin;
      hit |= 1;
      moved = true;
    }
    /* ── the ends ──────────────────────────────────────────────────────────
     * Unlike the lateral limit there is no width here: the walk stops. The
     * along-wash coordinate is `atZ(z).s`, so this is a one-dimensional
     * problem in z, and its derivative is known — a step of `ds` along the
     * tangent moves z by `-cos th ds` — so stepping by the residual and
     * re-reading converges geometrically.
     *
     * The hard z clamp comes first and is not belt and braces: outside the
     * table `atZ` saturates, so a z far past the head reports the same arc
     * length on every pass and the residual step would stand still. Placing z
     * on the end's own world z — which is inside the table, since the two ends
     * are — is one step from the target and cannot stall.
     *
     * `x` is deliberately untouched by the clamp, because the end is about the
     * walk stopping and not about the sides; the lateral pass above picks up
     * whatever the shift along z does to `u`. */
    if (player.z < cor.zMin || player.z > cor.zMax) {
      const stop = player.z < cor.zMin;
      player.z = stop ? cor.zMin : cor.zMax;
      hit |= 2;
      moved = true;
    } else {
      /* Whichever ends the player is past, `d` is the arc length owed *inward*:
         `+1` steps along +s, which is `(sin θ, −cos θ)`, and `−1` along −s. */
      for (const [edge, dir] of [[cor.sMin, 1], [cor.sMax, -1]]) {
        const d = dir > 0 ? edge - q.s : q.s - edge;
        if (d > OVER_EPS) {
          player.x += dir * sin * d;
          player.z += dir * -cos * d;
          hit |= 2;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return hit;
}

/** |u| and the limit at the player's current position — the invariant's own
 *  readout, so a probe can assert the thing the projection enforces rather than
 *  reconstruct it. */
export function corridorState(cor, path, player) {
  const q = path.atZ(player.z, _pq);
  const u = (player.x - q.x) * Math.cos(q.th);
  return { s: q.s, u, side: u >= 0 ? 1 : -1, lim: corridorAt(cor, q.s, u >= 0 ? 1 : -1) };
}
