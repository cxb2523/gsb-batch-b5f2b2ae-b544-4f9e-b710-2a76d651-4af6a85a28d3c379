// Contains all helper functions to be used in site
// Don't remove anything from here if not sure

import { TextureLoader, type Texture } from "three";

/* -------------------------------------------------------------------------- */
/*                        Decal texture lifecycle                             */
/* -------------------------------------------------------------------------- */

type DecalTextureEntry = {
  // Number of decals/slots currently referencing this texture.
  refs: number;
  // Resolved texture, available once the image has loaded.
  texture: Texture | null;
  // Shared load promise so concurrent requests for a source load once.
  promise: Promise<Texture>;
  // Set when the entry has been released and must not be handed out again.
  dropped: boolean;
};

// Keyed by image source (URL or data URL). Entries live only while referenced.
const decalTextureCache = new Map<string, DecalTextureEntry>();

const createDecalTextureEntry = (source: string): DecalTextureEntry => {
  let resolveEntry!: (texture: Texture) => void;
  let rejectEntry!: (reason: Error) => void;

  const promise = new Promise<Texture>((resolve, reject) => {
    resolveEntry = resolve;
    rejectEntry = reject;
  });
  // Failures are surfaced to each consumer; avoid unhandled rejections when
  // nobody is waiting anymore (e.g. the slot was switched off).
  promise.catch(() => undefined);

  const entry: DecalTextureEntry = {
    refs: 0,
    texture: null,
    dropped: false,
    promise,
  };

  const loader = new TextureLoader();
  loader.load(
    source,
    (texture) => {
      // Nobody holds the texture anymore (rapid switch / unmounted decal):
      // free it right away instead of leaking it.
      if (entry.dropped || entry.refs <= 0) {
        texture.dispose();
        rejectEntry(new Error(`Decal texture for "${source}" is no longer used`));
        return;
      }

      texture.needsUpdate = true;
      entry.texture = texture;
      resolveEntry(texture);
    },
    undefined,
    () => {
      rejectEntry(new Error(`Failed to load decal texture from "${source}"`));
    },
  );

  return entry;
};

export type DecalTextureHandle = {
  source: string;
  // Resolves once the texture is decoded and ready for the GPU.
  ready: Promise<Texture>;
  // Synchronously available texture (null until loaded).
  getTexture: () => Texture | null;
};

/**
 * Take a reference on the decal texture for `source`, starting a load if
 * needed. Every `acquireDecalTexture` must be paired with
 * `releaseDecalTexture` once the decal stops using it.
 */
export const acquireDecalTexture = (source: string): DecalTextureHandle => {
  let entry = decalTextureCache.get(source);
  if (!entry) {
    entry = createDecalTextureEntry(source);
    decalTextureCache.set(source, entry);
  }

  entry.refs += 1;
  const acquired = entry;

  return {
    source,
    ready: acquired.promise,
    getTexture: () => acquired.texture,
  };
};

/**
 * Drop a reference. The texture is disposed only when no Decal references it
 * anymore, so in-flight or still-mounted decals never lose their image.
 */
export const releaseDecalTexture = (source: string): void => {
  const entry = decalTextureCache.get(source);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;

  entry.dropped = true;
  decalTextureCache.delete(source);

  if (entry.texture) {
    entry.texture.dispose();
    entry.texture = null;
  }
};

// Introspection helpers (also useful for tests/telemetry).
export const getDecalTextureRefCount = (source: string): number =>
  decalTextureCache.get(source)?.refs ?? 0;

export const isDecalTextureTracked = (source: string): boolean =>
  decalTextureCache.has(source);

/* -------------------------------------------------------------------------- */
/*                        Canvas snapshot preparation                         */
/* -------------------------------------------------------------------------- */

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });

// Let the renderer draw the latest committed state before reading pixels.
export const waitForStableFrame = async (frames = 2): Promise<void> => {
  for (let index = 0; index < frames; index += 1) {
    await nextFrame();
  }
};

export type FrameSnapshotHandler = () => void | Promise<void>;

let frameSnapshotHandler: FrameSnapshotHandler | null = null;

/**
 * The 3D scene registers a handler that snaps any animated material
 * properties to their store values so a capture matches the current state.
 */
export const registerFrameSnapshotHandler = (
  handler: FrameSnapshotHandler,
): (() => void) => {
  frameSnapshotHandler = handler;

  return () => {
    if (frameSnapshotHandler === handler) frameSnapshotHandler = null;
  };
};

export const prepareCanvasSnapshot = async (): Promise<void> => {
  if (frameSnapshotHandler) await frameSnapshotHandler();
  // Always let at least one committed frame reach the drawing buffer.
  await waitForStableFrame(2);
};

/* -------------------------------------------------------------------------- */
/*                                  Download                                  */
/* -------------------------------------------------------------------------- */

// capture current canvas pixels
export const captureCanvasToImage = (): void => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return;

  const dataURL = canvas.toDataURL();
  const link = document.createElement("a");
  link.href = dataURL;
  link.download = `tshirt-design-${new Date().toISOString()}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// download canvas image, syncing animated state first
export const downloadCanvasToImage = async (): Promise<void> => {
  await prepareCanvasSnapshot();
  captureCanvasToImage();
};

// render file
export const reader = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => {
      if (typeof fileReader.result === "string") {
        resolve(fileReader.result);
      } else {
        reject(new Error("Failed to read file as data URL"));
      }
    };
    fileReader.onerror = () =>
      reject(fileReader.error ?? new Error("File read failed"));
    fileReader.readAsDataURL(file);
  });

// get contrasting color
export const getContrastingColor = (color: string): "black" | "white" => {
  // Remove the '#' character if it exists
  const hex = color.replace("#", "");

  // Convert the hex string to RGB values
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // Calculate the brightness of the color
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  // Return black or white depending on the brightness
  return brightness > 128 ? "black" : "white";
};
