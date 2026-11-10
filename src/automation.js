'use strict';

// Localhost-only HTTP automation interface so an agent (or a script) can drive
// the GUI: read state, evaluate JS in the renderer, take screenshots.
// Bound to 127.0.0.1 with a per-run token written to userData/automation.json.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function startAutomationServer(getWin, userDataDir) {
  const token = crypto.randomUUID();
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const t = u.searchParams.get('token') || req.headers['x-vibe-token'];
      if (t !== token) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
        return;
      }
      const win = getWin();
      if (!win || win.isDestroyed()) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no window' }));
        return;
      }
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (u.pathname === '/health') {
        send(200, { ok: true, pid: process.pid, title: win.getTitle() });
      } else if (u.pathname === '/state') {
        const state = await win.webContents.executeJavaScript('window.__snapshot ? window.__snapshot() : null', true);
        send(200, { ok: true, state });
      } else if (u.pathname === '/eval' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const result = await win.webContents.executeJavaScript(String(body.js), true);
        send(200, { ok: true, result: result === undefined ? null : result });
      } else if (u.pathname === '/screenshot') {
        const img = await win.webContents.capturePage();
        send(200, { ok: true, pngBase64: img.toPNG().toString('base64') });
      } else {
        send(404, { ok: false, error: 'not found' });
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      try {
        fs.writeFileSync(
          path.join(userDataDir, 'automation.json'),
          JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }, null, 2)
        );
      } catch (_) { /* ignore */ }
      console.log(`automation server on 127.0.0.1:${port}`);
      resolve({ server, port, token });
    });
  });
}

module.exports = { startAutomationServer };
