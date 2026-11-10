'use strict';
// Delete sessions created by smoke tests / protocol experiments and their temp dirs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppServerClient, resolveServerBin } = require('../src/server-client');

async function main() {
  const srv = new AppServerClient(resolveServerBin());
  await srv.handshake();
  const items = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const res = await srv.request('session/list', { limit: 500, includeArchived: false, cursor });
    items.push(...(res.items || []));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  const mine = items.filter((s) => {
    const c = (s.cwd || '').toLowerCase();
    return c.includes('vibe-desktop-smoke') || c.includes('vibe-desktop-test') || c.includes('vibe-model-test') || c.includes('vibe-desktop-demo');
  });
  console.log('deleting', mine.length, 'test sessions');
  for (const s of mine) {
    try { await srv.request('session/delete', { sessionId: s.id }); } catch (e) { console.log('del fail', s.id, e.message); }
    if (s.cwd) {
      try { fs.rmSync(s.cwd, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }
  // also remove leftover temp dirs
  for (const base of [os.tmpdir(), path.join(__dirname, '..', '..')]) {
    try {
      for (const n of fs.readdirSync(base)) {
        if (n.startsWith('vibe-desktop-smoke-') || n.startsWith('vibe-desktop-test-')) {
          fs.rmSync(path.join(base, n), { recursive: true, force: true });
        }
      }
    } catch (_) { /* ignore */ }
  }
  srv.kill();
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
