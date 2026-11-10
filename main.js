'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AppServerClient, resolveServerBin, APP_VERSION } = require('./src/server-client');
const { startAutomationServer } = require('./src/automation');

// keep memory footprint small
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384');
// needed for Windows toast notifications
app.setAppUserModelId('ai.mistral.vibe.desktop');

const SMOKE = process.argv.includes('--smoke');
let automation = null;

let win = null;
let server = null;
let serverStarting = null;
// sessionId -> { session, entries: Map, order: [entryId], turns: Map, activeCallbacks: Map, turnQueue, stats, lastEventId }
const sessionStates = new Map();
let globalLastEventId = 0;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const SETTINGS_DEFAULTS = {
  projects: [], lastProject: null, agent: null, autoApprove: false, windowBounds: null,
  theme: 'dark', model: null,
  notifyOnComplete: true, notifySound: true, soundPreset: 'default', soundFile: null,
};

function loadSettings() {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (_) {
    return { ...SETTINGS_DEFAULTS };
  }
}

function saveSettings(s) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  } catch (_) { /* ignore */ }
}

function terminalKeyFor(cwd) {
  return `vibe-desktop|${cwd}`;
}

// ---------- Windows toast notification on turn completion ----------

function maybeNotifyTurnCompleted(sessionId, turn) {
  try {
    const settings = loadSettings();
    if (!settings.notifyOnComplete) return;
    const st = getState(sessionId);
    if (!st || !st.session) return;
    const title = st.session.title || st.session.preview || 'Vibe Desktop';
    const lastAssistant = st.order
      .map((id) => st.entries.get(id))
      .filter((e) => e && e.type === 'message' && e.role === 'assistant')
      .pop();
    const body = lastAssistant
      ? (lastAssistant.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 160)
      : 'ターンが完了しました';
    const note = new Notification({ title: 'Vibe Desktop — ' + title, body });
    note.on('click', () => {
      if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    });
    note.show();
    console.log('NOTIFY sent:', title, '|', body.slice(0, 60));
    broadcast('vibe:turn-completed', { sessionId, turnId: turn.id, title, body });
  } catch (_) { /* notification is best-effort */ }
}

// ---------- usage / billing (残り使用量) ----------

let accountTimer = null;
function refreshAccountSoon() {
  if (accountTimer) return;
  accountTimer = setTimeout(async () => {
    accountTimer = null;
    await refreshAccount();
  }, 1500);
}

async function refreshAccount() {
  try {
    const srv = await ensureServer();
    const anySession = Array.from(sessionStates.keys())[0];
    const res = await srv.request('account/read', { sessionId: anySession || null });
    if (res && res.account) broadcast('vibe:account', res.account);
    return res && res.account;
  } catch (_) {
    return null;
  }
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function getState(sessionId) {
  return sessionStates.get(sessionId);
}

function ensureState(sessionId) {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, {
      session: null,
      entries: new Map(),
      order: [],
      turns: new Map(),
      activeCallbacks: new Map(),
      turnQueue: null,
      stats: null,
      lastEventId: 0,
    });
  }
  return sessionStates.get(sessionId);
}

function serializeState(sessionId) {
  const st = getState(sessionId);
  if (!st) return null;
  return {
    sessionId,
    session: st.session,
    entries: st.order.map((id) => st.entries.get(id)).filter(Boolean),
    turns: Array.from(st.turns.values()),
    activeCallbacks: Array.from(st.activeCallbacks.values()),
    turnQueue: st.turnQueue,
    stats: st.stats,
    lastEventId: st.lastEventId,
  };
}

function pushState(sessionId) {
  const s = serializeState(sessionId);
  if (s) broadcast('vibe:state', s);
}

function applyJsonPatch(obj, ops) {
  for (const op of ops || []) {
    const segs = String(op.path || '').split('/').filter((s) => s !== '')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!segs.length) continue;
    let target = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      if (target == null) break;
      target = target[segs[i]];
    }
    if (target == null) continue;
    const key = segs[segs.length - 1];
    if (op.op === 'remove') {
      if (Array.isArray(target)) target.splice(Number(key), 1);
      else delete target[key];
    } else {
      target[key] = op.value; // add / replace
    }
  }
  return obj;
}

function applyNotification(method, params) {
  const sessionId = params && params.sessionId;
  if (!sessionId) {
    broadcast('vibe:event', { method, params });
    return;
  }
  const st = ensureState(sessionId);
  if (typeof params.eventId === 'number') {
    globalLastEventId = Math.max(globalLastEventId, params.eventId);
    st.lastEventId = Math.max(st.lastEventId, params.eventId);
  }
  switch (method) {
    case 'session/snapshot': {
      const snap = params.state || {};
      const id = snap.session && snap.session.id;
      if (!id) break;
      const s = id === sessionId ? st : ensureState(id);
      s.session = snap.session;
      s.entries = new Map();
      s.order = [];
      for (const e of snap.history || []) {
        s.entries.set(e.id, e);
        s.order.push(e.id);
      }
      s.turns = new Map((snap.turns || []).map((t) => [t.id, t]));
      s.activeCallbacks = new Map((snap.activeCallbacks || []).map((c) => [c.callbackId, c]));
      s.turnQueue = snap.turnQueue || null;
      if (typeof snap.eventId === 'number') {
        s.lastEventId = snap.eventId;
        globalLastEventId = Math.max(globalLastEventId, snap.eventId);
      }
      pushState(id);
      break;
    }
    case 'history/entryAdded':
    case 'history/entryUpdated': {
      if (!params.entry) break;
      const added = !st.entries.has(params.entry.id);
      if (added) st.order.push(params.entry.id);
      st.entries.set(params.entry.id, params.entry);
      broadcast('vibe:entry', { sessionId, entry: params.entry, added });
      break;
    }
    case 'session/updated': {
      if (!sessionId) break;
      const s = ensureState(sessionId);
      if (params.session) {
        s.session = params.session;
      } else if (s.session && params.patch) {
        applyJsonPatch(s.session, params.patch);
      }
      if (s.session) broadcast('vibe:session', { sessionId, session: s.session });
      break;
    }
    case 'turn/started':
    case 'turn/completed': {
      if (!sessionId || !params.turn) break;
      const s = ensureState(sessionId);
      s.turns.set(params.turn.id, params.turn);
      if (s.session && s.session.status && s.session.status.type === 'running' && params.turn.status !== 'in_progress') {
        applyJsonPatch(s.session, [
          { op: 'remove', path: '/status/activeTurnId' },
          { op: 'replace', path: '/status/type', value: 'idle' },
        ]);
        broadcast('vibe:session', { sessionId, session: s.session });
      }
      if (method === 'turn/completed' && params.turn.status === 'completed') {
        maybeNotifyTurnCompleted(sessionId, params.turn);
        refreshAccountSoon();
      }
      break;
    }
    case 'turn/queueUpdated': {
      if (!sessionId) break;
      ensureState(sessionId).turnQueue = params.queue || null;
      broadcast('vibe:queue', { sessionId, queue: params.queue || null });
      break;
    }
    case 'session/statsUpdated': {
      if (!sessionId) break;
      ensureState(sessionId).stats = params.stats || null;
      broadcast('vibe:stats', { sessionId, stats: params.stats || null });
      break;
    }
    case 'session/compacted':
    case 'session/contextCleared': {
      // conversation was rewritten server-side: resync from the session itself
      if (sessionId) resyncSession(sessionId);
      break;
    }
    default:
      break;
  }
  broadcast('vibe:event', { method, params });
}

async function resyncSession(sessionId) {
  try {
    const srv = await ensureServer();
    await srv.request('session/read', { sessionId, history: { limit: 500, direction: 'backward' } });
  } catch (_) { /* best-effort */ }
}

let accountPollTimer = null;
let serverReady = false;

function startAccountPoll() {
  if (accountPollTimer) return;
  // usage/billing gauge refresh every 60s (also refreshed after each turn)
  accountPollTimer = setInterval(() => { refreshAccount(); }, 60000);
}

async function ensureServer() {
  if (serverReady && server && server.proc) return server;
  if (!serverStarting) {
    const bin = resolveServerBin();
    server = new AppServerClient(bin, path.join(app.getPath('userData'), 'server.log'));
    server.on('notification', (msg) => {
      if (process.env.VIBE_DESKTOP_DEBUG) console.log('EVT', msg.method, JSON.stringify(msg.params).slice(0, 200));
      applyNotification(msg.method, msg.params || {});
    });
    server.on('request', async (msg) => {
      if (msg.method === 'callback/call') {
        const cb = msg.params && msg.params.callback;
        if (cb) {
          const st = ensureState(cb.sessionId);
          st.activeCallbacks.set(cb.callbackId, cb);
          broadcast('vibe:callbacks', { sessionId: cb.sessionId, activeCallbacks: Array.from(st.activeCallbacks.values()) });
        }
        server.respond(msg.id, { callbackId: cb ? cb.callbackId : null, accepted: true });
        broadcast('vibe:callback', msg.params);
      } else {
        server.respond(msg.id, null, { code: -32601, message: 'Method not found' });
      }
    });
    server.on('exit', () => {
      serverReady = false;
      if (accountPollTimer) { clearInterval(accountPollTimer); accountPollTimer = null; }
      broadcast('vibe:serverExit', {});
    });
    serverStarting = (async () => {
      const result = await server.handshake();
      serverReady = true;
      startAccountPoll();
      return result;
    })().catch((e) => { serverStarting = null; throw e; });
  }
  try {
    await serverStarting;
  } finally {
    serverStarting = null;
  }
  return server;
}

function agentConfigFor(cwd, opts) {
  const o = opts || {};
  return {
    cwd,
    terminalKey: terminalKeyFor(cwd),
    trustWorkspace: true,
    agent: o.agent || undefined,
    autoApprove: !!o.autoApprove,
  };
}

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    let setup = null;
    let serverVersion = null;
    try {
      const srv = await ensureServer();
      serverVersion = srv.serverInfo && srv.serverInfo.version;
      setup = await srv.request('setup/status', {});
    } catch (e) {
      return { version: APP_VERSION, serverVersion: null, error: String(e && e.message || e), setup: null };
    }
    return { version: APP_VERSION, serverVersion, setup, error: null };
  });

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_e, s) => { saveSettings(s); return true; });

  ipcMain.handle('folders:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] || null);
  });

  ipcMain.handle('sessions:list', async (_e, args) => {
    const srv = await ensureServer();
    const items = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const params = { limit: 500, includeArchived: false, cursor };
      if (args && args.cwd) params.cwds = [args.cwd];
      const res = await srv.request('session/list', params);
      items.push(...(res.items || []));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return items;
  });

  ipcMain.handle('session:start', async (_e, args) => {
    const srv = await ensureServer();
    const res = await srv.request('session/start', {
      agentConfig: agentConfigFor(args.cwd, args),
      historyLimit: 500,
      model: args.model || null,
      reasoningEffort: args.thinking || null,
    });
    const st = res.state || {};
    if (st.session) {
      applyNotification('session/snapshot', { sessionId: st.session.id, state: st });
    }
    return { sessionId: st.session && st.session.id, lastEventId: res.lastEventId, state: serializeState(st.session && st.session.id) };
  });

  ipcMain.handle('session:resume', async (_e, args) => {
    const srv = await ensureServer();
    const res = await srv.request('session/resume', {
      sessionId: args.sessionId,
      agentConfig: agentConfigFor(args.cwd || undefined, args),
      historyLimit: 500,
    });
    const st = res.state || {};
    if (st.session) {
      applyNotification('session/snapshot', { sessionId: st.session.id, state: st });
    }
    return { sessionId: st.session && st.session.id, lastEventId: res.lastEventId, state: serializeState(st.session && st.session.id) };
  });

  ipcMain.handle('session:continue', async (_e, args) => {
    const srv = await ensureServer();
    const res = await srv.request('session/continue', {
      agentConfig: agentConfigFor(args.cwd, args),
      historyLimit: 500,
      model: args.model || null,
      reasoningEffort: args.thinking || null,
    });
    const st = res.state || {};
    if (st.session) {
      applyNotification('session/snapshot', { sessionId: st.session.id, state: st });
    }
    return { sessionId: st.session && st.session.id, lastEventId: res.lastEventId, state: serializeState(st.session && st.session.id) };
  });

  ipcMain.handle('session:read', async (_e, args) => {
    const srv = await ensureServer();
    const res = await srv.request('session/read', {
      sessionId: args.sessionId,
      history: { limit: args.historyLimit || 500, direction: 'backward' },
    });
    const st = res.state || {};
    if (st.session) {
      applyNotification('session/snapshot', { sessionId: st.session.id, state: st });
    }
    return serializeState(args.sessionId);
  });

  ipcMain.handle('session:state:get', (_e, args) => serializeState(args.sessionId));

  ipcMain.handle('turn:send', async (_e, args) => {
    const srv = await ensureServer();
    const blocks = [];
    for (const img of args.images || []) {
      blocks.push({ type: 'image', uri: img.dataUrl, mediaType: img.mediaType, altText: img.name || 'image' });
    }
    blocks.push({ type: 'text', text: args.text });
    try {
      return await srv.request('turn/start', { sessionId: args.sessionId, message: blocks });
    } catch (e) {
      // busy -> add to the session's turn queue instead (TurnUserInputEntry: role/entryId/content only)
      const res = await srv.request('session/turn/enqueue', {
        sessionId: args.sessionId,
        entries: [{ role: 'user', content: blocks }],
      });
      return { queued: true, result: res, originalError: String(e && e.message || e) };
    }
  });

  ipcMain.handle('turn:interrupt', async (_e, args) => {
    const srv = await ensureServer();
    return srv.request('turn/interrupt', { sessionId: args.sessionId, expectedTurnId: args.turnId || null });
  });

  ipcMain.handle('callback:answer', async (_e, args) => {
    const srv = await ensureServer();
    const res = await srv.request('callback/result', {
      sessionId: args.sessionId,
      result: { callbackId: args.callbackId, output: args.output },
    });
    const st = getState(args.sessionId);
    if (st) {
      st.activeCallbacks.delete(args.callbackId);
      broadcast('vibe:callbacks', { sessionId: args.sessionId, activeCallbacks: Array.from(st.activeCallbacks.values()) });
    }
    return res;
  });

  ipcMain.handle('session:stop', async (_e, args) => {
    const srv = await ensureServer();
    return srv.request('session/stop', { sessionId: args.sessionId });
  });

  ipcMain.handle('session:delete', async (_e, args) => {
    const srv = await ensureServer();
    const res = await srv.request('session/delete', { sessionId: args.sessionId });
    sessionStates.delete(args.sessionId);
    return res;
  });

  ipcMain.handle('session:rename', async (_e, args) => {
    const srv = await ensureServer();
    return srv.request('session/rename', { sessionId: args.sessionId, title: args.title });
  });

  ipcMain.handle('session:agent:update', async (_e, args) => {
    const srv = await ensureServer();
    return srv.request('session/agent/update', { sessionId: args.sessionId, agentName: args.agentName });
  });

  ipcMain.handle('agents:list', async () => {
    const srv = await ensureServer();
    return srv.request('agents/list', {});
  });

  ipcMain.handle('models:list', async (_e, args) => {
    const srv = await ensureServer();
    let models = [];
    let activeModel = null;
    let defaultModelAlias = null;
    try {
      if (args && args.sessionId) {
        const r = await srv.request('runtime/read', { sessionId: args.sessionId });
        const cfg = (r.runtime && r.runtime.config) || {};
        models = cfg.models || [];
        activeModel = cfg.activeModel || null;
        defaultModelAlias = cfg.defaultModelAlias || null;
      }
    } catch (_) { /* fall through to config/read */ }
    if (!models.length) {
      const r = await srv.request('config/read', {});
      const cfg = r.config || {};
      models = cfg.models || [];
      activeModel = cfg.activeModel || activeModel;
      defaultModelAlias = cfg.defaultModelAlias || defaultModelAlias;
    }
    return { models, activeModel, defaultModelAlias };
  });

  ipcMain.handle('model:set', async (_e, args) => {
    const srv = await ensureServer();
    return srv.request('config/model/write', {
      sessionId: args.sessionId || null,
      modelAlias: args.alias,
      reasoningEffort: args.thinking || null,
      sessionOnly: false,
    });
  });

  ipcMain.handle('account:read', async () => refreshAccount());

  ipcMain.handle('file:pick', async (_e, args) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: (args && args.filterName) || 'すべてのファイル', extensions: (args && args.extensions) || ['*'] }],
    });
    return r.canceled ? null : (r.filePaths[0] || null);
  });

  ipcMain.handle('events:read', async (_e, args) => {
    const srv = await ensureServer();
    const params = { afterEventId: args.afterEventId ?? null, batchSize: args.batchSize || 500 };
    if (args.sessionIds) params.filters = { sessionIds: args.sessionIds };
    return srv.request('events/read', params);
  });

  ipcMain.handle('fs:search', (_e, args) => {
    const cwd = args.cwd;
    const query = (args.query || '').toLowerCase();
    const results = [];
    const skip = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv']);
    const MAX = 100;
    try {
      const names = fs.readdirSync(cwd, { withFileTypes: true });
      if (query === '') {
        // bare '@': only non-hidden immediate children, like the CLI
        for (const n of names) {
          if (results.length >= MAX) break;
          if (n.name.startsWith('.')) continue;
          results.push({ path: n.name, isDir: n.isDirectory() });
        }
        return results;
      }
      const queue = [{ dir: cwd, rel: '', depth: 0 }];
      while (queue.length && results.length < MAX) {
        const { dir, rel, depth } = queue.shift();
        if (depth > 5) continue;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const n of entries) {
          if (results.length >= MAX) break;
          const rot = rel ? rel + '/' + n.name : n.name;
          const hidden = n.name.startsWith('.');
          if (hidden && !query.startsWith('.')) continue;
          if (n.isDirectory() && skip.has(n.name)) continue;
          if (rot.toLowerCase().includes(query)) {
            results.push({ path: rot, isDir: n.isDirectory() });
          }
          if (n.isDirectory()) queue.push({ dir: path.join(dir, n.name), rel: rot, depth: depth + 1 });
        }
      }
    } catch (_) { /* ignore */ }
    return results.slice(0, MAX);
  });

  ipcMain.handle('fs:readFile', (_e, args) => {
    try {
      const buf = fs.readFileSync(args.path);
      return { ok: true, size: buf.length };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('shell:openPath', (_e, p) => { shell.openPath(p); return true; });
  ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); return true; });
}

function createWindow() {
  const settings = loadSettings();
  const bounds = settings.windowBounds || { width: 1360, height: 860 };
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 600,
    show: !SMOKE,
    backgroundColor: '#0f0f12',
    title: 'Vibe Desktop',
    icon: fs.existsSync(path.join(__dirname, 'assets', 'icon.png')) ? path.join(__dirname, 'assets', 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.on('close', () => {
    try {
      const b = win.getBounds();
      const s = loadSettings();
      s.windowBounds = b;
      saveSettings(s);
    } catch (_) { /* ignore */ }
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('RENDERER-ERR', level, String(message).slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('RENDERER-GONE', JSON.stringify(details));
  });
  win.webContents.on('unresponsive', () => console.log('RENDERER-UNRESPONSIVE'));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), SMOKE ? { query: { smoke: '1' } } : undefined);
  if (process.env.VIBE_DESKTOP_DEVTOOLS === '1') win.webContents.openDevTools();
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  try {
    automation = await startAutomationServer(() => win, app.getPath('userData'));
  } catch (e) {
    console.error('automation server failed to start:', e);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (SMOKE) {
    runSmoke().then((code) => app.exit(code)).catch((e) => {
      console.error('SMOKE ERROR', e);
      app.exit(2);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (server) server.kill();
});

// ---------------- smoke test ----------------

async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout waiting for ' + label);
}

async function runSmoke() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-desktop-smoke-'));
  console.log('SMOKE workdir', tmp);
  const srv = await ensureServer();
  console.log('SMOKE server', JSON.stringify(srv.serverInfo));
  const setup = await srv.request('setup/status', {});
  console.log('SMOKE setup', JSON.stringify(setup).slice(0, 300));
  const hasKey = setup.hasApiKey ?? setup.has_api_key;
  console.log('SMOKE hasApiKey', hasKey);
  if (!hasKey) {
    console.log('SMOKE FAIL: no API key configured');
    return 3;
  }

  // wait for renderer boot
  await waitFor(async () => win.webContents.executeJavaScript('window.__ready === true'), 30000, 'renderer ready');

  // 1) basic turn, driven through the real renderer UI functions
  await win.webContents.executeJavaScript(
    `(async () => { await selectProject(${JSON.stringify(tmp)}); await startNewChat(); composerEl.value = 'Reply with exactly the word PONG and nothing else.'; autoGrow(); await send(); })()`
  );
  console.log('SMOKE ui send issued');
  const sid = await win.webContents.executeJavaScript('S.activeSessionId');
  console.log('SMOKE session', sid);
  try {
    await waitFor(async () => {
      const has = await win.webContents.executeJavaScript('document.body.innerText.includes("PONG")');
      return has;
    }, 90000, 'assistant PONG in DOM');
  } catch (e) {
    const st = getState(sid);
    console.log('SMOKE TIMEOUT dump entries:', JSON.stringify((st ? st.order.map((id) => st.entries.get(id)) : []), null, 1).slice(0, 3000));
    const fresh = await srv.request('session/read', { sessionId: sid, history: { limit: 100, direction: 'backward' } });
    console.log('SMOKE session/read:', JSON.stringify(fresh.state).slice(0, 3000));
    throw e;
  }
  console.log('SMOKE turn OK (PONG rendered in UI)');

  // 2) approval flow with ask agent (test pins a tool-reliable model,
  //    independent of whatever model the user currently has active)
  const start2 = await srv.request('session/start', {
    agentConfig: { cwd: tmp, terminalKey: 'vibe-desktop|smoke2', trustWorkspace: true, agent: 'ask' },
    historyLimit: 100,
    model: 'mistral-large-4-0-3',
  });
  const sid2 = start2.state.session.id;
  applyNotification('session/snapshot', { sessionId: sid2, state: start2.state });
  await srv.request('turn/start', { sessionId: sid2, message: [{ type: 'text', text: 'Run the shell/bash tool with exactly this command: node -e "console.log(\'SMOKE_OK_123\')". You must actually call the tool — do not answer with text only.' }] });
  let callback = null;
  await waitFor(() => {
    const st = getState(sid2);
    const cbs = st ? Array.from(st.activeCallbacks.values()) : [];
    callback = cbs.find((c) => (c.detail || {}).kind === 'approval') || null;
    return !!callback;
  }, 90000, 'approval callback');
  console.log('SMOKE approval callback', callback.callbackId, JSON.stringify(callback.detail).slice(0, 200));
  await srv.request('callback/result', {
    sessionId: sid2,
    result: { callbackId: callback.callbackId, output: { type: 'approval', decision: { type: 'approve' } } },
  });
  const st2 = getState(sid2);
  if (st2) st2.activeCallbacks.delete(callback.callbackId);
  await waitFor(() => {
    const st = getState(sid2);
    if (!st) return false;
    return st.order.map((id) => st.entries.get(id)).some((e) => e.type === 'effect' && JSON.stringify(e).includes('SMOKE_OK_123'));
  }, 90000, 'shell effect output');
  console.log('SMOKE approval flow OK (tool executed after approve)');

  // 3) renderer DOM check
  if (win) {
    await new Promise((r) => setTimeout(r, 1000));
    const text = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 2000)');
    console.log('SMOKE renderer text head:', JSON.stringify(text.slice(0, 300)));
  }

  console.log('SMOKE PASS');
  return 0;
}
