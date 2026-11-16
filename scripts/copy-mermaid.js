'use strict';
// Copy the self-contained browser build into the renderer. The preview loads
// it with a plain script tag (CSP script-src 'self', no bundler).
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const destDir = path.join(__dirname, '..', 'src', 'renderer', 'vendor');
const dest = path.join(destDir, 'mermaid.min.js');

if (!fs.existsSync(src)) {
  console.warn('copy-mermaid: mermaid.min.js not found, skipping');
  process.exit(0);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('copy-mermaid:', dest);
