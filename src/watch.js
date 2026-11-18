/* ============ watch: 一起看（MQTT 聊天 + 在线人数 + 进度同步） ============ */

var WT_URL = 'wss://broker.emqx.io:8084/mqtt';
var WT_TOPIC_PREFIX = 'tvbox-center/v1/chat/';
var WT_UID_KEY = 'tvbox_wt_uid';
var WT_NICK_KEY = 'tvbox_wt_nick';
var WT_CHAT_PREFIX = 'tvbox-center:chat:';
var WT_MSG_MAX = 200;
var WT_TEXT_MAX = 500;
var WT_ONLINE_TTL = 5 * 60 * 1000;
var WT_HB_INTERVAL = 60 * 1000;

var WT = {
  client: null, room: '', hash: '', msgs: [], users: {}, uid: '', nick: '',
  unread: 0, open: false, topic: '', hbTimer: 0, lastSync: null
};

function wtHash(str) {
  var h1 = 0x811c9dc5, h2 = 0x01000193;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= c + 0x9e3779b9; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}

function wtIdentity() {
  var uid = localStorage.getItem(WT_UID_KEY);
  if (!uid) { uid = Math.random().toString(36).slice(2, 10); localStorage.setItem(WT_UID_KEY, uid); }
  var nick = localStorage.getItem(WT_NICK_KEY) || ('观众' + uid.slice(0, 4));
  WT.uid = uid; WT.nick = nick;
  return { uid: uid, nick: nick };
}

function wtRoomOf(item) {
  if (!item) return '';
  return wtHash((item._sourceKey || '') + ':' + (item.vod_id || ''));
}

function wtTopicOf(hash) { return WT_TOPIC_PREFIX + hash; }

function wtLoadChat(hash) {
  try {
    var o = JSON.parse(localStorage.getItem(WT_CHAT_PREFIX + hash) || '{"messages":[]}');
    return Array.isArray(o.messages) ? o.messages : [];
  } catch (e) { return []; }
}

function wtSaveChat(hash, msgs) {
  if (!hash) return;
  try {
    localStorage.setItem(WT_CHAT_PREFIX + hash, JSON.stringify({ messages: msgs.slice(-WT_MSG_MAX) }));
  } catch (e) {}
}

/* ---------- 连接 ---------- */

function wtConnect() {
  if (WT.client) return WT.client;
  var mqtt = G.TVBoxCenter && G.TVBoxCenter.mqtt;
  if (!mqtt) { toast('MQTT 未加载'); return null; }
  var id = wtIdentity();
  if (typeof WebSocket === 'undefined') { toast('当前环境不支持 WebSocket'); return null; }
  WT.client = mqtt.connect(WT_URL, {
    clientId: 'tvc_' + id.uid + '_' + Math.random().toString(16).slice(2, 6),
    clean: true, reconnectPeriod: 4000, connectTimeout: 10000, keepalive: 30
  });
  WT.client.on('connect', function () {
    // 重连后只重新订阅当前房间主题；旧主题不再订阅
    if (WT.topic) WT.client.subscribe(WT.topic);
    wtPublish({ type: 'hello' });
  });
  WT.client.on('message', function (topic, payload) {
    // 房间是消息归属的唯一依据：主题不匹配当前房间的一律丢弃，
    // 不写缓存、不计未读、不更新在线名单（含重连窗口期到达的旧主题消息）
    if (!topic || topic !== WT.topic) return;
    var m;
    try { m = JSON.parse(payload.toString()); } catch (e) { return; }
    wtRecv(m);
  });
  WT.client.on('error', function () {});
  return WT.client;
}

function wtConnected() {
  return !!(WT.client && WT.client.connected && WT.topic);
}

function wtPublish(msg) {
  if (!WT.client || !WT.topic) return;
  msg.uid = WT.uid; msg.nick = WT.nick; msg.ts = msg.ts || Date.now();
  if (!msg.msgId) msg.msgId = WT.uid + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  WT.client.publish(WT.topic, JSON.stringify(msg), { qos: 0 });
}

function wtRecv(m) {
  if (!m || !m.type || !m.uid) return;
  // 同一用户（含同一账号的另一标签页）不按他人重复计入；自己的回显也忽略
  if (m.uid === WT.uid) return;

  if (m.type === 'hello' || m.type === 'chat' || m.type === 'sync') {
    WT.users[m.uid] = { nick: m.nick || '观众', at: Date.now() };
    wtPruneUsers();
  }
  if (m.type === 'bye') { delete WT.users[m.uid]; }

  if (m.type === 'chat') {
    if (WT.msgs.some(function (x) { return x.msgId === m.msgId; })) return;
    WT.msgs.push(m);
    wtSaveChat(WT.hash, WT.msgs);
    if (!WT.open) WT.unread++;
    renderWatch();
  }
  if (m.type === 'sync') {
    WT.lastSync = m;
    if (WT.open) renderWatch();
    else toast((m.nick || '有人') + ' 已同步到 ' + (m.ep + 1) + ' 集 ' + fmtTime(m.time || 0));
  }
  if (WT.open) renderWatch();
}

function wtPruneUsers() {
  var now = Date.now();
  Object.keys(WT.users).forEach(function (k) {
    if (now - WT.users[k].at > WT_ONLINE_TTL) delete WT.users[k];
  });
}

/* ---------- 心跳（保活在场 + 定期剔除超时用户） ---------- */

function wtStartHeartbeat() {
  wtStopHeartbeat();
  WT.hbTimer = setInterval(function () {
    if (!WT.topic) { wtStopHeartbeat(); return; }
    wtPruneUsers();
    wtPublish({ type: 'hello' });
    if (WT.open) renderWatch();
  }, WT_HB_INTERVAL);
}

function wtStopHeartbeat() {
  if (WT.hbTimer) { clearInterval(WT.hbTimer); WT.hbTimer = 0; }
}

/* ---------- 房间进出 ---------- */

// 清空当前房间的全部状态（未读 / 在线名单 / 待处理同步 / 消息列表）
function wtResetRoom() {
  WT.hash = '';
  WT.topic = '';
  WT.msgs = [];
  WT.users = {};
  WT.unread = 0;
  WT.lastSync = null;
}

// 退出当前订阅（发 bye + 退订），不动连接与状态
function wtQuitRoom() {
  if (!WT.topic) return;
  wtPublish({ type: 'bye' });
  if (WT.client) { try { WT.client.unsubscribe(WT.topic); } catch (e) {} }
}

function wtEnter(item) {
  var hash = wtRoomOf(item);
  if (!hash) return;
  wtIdentity();
  var topic = wtTopicOf(hash);

  // 切换房间：先退掉旧房间订阅，再清空旧房间的未读 / 在线名单 / 待同步状态
  if (WT.topic && WT.topic !== topic) wtQuitRoom();
  wtResetRoom();

  WT.hash = hash;
  WT.topic = topic;
  WT.msgs = wtLoadChat(hash); // 聊天缓存按房间哈希隔离
  WT.open = true;

  var c = wtConnect();
  if (c && c.connected) c.subscribe(topic);
  wtPublish({ type: 'hello' });
  wtStartHeartbeat();
  renderWatch();
}

function wtLeave() {
  wtQuitRoom();
  wtStopHeartbeat();
  wtResetRoom();
  WT.open = false;
  // 关闭面板即断开连接，不残留定时器与连接
  if (WT.client) { try { WT.client.end(true); } catch (e) {} WT.client = null; }
  var p = S.root && S.root.querySelector('#wtPanel');
  if (p) p.classList.remove('open');
}

/* ---------- 发送 ---------- */

function wtSend(text) {
  text = (text || '').trim().slice(0, WT_TEXT_MAX);
  if (!text) return;
  if (!WT.topic) { toast('先打开一个作品'); return; }
  if (!wtConnected()) { toast('未连接到房间，请稍后再试'); return; }
  wtPublish({ type: 'chat', text: text });
  var m = { type: 'chat', uid: WT.uid, nick: WT.nick, text: text, msgId: 'local-' + Date.now(), ts: Date.now() };
  WT.msgs.push(m);
  wtSaveChat(WT.hash, WT.msgs);
  renderWatch();
}

function wtSync() {
  var P = S.player;
  if (!P.item) return;
  if (!wtConnected()) { toast('未连接到房间，无法同步'); return; }
  var v = S.root.querySelector('#video');
  wtPublish({ type: 'sync', from: P.from, ep: P.ep, time: v ? v.currentTime : 0 });
  toast('已同步当前进度');
}

function wtFollow() {
  var m = WT.lastSync;
  if (!m || !S.player.item) return;
  if (m.from && S.player.groups[m.from]) { S.player.from = m.from; renderLines(); }
  S.player.ep = m.ep || 0;
  playEpisode(true, m.time || 0);
  toast('已跟随 ' + (m.nick || '对方'));
}

function renderWatch() {
  var box = S.root.querySelector('#wtPanel');
  if (!box) return;
  box.classList.toggle('open', WT.open);
  if (!WT.open) return;

  S.root.querySelector('#wtRoom').textContent = WT.hash.slice(0, 8);
  wtPruneUsers();
  var n = Object.keys(WT.users).length + 1;
  S.root.querySelector('#wtOnline').textContent = n + ' 人在看';
  S.root.querySelector('#wtBadge').textContent = WT.unread > 0 ? String(WT.unread) : '';

  var list = S.root.querySelector('#wtList');
  if (!WT.msgs.length) {
    list.innerHTML = '<div class="wt-empty">还没有人说话，打个招呼</div>';
  } else {
    list.innerHTML = WT.msgs.map(function (m) {
      var mine = m.uid === WT.uid;
      return '<div class="wt-msg' + (mine ? ' mine' : '') + '">' +
        '<div class="wt-nick">' + esc(m.nick || '观众') + '</div>' +
        '<div class="wt-text">' + esc(m.text) + '</div></div>';
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  var sync = S.root.querySelector('#wtSyncBar');
  if (WT.lastSync) {
    sync.style.display = '';
    sync.innerHTML = '<span>' + esc(WT.lastSync.nick || '有人') + ' 在第 ' + ((WT.lastSync.ep || 0) + 1) + ' 集 ' + fmtTime(WT.lastSync.time || 0) + '</span>' +
      '<button class="btn primary" data-act="wt-follow">跟随</button>';
  } else {
    sync.style.display = 'none';
  }
}

/* ---------- 分享 ---------- */

function wtShare() {
  if (!S.player.item) return;
  var item = S.player.item;
  var url = location.href.split('#')[0] + '#watch=' + wtRoomOf(item) + '&vod=' + encodeURIComponent(item._sourceKey + ':' + item.vod_id);
  var text = '一起看《' + (item.vod_name || '') + '》 ' + url;
  if (navigator.share) {
    navigator.share({ title: item.vod_name || 'TVBox', text: text, url: url }).catch(function () {});
    return;
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function () { toast('分享链接已复制'); }).catch(function () { toast('复制失败'); });
  } else {
    toast('当前浏览器不支持分享');
  }
}
