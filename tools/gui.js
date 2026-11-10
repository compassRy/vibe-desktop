'use strict';
// CLI driver for the Vibe Desktop automation interface (127.0.0.1 + token).
// usage:
//   node tools/gui.js health
//   node tools/gui.js state
//   node tools/gui.js eval "<js>"
//   node tools/gui.js screenshot <out.png>
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function creds() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'vibe-desktop', 'automation.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Vibe Desktop', 'automation.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
  }
  throw new Error('automation.json not found (is the app running?) in ' + candidates.join(' , '));
}

function call(c, pathname, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: c.port, path: pathname + '?token=' + c.token,
      method: method || 'GET',
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch (_) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const cmd = process.argv[2];
  const c = creds();
  if (cmd === 'health') {
    console.log(JSON.stringify(await call(c, '/health')));
  } else if (cmd === 'state') {
    const r = await call(c, '/state');
    console.log(JSON.stringify(r.body, null, 1));
  } else if (cmd === 'eval') {
    let js = process.argv.slice(3).join(' ');
    if (js.startsWith('@')) js = fs.readFileSync(js.slice(1), 'utf8');
    const r = await call(c, '/eval', 'POST', { js });
    console.log(JSON.stringify(r.body, null, 1));
  } else if (cmd === 'screenshot') {
    const out = process.argv[3] || 'screenshot.png';
    const r = await call(c, '/screenshot');
    if (r.body && r.body.pngBase64) {
      fs.writeFileSync(out, Buffer.from(r.body.pngBase64, 'base64'));
      console.log('saved', out);
    } else {
      console.log(JSON.stringify(r.body));
    }
  } else {
    console.log('usage: gui.js health|state|eval <js>|screenshot <out.png>');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
