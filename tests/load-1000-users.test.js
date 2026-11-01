const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// This is an isolated in-memory load scenario. It never connects to production
// and never creates public users, listings, engagement, or store metrics.
const source = fs.readFileSync(require.resolve('../firebase-store.js'), 'utf8');
const database = {};
let sequence = 0;

function parts(path) { return path.split('/').filter(Boolean); }
function read(path) {
  let value = database;
  for (const key of parts(path)) { if (value == null) return null; value = value[key]; }
  return value == null ? null : structuredClone(value);
}
function write(path, value) {
  const keys = parts(path); let target = database;
  for (const key of keys.slice(0, -1)) target = target[key] ||= {};
  if (!keys.length) Object.assign(database, value);
  else target[keys.at(-1)] = structuredClone(value);
}
function merge(path, value) { write(path, { ...(read(path) || {}), ...value }); }
function remove(path) {
  const keys = parts(path); let target = database;
  for (const key of keys.slice(0, -1)) { target = target[key]; if (!target) return; }
  delete target[keys.at(-1)];
}
async function mockFetch(input, options = {}) {
  const url = new URL(input);
  const match = url.pathname.match(/\/badilni\/?(.*?)\.json$/);
  if (!match) throw new Error(`Unexpected URL: ${url}`);
  const path = match[1];
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : null;
  let result = null;
  if (method === 'GET') result = read(path);
  else if (method === 'PUT') { write(path, body); result = body; }
  else if (method === 'PATCH') { merge(path, body); result = body; }
  else if (method === 'POST') { const name = `load_${++sequence}`; write(`${path}/${name}`, body); result = { name }; }
  else if (method === 'DELETE') remove(path);
  return { ok: true, status: 200, async json() { return structuredClone(result); } };
}

function createClient() {
  const storage = new Map();
  const context = vm.createContext({
    console, fetch: mockFetch, crypto: webcrypto, TextEncoder, URL, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    }
  });
  context.window = context;
  vm.runInContext(source, context);
  return context.sb;
}

async function inBatches(total, size, task) {
  const output = [];
  for (let start = 0; start < total; start += size) {
    const count = Math.min(size, total - start);
    output.push(...await Promise.all(Array.from({ length: count }, (_, offset) => task(start + offset))));
  }
  return output;
}

async function login(index) {
  const client = createClient();
  const phone = `+968${String(90000000 + index)}`;
  await client.auth.signInWithOtp({ phone });
  const result = await client.auth.verifyOtp({ phone, token: '246810' });
  assert.equal(result.error, null, `User ${index} should authenticate`);
  return { client, phone, userId: result.data.session.user.id };
}

(async () => {
  const startedAt = performance.now();
  const seed = createClient();
  await seed.__seed();
  const categories = ['electronics', 'games', 'books', 'home', 'sports', 'other'];

  const users = await inBatches(1000, 25, async index => {
    const { client, phone, userId } = await login(index);
    const category = categories[index % categories.length];
    const item = await client.from('items').insert({
      owner_id: userId,
      title: `غرض اختبار ${index + 1}`,
      description: 'إعلان تجريبي معزول للتحقق من تحمل النظام',
      category_id: category,
      condition: index % 2 ? 'good' : 'like_new',
      // A non-production sentinel prevents an O(n²) match explosion while the
      // separate offer stage still verifies real cross-user marketplace flows.
      wants_category_id: 'isolated-load-target',
      wants_description: 'أرغب بغرض مناسب من مستخدم آخر',
      photos: []
    }).select().single();
    assert.equal(item.error, null);
    return { index, phone, userId, itemId: item.data.id };
  });

  await inBatches(300, 25, async index => {
    const buyer = users[500 + index];
    const seller = users[index];
    const { client, userId } = await login(buyer.index);
    assert.equal(userId, buyer.userId);
    const offerResult = await client.from('trade_offers').insert({
      status: 'negotiating',
      target_item_id: seller.itemId,
      initiator_id: buyer.userId,
      target_owner_id: seller.userId
    }).select().single();
    assert.equal(offerResult.error, null);
    const offer = offerResult.data;
    await client.from('trade_offer_items').upsert({
      trade_offer_id: offer.id,
      item_id: buyer.itemId,
      offered_by: buyer.userId
    });
    await client.from('messages').insert({
      trade_offer_id: offer.id,
      sender_id: buyer.userId,
      content: `رسالة تفاوض تجريبية ${index + 1}`
    });
  });

  await inBatches(50, 25, async index => {
    const reporter = users[800 + index];
    const reported = users[100 + index];
    const { client } = await login(reporter.index);
    await client.from('reports').insert({
      reporter_id: reporter.userId,
      reported_item_id: reported.itemId,
      reported_user_id: reported.userId,
      reason: 'اختبار أدوات الإبلاغ',
      status: 'pending'
    });
    await client.from('blocked_users').insert({
      blocker_id: reporter.userId,
      blocked_user_id: reported.userId
    });
  });

  const rows = table => Object.entries(database[table] || {}).map(([id, value]) => ({ id, ...value }));
  const profiles = rows('profiles');
  const items = rows('items');
  const offers = rows('trade_offers');
  const messages = rows('messages');
  const notifications = rows('notifications');
  const reports = rows('reports');
  const blocked = rows('blocked_users');

  assert.equal(profiles.length, 1000, 'Exactly 1000 isolated profiles are created');
  assert.equal(items.length, 1000, 'Every synthetic user publishes one listing');
  assert.equal(new Set(items.map(item => item.owner_id)).size, 1000, 'Listings belong to 1000 distinct users');
  assert.ok(items.every(item => item.status === 'available'));
  assert.ok(items.every(item => item.category_id !== 'vehicles'), 'Removed vehicle category cannot return in the scenario');
  assert.ok(items.every(item => !Object.hasOwn(item, 'price')), 'Barter listings do not contain a price');
  assert.equal(offers.length, 300);
  assert.equal(messages.length, 300);
  assert.equal(notifications.filter(row => row.type === 'direct_offer').length, 300);
  assert.equal(notifications.filter(row => row.type === 'new_message').length, 300);
  assert.equal(reports.length, 50);
  assert.equal(blocked.length, 50);

  const elapsedMs = Math.round(performance.now() - startedAt);
  const summary = {
    environment: 'isolated-memory',
    synthetic_users: profiles.length,
    listings: items.length,
    offers: offers.length,
    chat_messages: messages.length,
    reports: reports.length,
    blocks: blocked.length,
    elapsed_ms: elapsedMs
  };
  console.log(`✓ 1000-user isolated marketplace scenario passed\n${JSON.stringify(summary, null, 2)}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
