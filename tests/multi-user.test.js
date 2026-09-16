const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

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
  let body = options.body ? JSON.parse(options.body) : null;
  let result = null;
  if (method === 'GET') result = read(path);
  else if (method === 'PUT') { write(path, body); result = body; }
  else if (method === 'PATCH') { merge(path, body); result = body; }
  else if (method === 'POST') { const name = `id_${++sequence}`; write(`${path}/${name}`, body); result = { name }; }
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

(async () => {
  const seller = createClient();
  const buyer = createClient();
  await seller.__seed();

  await seller.auth.signInWithOtp({ phone: '+96891111111' });
  const sellerLogin = await seller.auth.verifyOtp({ phone: '+96891111111', token: '1111' });
  await buyer.auth.signInWithOtp({ phone: '+96892222222' });
  const buyerLogin = await buyer.auth.verifyOtp({ phone: '+96892222222', token: '2222' });
  assert.equal(sellerLogin.error, null);
  assert.equal(buyerLogin.error, null);
  const sellerId = sellerLogin.data.session.user.id;
  const buyerId = buyerLogin.data.session.user.id;
  assert.notEqual(sellerId, buyerId);

  const sellerItemResult = await seller.from('items').insert({
    owner_id: sellerId, title: 'هاتف للاختبار', category_id: 'electronics', condition: 'good',
    wants_category_id: 'games', photos: []
  }).select().single();
  const sellerItem = sellerItemResult.data;

  const buyerItemResult = await buyer.from('items').insert({
    owner_id: buyerId, title: 'جهاز ألعاب للاختبار', category_id: 'games', condition: 'like_new',
    wants_category_id: 'electronics', photos: []
  }).select().single();
  const buyerItem = buyerItemResult.data;
  assert.equal(sellerItem.status, 'available', 'New listings default to public availability');
  assert.equal(buyerItem.status, 'available');

  const visibleToBuyer = await buyer.from('items').select('*').eq('status', 'available').neq('owner_id', buyerId);
  assert.ok(visibleToBuyer.data.some(item => item.id === sellerItem.id), 'Published item must be visible to another user');

  const offerResult = await buyer.from('trade_offers').insert({ status: 'negotiating', target_item_id: sellerItem.id }).select().single();
  const offer = offerResult.data;
  await buyer.from('trade_offer_items').upsert({ trade_offer_id: offer.id, item_id: buyerItem.id, offered_by: buyerId });

  const sellerNotifications = await seller.from('notifications').select('*').eq('user_id', sellerId);
  const directNotifications = sellerNotifications.data.filter(row => row.type === 'direct_offer');
  assert.equal(directNotifications.length, 1, 'Seller must receive one direct notification for the incoming offer');
  assert.equal(directNotifications[0].related_id, offer.id);
  assert.equal(directNotifications[0].is_read, false);

  const sellerItems = await seller.from('items').select('*').eq('owner_id', sellerId);
  const sellerItemIds = sellerItems.data.map(item => item.id);
  const incoming = await seller.from('trade_offers').select('*').in('target_item_id', sellerItemIds);
  assert.ok(incoming.data.some(row => row.id === offer.id), 'Seller must receive the incoming exchange offer');

  await seller.from('trade_offer_items').upsert({ trade_offer_id: offer.id, item_id: sellerItem.id, offered_by: sellerId });
  const participants = await seller.from('trade_offer_items').select('*').eq('trade_offer_id', offer.id);
  assert.equal(new Set(participants.data.map(row => row.offered_by)).size, 2, 'Both users must join the deal');

  await buyer.from('messages').insert({ trade_offer_id: offer.id, sender_id: buyerId, content: 'هل يناسبك عرض المبادلة؟' });
  const messages = await seller.from('messages').select('*').eq('trade_offer_id', offer.id);
  assert.equal(messages.data.length, 1);
  assert.equal(messages.data[0].content, 'هل يناسبك عرض المبادلة؟');

  const chatOnly = await buyer.from('trade_offers').insert({
    status: 'negotiating', target_item_id: sellerItem.id,
    initiator_id: buyerId, target_owner_id: sellerId
  }).select().single();
  await buyer.from('messages').insert({ trade_offer_id: chatOnly.data.id, sender_id: buyerId, content: 'أرغب بالتفاوض قبل اختيار سلعتي' });
  const messageAlerts = await seller.from('notifications').select('*').eq('user_id', sellerId).eq('type', 'new_message');
  assert.ok(messageAlerts.data.some(row => row.related_id === chatOnly.data.id), 'Listing chat notifies the owner');

  await buyer.from('items').delete().eq('id', buyerItem.id).eq('owner_id', buyerId);
  const afterDelete = await seller.from('items').select('*').eq('id', buyerItem.id);
  assert.equal(afterDelete.data.length, 0, 'Owners can delete their own listings');

  const sellerProfile = await seller.from('profiles').select('*').eq('id', sellerId).single();
  assert.equal(sellerProfile.data.role, 'admin', 'The first account becomes the initial app administrator');

  console.log('✓ multi-user marketplace, chat, notifications, deletion, and admin bootstrap passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
