import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'www');
if (basename(output) !== 'www') throw new Error('Unsafe output path');
if (existsSync(output)) rmSync(output, { recursive: true });
mkdirSync(output, { recursive: true });

const assets = [
  'index.html', 'secure-store.js', 'push-config.js', 'push.js', 'sw.js',
  'theme-v3.css', 'privacy.html', 'terms.html', 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'
];
for (const asset of assets) cpSync(resolve(root, asset), resolve(output, asset));
console.log(`Built ${assets.length} web assets in www/`);
