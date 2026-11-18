// Minimal example: run the simulation headlessly and print what happens.
//
//   node examples/basic.ts [fps]
//
// Frames are delivered at an arbitrary refresh rate; the simulation converts
// them to fixed 1/128 s ticks. The input below is held constant (forward plus
// a steady mouse sweep) precisely so the output is bit-identical at any fps —
// only the number of frames differs.

import { BunnyHopSim } from '../src/index.ts';

const fps = Number(process.argv[2] ?? 60);
const seconds = 2;

const sim = new BunnyHopSim({ autoHop: true });
let events = 0;
let jumped = false;

for (let frame = 0; frame < Math.round(fps * seconds); frame += 1) {
  const result = sim.frame(1 / fps, {
    forward: 1,
    side: 1,
    jump: !jumped, // press on the first frame, then hold released
    mouseDX: 160 / fps,
  });
  if (result.events.some((e) => e.type === 'jump')) jumped = true;
  events += result.events.length;
}

const state = sim.getState();
console.log(`rendered ${Math.round(fps * seconds)} frames at ${fps} Hz`);
console.log(`ticks=${state.tickCount} simulated=${state.simulatedTime.toFixed(6)} s`);
console.log(`grounded=${state.grounded} speed=${state.speed.toFixed(3)} u/s`);
console.log(`jumps=${state.jumpCount} landings=${state.landingCount} events=${events}`);
console.log(`position=(${state.position.x.toFixed(3)}, ${state.position.y.toFixed(3)}, ${state.position.z.toFixed(3)})`);
