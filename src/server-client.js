'use strict';

// JSON-RPC over stdio client for vibe-app-server (newline-delimited JSON).

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_VERSION = '0.1.0';

function resolveServerBin() {
  const candidates = [];
  if (process.env.VIBE_APP_SERVER_BIN) candidates.push(process.env.VIBE_APP_SERVER_BIN);
  const home = os.homedir();
  candidates.push(path.join(home, '.local', 'bin', 'vibe-app-server.exe'));
  candidates.push(path.join(home, '.local', 'bin', 'vibe-app-server'));
  candidates.push(path.join(home, 'AppData', 'Roaming', 'uv', 'tools', 'mistral-vibe', 'Scripts', 'vibe-app-server.exe'));
  candidates.push('vibe-app-server.exe', 'vibe-app-server');
  for (const c of candidates) {
    if (c.includes(path.sep) || c.includes('/')) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
  }
  // fall back to PATH lookup via where/which
  return 'vibe-app-server';
}

class AppServerClient extends EventEmitter {
  constructor(binPath, logFile) {
    super();
    this.bin = binPath;
    this.logFile = logFile || path.join(os.tmpdir(), 'vibe-desktop-server.log');
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.started = false;
    this.serverInfo = null;
  }

  start() {
    if (this.proc) return;
    const logFd = fs.openSync(this.logFile, 'a');
    this.proc = spawn(this.bin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', (d) => {
      try { fs.writeSync(logFd, d); } catch (_) { /* ignore */ }
      this.emit('stderr', d.toString('utf8'));
    });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      const err = new Error(`vibe-app-server exited (code=${code} signal=${signal})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.emit('exit', { code, signal });
    });
    this.proc.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.emit('exit', { code: -1, signal: null, error: String(err) });
    });
    this.started = true;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let idx;
    while ((idx = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + 1);
      if (!line.length) continue;
      let msg;
      try {
        msg = JSON.parse(line.toString('utf8'));
      } catch (e) {
        this.emit('badline', line.toString('utf8'));
        continue;
      }
      if (process.env.VIBE_DESKTOP_DEBUG) {
        const kind = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) ? 'resp' : (msg.method && msg.id !== undefined ? 'req' : 'notif');
        console.log('RAW', kind, msg.method || msg.id, JSON.stringify(msg.params || msg.result || msg.error || {}).slice(0, 160));
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(String(msg.id));
      if (p) {
        this.pending.delete(String(msg.id));
        if (msg.error) {
          const err = new Error(msg.error.message || 'JSON-RPC error');
          err.code = msg.error.code;
          err.data = msg.error.data;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (msg && msg.method !== undefined && msg.id !== undefined) {
      // server -> client request (e.g. callback/call)
      this.emit('request', msg);
      return;
    }
    if (msg && msg.method !== undefined) {
      this.emit('notification', msg);
      return;
    }
    this.emit('unknown', msg);
  }

  _send(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('server not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params) {
    this.start();
    const id = `vd-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._send({ jsonrpc: '2.0', id, method, params: params || {} });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    this.start();
    this._send({ jsonrpc: '2.0', method, params: params || {} });
  }

  respond(id, result, error) {
    const msg = { jsonrpc: '2.0', id };
    if (error) msg.error = error; else msg.result = result === undefined ? {} : result;
    this._send(msg);
  }

  async handshake() {
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'vibe-desktop',
        version: APP_VERSION,
        title: 'Vibe Desktop',
      },
      capabilities: {
        callbackKinds: ['approval', 'user_input', 'connector_auth'],
      },
    });
    this.serverInfo = result && result.serverInfo;
    this.notify('initialized', {});
    return result;
  }

  kill() {
    if (this.proc) {
      try { this.proc.kill(); } catch (_) { /* ignore */ }
      this.proc = null;
    }
  }
}

module.exports = { AppServerClient, resolveServerBin, APP_VERSION };
