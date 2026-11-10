'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AppServerClient, resolveServerBin, APP_VERSION } = require('./src/server-client');
const { startAutomationServer } = require('./src/automation');

// keep memory footprint small
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384');

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

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (_) {
    return { projects: [], lastProject: null, agent: null, autoApprove: false, windowBounds: null };
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

function applyNotification(method, params) {
  const sessionId = params && params.sessionId;
  if (typeof params.eventId === 'number') {
    globalLastEventId = Math.max(globalLastEventId, params.eventId);
    if (sessionId) {
      const st = ensureState(sessionId);
      st.lastEventId = Math.max(st.lastEventId, params.eventId);
    }
  }
  switch (method) {
    case 'session/snapshot': {
      const st = params.state || {};
      const id = st.session && st.session.id;
      if (!id) break;
      const s = ensureState(id);
      s.session = st.session;
      s.entries = new Map();
      s.order = [];
      for (const e of st.history || []) {
        s.entries.set(e.id, e);
        s.order.push(e.id);
      }
      s.turns = new Map((st.turns || []).map((t) => [t.id, t]));
      s.activeCallbacks = new Map((st.activeCallbacks || []).map((c) => [c.callbackId, c]));
      s.turnQueue = st.turnQueue || null;
      if (typeof st.eventId === 'number') s.lastEventId = st.eventId;
      pushState(id);
      break;
    }
    case 'history/entryAdded': {
      if (!sessionId || !params.entry) break;
      const s = ensureState(sessionId);
      if (!s.entries.has(params.entry.id)) {
        s.entries.set(params.entry.id, params.entry);
        s.order.push(params.entry.id);
      } else {
        s.entries.set(params.entry.id, params.entry);
      }
      pushState(sessionId);
      break;
    }
    case 'history/entryUpdated': {
      if (!sessionId || !params.entry) break;
      const s = ensureState(sessionId);
      s.entries.set(params.entry.id, params.entry);
      if (!s.order.includes(params.entry.id)) s.order.push(params.entry.id);
      pushState(sessionId);
      break;
    }
    case 'session/updated': {
      if (!sessionId || !params.session) break;
      const s = ensureState(sessionId);
      s.session = params.session;
      pushState(sessionId);
      break;
    }
    case 'turn/started':
    case 'turn/completed': {
      if (!sessionId || !params.turn) break;
      const s = ensureState(sessionId);
      s.turns.set(params.turn.id, params.turn);
      if (s.session && s.session.status && s.session.status.type === 'running' && params.turn.status !== 'in_progress') {
        s.session = { ...s.session, status: { type: 'idle' } };
      }
      pushState(sessionId);
      break;
    }
    case 'turn/queueUpdated': {
      if (!sessionId) break;
      ensureState(sessionId).turnQueue = params.queue || null;
      pushState(sessionId);
      break;
    }
    case 'session/statsUpdated': {
      if (!sessionId) break;
      ensureState(sessionId).stats = params.stats || null;
      pushState(sessionId);
      break;
    }
    case 'session/childSessionUpdated':
    case 'artifacts/created':
    case 'artifacts/updated':
    case 'session/compacted':
    case 'session/contextCleared':
    case 'runtime/updated':
    case 'warning':
    case 'error':
    case 'turn/retrying':
    case 'session/lease/updated':
    case 'session/lease/ended':
    case 'mcp_catalog/authRequired':
    case 'connector_catalog/authRequired':
      break; // forwarded raw below
    default:
      break;
  }
  broadcast('vibe:event', { method, params });
}

let eventPollTimer = null;
let serverReady = false;

function startEventPoll() {
  if (eventPollTimer) return;
  // Poll the server event log so sessions that are not currently attached
  // to this connection still update (titles, previews, background turns).
  eventPollTimer = setInterval(async () => {
    try {
      const batch = await server.request('events/read', { afterEventId: globalLastEventId, batchSize: 1000 });
      for (const ev of (batch && batch.events) || []) {
        if (ev && ev.method) applyNotification(ev.method, ev.params || {});
      }
    } catch (_) { /* server may be busy/restarting */ }
  }, 4000);
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
          pushState(cb.sessionId);
        }
        server.respond(msg.id, { callbackId: cb ? cb.callbackId : null, accepted: true });
        broadcast('vibe:callback', msg.params);
      } else {
        server.respond(msg.id, null, { code: -32601, message: 'Method not found' });
      }
    });
    server.on('exit', () => {
      serverReady = false;
      if (eventPollTimer) { clearInterval(eventPollTimer); eventPollTimer = null; }
      broadcast('vibe:serverExit', {});
    });
    serverStarting = (async () => {
      const result = await server.handshake();
      serverReady = true;
      startEventPoll();
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
      // busy -> enqueue instead
      const res = await srv.request('session/turn/enqueue', {
        sessionId: args.sessionId,
        entries: [{ type: 'message', role: 'user', content: blocks }],
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
      pushState(args.sessionId);
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
    return srv.request('session/title/update', { sessionId: args.sessionId, title: args.title });
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
    let count = 0;
    function walk(dir, rel, depth) {
      if (count >= 200 || depth > 6) return;
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) { return; }
      for (const n of names) {
        if (count >= 200) return;
        if (n.name.startsWith('.') && n.name !== '.') {
          if (query.startsWith('.') || query.includes(n.name.toLowerCase())) { /* still allow dotfiles when queried */ } else continue;
        }
        if (n.isDirectory() && skip.has(n.name) && !query.includes(n.name.toLowerCase())) continue;
        const relPath = rel ? rel + '/' + n.name : n.name;
        if (query && !relPath.toLowerCase().includes(query)) {
          if (n.isDirectory()) walk(path.join(dir, n.name), relPath, depth + 1);
          continue;
        }
        results.push({ path: relPath, isDir: n.isDirectory() });
        count++;
        if (n.isDirectory() && depth < 6) walk(path.join(dir, n.name), relPath, depth + 1);
      }
    }
    try { walk(cwd, '', 0); } catch (_) { /* ignore */ }
    return results.slice(0, 100);
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

  // 2) approval flow with ask agent
  const start2 = await srv.request('session/start', {
    agentConfig: { cwd: tmp, terminalKey: 'vibe-desktop|smoke2', trustWorkspace: true, agent: 'ask' },
    historyLimit: 100,
  });
  const sid2 = start2.state.session.id;
  applyNotification('session/snapshot', { sessionId: sid2, state: start2.state });
  await srv.request('turn/start', { sessionId: sid2, message: [{ type: 'text', text: 'Use the shell/bash tool to run exactly: echo SMOKE_OK_123' }] });
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
