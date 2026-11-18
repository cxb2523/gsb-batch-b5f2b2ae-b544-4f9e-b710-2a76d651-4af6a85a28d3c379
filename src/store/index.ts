import { proxy, subscribe } from "valtio";

// Decal slots that can own a texture.
export type DecalSlot = "logo" | "full";

// Lifecycle of the texture bound to a decal slot.
//   idle    -> nothing requested / decal is disabled
//   loading -> a source has been requested but its texture is not usable yet
//   ready   -> the applied texture matches the requested source
//   error   -> the requested source failed and there is no previous texture
export type DecalStatus = "idle" | "loading" | "ready" | "error";

export interface DecalSlotStatus {
  // Monotonic id used to discard results of superseded requests.
  requestId: number;
  // Source the UI asked for (mirrors logoDecal / fullDecal).
  requestedSource: string;
  // Source whose texture is actually mounted in the scene.
  appliedSource: string | null;
  status: DecalStatus;
  error: string | null;
}

export interface State {
  intro: boolean;
  color: string;
  isLogoTexture: boolean;
  isFullTexture: boolean;
  logoDecal: string;
  fullDecal: string;
  // Transient (not persisted) tracking for the decal texture lifecycle.
  decalStatus: Record<DecalSlot, DecalSlotStatus>;
}

const STORAGE_KEY = "tshirt-customizer-v1";

const defaults: Omit<State, "decalStatus"> = {
  intro: true, // are we on home page?
  color: "#EFBD48", // color of t-shirt
  isLogoTexture: true, // are we showing logo on t-shirt?
  isFullTexture: false, // full textures
  logoDecal: "/threejs.png", // t-shirt logo image
  fullDecal: "/full-texture.jpg", // t-shirt full texture image
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

// Avoid redundant localStorage writes when only transient state changes.
let lastPersisted: string | null = null;

type PersistedState = Omit<State, "decalStatus">;

const parseSavedState = (raw: string): Partial<PersistedState> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const saved = parsed as Record<string, unknown>;
    const next: Partial<PersistedState> = {};

    if (typeof saved.intro === "boolean") next.intro = saved.intro;
    if (isNonEmptyString(saved.color)) next.color = saved.color;
    if (typeof saved.isLogoTexture === "boolean") {
      next.isLogoTexture = saved.isLogoTexture;
    }
    if (typeof saved.isFullTexture === "boolean") {
      next.isFullTexture = saved.isFullTexture;
    }
    if (isNonEmptyString(saved.logoDecal)) next.logoDecal = saved.logoDecal;
    if (isNonEmptyString(saved.fullDecal)) next.fullDecal = saved.fullDecal;

    return next;
  } catch {
    return null;
  }
};

const loadState = (): Partial<PersistedState> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return parseSavedState(raw) ?? {};
  } catch {
    return {};
  }
};

const persistState = (current: State) => {
  try {
    const payload: PersistedState = {
      intro: current.intro,
      color: current.color,
      isLogoTexture: current.isLogoTexture,
      isFullTexture: current.isFullTexture,
      logoDecal: current.logoDecal,
      fullDecal: current.fullDecal,
    };
    const serialized = JSON.stringify(payload);
    // decalStatus churns during loads; only write when persisted data changes.
    if (serialized === lastPersisted) return;
    lastPersisted = serialized;
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    console.warn("Failed to persist customizer state to localStorage", error);
  }
};

const hydrated: PersistedState = {
  ...defaults,
  ...loadState(),
};

const createSlotStatus = (source: string): DecalSlotStatus => ({
  requestId: 0,
  requestedSource: source,
  appliedSource: null,
  status: "idle",
  error: null,
});

// Default State (hydrated from localStorage when available)
const state = proxy<State>({
  ...hydrated,
  decalStatus: {
    logo: createSlotStatus(hydrated.logoDecal),
    full: createSlotStatus(hydrated.fullDecal),
  },
});

subscribe(state, () => {
  persistState(state);
});

export const decalSourceProperty = (
  slot: DecalSlot,
): "logoDecal" | "fullDecal" => (slot === "logo" ? "logoDecal" : "fullDecal");

export const decalEnabledProperty = (
  slot: DecalSlot,
): "isLogoTexture" | "isFullTexture" =>
  slot === "logo" ? "isLogoTexture" : "isFullTexture";

export const decalLabel = (slot: DecalSlot): string =>
  slot === "logo" ? "logo" : "full";

/**
 * Mark a new source as requested. Returns a request id that must be passed
 * back to `settleDecalRequest`; stale ids are ignored, which makes rapid
 * consecutive switches keep only the last request.
 */
export const beginDecalRequest = (
  slot: DecalSlot,
  source: string,
): number => {
  state[decalSourceProperty(slot)] = source;

  const current = state.decalStatus[slot];
  const alreadyReady =
    current.status === "ready" &&
    current.requestedSource === source &&
    current.appliedSource === source;

  if (alreadyReady) return current.requestId;

  const requestId = current.requestId + 1;
  state.decalStatus[slot] = {
    requestId,
    requestedSource: source,
    appliedSource: current.appliedSource,
    status: "loading",
    error: null,
  };

  return requestId;
};

export type DecalRequestResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Record the outcome of a texture request. Out-of-date request ids are
 * ignored so a slow, superseded load can never overwrite the latest state.
 */
export const settleDecalRequest = (
  slot: DecalSlot,
  requestId: number,
  result: DecalRequestResult,
): boolean => {
  const current = state.decalStatus[slot];
  if (current.requestId !== requestId) return false;

  if (result.ok) {
    state.decalStatus[slot] = {
      requestId,
      requestedSource: current.requestedSource,
      appliedSource: current.requestedSource,
      status: "ready",
      error: null,
    };
    return true;
  }

  // Keep using the previous decal when a new source cannot be loaded.
  const fallback = current.appliedSource;

  if (fallback) {
    state[decalSourceProperty(slot)] = fallback;
    state.decalStatus[slot] = {
      requestId,
      requestedSource: fallback,
      appliedSource: fallback,
      status: "ready",
      error: result.message,
    };
  } else {
    state.decalStatus[slot] = {
      requestId,
      requestedSource: current.requestedSource,
      appliedSource: null,
      status: "error",
      error: result.message,
    };
  }

  return true;
};

/**
 * Decal was switched off (or unmounted): invalidate in-flight requests and
 * mark the slot idle. The source stays in the store so re-enabling reloads it.
 */
export const releaseDecalSlot = (slot: DecalSlot): void => {
  const current = state.decalStatus[slot];
  state.decalStatus[slot] = {
    requestId: current.requestId + 1,
    requestedSource: state[decalSourceProperty(slot)],
    appliedSource: null,
    status: "idle",
    error: null,
  };
};

/**
 * Clear a previously reported error without touching the applied texture.
 * Used to retire a notice after the user has had a chance to read it.
 */
export const clearDecalError = (slot: DecalSlot): void => {
  const current = state.decalStatus[slot];
  if (!current.error) return;
  state.decalStatus[slot] = { ...current, error: null };
};

export type DecalStateInput = Pick<
  State,
  "isLogoTexture" | "isFullTexture" | "logoDecal" | "fullDecal" | "decalStatus"
>;

export type DownloadReadiness = {
  ready: boolean;
  message: string;
};

/**
 * A download may only capture the canvas once every enabled decal has its
 * requested texture applied. Disabled decals impose no requirement because
 * they do not render.
 */
export const getDownloadReadiness = (
  snapshot: DecalStateInput = state,
): DownloadReadiness => {
  const slots: DecalSlot[] = ["logo", "full"];

  for (const slot of slots) {
    const enabled =
      slot === "logo" ? snapshot.isLogoTexture : snapshot.isFullTexture;
    if (!enabled) continue;

    const expected =
      slot === "logo" ? snapshot.logoDecal : snapshot.fullDecal;
    const status = snapshot.decalStatus[slot];

    if (status.status === "error") {
      return {
        ready: false,
        message: `Could not load ${decalLabel(slot)} texture`,
      };
    }

    if (
      status.status !== "ready" ||
      status.appliedSource !== expected ||
      status.requestedSource !== expected
    ) {
      return {
        ready: false,
        message: `Loading ${decalLabel(slot)} texture…`,
      };
    }
  }

  return { ready: true, message: "" };
};

export default state;
