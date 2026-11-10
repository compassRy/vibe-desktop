'use strict';

/* Vibe Desktop renderer */

const SMOKE_MODE = new URLSearchParams(location.search).has('smoke');
const $ = (sel) => document.querySelector(sel);
const chatEl = $('#chat');
const composerEl = $('#composer');
const S = {
  settings: null,
  info: null,
  agents: [],
  models: [],
  activeModel: null,
  sessions: [],
  projects: [],
  activeCwd: null,
  activeSessionId: null,
  state: null,
  attachments: [],
  sending: false,
  mention: null, // {tokenStart, token, items, sel}
  nodeCache: new Map(), // entryId -> {key, el}  (render cache to stay light)
  account: null, // {plan, budget:{usage_percentage, reset_at, payg_enabled}, ...}
};

const SYSTEM_SOUNDS = {
  notify: 'C:/Windows/Media/notify.wav',
  chime: 'C:/Windows/Media/chimes.wav',
  ding: 'C:/Windows/Media/ding.wav',
  chord: 'C:/Windows/Media/chord.wav',
};

function playNotifySound() {
  if (!S.settings || !S.settings.notifySound) return;
  let src = null;
  if (S.settings.soundFile) {
    src = 'file:///' + S.settings.soundFile.replace(/\\/g, '/');
  } else if (S.settings.soundPreset && SYSTEM_SOUNDS[S.settings.soundPreset]) {
    src = 'file:///' + SYSTEM_SOUNDS[S.settings.soundPreset];
  }
  if (!src) return; // 'default' = toast の標準音のみ
  try {
    const a = new Audio(src);
    a.play().catch(() => {});
  } catch (_) { /* ignore */ }
}

function wireNotificationSettings() {
  const nt = $('#notify-toggle');
  const st = $('#sound-toggle');
  const ss = $('#sound-select');
  const pick = $('#btn-pick-sound');
  nt.checked = S.settings.notifyOnComplete !== false;
  st.checked = S.settings.notifySound !== false;
  ss.value = S.settings.soundFile ? 'custom' : (S.settings.soundPreset || 'default');
  pick.classList.toggle('hidden', ss.value !== 'custom');
  nt.onchange = async () => { S.settings.notifyOnComplete = nt.checked; await vibe.invoke('settings:save', S.settings); };
  st.onchange = async () => { S.settings.notifySound = st.checked; await vibe.invoke('settings:save', S.settings); };
  ss.onchange = async () => {
    if (ss.value === 'custom') {
      S.settings.soundPreset = 'custom';
      pick.classList.remove('hidden');
      if (!S.settings.soundFile) {
        const f = await vibe.invoke('file:pick', { filterName: '音声ファイル', extensions: ['wav', 'mp3', 'ogg', 'm4a'] });
        if (f) S.settings.soundFile = f;
      }
    } else {
      S.settings.soundPreset = ss.value;
      S.settings.soundFile = null;
      pick.classList.add('hidden');
    }
    await vibe.invoke('settings:save', S.settings);
  };
  pick.onclick = async () => {
    const f = await vibe.invoke('file:pick', { filterName: '音声ファイル', extensions: ['wav', 'mp3', 'ogg', 'm4a'] });
    if (f) {
      S.settings.soundFile = f;
      S.settings.soundPreset = 'custom';
      ss.value = 'custom';
      await vibe.invoke('settings:save', S.settings);
      playNotifySound(); //試聴
    }
  };
}

function renderHeaderChips() {
  // usage (残り使用量)
  const uc = $('#usage-chip');
  const b = S.account && S.account.budget;
  if (b && typeof b.usagePercentage === 'number') {
    const pct = Math.min(100, Math.round(b.usagePercentage));
    uc.innerHTML = `使用量 ${pct}%<span class="mini-bar"><span style="width:${pct}%"></span></span>`;
    uc.className = 'chip' + (pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : '');
    const reset = b.resetAt ? new Date(b.resetAt).toLocaleDateString() : '';
    uc.title = `今月の使用量 ${pct}%（残り ${100 - pct}%）${reset ? '／リセット: ' + reset : ''}${b.paygEnabled ? '／PAYG' : ''}`;
  } else {
    uc.textContent = '使用量 --';
    uc.className = 'chip';
    uc.title = '使用量を取得できませんでした（APIキーのプランで非対応の可能性があります)';
  }
  // context
  const cc = $('#ctx-chip');
  const cu = S.state && S.state.session && S.state.session.contextUsage;
  const total = cu && cu.totalTokens;
  const winSize = (S.activeModel && (S.activeModel.autoCompactThreshold || S.activeModel.maxContextLength)) || 200000;
  if (total) {
    const pct = Math.min(100, Math.round((total / winSize) * 100));
    $('#ctx-label').textContent = `ctx ${fmtNum(total)}/${fmtNum(winSize)}`;
    $('#ctx-fill').style.width = pct + '%';
    cc.className = 'chip' + (pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : '');
    cc.title = `コンテキスト使用量 ${total.toLocaleString()} / ${winSize.toLocaleString()} トークン (${pct}%)`;
  } else {
    $('#ctx-label').textContent = 'ctx --';
    $('#ctx-fill').style.width = '0%';
    cc.className = 'chip';
    cc.title = 'コンテキスト使用量（モデル呼び出し後に表示されます)';
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,form,base,meta,link').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') {
      const h = el.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#|\/)/i.test(h)) el.setAttribute('href', '#');
    }
  });
  return doc.body.innerHTML;
}

function md(text) {
  if (window.marked) {
    return sanitizeHtml(marked.parse(text, { async: false }));
  }
  return '<pre>' + escapeHtml(text) + '</pre>';
}

function pretty(v, maxLen) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (_) { s = String(v); }
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen) + '\n… (truncated)';
  return s;
}

// ---------------- theme ----------------
const THEMES = ['dark', 'light', 'system'];
const LOGO_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 5 L12 27 L16 17 L20 27 L28 5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function applyTheme(mode) {
  const resolved = mode === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  document.documentElement.dataset.theme = resolved;
  const btn = $('#theme-toggle');
  if (btn) btn.dataset.mode = mode;
}

function wireThemeToggle() {
  const btn = $('#theme-toggle');
  if (!btn) return;
  btn.onclick = async () => {
    const cur = S.settings.theme || 'dark';
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    S.settings.theme = next;
    applyTheme(next);
    await vibe.invoke('settings:save', S.settings);
  };
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((S.settings.theme || 'dark') === 'system') applyTheme('system');
    });
  }
}

// ---------------- boot ----------------

async function boot() {
  S.settings = await vibe.invoke('settings:get');
  applyTheme(S.settings.theme || 'dark');
  wireThemeToggle();
  try {
    S.info = await vibe.invoke('app:info');
  } catch (e) {
    S.info = { error: String(e) };
  }
  const st = $('#server-status');
  if (S.info.error) {
    st.textContent = 'サーバー接続エラー: ' + S.info.error;
    st.className = 'server-status err';
  } else {
    st.textContent = `vibe-app-server ${S.info.serverVersion || ''} 接続済み`;
    st.className = 'server-status ok';
  }
  const hasKey = S.info.setup && (S.info.setup.hasApiKey ?? S.info.setup.has_api_key);
  if (S.info.setup && !hasKey) {
    showBanner('APIキーが未設定です。ターミナルで `vibe --setup` を実行して認証してください。');
  }

  try {
    const a = await vibe.invoke('agents:list');
    S.agents = a.agents || [];
  } catch (_) { S.agents = []; }
  fillAgentSelect();
  $('#auto-approve').checked = !!S.settings.autoApprove;
  wireModelSelectors();
  wireNotificationSettings();
  vibe.on('vibe:account', (a) => { S.account = a; renderHeaderChips(); });
  vibe.on('vibe:turn-completed', () => playNotifySound());
  await loadModels();
  vibe.invoke('account:read').then((a) => { if (a) { S.account = a; renderHeaderChips(); } });

  await refreshSessions();
  rebuildProjects();
  renderSidebar();

  if (!SMOKE_MODE) {
    const last = S.settings.lastProject;
    if (last && S.projects.includes(last)) selectProject(last);
    else if (S.projects.length) selectProject(S.projects[0]);
    else renderEmpty();
  } else {
    renderEmpty();
  }

  vibe.on('vibe:state', (st2) => {
    if (st2 && st2.sessionId === S.activeSessionId) {
      const prevModel = S.state && S.state.session && S.state.session.model;
      S.state = st2;
      renderChat();
      updateHeader();
      const nowModel = st2.session && st2.session.model;
      if (nowModel && nowModel !== prevModel) {
        $('#model-select').value = nowModel;
        loadModels();
      } else if (st2.session && st2.session.reasoningEffort) {
        const ts = $('#thinking-select');
        if (Array.from(ts.options).some((o) => o.value === st2.session.reasoningEffort)) ts.value = st2.session.reasoningEffort;
      }
    }
  });
  vibe.on('vibe:event', (ev) => {
    if (ev.method === 'error') showBanner('サーバーエラー: ' + pretty(ev.params, 500));
  });
  vibe.on('vibe:serverExit', () => {
    const s2 = $('#server-status');
    s2.textContent = 'サーバーが終了しました。再接続するにはアプリを再起動してください。';
    s2.className = 'server-status err';
  });
}

function showBanner(msg) {
  const b = $('#banner');
  b.textContent = msg;
  b.classList.remove('hidden');
}

function fillAgentSelect() {
  const sel = $('#agent-select');
  sel.innerHTML = '';
  for (const a of S.agents) {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = `${a.displayName || a.name} (${a.safety || ''})`;
    sel.appendChild(opt);
  }
  sel.value = S.settings.agent || (S.agents.find((a) => a.name === 'accept-edits') || S.agents[0] || {}).name || '';
  sel.onchange = async () => {
    S.settings.agent = sel.value;
    await vibe.invoke('settings:save', S.settings);
    if (S.activeSessionId && S.state && S.state.session && S.state.session.status && S.state.session.status.type === 'idle') {
      try { await vibe.invoke('session:agent:update', { sessionId: S.activeSessionId, agentName: sel.value }); } catch (_) { /* ignore */ }
    }
  };
  $('#auto-approve').onchange = async () => {
    S.settings.autoApprove = $('#auto-approve').checked;
    await vibe.invoke('settings:save', S.settings);
  };
}

function wireModelSelectors() {
  $('#model-select').onchange = async () => {
    const alias = $('#model-select').value;
    S.settings.model = alias;
    await vibe.invoke('settings:save', S.settings);
    if (S.activeSessionId) {
      try {
        await vibe.invoke('model:set', { sessionId: S.activeSessionId, alias, thinking: $('#thinking-select').value || null });
        await vibe.invoke('session:read', { sessionId: S.activeSessionId, historyLimit: 10 });
        await loadModels();
  vibe.invoke('account:read').then((a) => { if (a) { S.account = a; renderHeaderChips(); } });
      } catch (e) { showBanner('モデル変更に失敗: ' + String(e && e.message || e)); }
    }
  };
  $('#thinking-select').onchange = async () => {
    if (!S.activeSessionId) return;
    try {
      await vibe.invoke('model:set', { sessionId: S.activeSessionId, alias: $('#model-select').value, thinking: $('#thinking-select').value || null });
      await vibe.invoke('session:read', { sessionId: S.activeSessionId, historyLimit: 10 });
    } catch (e) { showBanner('思考レベル変更に失敗: ' + String(e && e.message || e)); }
  };
}

async function loadModels() {
  try {
    const r = await vibe.invoke('models:list', { sessionId: S.activeSessionId });
    S.models = r.models || [];
    S.activeModel = r.activeModel || null;
    const sel = $('#model-select');
    sel.innerHTML = '';
    for (const m of S.models) {
      const opt = document.createElement('option');
      opt.value = m.alias || m.name;
      opt.textContent = m.displayName || m.alias || m.name;
      sel.appendChild(opt);
    }
    const cur = (S.state && S.state.session && S.state.session.model) || (S.activeModel && (S.activeModel.alias || S.activeModel.name)) || S.settings.model;
    if (cur) sel.value = cur;
    const tsel = $('#thinking-select');
    const levels = (S.activeModel && S.activeModel.thinkingLevels) || [];
    tsel.innerHTML = '';
    for (const lv of levels.length ? levels : ['off']) {
      const opt = document.createElement('option');
      opt.value = lv;
      opt.textContent = '🧠 ' + lv;
      tsel.appendChild(opt);
    }
    const curT = (S.state && S.state.session && S.state.session.reasoningEffort) || (S.activeModel && S.activeModel.thinking);
    if (curT && levels.includes(curT)) tsel.value = curT;
    tsel.style.display = levels.length ? '' : 'none';
  } catch (e) {
    console.warn('models:list failed', e);
  }
}

async function refreshSessions() {
  try {
    S.sessions = await vibe.invoke('sessions:list', {});
  } catch (e) {
    S.sessions = [];
    showBanner('セッション一覧の取得に失敗: ' + String(e && e.message || e));
  }
  S.sessions.sort((a, b) => (b.bumpedAt || b.updatedAt || 0) - (a.updatedAt || 0));
}

function rebuildProjects() {
  const set = new Set(S.settings.projects || []);
  for (const s of S.sessions) if (s.cwd) set.add(s.cwd);
  S.projects = Array.from(set);
}

function sessionsFor(cwd) {
  return S.sessions.filter((s) => s.cwd === cwd);
}

// ---------------- sidebar ----------------

function renderSidebar() {
  const pl = $('#project-list');
  pl.innerHTML = '';
  for (const p of S.projects) {
    const div = document.createElement('div');
    div.className = 'project-item' + (p === S.activeCwd ? ' active' : '');
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    div.innerHTML = `<div class="project-name">${escapeHtml(name)}</div><div class="project-path" title="${escapeHtml(p)}">${escapeHtml(p)}</div>`;
    div.onclick = () => selectProject(p);
    pl.appendChild(div);
  }

  const sl = $('#session-list');
  sl.innerHTML = '';
  if (!S.activeCwd) {
    sl.innerHTML = '<div class="session-meta" style="padding:6px">フォルダを選んでください</div>';
    return;
  }
  const list = sessionsFor(S.activeCwd);
  if (!list.length) {
    sl.innerHTML = '<div class="session-meta" style="padding:6px">セッションなし。「新規」で開始</div>';
    return;
  }
  for (const s of list) {
    const div = document.createElement('div');
    div.className = 'session-item' + (s.id === S.activeSessionId ? ' active' : '');
    const title = s.title || s.preview || '(無題)';
    div.innerHTML = `
      <div class="session-head">
        <div class="session-title">${escapeHtml(title)}</div>
        <button class="del" title="削除">×</button>
      </div>
      <div class="session-meta"><span>${fmtTime(s.bumpedAt || s.updatedAt)}</span><span>${escapeHtml((s.model || '').split('-').pop() || '')}</span></div>`;
    div.onclick = (e) => {
      if (e.target.classList.contains('del')) return;
      resumeSession(s.id);
    };
    div.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('このセッションを削除しますか？')) return;
      await vibe.invoke('session:delete', { sessionId: s.id });
      if (S.activeSessionId === s.id) { S.activeSessionId = null; S.state = null; renderChat(); }
      await refreshSessions();
      renderSidebar();
    };
    sl.appendChild(div);
  }
}

async function selectProject(cwd) {
  S.activeCwd = cwd;
  S.settings.lastProject = cwd;
  await vibe.invoke('settings:save', S.settings);
  if (!S.sessions.some((s) => s.cwd === cwd)) await refreshSessions();
  renderSidebar();
  const list = sessionsFor(cwd);
  if (list.length) {
    await resumeSession(list[0].id);
  } else {
    S.activeSessionId = null;
    S.state = null;
    renderEmpty();
    updateHeader();
  }
}

// ---------------- sessions ----------------

async function startNewChat() {
  if (!S.activeCwd) { showBanner('先にプロジェクト（フォルダ）を選んでください'); return; }
  const res = await vibe.invoke('session:start', {
    cwd: S.activeCwd,
    agent: $('#agent-select').value || null,
    autoApprove: $('#auto-approve').checked,
    model: $('#model-select').value || S.settings.model || null,
    thinking: $('#thinking-select').value || null,
  });
  S.activeSessionId = res.sessionId;
  S.state = res.state;
  await loadModels();
  vibe.invoke('account:read').then((a) => { if (a) { S.account = a; renderHeaderChips(); } });
  await refreshSessions();
  renderSidebar();
  renderChat();
  updateHeader();
  composerEl.focus();
}

async function resumeSession(sessionId) {
  const res = await vibe.invoke('session:resume', { sessionId, cwd: S.activeCwd });
  S.activeSessionId = res.sessionId || sessionId;
  S.state = res.state;
  await loadModels();
  vibe.invoke('account:read').then((a) => { if (a) { S.account = a; renderHeaderChips(); } });
  await refreshSessions();
  renderSidebar();
  renderChat();
  updateHeader();
}

async function continueLast() {
  if (!S.activeCwd) return;
  const res = await vibe.invoke('session:continue', {
    cwd: S.activeCwd,
    agent: $('#agent-select').value || null,
    autoApprove: $('#auto-approve').checked,
    model: $('#model-select').value || S.settings.model || null,
    thinking: $('#thinking-select').value || null,
  });
  S.activeSessionId = res.sessionId;
  S.state = res.state;
  await loadModels();
  vibe.invoke('account:read').then((a) => { if (a) { S.account = a; renderHeaderChips(); } });
  await refreshSessions();
  renderSidebar();
  renderChat();
  updateHeader();
}

// ---------------- chat rendering ----------------

function renderEmpty() {
  S.nodeCache.clear();
  chatEl.innerHTML = `
    <div class="empty-state">
      <div class="logo">${LOGO_SVG}</div>
      <h2>Vibe Desktop</h2>
      <p>左の「新規」ボタンで新しいチャットを始めるか、過去のセッションを開いてください。</p>
    </div>`;
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.classList.contains('codeblock')) return;
    pre.classList.add('codeblock');
    const code = pre.querySelector('code');
    const lang = code && code.className ? (code.className.match(/language-(\w+)/) || [])[1] : null;
    const head = document.createElement('div');
    head.className = 'cb-head';
    const label = document.createElement('span');
    label.textContent = lang || 'code';
    const sp = document.createElement('span');
    sp.className = 'spacer';
    const copy = document.createElement('button');
    copy.className = 'cb-copy';
    copy.textContent = 'コピー';
    copy.onclick = () => {
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
      copy.textContent = 'コピーしました';
      setTimeout(() => { copy.textContent = 'コピー'; }, 1200);
    };
    head.appendChild(label); head.appendChild(sp); head.appendChild(copy);
    pre.insertBefore(head, code || pre.firstChild);
  });
}

function effectIcon(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('bash') || t.includes('shell') || t.includes('process')) return '⌨️';
  if (t.includes('read')) return '📖';
  if (t.includes('write')) return '✍️';
  if (t.includes('edit')) return '📝';
  if (t.includes('search') || t.includes('grep')) return '🔍';
  if (t.includes('web') || t.includes('fetch')) return '🌐';
  if (t.includes('skill')) return '🎓';
  if (t.includes('subagent') || t.includes('spawn')) return '🤖';
  if (t.includes('todo')) return '✅';
  if (t.includes('scratchpad')) return '📋';
  return '🔧';
}

function entryKey(e) {
  return [e.updatedAt, e.generationStatus, e.title || '', (e.text || '').length,
    e.content ? JSON.stringify(e.content).length : 0,
    e.state ? JSON.stringify(e.state).length : 0, e.role || ''].join('|');
}

function renderChat() {
  const st = S.state;
  if (!st || !st.session) { renderEmpty(); return; }
  if (S._renderedSessionId !== st.sessionId) {
    S._renderedSessionId = st.sessionId;
    S.nodeCache.clear();
  }
  let inner = chatEl.querySelector('.chat-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'chat-inner';
    chatEl.innerHTML = '';
    chatEl.appendChild(inner);
  }
  const entries = st.entries || [];
  const seen = new Set();
  for (const e of entries) {
    seen.add(e.id);
    const key = entryKey(e);
    let cached = S.nodeCache.get(e.id);
    if (!cached || cached.key !== key) {
      cached = { key, el: renderEntry(e, st.sessionId) };
      S.nodeCache.set(e.id, cached);
    }
    inner.appendChild(cached.el); // appends/moves into order
  }
  // drop cached nodes for removed entries
  for (const [id, c] of S.nodeCache) {
    if (!seen.has(id)) {
      c.el.remove();
      S.nodeCache.delete(id);
    }
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderEntry(e, sessionId) {
  const wrap = document.createElement('div');
  switch (e.type) {
    case 'message': {
      const role = e.role;
      wrap.className = 'msg ' + role;
      const row = document.createElement('div');
      row.className = 'msg-row';
      if (role === 'assistant') {
        const av = document.createElement('div');
        av.className = 'avatar';
        av.innerHTML = LOGO_SVG;
        row.appendChild(av);
      }
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      for (const b of e.content || []) {
        if (b.type === 'text') {
          if (role === 'assistant') bubble.innerHTML += md(b.text);
          else {
            const p = document.createElement('div');
            p.textContent = b.text;
            bubble.appendChild(p);
          }
        } else if (b.type === 'image') {
          const img = document.createElement('img');
          img.src = b.uri;
          img.alt = b.altText || 'image';
          bubble.appendChild(img);
        } else if (b.type === 'resource_link' || b.type === 'embedded_resource') {
          const div = document.createElement('div');
          div.className = 'effect-kv';
          div.textContent = '📎 ' + (b.name || b.uri || 'resource');
          bubble.appendChild(div);
        }
      }
      if (role === 'assistant') enhanceCodeBlocks(bubble);
      row.appendChild(bubble);
      wrap.appendChild(row);
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'コピー';
      copyBtn.onclick = () => {
        const text = (e.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        navigator.clipboard.writeText(text);
        copyBtn.textContent = 'コピーしました';
        setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1200);
      };
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = fmtTime(e.createdAt);
      actions.appendChild(copyBtn);
      actions.appendChild(time);
      wrap.appendChild(actions);
      return wrap;
    }
    case 'reasoning': {
      const d = document.createElement('details');
      d.className = 'collapsible';
      const sum = document.createElement('summary');
      sum.textContent = '🤔 思考 ' + (e.summary && e.summary.length ? '(要約あり)' : '');
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = e.text || '';
      d.appendChild(sum); d.appendChild(body);
      wrap.appendChild(d);
      return wrap;
    }
    case 'effect': {
      wrap.appendChild(renderEffect(e));
      return wrap;
    }
    case 'notice': {
      const n = document.createElement('div');
      n.className = 'notice ' + (e.level || 'info');
      n.textContent = e.message || '';
      wrap.appendChild(n);
      return wrap;
    }
    case 'callback': {
      wrap.appendChild(renderCallback(e, sessionId));
      return wrap;
    }
    case 'checkpoint': {
      const d = document.createElement('details');
      d.className = 'collapsible';
      const sum = document.createElement('summary');
      sum.textContent = '🔖 チェックポイント';
      d.appendChild(sum);
      wrap.appendChild(d);
      return wrap;
    }
    default: {
      const d = document.createElement('details');
      d.className = 'collapsible';
      const sum = document.createElement('summary');
      sum.textContent = e.type || 'entry';
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = pretty(e, 2000);
      d.appendChild(sum); d.appendChild(body);
      wrap.appendChild(d);
      return wrap;
    }
  }
}

function renderEffect(e) {
  const box = document.createElement('div');
  box.className = 'effect';
  const state = e.state || {};
  const detail = e.detail || {};
  const head = document.createElement('div');
  head.className = 'effect-head';
  const icon = document.createElement('span');
  icon.className = 'effect-icon';
  icon.textContent = effectIcon(e.title || detail.toolName);
  const badge = document.createElement('span');
  badge.className = 'badge ' + (state.status || '');
  badge.textContent = state.status || '';
  const title = document.createElement('span');
  title.className = 'effect-title';
  const rawTitle = e.title || detail.toolName || 'tool';
  const dotIdx = rawTitle.indexOf('.');
  if (dotIdx > 0) {
    const ns = document.createElement('span');
    ns.className = 'tool-ns';
    ns.textContent = rawTitle.slice(0, dotIdx + 1);
    title.appendChild(ns);
    title.appendChild(document.createTextNode(rawTitle.slice(dotIdx + 1)));
  } else {
    title.textContent = rawTitle;
  }
  head.appendChild(icon);
  head.appendChild(title);
  head.appendChild(badge);
  box.appendChild(head);

  const body = document.createElement('div');
  body.className = 'effect-body';
  body.style.display = 'none';

  if (detail.display) {
    const d = document.createElement('div');
    d.className = 'effect-kv';
    d.innerHTML = escapeHtml(detail.display);
    body.appendChild(d);
  }
  const input = detail.input;
  if (input) {
    if (typeof input === 'object' && (input.command || input.file_path || input.path)) {
      const cmd = input.command || input.file_path || input.path;
      const c = document.createElement('div');
      c.className = 'effect-cmd';
      const pr = document.createElement('span');
      pr.className = 'prompt';
      pr.textContent = '$';
      c.appendChild(pr);
      c.appendChild(document.createTextNode(' ' + cmd));
      body.appendChild(c);
    }
    const pre = document.createElement('div');
    pre.className = 'effect-pre';
    pre.textContent = pretty(input, 4000);
    body.appendChild(pre);
  }
  const out = state.outputText || state.output || state.error;
  if (out) {
    const pre = document.createElement('div');
    pre.className = 'effect-pre';
    pre.textContent = pretty(out, 8000);
    body.appendChild(pre);
  }
  if (body.children.length) {
    head.onclick = () => { body.style.display = body.style.display === 'none' ? 'flex' : 'none'; };
    box.appendChild(body);
  }
  return box;
}

const APPROVAL_LABELS = {
  approve: '許可',
  approve_for_session: 'このセッションで許可',
  approve_permanently: '常に許可',
  deny: '拒否',
  cancel_turn: 'ターンをキャンセル',
};

function renderCallback(e, sessionId) {
  const box = document.createElement('div');
  box.className = 'approval';
  const detail = e.detail || {};
  const state = e.state || {};
  const title = document.createElement('div');
  title.className = 'approval-title';
  const warn = document.createElement('span');
  warn.className = 'warn-ico';
  warn.textContent = '⚠';
  title.appendChild(warn);
  title.appendChild(document.createTextNode(e.title || (detail.kind === 'approval' ? '承認が必要です' : '入力が必要です')));
  box.appendChild(title);

  if (state.status !== 'open') {
    const s = document.createElement('div');
    s.className = 'effect-kv';
    s.textContent = '状態: ' + state.status + (state.output ? ' — ' + pretty(state.output, 300) : '');
    box.appendChild(s);
    return box;
  }

  if (detail.kind === 'approval') {
    const d = document.createElement('div');
    d.className = 'approval-detail';
    const perms = (detail.requiredPermissions || []).map((p) => p.label).join('\n');
    d.textContent = (perms ? perms + '\n\n' : '') + pretty(detail.effect || {}, 2000);
    box.appendChild(d);
    const btns = document.createElement('div');
    btns.className = 'approval-buttons';
    for (const choice of detail.choices || ['approve', 'deny']) {
      const b = document.createElement('button');
      b.className = 'btn' + (choice === 'deny' || choice === 'cancel_turn' ? ' btn-danger' : ' btn-primary');
      b.textContent = APPROVAL_LABELS[choice] || choice;
      b.onclick = async () => {
        await vibe.invoke('callback:answer', {
          sessionId,
          callbackId: e.callbackId,
          output: { type: 'approval', decision: { type: choice } },
        });
      };
      btns.appendChild(b);
    }
    box.appendChild(btns);
  } else if (detail.kind === 'user_input') {
    const req = detail.request || { questions: [] };
    const answers = [];
    for (const q of req.questions || []) {
      const qbox = document.createElement('div');
      qbox.style.marginBottom = '10px';
      const lab = document.createElement('div');
      lab.style.fontWeight = '600';
      lab.style.marginBottom = '4px';
      lab.textContent = (q.header ? q.header + ' — ' : '') + q.question;
      qbox.appendChild(lab);
      if (q.options && q.options.length) {
        const ob = document.createElement('div');
        ob.style.display = 'flex';
        ob.style.flexWrap = 'wrap';
        ob.style.gap = '6px';
        for (const opt of q.options) {
          const obtn = document.createElement('button');
          obtn.className = 'btn btn-small';
          obtn.textContent = opt.label;
          obtn.onclick = () => { inp.value = opt.label; };
          ob.appendChild(obtn);
        }
        qbox.appendChild(ob);
      }
      const inp = document.createElement('input');
      inp.className = 'select';
      inp.placeholder = '回答を入力…';
      qbox.appendChild(inp);
      answers.push({ question: q.question, input: inp });
      box.appendChild(qbox);
    }
    if (req.footerNote) {
      const f = document.createElement('div');
      f.className = 'effect-kv';
      f.textContent = req.footerNote;
      box.appendChild(f);
    }
    const btns = document.createElement('div');
    btns.className = 'approval-buttons';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary';
    ok.textContent = '回答する';
    ok.onclick = async () => {
      await vibe.invoke('callback:answer', {
        sessionId,
        callbackId: e.callbackId,
        output: { type: 'user_input', result: { answers: answers.map((a) => ({ question: a.question, answer: a.input.value })), cancelled: false } },
      });
    };
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-danger';
    cancel.textContent = 'キャンセル';
    cancel.onclick = async () => {
      await vibe.invoke('callback:answer', {
        sessionId,
        callbackId: e.callbackId,
        output: { type: 'user_input', result: { answers: [], cancelled: true } },
      });
    };
    btns.appendChild(ok); btns.appendChild(cancel);
    box.appendChild(btns);
  } else {
    const d = document.createElement('div');
    d.className = 'approval-detail';
    d.textContent = pretty(detail, 2000);
    box.appendChild(d);
    const btns = document.createElement('div');
    btns.className = 'approval-buttons';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary';
    ok.textContent = 'OK';
    ok.onclick = async () => {
      await vibe.invoke('callback:answer', { sessionId, callbackId: e.callbackId, output: { type: detail.kind, result: null } });
    };
    btns.appendChild(ok);
    box.appendChild(btns);
  }
  return box;
}

// ---------------- header ----------------

function updateHeader() {
  const st = S.state;
  const titleEl = $('#session-title');
  const cwdEl = $('#session-cwd');
  const badge = $('#status-badge');
  const ctx = $('#ctx-chip');
  const btnInt = $('#btn-interrupt');
  if (!st || !st.session) {
    titleEl.textContent = '新しいチャット';
    cwdEl.textContent = S.activeCwd || '';
    badge.textContent = 'idle';
    badge.className = 'status-badge idle';
    renderHeaderChips();
    btnInt.classList.add('hidden');
    return;
  }
  const s = st.session;
  titleEl.textContent = s.title || s.preview || '新しいチャット';
  titleEl.title = 'クリックで編集 — ' + (s.cwd || '');
  cwdEl.textContent = s.cwd || S.activeCwd || '';
  const running = s.status && s.status.type === 'running';
  const label = badge.querySelector('.label');
  if (label) label.textContent = running ? '実行中' : '待機中';
  else badge.textContent = running ? '実行中…' : '待機中';
  badge.className = 'status-badge ' + (running ? 'running' : 'idle');
  renderHeaderChips();
  btnInt.classList.toggle('hidden', !running);
}

// ---------------- composer ----------------

async function send() {
  if (S.sending) return;
  const text = composerEl.value.trim();
  const images = S.attachments.slice();
  if (!text && !images.length) return;
  if (!S.activeSessionId) { showBanner('先にセッションを開いてください'); return; }
  S.sending = true;
  try {
    await vibe.invoke('turn:send', { sessionId: S.activeSessionId, text, images });
  } catch (e) {
    showBanner('送信に失敗: ' + String(e && e.message || e));
  } finally {
    S.sending = false;
  }
  composerEl.value = '';
  autoGrow();
  S.attachments = [];
  renderAttachments();
  composerEl.focus();
}

function autoGrow() {
  composerEl.style.height = 'auto';
  composerEl.style.height = Math.min(composerEl.scrollHeight, 200) + 'px';
}

function renderAttachments() {
  const bar = $('#attach-bar');
  bar.innerHTML = '';
  if (!S.attachments.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  S.attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `<img src="${a.dataUrl}" /><span>${escapeHtml(a.name || 'image')}</span>`;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => { S.attachments.splice(i, 1); renderAttachments(); };
    chip.appendChild(x);
    bar.appendChild(chip);
  });
}

// @ mention autocomplete
function updateMention() {
  const val = composerEl.value;
  const caret = composerEl.selectionStart;
  const before = val.slice(0, caret);
  const m = before.match(/@([^\s@]*)$/);
  const popup = $('#mention-popup');
  if (!m || !S.activeCwd) {
    popup.classList.add('hidden');
    S.mention = null;
    return;
  }
  const token = m[1];
  S.mention = { start: caret - m[0].length, token, items: [], sel: 0 };
  vibe.invoke('fs:search', { cwd: S.activeCwd, query: token }).then((items) => {
    if (!S.mention || S.mention.token !== token) return;
    S.mention.items = items || [];
    S.mention.sel = 0;
    renderMention();
  });
}

function renderMention() {
  const popup = $('#mention-popup');
  if (!S.mention) { popup.classList.add('hidden'); return; }
  const items = S.mention.items;
  if (!items.length) { popup.classList.add('hidden'); return; }
  popup.innerHTML = '';
  items.slice(0, 30).forEach((it, i) => {
    const div = document.createElement('div');
    div.className = 'mention-item' + (i === S.mention.sel ? ' sel' : '');
    div.innerHTML = `<span class="${it.isDir ? 'dir' : ''}">${it.isDir ? '📁' : '📄'} ${escapeHtml(it.path)}</span>`;
    div.onmousedown = (e) => {
      e.preventDefault();
      acceptMention(it);
    };
    popup.appendChild(div);
  });
  popup.classList.remove('hidden');
}

function acceptMention(it) {
  if (!S.mention) return;
  const val = composerEl.value;
  const caret = composerEl.selectionStart;
  const ins = '@' + (it.path.includes(' ') ? `"${it.path}"` : it.path) + ' ';
  composerEl.value = val.slice(0, S.mention.start) + ins + val.slice(caret);
  composerEl.selectionStart = composerEl.selectionEnd = S.mention.start + ins.length;
  S.mention = null;
  $('#mention-popup').classList.add('hidden');
  composerEl.focus();
}

// ---------------- events ----------------

$('#btn-send').onclick = send;
$('#btn-new-chat').onclick = startNewChat;
$('#btn-continue').onclick = continueLast;
$('#btn-interrupt').onclick = async () => {
  if (!S.activeSessionId) return;
  const st = S.state;
  const turnId = st && st.session && st.session.status && st.session.status.activeTurnId;
  try { await vibe.invoke('turn:interrupt', { sessionId: S.activeSessionId, turnId: turnId || null }); } catch (_) { /* ignore */ }
};
$('#btn-open-folder').onclick = async () => {
  const dir = await vibe.invoke('folders:pick');
  if (!dir) return;
  if (!S.settings.projects.includes(dir)) {
    S.settings.projects.push(dir);
    await vibe.invoke('settings:save', S.settings);
  }
  rebuildProjects();
  renderSidebar();
  selectProject(dir);
};

composerEl.addEventListener('input', () => { autoGrow(); updateMention(); });
composerEl.addEventListener('keydown', (e) => {
  if (S.mention && S.mention.items.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); S.mention.sel = Math.min(S.mention.sel + 1, S.mention.items.length - 1); renderMention(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); S.mention.sel = Math.max(S.mention.sel - 1, 0); renderMention(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptMention(S.mention.items[S.mention.sel]); return; }
    if (e.key === 'Escape') { S.mention = null; $('#mention-popup').classList.add('hidden'); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
composerEl.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (!f) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        S.attachments.push({ name: f.name || 'pasted.png', dataUrl: reader.result, mediaType: f.type });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    }
  }
});

$('#session-title').onclick = async () => {
  if (!S.activeSessionId) return;
  const cur = S.state && S.state.session ? (S.state.session.title || '') : '';
  const t = prompt('セッションタイトルを入力:', cur);
  if (t == null) return;
  try {
    await vibe.invoke('session:rename', { sessionId: S.activeSessionId, title: t });
    await refreshSessions();
    renderSidebar();
  } catch (_) { /* ignore */ }
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('#composer-wrap')) {
    S.mention = null;
    $('#mention-popup').classList.add('hidden');
  }
});

window.__snapshot = () => ({
  ready: !!window.__ready,
  serverStatus: $('#server-status').textContent,
  banner: $('#banner').classList.contains('hidden') ? null : $('#banner').textContent,
  projects: S.projects,
  activeCwd: S.activeCwd,
  activeSessionId: S.activeSessionId,
  session: S.state && S.state.session ? {
    id: S.state.session.id, title: S.state.session.title, preview: S.state.session.preview,
    cwd: S.state.session.cwd, status: S.state.session.status, model: S.state.session.model,
    reasoningEffort: S.state.session.reasoningEffort, agent: S.state.session.agent,
    contextUsage: S.state.session.contextUsage,
  } : null,
  models: S.models,
  activeModel: S.activeModel,
  selectedModel: $('#model-select').value,
  selectedThinking: $('#thinking-select').value,
  agents: S.agents.map((a) => a.name),
  selectedAgent: $('#agent-select').value,
  autoApprove: $('#auto-approve').checked,
  sessions: S.sessions.map((s) => ({ id: s.id, title: s.title, preview: s.preview, cwd: s.cwd, bumpedAt: s.bumpedAt })),
  entries: S.state ? (S.state.entries || []).map((e) => ({
    id: e.id, type: e.type, role: e.role, title: e.title,
    text: (e.text || '').slice(0, 300),
    content: e.content ? JSON.stringify(e.content).slice(0, 400) : null,
    state: e.state && e.state.status,
    callbackId: e.callbackId, callbackKind: e.detail && e.detail.kind,
  })) : [],
  activeCallbacks: S.state ? (S.state.activeCallbacks || []).map((c) => ({ callbackId: c.callbackId, title: c.title, kind: c.detail && c.detail.kind, status: c.state && c.state.status })) : [],
  composer: composerEl.value,
  chatTextHead: chatEl.innerText.slice(0, 500),
  account: S.account,
  notifyOnComplete: S.settings.notifyOnComplete,
  notifySound: S.settings.notifySound,
  soundPreset: S.settings.soundPreset,
  soundFile: S.settings.soundFile,
});

boot().then(() => { window.__ready = true; });
