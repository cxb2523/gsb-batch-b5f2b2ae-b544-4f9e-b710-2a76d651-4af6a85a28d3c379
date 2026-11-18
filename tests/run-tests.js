"use strict";
/*
 * Neovid acceptance tests for the playback <-> recent-list integration.
 *
 * Covers:
 *  - one record per video, matched by title OR address (no cross-writing)
 *  - progress write-back / resume positioning bound to the playing record id
 *  - object URL lifecycle for local video/subtitle files
 *  - progress + "completed" marker persisted on pause / seek / ended
 *  - import consistency (list, resume button, local entries not auto-played)
 *  - deleting the playing record stops further write-back
 *
 * Run locally with:  node tests/run-tests.js   (no dependencies required)
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

/* ---------------- browser stubs ---------------- */

function createElementStub(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    listeners: {},
    value: "",
    files: [],
    textContent: "",
    className: "",
    disabled: false,
    offsetWidth: 220,
    _innerHTML: "",
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type, event = {}) {
      (this.listeners[type] || []).slice().forEach(fn => fn(event));
    },
    click() { this.dispatch("click"); },
    scrollIntoView() {},
    requestSubmit() { this.dispatch("submit", { preventDefault() {} }); },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._innerHTML; },
    set(v) { this._innerHTML = v; if (v === "") this.children = []; },
  });
  return el;
}

const elements = new Map();
function getEl(id) {
  if (!elements.has(id)) elements.set(id, createElementStub(id));
  return elements.get(id);
}

const documentStub = {
  getElementById: getEl,
  createElement: tag => createElementStub(tag),
  addEventListener() {},
};

const windowStub = {
  addEventListener() {},
  location: { search: "" },
};

function createLocalStorage() {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; },
  };
}
const localStorageStub = createLocalStorage();

// Track object URL creation / revocation.
let urlSeq = 0;
const activeObjectUrls = new Set();
const createUrlCalls = [];
const revokeUrlCalls = [];
class URLStub {
  static createObjectURL(file) {
    const url = `blob:mock-${++urlSeq}`;
    activeObjectUrls.add(url);
    createUrlCalls.push({ file, url });
    return url;
  }
  static revokeObjectURL(url) {
    activeObjectUrls.delete(url);
    revokeUrlCalls.push(url);
  }
}

class FileReaderStub {
  readAsText(file) {
    this.result = file._content;
    if (this.onload) this.onload();
  }
}

const swalCalls = [];
const SwalStub = {
  fire(opts) {
    swalCalls.push(opts);
    return Promise.resolve({ isConfirmed: true, value: "" });
  },
};

/* ---------------- load script.js in a sandbox ---------------- */

const code = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
const sandbox = {
  document: documentStub,
  window: windowStub,
  localStorage: localStorageStub,
  navigator: {},
  Swal: SwalStub,
  URL: URLStub,
  URLSearchParams,
  FileReader: FileReaderStub,
  console,
  module: { exports: {} },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "script.js" });
const app = sandbox.module.exports;
assert.ok(app && app.state, "script.js should export its internals for tests");

const player = getEl("video-player");
Object.assign(player, {
  currentTime: 0,
  duration: 0,
  paused: true,
  textTracks: [{ mode: "" }],
  play: () => Promise.resolve(),
  pause() {},
  load() {},
});

const form = getEl("video-form");
const M = app.CONFIG.MESSAGES;

/* ---------------- helpers ---------------- */

function reset() {
  localStorageStub.clear();
  Object.assign(app.state, {
    currentVideo: null,
    currentVideoType: "url",
    currentSubtitle: "",
    currentSubtitleType: "url",
    currentTitle: "",
    currentRecentId: null,
    videoLastTime: null,
    totalWatchTime: 0,
    accumulatedWatchTime: 0,
  });
  app.localFileUrls.clear();
  activeObjectUrls.clear();
  createUrlCalls.length = 0;
  revokeUrlCalls.length = 0;
  swalCalls.length = 0;
  getEl("video-load-type").value = "url";
  getEl("video-url").value = "";
  getEl("video-file").files = [];
  getEl("subtitle-load-type").value = "url";
  getEl("subtitle-url").value = "";
  getEl("subtitle-file").files = [];
  player.currentTime = 0;
  player.duration = 0;
}

function submitForm() {
  form.dispatch("submit", { preventDefault() {} });
}

function playUrlVideo(url, title) {
  getEl("video-load-type").value = "url";
  getEl("video-url").value = url;
  submitForm();
  return app.state.currentRecentId;
}

function makeFile(name, size = 1000, lastModified = 1700000000000) {
  return { name, size, lastModified };
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/* ---------------- tests ---------------- */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("same title updates the same record, keeping id and progress", () => {
  reset();
  const id1 = app.saveRecent("Movie A", "http://x/a-v1.mp4", "url");
  const recs = app.getRecent();
  recs[0].progress = 40;
  app.setRecent(recs);

  const id2 = app.saveRecent("Movie A", "http://x/a-v2.mp4", "url");
  const after = app.getRecent();
  assert.strictEqual(after.length, 1, "must not create a second record");
  assert.strictEqual(id2, id1, "record id must be stable");
  assert.strictEqual(after[0].video, "http://x/a-v2.mp4", "address updated");
  assert.strictEqual(after[0].progress, 40, "progress preserved");
});

test("same address updates the same record even when the title changed", () => {
  reset();
  const id1 = app.saveRecent("Old Title", "http://x/same.mp4", "url");
  const id2 = app.saveRecent("New Title", "http://x/same.mp4", "url");
  const recs = app.getRecent();
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(id2, id1);
  assert.strictEqual(recs[0].title, "New Title");
});

test("different videos keep separate records", () => {
  reset();
  app.saveRecent("A", "http://x/1.mp4", "url");
  app.saveRecent("B", "http://x/2.mp4", "url");
  assert.strictEqual(app.getRecent().length, 2);
});

test("progress write-back hits only the playing record when titles collide", () => {
  reset();
  // Two imported duplicates: same title, different addresses.
  app.setRecent(app.normalizeRecent([
    { title: "Dup", video: "http://x/dup-1.mp4", videoType: "url", subtitle: "", subtitleType: "url", progress: 5 },
    { title: "Dup", video: "http://x/dup-2.mp4", videoType: "url", subtitle: "", subtitleType: "url", progress: 10 },
  ]));
  const idV2 = app.getRecent().find(r => r.video === "http://x/dup-2.mp4").id;

  playUrlVideo("http://x/dup-2.mp4");
  assert.strictEqual(app.state.currentRecentId, idV2, "write-back target is the played record");

  player.duration = 100;
  player.currentTime = 50;
  player.dispatch("timeupdate");

  const recs = app.getRecent();
  assert.strictEqual(recs.find(r => r.id === idV2).progress, 50);
  assert.strictEqual(recs.find(r => r.video === "http://x/dup-1.mp4").progress, 5,
    "the other same-titled record must not be touched");
});

test("watch later does not steal the write-back target", () => {
  reset();
  const idA = playUrlVideo("http://x/playing.mp4");
  getEl("video-url").value = "http://x/later.mp4";
  getEl("watch-later-button").dispatch("click");
  assert.strictEqual(app.state.currentRecentId, idA, "still bound to the playing record");

  player.duration = 100;
  player.currentTime = 30;
  player.dispatch("timeupdate");
  const recs = app.getRecent();
  assert.strictEqual(recs.find(r => r.id === idA).progress, 30);
  assert.strictEqual(recs.find(r => r.video === "http://x/later.mp4").progress, 0);
});

test("switching source revokes previous local video and subtitle URLs", () => {
  reset();
  getEl("video-load-type").value = "local";
  getEl("video-file").files = [makeFile("a.mp4")];
  getEl("subtitle-load-type").value = "local";
  getEl("subtitle-file").files = [makeFile("a.vtt", 100)];
  submitForm();
  assert.strictEqual(activeObjectUrls.size, 2, "video + subtitle URLs created");
  assert.strictEqual(app.state.currentVideoType, "local");

  getEl("video-load-type").value = "url";
  getEl("video-url").value = "http://x/next.mp4";
  getEl("subtitle-load-type").value = "url";
  getEl("subtitle-url").value = "";
  submitForm();
  assert.strictEqual(activeObjectUrls.size, 0, "both object URLs revoked before loading the new source");
  assert.strictEqual(revokeUrlCalls.length, 2);
});

test("re-selecting the same local file reuses its URL and never revokes it", () => {
  reset();
  getEl("video-load-type").value = "local";
  getEl("video-file").files = [makeFile("same.mp4")];
  submitForm();
  assert.strictEqual(createUrlCalls.length, 1);
  const url = app.state.currentVideo;

  // A new File object with identical metadata (browser re-select).
  getEl("video-file").files = [makeFile("same.mp4")];
  submitForm();
  assert.strictEqual(createUrlCalls.length, 1, "no duplicate object URL created");
  assert.strictEqual(revokeUrlCalls.length, 0, "URL still in use must not be revoked");
  assert.strictEqual(app.state.currentVideo, url);
  assert.ok(activeObjectUrls.has(url));
});

test("pause, seek and ended persist progress; ended sets the completed marker", () => {
  reset();
  const id = playUrlVideo("http://x/movie.mp4");
  player.duration = 200;

  player.currentTime = 100;
  player.dispatch("pause");
  assert.strictEqual(app.getRecent().find(r => r.id === id).progress, 50);

  player.currentTime = 150;
  player.dispatch("seeked");
  assert.strictEqual(app.getRecent().find(r => r.id === id).progress, 75);

  player.currentTime = 200;
  player.dispatch("ended");
  assert.strictEqual(app.getRecent().find(r => r.id === id).progress, 100);

  const progressSpan = getEl("recent-items").children[0].children[2];
  assert.ok(progressSpan.innerHTML.includes("fa-check"),
    "progress >= completed threshold renders the check mark");
});

test("resume positions the player from the playing record's progress", () => {
  reset();
  app.saveRecent("Movie", "http://x/resume.mp4", "url");
  const recs = app.getRecent();
  recs[0].progress = 30;
  app.setRecent(recs);

  playUrlVideo("http://x/resume.mp4");
  player.duration = 100;
  player.dispatch("loadedmetadata");
  assert.strictEqual(player.currentTime, 30);
});

test("a fully completed record restarts from the beginning", () => {
  reset();
  app.saveRecent("Done", "http://x/done.mp4", "url");
  const recs = app.getRecent();
  recs[0].progress = 100;
  app.setRecent(recs);

  playUrlVideo("http://x/done.mp4");
  player.duration = 100;
  player.dispatch("loadedmetadata");
  assert.strictEqual(player.currentTime, 0);
});

test("deleting the playing record stops any further write-back", async () => {
  reset();
  const id = playUrlVideo("http://x/deleted.mp4");
  await app.removeRecent(id);
  await tick();
  assert.strictEqual(app.getRecent().length, 0);
  assert.strictEqual(app.state.currentRecentId, null);

  player.duration = 100;
  player.currentTime = 80;
  player.dispatch("timeupdate");
  player.dispatch("pause");
  assert.strictEqual(app.getRecent().length, 0, "deleted record must not be recreated or cross-written");
});

test("remove all while playing stops any further write-back", async () => {
  reset();
  playUrlVideo("http://x/a.mp4");
  playUrlVideo("http://x/b.mp4");
  await app.removeAllVideos();
  await tick();
  assert.strictEqual(app.state.currentRecentId, null);

  player.duration = 100;
  player.currentTime = 60;
  player.dispatch("timeupdate");
  assert.strictEqual(app.getRecent().length, 0);
});

test("import refreshes list, resume button and progress display immediately", () => {
  reset();
  const imported = [
    { title: "Remote", video: "http://x/remote.mp4", videoType: "url", subtitle: "", subtitleType: "url", progress: 40 },
    { title: "Local", video: "blob:dead", videoType: "local", subtitle: "", subtitleType: "url", progress: 0 },
  ];
  getEl("recent-file").files = [{ _content: JSON.stringify(imported) }];
  getEl("recent-file").dispatch("change");

  const recs = app.getRecent();
  assert.strictEqual(recs.length, 2);
  assert.ok(recs.every(r => typeof r.id === "string" && r.id), "imported records get ids");
  assert.strictEqual(new Set(recs.map(r => r.id)).size, 2, "ids are unique");
  assert.strictEqual(getEl("resume-button").disabled, false, "resume button enabled");
  assert.strictEqual(getEl("recent-items").children.length, 2, "list rendered");
  assert.strictEqual(getEl("recent-items").children[0].children[2].textContent, "40%",
    "progress display matches imported data");
});

test("imported local entry is not auto-played by resume, it asks to reselect", () => {
  reset();
  const imported = [
    { title: "Local", video: "blob:dead", videoType: "local", subtitle: "", subtitleType: "url", progress: 10 },
  ];
  getEl("recent-file").files = [{ _content: JSON.stringify(imported) }];
  getEl("recent-file").dispatch("change");

  getEl("resume-button").dispatch("click");
  assert.strictEqual(app.state.currentVideo, null, "nothing was played");
  assert.ok(swalCalls.some(c => c.text === M.RESELECT_LOCAL_VIDEO),
    "user is asked to reselect the local file");
});

test("import replacing the list drops a stale write-back target", () => {
  reset();
  playUrlVideo("http://x/playing.mp4");
  player.duration = 100;

  const imported = [
    { title: "Other", video: "http://x/other.mp4", videoType: "url", subtitle: "", subtitleType: "url", progress: 0 },
  ];
  getEl("recent-file").files = [{ _content: JSON.stringify(imported) }];
  getEl("recent-file").dispatch("change");
  assert.strictEqual(app.state.currentRecentId, null);

  player.currentTime = 90;
  player.dispatch("timeupdate");
  assert.strictEqual(app.getRecent().find(r => r.video === "http://x/other.mp4").progress, 0,
    "no write-back into imported records");
});

test("legacy records without ids are migrated on read", () => {
  reset();
  localStorageStub.setItem(app.CONFIG.STORAGE_KEYS.RECENT, JSON.stringify([
    { title: "Old", video: "http://x/old.mp4", videoType: "url", subtitle: "", subtitleType: "url", progress: 10 },
  ]));
  const recs = app.getRecent();
  assert.ok(recs[0].id, "id assigned");
  assert.ok(JSON.parse(localStorageStub.getItem(app.CONFIG.STORAGE_KEYS.RECENT))[0].id,
    "migration persisted");
});

/* ---------------- runner ---------------- */

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`ok   - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err && err.message ? err.message : err);
      if (err && err.actual !== undefined) {
        console.error("  actual:  ", err.actual);
        console.error("  expected:", err.expected);
      }
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
