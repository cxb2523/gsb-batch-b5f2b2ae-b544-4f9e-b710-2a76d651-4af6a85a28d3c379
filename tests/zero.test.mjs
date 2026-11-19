import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../dist/vendor/three.module.js';
import {Miniguns,launchRound,aimPoint,makeGunMounts,GRAVITY,SHOT_RATE} from '../dist/weapons.js';

const heli=()=>({position:new T.Vector3(),orientation:new T.Quaternion(),velocity:new T.Vector3()});
const atZ=(round,z)=>{const time=(z-round.position.z)/round.velocity.z;return round.position.clone().addScaledVector(round.velocity,time).add(new T.Vector3(0,-GRAVITY*time*time/2,0));};
const hitAt=(x,y,z)=>({point:new T.Vector3(x,y,z),normal:new T.Vector3(0,1,0)});
const markPosition=(guns,i)=>{const matrix=new T.Matrix4();guns.marks.getMatrixAt(i,matrix);return new T.Vector3().setFromMatrixPosition(matrix);};
const barrelDirection=(mounts,side)=>new T.Vector3(0,0,-1).applyQuaternion(mounts.group.children[side].quaternion);

test('switching zero re-aims new rounds and the gun barrels while fired rounds keep their launch zero',()=>{
  const guns=new Miniguns(new T.Group()),mounts=makeGunMounts(),fired=[];
  for(const zero of [30,50,100]){
    guns.setZero(zero);mounts.setZero(zero);
    assert.equal(guns.zero,zero);
    guns.step(heli(),true,1/SHOT_RATE);
    const fresh=guns.rounds.slice(-2),target=aimPoint(zero);
    assert.equal(fresh.length,2);
    for(const round of fresh){
      assert.equal(round.zero,zero,'each round records the zero at its launch instant');
      assert.ok(atZ(round,target.z).distanceTo(target)<1e-6,'new rounds zero at the current range');
    }
    fired.push(...fresh);
    for(let side=0;side<2;side++)
      assert.ok(barrelDirection(mounts,side).distanceTo(launchRound(heli(),side,zero).velocity.normalize())<1e-9,'barrels follow the selected zero');
  }
  const launchZeros=[30,30,50,50,100,100];
  fired.forEach((round,i)=>{
    assert.equal(round.zero,launchZeros[i],'later switches must not rewrite a fired round');
    const target=aimPoint(launchZeros[i]);
    assert.ok(atZ(round,target.z).distanceTo(target)<1e-6,'old rounds still settle on their launch zero');
  });
  guns.dispose();
});

test('reset clears rounds, tracers, marks and the ring cursor so the next mark lands at index 0',()=>{
  const guns=new Miniguns(new T.Group(),{capacity:8});
  guns.step(heli(),true,1/SHOT_RATE);
  guns.step(heli(),false,.01);
  guns.updateTracers();
  assert.ok(guns.rounds.length>0);assert.ok(guns.tracers.count>0);
  guns.mark(hitAt(1,2,3));guns.mark(hitAt(4,5,6));
  assert.equal(guns.marks.count,2);assert.equal(guns.cursor,2);
  guns.reset();
  assert.equal(guns.rounds.length,0,'rounds cleared');
  assert.equal(guns.streaks.length,0,'tracer streaks cleared');
  assert.equal(guns.tracers.count,0,'tracer segments cleared');
  assert.equal(guns.tracers.geometry.drawRange.count,0);
  assert.equal(guns.marks.count,0,'marks cleared');
  assert.equal(guns.cursor,0,'ring cursor rewound');
  assert.equal(guns.shots,0);assert.equal(guns.clock,0);
  guns.mark(hitAt(7,8,9));
  assert.equal(guns.cursor,1);assert.equal(guns.marks.count,1);
  assert.ok(markPosition(guns,0).distanceTo(new T.Vector3(7,8.006,9))<1e-4,'first mark of the next session lands at index 0');
  guns.dispose();
});

test('ring buffer wraps at capacity: count clamps, cursor stays in range and the oldest matrix is overwritten',()=>{
  const guns=new Miniguns(new T.Group(),{capacity:4});
  for(let i=0;i<4;i++)guns.mark(hitAt(i,0,0));
  assert.equal(guns.marks.count,4,'count saturates at capacity');
  assert.equal(guns.cursor,0,'cursor wrapped back to the oldest slot');
  guns.mark(hitAt(10,0,0));guns.mark(hitAt(11,0,0));
  assert.equal(guns.marks.count,4,'count never exceeds capacity');
  assert.equal(guns.cursor,2,'cursor stays within the buffer');
  assert.ok(markPosition(guns,0).distanceTo(new T.Vector3(10,.006,0))<1e-4,'oldest slot overwritten by the newest mark');
  assert.ok(markPosition(guns,1).distanceTo(new T.Vector3(11,.006,0))<1e-4);
  assert.ok(markPosition(guns,2).distanceTo(new T.Vector3(2,.006,0))<1e-4,'unwrapped slots keep their marks');
  assert.ok(markPosition(guns,3).distanceTo(new T.Vector3(3,.006,0))<1e-4);
  guns.reset();
  assert.equal(guns.cursor,0);assert.equal(guns.marks.count,0);
  guns.mark(hitAt(99,0,0));
  assert.equal(guns.cursor,1);assert.equal(guns.marks.count,1);
  assert.ok(markPosition(guns,0).distanceTo(new T.Vector3(99,.006,0))<1e-4,'no stale matrix reuse after a wrapped reset');
  guns.dispose();
});
