const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const root = new URL('..', `file://${__dirname}/`).pathname;
const secureStore = fs.readFileSync(`${root}/secure-store.js`, 'utf8');
const worker = fs.readFileSync(`${root}/badilni-cloudflare-worker.js`, 'utf8');
const rules = JSON.parse(fs.readFileSync(`${root}/database.rules.json`, 'utf8'));
const index = fs.readFileSync(`${root}/index.html`, 'utf8');
const push = fs.readFileSync(`${root}/push.js`, 'utf8');

function adapter(fetchImpl) {
  const values = new Map();
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const window = { BADILNI_PUSH_CONFIG: { apiURL: 'https://api.example/api' } };
  const context = { window, localStorage, fetch: fetchImpl, URLSearchParams, TextEncoder, Date, setInterval, clearInterval, console };
  vm.createContext(context); vm.runInContext(secureStore, context);
  return { sb: window.sb, localStorage };
}

(async () => {
  assert.strictEqual(rules.rules['.read'], false, 'Firebase reads must default-deny');
  assert.strictEqual(rules.rules['.write'], false, 'Firebase writes must default-deny');
  assert(!index.includes('src="firebase-store.js"'), 'legacy unauthenticated adapter must not load');
  assert(index.includes('src="secure-store.js"'), 'secure adapter must load');
  assert(index.includes("['verifyEmail','resetPassword','recoverEmail']"), 'app must handle Firebase email actions on the Badilni domain');
  assert(secureStore.includes("continueUrl: 'https://byyassmin.com/badilni/'"), 'email actions must return to the branded Badilni domain');
  assert(secureStore.includes("accounts:resetPassword"), 'app must securely process password reset action codes');
  assert(secureStore.includes("accounts:update"), 'app must securely process email verification action codes');
  assert(!push.includes('databaseURL}/${TOKEN_PATH}'), 'push token must not write directly to Firebase');
  assert(worker.includes('accounts:lookup'), 'worker must verify Firebase ID tokens');
  assert(worker.includes('emailVerified'), 'worker must reject unverified email users');
  assert(worker.includes('ADMIN_EMAILS'), 'admin access must be server-controlled');
  assert(worker.includes("count>150"), 'API must rate-limit authenticated users');
  assert(worker.includes("content-length')||0)>4500000"), 'API must limit request size');

  const itemContext = {};
  vm.runInNewContext(`${worker.slice(0, worker.indexOf('async function notify'))}\nthis.safeItem=safeItem;`, itemContext);
  const listing = { title: 'كتاب', category_id: 'books', condition: 'good', contact_phone: '+968 9123 4567' };
  const privateItem = itemContext.safeItem(listing, { uid: 'u1' });
  assert.strictEqual(privateItem.contact_phone, null, 'phone must not be stored without explicit listing consent');
  assert.strictEqual(privateItem.show_phone, false);
  const publicItem = itemContext.safeItem({ ...listing, show_phone: true }, { uid: 'u1' });
  assert.strictEqual(publicItem.contact_phone, '+96891234567', 'consented phone should be normalized');
  assert.strictEqual(itemContext.safeItem({ ...listing, contact_phone: '91234567', show_phone: true }, { uid: 'u1' }).contact_phone, '+96891234567');
  assert.throws(() => itemContext.safeItem({ ...listing, contact_phone: '123', show_phone: true }, { uid: 'u1' }), /رقم هاتف صحيح/);
  assert.strictEqual(itemContext.safeItem({ ...publicItem, show_phone: false }, { uid: 'u1' }).contact_phone, null, 'turning off consent must remove an existing phone');
  assert(index.includes('publicListingPhone(it)'), 'phone should only render through the consent-aware UI helper');

  let fetchCount = 0;
  const underage = adapter(async () => { fetchCount++; throw new Error('network should not be used'); });
  const future = new Date(); future.setUTCFullYear(future.getUTCFullYear() - 12);
  const underageResult = await underage.sb.auth.signUpWithEmail({ email: 'minor@example.com', password: 'verysecure', birthDate: future.toISOString().slice(0, 10), acceptedTerms: true });
  assert(underageResult.error, 'under-13 registration must fail');
  assert.strictEqual(fetchCount, 0, 'under-13 registration must fail before network access');

  const noConsent = await underage.sb.auth.signUpWithEmail({ email: 'adult@example.com', password: 'verysecure', birthDate: '1990-01-01', acceptedTerms: false });
  assert(noConsent.error, 'registration without terms consent must fail');

  const calls = [];
  const secured = adapter(async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  secured.localStorage.setItem('badilni_secure_session_v2', JSON.stringify({ user: { id: 'u1', email: 'a@example.com' }, idToken: 'signed-token', refreshToken: 'refresh', expiresAt: Date.now() + 600000 }));
  const result = await secured.sb.from('items').select('*');
  assert.ifError(result.error);
  assert.strictEqual(calls[0].url, 'https://api.example/api/query');
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer signed-token');

  console.log('✓ secure auth, age gate, server API, push, admin, and Firebase deny rules passed');
})().catch(error => { console.error(error); process.exit(1); });
