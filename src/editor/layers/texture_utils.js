import * as THREE from "three";
import { getUVMap, MODEL_MAP, uvLookup } from "../model/uv.js";
import MIRROR_MAP from "./mirror_map.js";
import { IMAGE_HEIGHT, IMAGE_WIDTH } from "../../constants.js";
import { nonPolyfilledCtx } from "../../helpers.js";

const MODEL_LAYERS = ["base", "overlay"];
const MODEL_PARTS = ["arm_left", "arm_right", "head", "torso", "leg_left", "leg_right", "ears"];
const MODEL_FACES = ["front", "back", "left", "right", "top", "bottom"];

function remapUV(texture, ctx, source, destination) {
  ctx.clearRect(...destination);
  ctx.drawImage(texture, ...source, ...destination);
}

function swapBodyOverlay(inputCanvas, variant = "classic") {
  const canvas = new OffscreenCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = nonPolyfilledCtx(canvas.getContext("2d"));

  ctx.drawImage(inputCanvas, 0, 0);
  
  function swapUV(source, destination) {
    Object.keys(source).forEach(key => {
      remapUV(inputCanvas, ctx, source[key], destination[key])
    });
  }

  MODEL_PARTS.forEach(part => {
    const base = getUVMap(variant, part + "_base");
    const overlay = getUVMap(variant, part + "_overlay");

    swapUV(base, overlay);
    swapUV(overlay, base);
  })

  return canvas;
}

function swapFrontBack(inputCanvas, variant = "classic") {
  const canvas = new OffscreenCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = nonPolyfilledCtx(canvas.getContext("2d"));

  ctx.drawImage(inputCanvas, 0, 0);

  const partPairs = [["arm_left", "arm_right"], ["head", "head"], ["torso", "torso"], ["leg_left", "leg_right"], ["ears", "ears"]];

  function flipUV(source, destination) {
    const pairs = [["front", "back"], ["left", "right"]];

    pairs.forEach(pair => {
      const faceA = source[pair[0]];
      const faceB = destination[pair[1]];

      const faceC = source[pair[1]];
      const faceD = destination[pair[0]];

      remapUV(inputCanvas, ctx, faceA, faceB);
      remapUV(inputCanvas, ctx, faceB, faceA);

      remapUV(inputCanvas, ctx, faceC, faceD);
      remapUV(inputCanvas, ctx, faceD, faceC);
    });

    function flip(src, dest) {
      ctx.save();
      ctx.translate(src[2] + (dest[0] * 2), src[3] + (dest[1] * 2));
      ctx.scale(-1, -1);
      remapUV(inputCanvas, ctx, src, dest);
      ctx.restore();
    }

    // Flip top
    flip(source.top, destination.top);
    flip(destination.top, source.top);

    // Flip bottom
    flip(source.bottom, destination.bottom);
    flip(destination.bottom, source.bottom);
  }

  partPairs.forEach(pair => {
    const baseA = getUVMap(variant, pair[0] + "_base");
    const overlayA = getUVMap(variant, pair[0] + "_overlay");

    const baseB = getUVMap(variant, pair[1] + "_base");
    const overlayB = getUVMap(variant, pair[1] + "_overlay");

    flipUV(baseA, baseB);
    flipUV(overlayA, overlayB);
  })

  return canvas;
}

function swapLeftRight(inputCanvas, variant = "classic") {
  const canvas = new OffscreenCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = nonPolyfilledCtx(canvas.getContext("2d"));

  ctx.drawImage(inputCanvas, 0, 0);

  const partPairs = [["arm_left", "arm_right"], ["head", "head"], ["torso", "torso"], ["leg_left", "leg_right"], ["ears", "ears"]];

  function flipUV(source, destination) {
    const pairs = [["front", "front"],["back", "back"]];

    pairs.forEach(pair => {
      const faceA = source[pair[0]];
      const faceB = destination[pair[1]];

      const faceC = source[pair[1]];
      const faceD = destination[pair[0]];

      remapUV(inputCanvas, ctx, faceA, faceB);
      remapUV(inputCanvas, ctx, faceB, faceA);

      remapUV(inputCanvas, ctx, faceC, faceD);
      remapUV(inputCanvas, ctx, faceD, faceC);
    });

    function mirror(src, dest) {
      ctx.save();
      ctx.translate(src[2] + (dest[0] * 2), 0);
      ctx.scale(-1, 1);
      remapUV(inputCanvas, ctx, src, dest);
      ctx.restore();
    }

    // Flip top
    mirror(source.top, destination.top);
    mirror(destination.top, source.top);

    // Flip bottom
    mirror(source.bottom, destination.bottom);
    mirror(destination.bottom, source.bottom);

    // Flip front
    mirror(source.front, destination.front);
    mirror(destination.front, source.front);

    // Flip back
    mirror(source.back, destination.back);
    mirror(destination.back, source.back);

    // Flip left
    mirror(source.left, destination.right);
    mirror(destination.right, source.left);

    // Flip right
    mirror(source.right, destination.left);
    mirror(destination.left, source.right);

  }

  partPairs.forEach(pair => {
    const baseA = getUVMap(variant, pair[0] + "_base");
    const overlayA = getUVMap(variant, pair[0] + "_overlay");

    const baseB = getUVMap(variant, pair[1] + "_base");
    const overlayB = getUVMap(variant, pair[1] + "_overlay");

    flipUV(baseA, baseB);
    flipUV(overlayA, overlayB);
  })

  return canvas;
}

function getPartFromCoords(variant, point) {
  const uv = MODEL_MAP[variant];

  function inBox(point, x, y, w, h) {
    // Account for negative uv width / height
    const checkX = w >= 0 ? (point.x >= x && point.x < x + w) : (point.x >= x + w && point.x < x);
    const checkY = h >= 0 ? (point.y >= y && point.y < y + h) : (point.y >= y + h && point.y < y);
    return checkX && checkY;
  }

  let part;
  Object.entries(uv).find(([key, value]) => {
    if (inBox(point, ...value)) {
      part = key;
      return true;
    }

    return false;
  })

  return part;
}

// Normalise an entry of the uv map ([x, y, width, height]) into a positive
// width / height rectangle.
function normalizeUVRect([x, y, width, height]) {
  if (width < 0) {
    x += width;
    width *= -1;
  }

  if (height < 0) {
    y += height;
    height *= -1;
  }

  return {x, y, width, height};
}

// Find the face (part, layer, face) a texture pixel belongs to, along with the
// rectangle that face occupies on the texture.
function getFaceFromCoords(variant, point) {
  const uv = MODEL_MAP[variant];
  if (!uv) { return undefined; }

  const x = Math.floor(point.x);
  const y = Math.floor(point.y);

  for (const [key, value] of Object.entries(uv)) {
    const rect = normalizeUVRect(value);

    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
      const match = key.match(/^(.+)_(base|overlay)_(front|back|left|right|top|bottom)$/);
      if (!match) { continue; }

      return {
        key,
        part: match[1],
        layer: match[2],
        face: match[3],
        rect,
      };
    }
  }

  return undefined;
}

function getMirroredCoords(variant, point) {
  const uv = MODEL_MAP[variant];
  const part = getPartFromCoords(variant, point);

  function mirrorAlternate(currentPart, newPart, point) {
    const currentUV = uv[currentPart];
    const newUV = uv[newPart];
    
    const offsetX = point.x - currentUV[0];
    const offsetY = point.y - currentUV[1];

    return new THREE.Vector2((newUV[0] + newUV[2]) - (offsetX + 1), newUV[1] + offsetY);
  }

  function mirrorSame(currentPart, point) {
    const currentUV = uv[currentPart];

    const offsetX = point.x - currentUV[0];

    return new THREE.Vector2((currentUV[0] + currentUV[2]) - (offsetX + 1), point.y);
  }

  let alternatePart = MIRROR_MAP[part];

  if (alternatePart) {
    return mirrorAlternate(part, alternatePart, point);
  } else {
    return mirrorSame(part, point);
  }
}

function clearLayer(inputCanvas, variant, layer) {
  const canvas = new OffscreenCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = nonPolyfilledCtx(canvas.getContext("2d"));

  ctx.drawImage(inputCanvas, 0, 0);

  MODEL_PARTS.forEach(part => {
    MODEL_FACES.forEach(face => {
      const uv = uvLookup(variant, layer, part, face);

      ctx.clearRect(...uv);
    });
  });

  return canvas;
}

function getUV(variant, part) {
  return normalizeUVRect(MODEL_MAP[variant][part]);
}

function getUVFromCoords(variant, point) {
  const part = getPartFromCoords(variant, point);

  return getUV(variant, part);
}

function getWatermarkData(canvas) {
  const ctx = nonPolyfilledCtx(canvas.getContext("2d"));

  function bytesToString(bytea) {
    let i = 0;
    return bytea.map(byte => {
      i ++;
      if (byte == 0 || i % 4 == 0) {
        return '';
      }
      return String.fromCharCode(byte);
    }).join('');
  }

  const imgData = ctx.getImageData(0, 0, 8, 8);
  const str = bytesToString(Array.from(imgData.data));

  if (/https?/.test(str)) {
    return str;
  } else {
    return false;
  }
}

function mergeLayers(inputCanvas, sourceLayer, destLayer, variant) {
  const canvas = new OffscreenCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = nonPolyfilledCtx(canvas.getContext("2d"));

  ctx.drawImage(inputCanvas, 0, 0);

  MODEL_LAYERS.forEach(layer => {
    MODEL_PARTS.forEach(part => {
      MODEL_FACES.forEach(face => {
        const uv = uvLookup(variant, layer, part, face);
        ctx.clearRect(...uv);
      });
    });
  });
  
  function swapUV(source, destination) {
    Object.keys(source).forEach(key => {
      remapUV(inputCanvas, ctx, source[key], destination[key])
    });
  }

  MODEL_PARTS.forEach(part => {
    const source = getUVMap(variant, part + "_" + sourceLayer);
    const dest = getUVMap(variant, part + "_" + destLayer);

    Object.keys(dest).forEach(key => {
      ctx.drawImage(inputCanvas, ...dest[key], ...dest[key]);
    });

    Object.keys(source).forEach(key => {
      ctx.drawImage(inputCanvas, ...source[key], ...dest[key]);
    });
  })

  return canvas;
}

export {remapUV, getMirroredCoords, swapBodyOverlay, swapFrontBack, swapLeftRight, getPartFromCoords, getFaceFromCoords, getUV, getUVFromCoords, getWatermarkData, clearLayer, mergeLayers}