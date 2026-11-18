import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  acquireVideoPlaybackManager,
  getVideoPlaybackManagerCount,
  MIN_VIDEO_NODE_DIMENSION,
  releaseVideoPlaybackManager,
  type VideoElementLike,
  VideoPlaybackManager,
} from "./video-playback.ts"

const URL_A = "https://cdn.test/a.mp4"
const URL_B = "https://cdn.test/b.mp4"

/** Minimal HTMLVideoElement stand-in driven by the manager. */
class FakeVideoElement implements VideoElementLike {
  currentTime = 0
  paused = true
  playCalls = 0
  pauseCalls = 0
  loadCalls = 0
  private url = ""
  private listeners = new Map<string, Set<() => void>>()

  get src(): string {
    return this.url
  }

  set src(value: string) {
    this.url = value
  }

  removeAttribute(name: string): void {
    if (name === "src") this.url = ""
  }

  load(): void {
    this.loadCalls += 1
  }

  play(): Promise<void> {
    this.playCalls += 1
    this.paused = false
    return Promise.resolve()
  }

  pause(): void {
    this.pauseCalls += 1
    this.paused = true
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

function boundNode(url: string = URL_A) {
  const manager = new VideoPlaybackManager("node-1")
  manager.setVideoUrl(url)
  const element = new FakeVideoElement()
  const unbind = manager.bindElement("node", element)
  return { manager, element, unbind }
}

describe("VideoPlaybackManager", () => {
  it("autoplays the node surface as soon as it is bound", () => {
    const { element } = boundNode()
    assert.equal(element.src, URL_A)
    assert.equal(element.paused, false)
    assert.equal(element.playCalls, 1)
  })

  it("does not decode anything before a url is set", () => {
    const manager = new VideoPlaybackManager("node-1")
    const element = new FakeVideoElement()
    manager.bindElement("node", element)
    assert.equal(element.src, "")
    assert.equal(element.paused, true)
    assert.equal(element.playCalls, 0)
  })

  it("hands playback from node to focus without losing progress", () => {
    const { manager, element: node } = boundNode()
    node.currentTime = 5
    node.emit("timeupdate")

    const focus = new FakeVideoElement()
    manager.bindElement("focus", focus)

    // Node decoder released: paused, src dropped, load() called to free resources.
    assert.equal(node.src, "")
    assert.equal(node.paused, true)
    assert.ok(node.pauseCalls >= 1)
    assert.ok(node.loadCalls >= 1)

    // Focus continues from the node's position instead of restarting.
    assert.equal(focus.src, URL_A)
    assert.equal(focus.currentTime, 5)
    assert.equal(focus.paused, false)
  })

  it("returns playback to the node when focus closes, keeping progress", () => {
    const { manager, element: node } = boundNode()
    const focus = new FakeVideoElement()
    const unbindFocus = manager.bindElement("focus", focus)

    focus.currentTime = 8
    focus.emit("timeupdate")
    unbindFocus()

    // Focus released, node resumes exactly where the focus layer stopped.
    assert.equal(focus.src, "")
    assert.equal(focus.paused, true)
    assert.equal(node.src, URL_A)
    assert.equal(node.currentTime, 8)
    assert.equal(node.paused, false)
  })

  it("never lets node and focus hold a src at the same time", () => {
    const { manager, element: node } = boundNode()
    const focus = new FakeVideoElement()
    const unbindFocus = manager.bindElement("focus", focus)

    const bothDecoding = () => node.src !== "" && focus.src !== ""
    assert.equal(bothDecoding(), false)

    node.emit("timeupdate")
    focus.emit("timeupdate")
    assert.equal(bothDecoding(), false)

    unbindFocus()
    assert.equal(bothDecoding(), false)
  })

  it("suspends a hidden or too-small node and resumes at the same position", () => {
    const { manager, element: node } = boundNode()
    node.currentTime = 3
    node.emit("timeupdate")

    manager.setNodeAvailable(false)
    assert.equal(node.src, "")
    assert.equal(node.paused, true)
    assert.ok(node.loadCalls >= 1)

    manager.setNodeAvailable(true)
    assert.equal(node.src, URL_A)
    assert.equal(node.currentTime, 3)
    assert.equal(node.paused, false)
  })

  it("keeps the focus surface playing while the node is suspended", () => {
    const { manager, element: node } = boundNode()
    const focus = new FakeVideoElement()
    manager.bindElement("focus", focus)

    manager.setNodeAvailable(false)
    assert.equal(node.src, "")
    assert.equal(focus.src, URL_A)
    assert.equal(focus.paused, false)
  })

  it("restarts from 0 when the url changes and releases the old video", () => {
    const { manager, element: node } = boundNode()
    node.currentTime = 7
    node.emit("timeupdate")
    const loadsBefore = node.loadCalls

    manager.setVideoUrl(URL_B)

    assert.equal(node.src, URL_B)
    assert.equal(node.currentTime, 0)
    assert.equal(manager.currentPosition, 0)
    assert.equal(node.paused, false)
    // The old resource was released via load() before the new one was applied.
    assert.ok(node.loadCalls > loadsBefore)
  })

  it("switches the url on the focus surface while it is open", () => {
    const { manager, element: node } = boundNode()
    const focus = new FakeVideoElement()
    manager.bindElement("focus", focus)
    focus.currentTime = 4
    focus.emit("timeupdate")

    manager.setVideoUrl(URL_B)

    assert.equal(focus.src, URL_B)
    assert.equal(focus.currentTime, 0)
    assert.equal(focus.paused, false)
    // Node stays released while focus owns playback.
    assert.equal(node.src, "")
  })

  it("ignores redundant url updates", () => {
    const { manager, element: node } = boundNode()
    node.currentTime = 6
    node.emit("timeupdate")
    const playCalls = node.playCalls
    const loadCalls = node.loadCalls

    manager.setVideoUrl(URL_A)

    assert.equal(node.src, URL_A)
    assert.equal(manager.currentPosition, 6)
    assert.equal(node.playCalls, playCalls)
    assert.equal(node.loadCalls, loadCalls)
  })

  it("clears the url: both surfaces release and nothing decodes", () => {
    const { manager, element: node } = boundNode()
    manager.setVideoUrl(undefined)
    assert.equal(node.src, "")
    assert.equal(node.paused, true)
    assert.equal(manager.currentUrl, null)
  })

  it("applies a url change made while suspended once the node is visible again", () => {
    const { manager, element: node } = boundNode()
    manager.setNodeAvailable(false)
    manager.setVideoUrl(URL_B)
    assert.equal(node.src, "")

    manager.setNodeAvailable(true)
    assert.equal(node.src, URL_B)
    assert.equal(node.currentTime, 0)
    assert.equal(node.paused, false)
  })

  it("removes listeners and releases the element when unbound", () => {
    const { manager, element: node, unbind } = boundNode()
    unbind()

    assert.equal(node.src, "")
    assert.equal(node.paused, true)
    assert.equal(node.listenerCount("timeupdate"), 0)
    assert.equal(node.listenerCount("loadedmetadata"), 0)

    // Stray events from the detached element must not reach the manager.
    node.currentTime = 99
    node.emit("timeupdate")
    assert.equal(manager.currentPosition, 0)
  })

  it("makes unbind idempotent", () => {
    const { element: node, unbind } = boundNode()
    unbind()
    const loadCalls = node.loadCalls
    unbind()
    assert.equal(node.loadCalls, loadCalls)
  })

  it("keeps the shared position when the node rebinds after focus closes", () => {
    const manager = new VideoPlaybackManager("node-1")
    manager.setVideoUrl(URL_A)
    const node = new FakeVideoElement()
    manager.bindElement("node", node)
    const focus = new FakeVideoElement()
    const unbindFocus = manager.bindElement("focus", focus)
    focus.currentTime = 12
    focus.emit("timeupdate")
    unbindFocus()

    // Node component remounts (e.g. re-rendered after being off-screen).
    const nodeAgain = new FakeVideoElement()
    manager.bindElement("node", nodeAgain)
    assert.equal(nodeAgain.src, URL_A)
    assert.equal(nodeAgain.currentTime, 12)
    assert.equal(nodeAgain.paused, false)
  })

  it("destroy releases every bound surface and its listeners", () => {
    const { manager, element: node } = boundNode()
    const focus = new FakeVideoElement()
    manager.bindElement("focus", focus)

    manager.destroy()

    for (const element of [node, focus]) {
      assert.equal(element.src, "")
      assert.equal(element.paused, true)
      assert.equal(element.listenerCount("timeupdate"), 0)
      assert.equal(element.listenerCount("loadedmetadata"), 0)
    }
  })

  it("seeks an element that finishes loading after the position advanced", () => {
    const { element: node } = boundNode()
    // Simulate a late loadedmetadata with drifted currentTime.
    node.currentTime = 30
    node.emit("loadedmetadata")
    assert.equal(node.currentTime, 0)
    assert.equal(node.paused, false)
  })

  it("exposes a positive size threshold for node suspension", () => {
    assert.ok(MIN_VIDEO_NODE_DIMENSION > 0)
  })
})

describe("video playback manager registry", () => {
  it("shares one manager per node id and disposes it when the last consumer leaves", () => {
    const before = getVideoPlaybackManagerCount()

    const first = acquireVideoPlaybackManager("registry-node")
    const second = acquireVideoPlaybackManager("registry-node")
    assert.equal(first, second)
    assert.equal(getVideoPlaybackManagerCount(), before + 1)

    releaseVideoPlaybackManager("registry-node")
    assert.equal(getVideoPlaybackManagerCount(), before + 1)

    releaseVideoPlaybackManager("registry-node")
    assert.equal(getVideoPlaybackManagerCount(), before)

    // A fresh acquire after full release starts from a clean state.
    const third = acquireVideoPlaybackManager("registry-node")
    assert.notEqual(third, first)
    assert.equal(third.currentPosition, 0)
    releaseVideoPlaybackManager("registry-node")
    assert.equal(getVideoPlaybackManagerCount(), before)
  })

  it("releases elements bound through the registry when the last consumer leaves", () => {
    const manager = acquireVideoPlaybackManager("registry-cleanup")
    manager.setVideoUrl(URL_A)
    const node = new FakeVideoElement()
    manager.bindElement("node", node)
    releaseVideoPlaybackManager("registry-cleanup")

    assert.equal(node.src, "")
    assert.equal(node.paused, true)
    assert.equal(node.listenerCount("timeupdate"), 0)
  })
})
