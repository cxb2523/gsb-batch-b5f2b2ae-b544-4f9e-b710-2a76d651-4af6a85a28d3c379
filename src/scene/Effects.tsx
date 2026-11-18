/**
 * Things that make activity readable from far away:
 *  - DeployBeams: a light column, a spinning floor ring and a stage label over every node
 *    that is deploying right now
 *  - Pulses: a one-off shockwave when a deploy finishes (green / red) or a node goes down / up
 *
 * Shockwaves are driven by the live event stream with three guards so a reconnect or a big poll
 * can never flood the floor:
 *  - on a session switch the set of already-seen event ids is reset, so events from the previous
 *    session can never be replayed as if they had just arrived;
 *  - within one batch of new events a service keeps only its most severe event (a failure / a node
 *    going down outranks a success / recovery / new node);
 *  - the number of waves spawned from a single batch is capped.
 * Every processed event id is consumed exactly once, and every wave removes itself by id when its
 * animation finishes.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { STAGES, isActiveDeploy, type Deployment } from '../data/types';
import { duration } from '../format';
import { type Layout, type Slot } from '../layout';
import { useStore, type ActivityEvent } from '../store';
import { Label } from './Label';

const BEAM = '#3da2ff';
const BEAM_H = 7;

const beamVertex = /* glsl */ `
  varying float vH;
  void main() {
    vH = position.y / ${BEAM_H.toFixed(1)} + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const beamFragment = /* glsl */ `
  uniform vec3 color;
  uniform float time;
  varying float vH;
  void main() {
    float fade = pow(1.0 - clamp(vH, 0.0, 1.0), 1.7);
    float bands = 0.6 + 0.4 * sin(time * 7.0 - vH * 26.0);
    gl_FragColor = vec4(color * 2.2, fade * bands * 0.5);
  }
`;

export function DeployBeams({ layout }: { layout: Layout }) {
  const services = useStore((s) => s.services);
  const deployments = useStore((s) => s.deployments);

  // A beam needs Dokploy reporting "deploying" OR a deploy record in flight. The list is derived
  // from current state on every render: when a deploy record finishes or the service leaves the
  // deploying state (so neither condition holds anymore), its Beam unmounts in this same render
  // cycle — it never lingers until the next layout rebuild.
  const active = useMemo(() => {
    const byService = new Map<string, Deployment>();
    for (const d of Object.values(deployments)) if (isActiveDeploy(d)) byService.set(d.serviceId, d);
    return Object.values(services)
      .filter((s) => layout.slots[s.id] && (s.status === 'deploying' || byService.has(s.id)))
      .map((s) => ({ serviceId: s.id, slot: layout.slots[s.id]!, deploy: byService.get(s.id) }));
  }, [services, deployments, layout]);

  return (
    <>
      {active.map(({ serviceId, slot, deploy }) => (
        <Beam key={serviceId} slot={slot} deploy={deploy} />
      ))}
    </>
  );
}

function Beam({ slot, deploy }: { slot: Slot; deploy?: Deployment }) {
  const still = useStore((s) => s.reducedMotion);
  const now = useStore((s) => s.now);
  const ring = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
        uniforms: { color: { value: new THREE.Color(BEAM) }, time: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock }) => {
    if (still) return;
    material.uniforms.time.value = clock.elapsedTime;
    if (ring.current) ring.current.rotation.z = clock.elapsedTime * 1.8;
  });

  const stage = deploy?.stages.findIndex((s) => s === 'running') ?? -1;
  const since = deploy?.startedAt ?? deploy?.createdAt;
  const [x, , z] = slot.pos;

  return (
    <group position={[x, 0, z]}>
      <mesh position-y={BEAM_H / 2} material={material} raycast={() => null}>
        <cylinderGeometry args={[0.62, 0.62, BEAM_H, 32, 1, true]} />
      </mesh>
      <mesh position-y={BEAM_H / 2} raycast={() => null}>
        <cylinderGeometry args={[0.035, 0.035, BEAM_H, 8, 1, true]} />
        <meshBasicMaterial color={new THREE.Color(BEAM).multiplyScalar(3)} toneMapped={false} transparent opacity={0.7} />
      </mesh>
      <mesh ref={ring} position-y={0.06} rotation-x={-Math.PI / 2} raycast={() => null}>
        <ringGeometry args={[0.86, 0.98, 48, 1, 0, Math.PI * 1.5]} />
        <meshBasicMaterial color={new THREE.Color(BEAM).multiplyScalar(2.5)} toneMapped={false} transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      <Label position={[0, 2.5, 0]} zIndex={10} minZoom={11}>
        <div className="deploy-tag">
          <span className="bubble-spinner" />
          Deploying
          {stage >= 0 && <b>{STAGES[stage]}</b>}
          {since && <span className="num">{duration(now - since)}</span>}
        </div>
      </Label>
    </group>
  );
}

// ---- shockwaves -----------------------------------------------------------------------

const PULSE_S = 1.8;
/** Max shockwaves spawned from a single batch of events (e.g. one poll catching up). */
export const MAX_PULSES_PER_BATCH = 6;

interface PulseSpec {
  color: string;
  /** Higher wins when one service reports several events in the same batch. */
  severity: number;
}

/** Only these events reach the floor as waves. Failure / outage always outranks success / arrival. */
const PULSE: Partial<Record<ActivityEvent['kind'], PulseSpec>> = {
  'deploy-fail': { color: '#ff2e55', severity: 2 },
  down: { color: '#ff2e55', severity: 2 },
  'deploy-ok': { color: '#2bff9a', severity: 1 },
  up: { color: '#2bff9a', severity: 1 },
  'new-node': { color: '#2de2ff', severity: 1 },
};

interface Pulse {
  id: string;
  slot: Slot;
  color: string;
}

interface PickedPulse {
  pulse: Pulse;
  severity: number;
}

export function Pulses({ layout }: { layout: Layout }) {
  const events = useStore((s) => s.events);
  const session = useStore((s) => s.session);
  const still = useStore((s) => s.reducedMotion);
  const seen = useRef<Set<string> | null>(null);
  const sessionRef = useRef(session);
  const [pulses, setPulses] = useState<Pulse[]>([]);

  useEffect(() => {
    // A reconnect starts a new session. Nothing known before the switch may wave again: reset the
    // seen set to the events the new session currently holds and let in-flight waves die with the
    // old scene. Only events arriving after this point can spawn a shockwave.
    if (sessionRef.current !== session) {
      sessionRef.current = session;
      seen.current = new Set(events.map((e) => e.id));
      setPulses((p) => (p.length ? [] : p));
      return;
    }
    // First run of a session: the seeded history stays quiet, only later arrivals play.
    if (!seen.current) {
      seen.current = new Set(events.map((e) => e.id));
      return;
    }

    const freshEvents = events.filter((e) => !seen.current!.has(e.id));
    if (!freshEvents.length) return;
    // Consume every fresh id up front — ids that never become a wave (no pulse color, no slot,
    // reduced motion, over the cap) must not replay on the next effect run either.
    for (const e of freshEvents) seen.current!.add(e.id);
    // Reduced motion: no new waves, but waves already on the floor keep animating to completion.
    if (still) return;

    // One wave per service per batch: keep the most severe event. Events are newest-first, so at
    // equal severity the first (most recent) entry wins because we only replace on a strict gain.
    const picked = new Map<string, PickedPulse>();
    for (const e of freshEvents) {
      const spec = PULSE[e.kind];
      const slot = e.serviceId ? layout.slots[e.serviceId] : undefined;
      if (!spec || !slot) continue;
      const prev = picked.get(e.serviceId!);
      if (!prev) {
        picked.set(e.serviceId!, { pulse: { id: e.id, slot, color: spec.color }, severity: spec.severity });
      } else if (spec.severity > prev.severity) {
        picked.set(e.serviceId!, { pulse: { id: e.id, slot, color: spec.color }, severity: spec.severity });
      }
    }

    // Cap the batch: severest first, ties keep arrival order (stable sort). The dropped events
    // were already marked seen, so a catch-up poll can never dump dozens of rings in one frame.
    const waves = [...picked.values()]
      .sort((a, b) => b.severity - a.severity)
      .slice(0, MAX_PULSES_PER_BATCH)
      .map((x) => x.pulse);
    if (waves.length) {
      setPulses((p) => {
        const ids = new Set(p.map((x) => x.id));
        return [...p, ...waves.filter((w) => !ids.has(w.id))];
      });
    }
  }, [session, events, layout, still]);

  return (
    <>
      {pulses.map((p) => (
        <Shockwave key={p.id} pulse={p} onDone={() => setPulses((all) => all.filter((x) => x.id !== p.id))} />
      ))}
    </>
  );
}

function Shockwave({ pulse, onDone }: { pulse: Pulse; onDone: () => void }) {
  const ring = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const age = useRef(0);
  const finished = useRef(false);
  const color = useMemo(() => new THREE.Color(pulse.color).multiplyScalar(2.6), [pulse.color]);

  useFrame((_, dt) => {
    age.current += dt;
    const t = age.current / PULSE_S;
    if (t >= 1) {
      // Remove once, by id: a re-render with a new layout object must not remount or re-fire this.
      if (!finished.current) onDone();
      finished.current = true;
      return;
    }
    const ease = 1 - (1 - t) ** 3;
    ring.current?.scale.setScalar(0.6 + ease * 4.2);
    if (mat.current) mat.current.opacity = (1 - t) ** 1.5;
  });

  return (
    <mesh ref={ring} position={[pulse.slot.pos[0], 0.07, pulse.slot.pos[2]]} rotation-x={-Math.PI / 2} raycast={() => null}>
      <ringGeometry args={[0.85, 1, 64]} />
      <meshBasicMaterial ref={mat} color={color} toneMapped={false} transparent depthWrite={false} />
    </mesh>
  );
}
