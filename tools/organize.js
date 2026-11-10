'use strict';
const fs = require('fs');
const path = require('path');

const root = 'C:\\Users\\dyuus\\Documents\\Mistral';
const appDir = path.join(root, 'vibe-desktop');
const devtools = path.join(appDir, 'devtools');

function listDir(d) {
  if (!fs.existsSync(d)) return '(missing)';
  return fs.readdirSync(d, { withFileTypes: true }).map((e) => `${e.isDirectory() ? 'D' : 'F'} ${e.name}`);
}

// If 'devtools' is a file (botched move), remove it
if (fs.existsSync(devtools) && !fs.statSync(devtools).isDirectory()) {
  fs.rmSync(devtools, { force: true });
  console.log('removed file-named devtools');
}
fs.mkdirSync(devtools, { recursive: true });

console.log('root:', listDir(root));
console.log('appDir:', listDir(appDir));
console.log('devtools:', listDir(devtools));

// move all _* files from root into devtools
const moved = [];
for (const name of fs.readdirSync(root)) {
  if (!name.startsWith('_')) continue;
  const src = path.join(root, name);
  if (!fs.statSync(src).isFile()) continue;
  const dst = path.join(devtools, name);
  if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
  fs.renameSync(src, dst);
  moved.push(name);
}
console.log('moved:', moved.length, moved.join(', '));

// remove leftover test dirs in root
for (const name of fs.readdirSync(root)) {
  if (name.startsWith('vibe-desktop-test-')) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    console.log('removed test dir', name);
  }
}
console.log('root after:', listDir(root));
console.log('devtools count:', fs.readdirSync(devtools).length);
