/* 一起看房间归属改造的可运行验收样例。
 * 用可控的模拟 MQTT 客户端注入不同主题的消息，验证：
 *   1. 跨房间（主题不匹配）消息被丢弃：不写缓存、不计未读、不更新在线名单
 *   2. 切换房间时未读 / 在线名单 / 待处理同步状态被重置，聊天缓存按房间哈希隔离
 *   3. 重连后只重新订阅当前主题，旧主题消息不串入
 *   4. 在线人数按用户 ID 去重（同一用户多标签页只算一人），超 5 分钟未活跃被剔除
 *   5. 未连接时发送消息会提示而不是静默丢弃
 *   6. 关闭面板后无残留订阅、连接与定时器
 *
 * 运行：node test/watch-room.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src', 'watch.js');

/* ---------- 可控的模拟 MQTT 客户端 ---------- */

function makeMockClient() {
  const handlers = {};
  return {
    connected: false,
    subscriptions: new Set(),
    published: [],
    ended: false,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, ...args) { (handlers[ev] || []).slice().forEach((f) => f(...args)); },
    subscribe(t) { this.subscriptions.add(t); },
    unsubscribe(t) { this.subscriptions.delete(t); },
    publish(t, payload) { this.published.push({ topic: t, payload }); },
    end() { this.ended = true; this.connected = false; }
  };
}

/* ---------- 加载 watch.js 到带桩件的沙箱 ---------- */

function loadWatch() {
  const store = {};                 // localStorage
  const toasts = [];                // toast 记录
  const intervals = new Set();      // 活跃定时器
  let client = null;                // 最近一次 connect 创建的客户端
  let nextTimer = 1;

  const sandbox = {
    console,
    JSON, Math, Date, Object, Array, String, Number, Boolean, isFinite, parseInt, parseFloat,
    WebSocket: function WebSocket() {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    toast: (m) => { toasts.push(String(m)); },
    setInterval: (fn, ms) => { const id = nextTimer++; intervals.add(id); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: () => 0,
    clearTimeout: () => {},
    esc: (s) => String(s == null ? '' : s),
    fmtTime: () => '00:00',
    S: { root: { querySelector: () => null }, player: { item: null, groups: {}, from: '', ep: 0 } },
    G: { TVBoxCenter: { mqtt: { connect: () => { client = makeMockClient(); return client; } } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'watch.js' });
  return {
    wt: sandbox,
    store, toasts, intervals,
    get client() { return client; }
  };
}

const WT_TOPIC_PREFIX = 'tvbox-center/v1/chat/';
const WT_CHAT_PREFIX = 'tvbox-center:chat:';

function chatMsg(uid, text, msgId) {
  return JSON.stringify({ type: 'chat', uid, nick: '观众' + uid, text, msgId: msgId || ('m-' + uid + '-' + text) });
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name);
    console.error(e);
    process.exitCode = 1;
  }
}

const itemA = { _sourceKey: 'src1', vod_id: 'A' };
const itemB = { _sourceKey: 'src1', vod_id: 'B' };

/* ---------- 1. 跨房间消息被丢弃 ---------- */

test('主题不匹配的消息被丢弃：不写缓存、不计未读、不更新在线名单', () => {
  const env = loadWatch();
  const { wt, store } = env;
  wt.wtEnter(itemA);
  const client = env.client;
  client.connected = true;
  client.emit('connect');
  const topicA = WT_TOPIC_PREFIX + wt.WT.hash;
  assert(client.subscriptions.has(topicA), '应订阅当前房间主题');

  // 面板关闭状态下，旧房间主题的在途消息到达
  wt.WT.open = false;
  const otherTopic = WT_TOPIC_PREFIX + 'deadbeefdeadbeef';
  client.emit('message', otherTopic, chatMsg('other1', 'hello'));
  client.emit('message', otherTopic, JSON.stringify({ type: 'hello', uid: 'other1', nick: 'X' }));
  client.emit('message', otherTopic, JSON.stringify({ type: 'sync', uid: 'other1', ep: 1, time: 30 }));

  assert.strictEqual(wt.WT.msgs.length, 0, '不应写入消息列表');
  assert.strictEqual(wt.WT.unread, 0, '不应计未读');
  assert.strictEqual(Object.keys(wt.WT.users).length, 0, '不应更新在线名单');
  assert.strictEqual(wt.WT.lastSync, null, '不应记录同步状态');
  assert.strictEqual(store[WT_CHAT_PREFIX + wt.WT.hash], undefined, '不应写入本地聊天缓存');
});

/* ---------- 2. 正常接收 + 切换房间重置状态 + 缓存隔离 ---------- */

test('当前房间消息正常接收；切换房间重置未读/在线/同步状态，缓存按哈希隔离', () => {
  const env = loadWatch();
  const { wt, store } = env;
  wt.wtEnter(itemA);
  const client = env.client;
  client.connected = true;
  client.emit('connect');
  const hashA = wt.WT.hash;
  const topicA = WT_TOPIC_PREFIX + hashA;

  wt.WT.open = false; // 模拟面板关闭，消息计未读
  client.emit('message', topicA, chatMsg('u1', '在吗'));
  client.emit('message', topicA, JSON.stringify({ type: 'sync', uid: 'u2', nick: 'N', ep: 2, time: 10 }));
  assert.strictEqual(wt.WT.msgs.length, 1);
  assert.strictEqual(wt.WT.unread, 1);
  assert.ok(wt.WT.users.u1 && wt.WT.users.u2, '在线名单应包含两人');
  assert.ok(wt.WT.lastSync, '应有待处理同步状态');
  assert.ok(JSON.parse(store[WT_CHAT_PREFIX + hashA]).messages.length === 1, '房间 A 缓存应落盘');

  // 切换到房间 B
  wt.wtEnter(itemB);
  const hashB = wt.WT.hash;
  const topicB = WT_TOPIC_PREFIX + hashB;
  assert.notStrictEqual(hashA, hashB);
  assert.ok(!client.subscriptions.has(topicA), '应退订旧房间主题');
  assert.ok(client.subscriptions.has(topicB), '应订阅新房间主题');
  assert.strictEqual(wt.WT.unread, 0, '未读应重置');
  assert.strictEqual(Object.keys(wt.WT.users).length, 0, '在线名单应重置');
  assert.strictEqual(wt.WT.lastSync, null, '待处理同步状态应重置');
  assert.strictEqual(wt.WT.msgs.length, 0, '新房间消息列表应为其自有缓存（空）');

  // 房间 B 收一条消息，验证缓存互相隔离
  client.emit('message', topicB, chatMsg('u3', 'B 房间消息'));
  assert.strictEqual(JSON.parse(store[WT_CHAT_PREFIX + hashB]).messages.length, 1);
  assert.strictEqual(JSON.parse(store[WT_CHAT_PREFIX + hashA]).messages.length, 1, '房间 A 缓存不应被污染');
  assert.strictEqual(JSON.parse(store[WT_CHAT_PREFIX + hashA]).messages[0].text, '在吗');
});

/* ---------- 3. 重连后旧主题消息不串入 ---------- */

test('重连后只重新订阅当前主题，重连窗口期的旧主题消息被拦截', () => {
  const env = loadWatch();
  const { wt } = env;
  wt.wtEnter(itemA);
  const client = env.client;
  client.connected = true;
  client.emit('connect');
  const topicA = WT_TOPIC_PREFIX + wt.WT.hash;

  wt.wtEnter(itemB);
  const topicB = WT_TOPIC_PREFIX + wt.WT.hash;

  // 模拟断线重连（clean 会话，订阅丢失，客户端重新发起 connect）
  client.subscriptions.clear();
  client.emit('connect');
  assert.ok(client.subscriptions.has(topicB), '重连后应重新订阅当前主题');
  assert.ok(!client.subscriptions.has(topicA), '重连后不应再订阅旧主题');

  // 重连窗口期到达的旧主题消息
  const before = wt.WT.msgs.length;
  wt.WT.open = false;
  client.emit('message', topicA, chatMsg('u9', '旧房间滞留消息'));
  assert.strictEqual(wt.WT.msgs.length, before, '旧主题消息不应写入');
  assert.strictEqual(wt.WT.unread, 0, '旧主题消息不应计未读');
  assert.strictEqual(Object.keys(wt.WT.users).length, 0, '旧主题消息不应更新在线名单');
});

/* ---------- 4. 在线人数按用户 ID 去重 + 超时剔除 ---------- */

test('同一用户多标签页只计一人；超过 5 分钟未活跃被剔除', () => {
  const env = loadWatch();
  const { wt } = env;
  wt.wtEnter(itemA);
  const client = env.client;
  client.connected = true;
  client.emit('connect');
  const topic = WT_TOPIC_PREFIX + wt.WT.hash;
  const myUid = wt.WT.uid;

  // 同一 uid 的另一标签页发来 hello / chat —— 不应作为另一个人计入
  client.emit('message', topic, JSON.stringify({ type: 'hello', uid: myUid, nick: '另一个标签页' }));
  client.emit('message', topic, chatMsg(myUid, '另一标签页的发言'));
  assert.strictEqual(Object.keys(wt.WT.users).length, 0, '同一用户多标签页不应重复计入');

  // 两个不同用户
  client.emit('message', topic, JSON.stringify({ type: 'hello', uid: 'x1', nick: '甲' }));
  client.emit('message', topic, JSON.stringify({ type: 'hello', uid: 'x2', nick: '乙' }));
  client.emit('message', topic, JSON.stringify({ type: 'hello', uid: 'x1', nick: '甲' })); // 重复 hello 去重
  assert.strictEqual(Object.keys(wt.WT.users).length, 2, '不同用户各计一人');

  // 超过 5 分钟未活跃剔除
  wt.WT.users.x1.at = Date.now() - (5 * 60 * 1000 + 1);
  wt.wtPruneUsers();
  assert.ok(!wt.WT.users.x1, '超时用户应被剔除');
  assert.ok(wt.WT.users.x2, '活跃用户应保留');
});

/* ---------- 5. 未连接时发送提示而不是静默丢弃 ---------- */

test('未连接时发送消息给出提示，不静默丢弃', () => {
  const env = loadWatch();
  const { wt, toasts } = env;
  wt.wtEnter(itemA);
  const client = env.client;
  client.connected = false; // 尚未连接

  const before = wt.WT.msgs.length;
  const pubBefore = client.published.length;
  wt.wtSend('你好');
  assert.ok(toasts.some((t) => t.indexOf('未连接') >= 0), '应提示未连接');
  assert.strictEqual(wt.WT.msgs.length, before, '未连接时不应写入本地消息');
  assert.strictEqual(client.published.length, pubBefore, '未连接时不应发布');

  // 连接恢复后可以发送
  toasts.length = 0;
  client.connected = true;
  client.emit('connect');
  wt.wtSend('你好');
  assert.ok(client.published.some((p) => p.topic === WT_TOPIC_PREFIX + wt.WT.hash && JSON.parse(p.payload).text === '你好'));
  assert.strictEqual(wt.WT.msgs.length, before + 1, '发送后应有本地回显');
});

/* ---------- 6. 关闭面板后无残留订阅 / 连接 / 定时器 ---------- */

test('关闭面板后停止心跳与订阅，不残留定时器与连接', () => {
  const env = loadWatch();
  const { wt, intervals } = env;
  const baseTimers = intervals.size;

  wt.wtEnter(itemA);
  const client = env.client;
  client.connected = true;
  client.emit('connect');
  assert.strictEqual(intervals.size, baseTimers + 1, '进入房间应启动心跳定时器');
  assert.strictEqual(wt.WT.hbTimer !== 0, true);

  wt.wtLeave();
  assert.strictEqual(intervals.size, baseTimers, '关闭后不应残留定时器');
  assert.strictEqual(wt.WT.hbTimer, 0);
  assert.strictEqual(client.subscriptions.size, 0, '关闭后不应残留订阅');
  assert.strictEqual(client.ended, true, '关闭后应断开连接');
  assert.strictEqual(wt.WT.client, null, '客户端引用应清空');
  assert.strictEqual(wt.WT.topic, '', '房间主题应清空');
  assert.strictEqual(wt.WT.open, false);

  // 关闭后到达的任何消息都被丢弃（无当前主题）
  wt.wtEnter(itemB); // 重新进入会新建连接
  const client2 = env.client;
  assert.notStrictEqual(client2, client, '重新进入应建立新连接');
  client2.connected = true;
  client2.emit('connect');
  wt.wtLeave();
  assert.strictEqual(intervals.size, baseTimers, '再次关闭后仍不应残留定时器');
});

console.log(passed + ' 个用例通过' + (process.exitCode ? '（存在失败）' : ''));
