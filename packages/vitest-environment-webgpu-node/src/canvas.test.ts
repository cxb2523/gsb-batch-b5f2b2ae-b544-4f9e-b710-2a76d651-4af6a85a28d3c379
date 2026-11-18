import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas } from './canvas.ts';
import environment from './index.ts';

let teardown: (g?: Record<string, unknown>) => void;
let device: GPUDevice;
beforeAll(async () => {
  ({ teardown } = environment.setup(globalThis, {}));
  device = await (await navigator.gpu.requestAdapter())!.requestDevice();
});
afterAll(async () => {
  device.destroy();
  teardown(globalThis);
});

const clearTo = (canvas: ReturnType<typeof createCanvas>, color: GPUColor) => {
  const encoder = device.createCommandEncoder();
  const view = canvas.getContext('webgpu').getCurrentTexture().createView();
  encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: color }] }).end();
  device.queue.submit([encoder.finish()]);
};

it('behaves like a canvas element', () => {
  const canvas = createCanvas(10, 20);
  expect(canvas.clientWidth).toBe(10);
  expect(canvas.clientHeight).toBe(20);
  expect(canvas.getBoundingClientRect()).toMatchObject({ width: 10, height: 20, top: 0, left: 0 });
  expect(canvas.getContext('2d')).toBeNull();
  expect(canvas.style).toEqual({});
  expect(canvas.getAttribute('id')).toBeNull();
  canvas.setAttribute('id', 'c');
  expect(canvas.getAttribute('id')).toBe('c');
  canvas.addEventListener();
  canvas.removeEventListener();
  expect(canvas.dispatchEvent()).toBe(true);
  expect(canvas.asElement()).toBe(canvas);
  expect(createCanvas(300, 150).width).toBe(300);
});

it('requires configure() before accessing pixels', async () => {
  const context = createCanvas(4, 4).getContext('webgpu');
  expect(context.getConfiguration()).toBeNull();
  expect(() => context.getCurrentTexture()).toThrow(/configure/);
  await expect(context.readPixels()).rejects.toThrow('readPixels() called before configure()');
});

it('renders into the current texture and reads pixels back, swizzling bgra', async () => {
  const canvas = createCanvas(70, 3); // 70 * 4 = 280 bytes per row forces 512-byte padding
  const context = canvas.getContext('webgpu');
  context.configure({ device, format: 'bgra8unorm' });
  expect(context.getConfiguration()?.format).toBe('bgra8unorm');
  clearTo(canvas, [1, 0.5, 0, 1]);
  const image = await canvas.readPixels();
  expect(image).toMatchObject({ width: 70, height: 3 });
  expect(Array.from(image.data.subarray(0, 4))).toEqual([255, 128, 0, 255]);
  expect(Array.from(image.data.subarray(-4))).toEqual([255, 128, 0, 255]);
  expect(image.data.length).toBe(70 * 3 * 4);
});

it('accepts wider canvas formats but clearly rejects unsupported readback', async () => {
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext('webgpu');
  context.configure({ device, format: 'rgba16float' });
  expect(context.getConfiguration()?.format).toBe('rgba16float');
  clearTo(canvas, [1, 0, 0, 1]);
  await expect(canvas.readPixels()).rejects.toThrow(
    'readPixels() does not support canvas format "rgba16float"; supported formats are rgba8unorm, rgba8unorm-srgb, bgra8unorm, and bgra8unorm-srgb',
  );
});

it('destroys the staging buffer when mapping fails', async () => {
  const destroy = vi.fn();
  const buffer = {
    mapAsync: vi.fn().mockRejectedValue(new Error('map failed')),
    destroy,
  };
  const texture = { width: 1, height: 1, destroy: vi.fn() };
  const encoder = { copyTextureToBuffer: vi.fn(), finish: vi.fn() };
  const fakeDevice = {
    createTexture: vi.fn().mockReturnValue(texture),
    createBuffer: vi.fn().mockReturnValue(buffer),
    createCommandEncoder: vi.fn().mockReturnValue(encoder),
    queue: { submit: vi.fn() },
  } as unknown as GPUDevice;
  const canvas = createCanvas(1, 1);
  canvas.getContext('webgpu').configure({ device: fakeDevice, format: 'rgba8unorm' });

  await expect(canvas.readPixels()).rejects.toThrow('map failed');
  expect(destroy).toHaveBeenCalledOnce();
});

it('keeps the texture across frames, but recreates it on resize or reconfigure', async () => {
  const canvas = createCanvas(4, 4);
  const context = canvas.getContext('webgpu');
  context.configure({ device, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  const first = context.getCurrentTexture();
  expect(context.getCurrentTexture()).toBe(first);
  expect(first.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
  canvas.width = 8;
  const resized = context.getCurrentTexture();
  expect(resized).not.toBe(first);
  expect(resized.width).toBe(8);
  clearTo(canvas, [0, 0, 1, 1]);
  expect(Array.from((await canvas.readPixels()).data.subarray(0, 4))).toEqual([0, 0, 255, 255]);
  context.configure({ device, format: 'rgba8unorm' });
  expect(context.getCurrentTexture()).not.toBe(resized);
  context.unconfigure();
  expect(context.getConfiguration()).toBeNull();
});

it('readPixels() follows the canvas size after a resize between render and readback', async () => {
  const canvas = createCanvas(4, 4);
  const context = canvas.getContext('webgpu');
  context.configure({ device, format: 'rgba8unorm' });
  clearTo(canvas, [0, 1, 0, 1]);
  const before = await canvas.readPixels();
  expect(before).toMatchObject({ width: 4, height: 4 });
  expect(before.data.length).toBe(4 * 4 * 4);

  // Resize without calling getCurrentTexture(): readPixels() itself must converge on the new canvas size.
  canvas.width = 8;
  canvas.height = 5;
  const after = await canvas.readPixels();
  expect(after).toMatchObject({ width: 8, height: 5 });
  expect(after.data.length).toBe(8 * 5 * 4);
  expect(context.getCurrentTexture()).toMatchObject({ width: 8, height: 5 });

  // Shrinking back recreates the texture again rather than reusing the oversized one.
  canvas.width = 3;
  canvas.height = 7;
  const shrunk = await canvas.readPixels();
  expect(shrunk).toMatchObject({ width: 3, height: 7 });
  expect(shrunk.data.length).toBe(3 * 7 * 4);
});

it('destroys the stale texture and staging buffers when readPixels() crosses a resize', async () => {
  const textures: Array<{ width: number; height: number; destroy: ReturnType<typeof vi.fn> }> = [];
  const buffers: Array<{
    size: number;
    mapAsync: ReturnType<typeof vi.fn>;
    getMappedRange: ReturnType<typeof vi.fn>;
    unmap: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const createTexture = vi.fn((descriptor: { size: [number, number]; format: GPUTextureFormat }) => {
    const texture = { width: descriptor.size[0], height: descriptor.size[1], destroy: vi.fn() };
    textures.push(texture);
    return texture;
  });
  const fakeDevice = {
    createTexture,
    createBuffer: vi.fn((descriptor: { size: number }) => {
      const buffer = {
        size: descriptor.size,
        mapAsync: vi.fn().mockResolvedValue(undefined),
        getMappedRange: vi.fn(() => new ArrayBuffer(descriptor.size)),
        unmap: vi.fn(),
        destroy: vi.fn(),
      };
      buffers.push(buffer);
      return buffer;
    }),
    createCommandEncoder: vi.fn(() => ({ copyTextureToBuffer: vi.fn(), finish: vi.fn() })),
    queue: { submit: vi.fn() },
  } as unknown as GPUDevice;
  const canvas = createCanvas(4, 4);
  const context = canvas.getContext('webgpu');
  context.configure({ device: fakeDevice, format: 'rgba8unorm' });

  const first = await context.readPixels();
  expect(first).toMatchObject({ width: 4, height: 4 });
  expect(textures).toHaveLength(1);

  canvas.width = 6;
  canvas.height = 2;
  const second = await context.readPixels();
  expect(second).toMatchObject({ width: 6, height: 2 });
  expect(second.data.length).toBe(6 * 2 * 4);
  expect(textures).toHaveLength(2);
  expect(textures[0]!.destroy).toHaveBeenCalledOnce();
  expect(textures[1]).toMatchObject({ width: 6, height: 2 });
  expect(textures[1]!.destroy).not.toHaveBeenCalled();
  // Every readback gets a fresh staging buffer that is unmapped and destroyed, never leaked.
  expect(buffers).toHaveLength(2);
  for (const buffer of buffers) {
    expect(buffer.unmap).toHaveBeenCalledOnce();
    expect(buffer.destroy).toHaveBeenCalledOnce();
  }

  // Reconfiguring with another format/device drops the texture even when the size is unchanged.
  context.configure({ device: fakeDevice, format: 'bgra8unorm' });
  expect(textures[1]!.destroy).toHaveBeenCalledOnce();
  const third = await context.readPixels();
  expect(third).toMatchObject({ width: 6, height: 2 });
  expect(textures).toHaveLength(3);
  expect(createTexture).toHaveBeenLastCalledWith(expect.objectContaining({ size: [6, 2], format: 'bgra8unorm' }));
});
