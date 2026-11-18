import { beforeEach, describe, expect, it, vi } from 'vitest';
import offscreenSource from '../public/offscreen.js?raw';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const mediaStream = () => {
  const track = { stop: vi.fn(), onended: null };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
};

let receive: (message: any, sender: any, response: Function) => void;
let getUserMedia: ReturnType<typeof vi.fn>, messages: any[];
// Handles into the mocked audio graph, so tests can assert on the real wiring decisions:
// which nodes were disconnected, whether the shared limiter was reset, whether the
// context was suspended/resumed.
let context: any, limiter: any, sources: any[], filters: any[];

beforeEach(async () => {
  messages = [];
  getUserMedia = vi.fn();
  sources = [];
  filters = [];
  const parameter = () => ({ value: 0, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: parameter(), frequency: parameter(), Q: parameter() });
  class Context {
    sampleRate = 48000;
    currentTime = 0;
    state = 'suspended';
    destination = node();
    audioWorklet = { addModule: vi.fn(async () => {}) };
    suspend = vi.fn(async () => {});
    resume = vi.fn(async () => {});
    createGain = node;
    createBiquadFilter = vi.fn(() => { const n = node(); filters.push(n); return n; });
    createAnalyser = node;
    createChannelSplitter = node;
    createMediaStreamSource = vi.fn(() => { const n = node(); sources.push(n); return n; });
    constructor() { context = this; }
  }
  class Worklet {
    connect = vi.fn();
    port = { postMessage: vi.fn() };
    constructor() { limiter = this; }
  }
  // Run the shipped classic script, not a copy of its capture implementation. Only browser APIs
  // are replaced: these tests exercise message routing, pending promises, status and track cleanup.
  new Function('window', 'AudioWorkletNode', 'chrome', 'navigator', 'self', 'setInterval', 'setTimeout', 'console', offscreenSource)(
    { AudioContext: Context }, Worklet,
    { runtime: {
      getURL: (path: string) => path,
      onMessage: { addListener: (handler: typeof receive) => { receive = handler; } },
      sendMessage: async (message: any) => { messages.push(structuredClone(message)); }
    } },
    { mediaDevices: { getUserMedia } }, { addEventListener: vi.fn() }, vi.fn(), vi.fn(), { error: vi.fn(), log: vi.fn() }
  );
  await flush();
  messages = [];
});

const send = async (type: string, fields: Record<string, unknown> = {}) => {
  receive({ target: 'offscreen', type, ...fields }, {}, vi.fn());
  await flush();
};
const start = (tabId = 1) => send('startCapture', { streamId: 'stream-' + tabId, tab: { id: tabId, url: 'https://example.com/' } });
const statuses = () => messages.filter(m => m.type === 'workspaceStatus');
const getStatus = async () => {
  const response = vi.fn();
  receive({ target: 'offscreen', type: 'getStatus' }, {}, response);
  await flush();
  return response.mock.calls[0][0];
};

describe('offscreen pending capture lifecycle', () => {
  it('does not broadcast an acquisition error after that capture has been stopped', async () => {
    const request = deferred<ReturnType<typeof mediaStream>>();
    getUserMedia.mockReturnValueOnce(request.promise);
    await start();
    await send('stopCapture', { tabId: 1 });
    request.reject(new Error('Capture revoked')); await flush();
    expect(messages.some(m => m.type === 'engineError')).toBe(false);
  });

  it('does not let an older failed request mark a replacement capture as broken', async () => {
    const old = deferred<ReturnType<typeof mediaStream>>();
    const replacement = mediaStream();
    getUserMedia.mockReturnValueOnce(old.promise).mockResolvedValueOnce(replacement);
    await start();
    await start();
    old.reject(new Error('Old stream id expired')); await flush();
    expect(messages.some(m => m.type === 'engineError')).toBe(false);
    expect((await getStatus()).tabs.map((tab: any) => tab.id)).toEqual([1]);
    expect(replacement.track.stop).not.toHaveBeenCalled();
  });

  it('still reports a failure for the current capture attempt', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
    await start();
    expect(messages).toContainEqual({ type: 'engineError', where: 'getUserMedia for tab capture failed', error: 'Permission denied' });
  });

  it('stops a canceled stream that finishes acquiring after Stop', async () => {
    const request = deferred<ReturnType<typeof mediaStream>>();
    getUserMedia.mockReturnValueOnce(request.promise);
    await start();
    await send('stopCapture', { tabId: 1 });
    const stream = mediaStream();
    request.resolve(stream); await flush();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(statuses().every(m => m.tabs.length === 0)).toBe(true);
  });
});

describe('offscreen chain teardown convergence', () => {
  it('releases the old chain and resets the limiter before a fast re-capture takes over', async () => {
    const first = mediaStream(), second = mediaStream();
    getUserMedia.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await start();
    expect(sources).toHaveLength(1);
    const oldSource = sources[0];
    const oldFilters = filters.slice();
    limiter.port.postMessage.mockClear();

    await start(); // same tab, re-captured while the first chain is live

    // The old chain is fully released BEFORE the new one exists: tracks stopped, nodes disconnected.
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(oldSource.disconnect).toHaveBeenCalled();
    for (const f of oldFilters) expect(f.disconnect).toHaveBeenCalled();
    // The old chain was the last one, so the shared limiter was reset — its delayed samples
    // and gain envelope must not leak into the replacement mix.
    expect(limiter.port.postMessage).toHaveBeenCalledWith({ type: 'reset' });
    // The replacement chain is untouched and is the only one the status reports.
    expect(second.track.stop).not.toHaveBeenCalled();
    expect(sources[1].disconnect).not.toHaveBeenCalled();
    expect((await getStatus()).tabs.map((tab: any) => tab.id)).toEqual([1]);
    expect(statuses().at(-1).tabs.map((tab: any) => tab.id)).toEqual([1]);
  });

  it('stops the acquired stream and tears down the partial chain when chain construction throws', async () => {
    const stream = mediaStream();
    getUserMedia.mockResolvedValueOnce(stream);
    // The third biquad blows up mid-build: two filters are already wired and must be disconnected.
    const makeFilter = context.createBiquadFilter.getMockImplementation();
    context.createBiquadFilter
      .mockImplementationOnce(makeFilter)
      .mockImplementationOnce(makeFilter)
      .mockImplementationOnce(() => { throw new Error('node limit reached'); });
    context.suspend.mockClear();

    await start();

    expect(stream.track.stop).toHaveBeenCalledOnce(); // the acquired stream is never orphaned
    expect(filters).toHaveLength(2);
    for (const f of filters) expect(f.disconnect).toHaveBeenCalled(); // partial chain unwired
    expect(messages).toContainEqual({ type: 'engineError', where: 'startCapture: building chain failed', error: 'node limit reached' });
    // No chain survived, so the engine idles: limiter reset, context suspended, empty tab list.
    expect(limiter.port.postMessage).toHaveBeenCalledWith({ type: 'reset' });
    expect(context.suspend).toHaveBeenCalled();
    expect(statuses().at(-1).tabs).toEqual([]);
    expect((await getStatus()).tabs).toEqual([]);
  });

  it('a failed re-capture releases the old chain and reports the tab gone', async () => {
    const first = mediaStream();
    getUserMedia.mockResolvedValueOnce(first);
    await start();
    expect(statuses().at(-1).tabs.map((tab: any) => tab.id)).toEqual([1]);

    const failing = mediaStream();
    getUserMedia.mockResolvedValueOnce(failing);
    context.createMediaStreamSource.mockImplementationOnce(() => { throw new Error('context closed'); });
    limiter.port.postMessage.mockClear();

    await start(); // re-capture: old chain released, then the build of the new one throws

    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(sources[0].disconnect).toHaveBeenCalled();
    expect(failing.track.stop).toHaveBeenCalledOnce();
    expect(messages).toContainEqual({ type: 'engineError', where: 'startCapture: building chain failed', error: 'context closed' });
    // The tab is gone from the broadcast list — the popup must not keep showing a live chain.
    expect(statuses().at(-1).tabs).toEqual([]);
    expect(limiter.port.postMessage).toHaveBeenCalledWith({ type: 'reset' });
  });

  it('a build failure on one tab leaves the other tabs playing and their limiter untouched', async () => {
    const other = mediaStream();
    getUserMedia.mockResolvedValueOnce(other);
    await start(2); // a healthy chain on another tab
    const stream = mediaStream();
    getUserMedia.mockResolvedValueOnce(stream);
    context.createMediaStreamSource.mockImplementationOnce(() => { throw new Error('context closed'); });
    limiter.port.postMessage.mockClear();
    context.suspend.mockClear();

    await start(1);

    // The error is reported once, for the request that failed...
    expect(messages.filter(m => m.type === 'engineError')).toEqual([
      { type: 'engineError', where: 'startCapture: building chain failed', error: 'context closed' }
    ]);
    expect(stream.track.stop).toHaveBeenCalledOnce();
    // ...while tab 2 keeps playing: its stream is not stopped, the context is not suspended,
    // and the shared limiter is NOT reset (a reset would click the surviving tab's audio).
    expect(other.track.stop).not.toHaveBeenCalled();
    expect(limiter.port.postMessage).not.toHaveBeenCalled();
    expect(context.suspend).not.toHaveBeenCalled();
    // The broadcast tab list matches the chains that actually survive.
    expect(statuses().at(-1).tabs.map((tab: any) => tab.id)).toEqual([2]);
    expect((await getStatus()).tabs.map((tab: any) => tab.id)).toEqual([2]);
  });

  it('resets the shared limiter only after the last tab disconnects', async () => {
    const one = mediaStream(), two = mediaStream();
    getUserMedia.mockResolvedValueOnce(one).mockResolvedValueOnce(two);
    await start(1);
    await start(2);
    limiter.port.postMessage.mockClear();
    context.suspend.mockClear();

    await send('stopCapture', { tabId: 1 });
    expect(one.track.stop).toHaveBeenCalledOnce();
    expect(limiter.port.postMessage).not.toHaveBeenCalled(); // tab 2 still plays through it
    expect(context.suspend).not.toHaveBeenCalled();
    expect(statuses().at(-1).tabs.map((tab: any) => tab.id)).toEqual([2]);

    await send('stopCapture', { tabId: 2 });
    expect(two.track.stop).toHaveBeenCalledOnce();
    expect(limiter.port.postMessage).toHaveBeenCalledWith({ type: 'reset' });
    expect(context.suspend).toHaveBeenCalled();
    expect(statuses().at(-1).tabs).toEqual([]);
  });
});
