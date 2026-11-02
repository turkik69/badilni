const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = file => JSON.parse(read(file));

const index = read('index.html');
const worker = read('badilni-cloudflare-worker.js');
const secureStore = read('secure-store.js');
const privacy = read('privacy.html');
const terms = read('terms.html');
const deletion = read('delete-account.html');
const serviceWorker = read('sw.js');
const build = read('scripts/build-web.mjs');
const manifest = json('manifest.webmanifest');
const capacitor = json('capacitor.config.json');

assert.equal(manifest.name, 'بادلني — منصة المبادلة');
assert.equal(manifest.short_name, 'بادلني');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.dir, 'rtl');
assert.equal(manifest.theme_color, '#0a4f6a');
assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
assert.match(capacitor.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$/i);
assert.equal(capacitor.appName, 'بادلني');
assert.equal(capacitor.server.cleartext, false);

assert.match(index, /id="delete-account-btn"/);
assert.match(secureStore, /deleteAccount\(\).*delete-account/s);
assert.match(worker, /path==='delete-account'/);
assert.match(worker, /accounts:delete/);
assert.match(deletion, /طلب حذف حساب بادلني/);
assert.match(deletion, /لا ترسل كلمة المرور/);
assert.match(privacy, /delete-account\.html/);

assert.match(index, /handleReport/);
assert.match(index, /handleBlockUser/);
assert.match(worker, /PROHIBITED_CONTENT/);
assert.match(worker, /moderatedText/);
assert.match(terms, /الإبلاغ|الحظر/);
assert.match(terms, /المحتوى المحظور|مواد محظورة/);

assert.match(index, /العمر 13|13 سنة/);
assert.match(worker, /setUTCFullYear\(threshold\.getUTCFullYear\(\)-13\)/);
assert.match(worker, /accepted_at/);
assert.match(worker, /terms_version/);
assert.match(worker, /category_id==='vehicles'/);
assert.match(index, /c\.id!==['"]vehicles['"]/);

const documentVersions = [...index.matchAll(/(?:manifest\.webmanifest|theme-v3\.css|push-config\.js|push\.js|sw\.js)\?v=([0-9.]+)/g)].map(match => match[1]);
assert.ok(documentVersions.length >= 5);
assert.equal(new Set(documentVersions).size, 1, 'PWA assets must share one cache-busting version');
const appVersion = documentVersions[0];
assert.match(serviceWorker, new RegExp(`badilni-v${appVersion.replaceAll('.', '\\.')}[-']`));
assert.match(serviceWorker, /delete-account\.html/);
assert.match(build, /delete-account\.html/);

for (const page of [privacy, terms, deletion]) {
  assert.match(page, /turki\.k69@gmail\.com/);
  assert.match(page, /byyassmin\.com\/badilni/);
}

console.log('✓ store readiness contracts: identity, PWA, deletion, UGC safety, age gate, and vehicle removal passed');
