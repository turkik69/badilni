/* Badilni Firebase Realtime Database adapter.
 * Keeps the existing UI data contract while removing the Supabase dependency.
 */
(function () {
  'use strict';

  const DB_URL = 'https://world-cup-2026-d3091-default-rtdb.europe-west1.firebasedatabase.app';
  const ROOT = 'badilni';
  const SESSION_KEY = 'badilni_firebase_session_v1';
  const DEFAULT_CATEGORIES = {
    electronics: { id: 'electronics', name_ar: 'إلكترونيات', name_en: 'Electronics', icon: 'smartphone', is_active: true },
    games: { id: 'games', name_ar: 'ألعاب فيديو', name_en: 'Video Games', icon: 'gamepad', is_active: true },
    books: { id: 'books', name_ar: 'كتب', name_en: 'Books', icon: 'book', is_active: true },
    home: { id: 'home', name_ar: 'المنزل', name_en: 'Home', icon: 'home', is_active: true },
    sports: { id: 'sports', name_ar: 'رياضة', name_en: 'Sports', icon: 'sports', is_active: true },
    other: { id: 'other', name_ar: 'أخرى', name_en: 'Other', icon: 'other', is_active: true }
  };

  const listeners = new Set();
  const uploads = new Map();
  let pendingPhone = '';

  function pathUrl(path) {
    const clean = String(path || '').replace(/^\/+|\/+$/g, '');
    return `${DB_URL}/${ROOT}${clean ? '/' + clean : ''}.json`;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(pathUrl(path), {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
      if (!response.ok) throw new Error(`تعذّر الاتصال بقاعدة البيانات (${response.status})`);
      return response.status === 204 ? null : response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const get = path => request(path);
  const put = (path, value) => request(path, { method: 'PUT', body: JSON.stringify(value) });
  const patch = (path, value) => request(path, { method: 'PATCH', body: JSON.stringify(value) });
  const remove = path => request(path, { method: 'DELETE' });
  async function push(path, value) {
    const result = await request(path, { method: 'POST', body: JSON.stringify(value) });
    return result && result.name;
  }

  const now = () => new Date().toISOString();
  const toArray = object => Object.entries(object || {}).map(([id, row]) => ({ id, ...(row || {}) }));
  const currentSession = () => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  };

  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function userIdForPhone(phone) {
    return `u_${(await sha256(phone)).slice(0, 24)}`;
  }

  function saveSession(session) {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
    listeners.forEach(listener => listener(session ? 'SIGNED_IN' : 'SIGNED_OUT', session));
  }

  async function seedCategories() {
    const categories = await get('categories');
    if (!categories) await put('categories', DEFAULT_CATEGORIES);
  }

  async function createNotification(userId, type, relatedId, title, body) {
    if (!userId) return;
    await push('notifications', { user_id: userId, type, related_id: relatedId || null, title, body, is_read: false, created_at: now() });
  }

  async function autoMatch(itemId, item) {
    const items = toArray(await get('items'));
    const existingMatches = toArray(await get('matches'));
    for (const candidate of items) {
      if (candidate.id === itemId || candidate.owner_id === item.owner_id || candidate.status !== 'available') continue;
      const wantedByNew = !item.wants_category_id || candidate.category_id === item.wants_category_id;
      const wantedByCandidate = !candidate.wants_category_id || item.category_id === candidate.wants_category_id;
      if (!wantedByNew || !wantedByCandidate) continue;
      const exists = existingMatches.some(match => {
        const ids = Object.values(match.item_ids || {});
        return ids.includes(itemId) && ids.includes(candidate.id);
      });
      if (exists) continue;
      const matchId = await push('matches', {
        match_type: 'direct', status: 'suggested', item_ids: { a: itemId, b: candidate.id },
        owner_ids: { a: item.owner_id, b: candidate.owner_id }, created_at: now()
      });
      await Promise.all([
        createNotification(item.owner_id, 'match_found', matchId, 'وجدنا لك مطابقة!', `قد يناسبك تبديل «${item.title}» مع «${candidate.title}»`),
        createNotification(candidate.owner_id, 'match_found', matchId, 'وجدنا لك مطابقة!', `قد يناسبك تبديل «${candidate.title}» مع «${item.title}»`)
      ]);
    }
  }

  async function compressImage(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('الملف المختار ليس صورة');
    if (file.size > 12 * 1024 * 1024) throw new Error('حجم الصورة أكبر من 12 ميجابايت');
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('تعذّرت قراءة الصورة'));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('تعذّر فتح الصورة'));
      element.src = source;
    });
    const maxSide = 1100;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  async function viewRows(table) {
    if (table === 'user_points_balance') {
      const ledger = toArray(await get('points_ledger'));
      const sums = {};
      ledger.forEach(row => { sums[row.user_id] = (sums[row.user_id] || 0) + Number(row.amount || 0); });
      return Object.entries(sums).map(([user_id, balance]) => ({ id: user_id, user_id, balance }));
    }
    if (table === 'user_ratings') {
      const reviews = toArray(await get('reviews'));
      const grouped = {};
      reviews.forEach(row => {
        const bucket = grouped[row.reviewee_id] || { total: 0, count: 0 };
        bucket.total += Number(row.rating || 0); bucket.count += 1; grouped[row.reviewee_id] = bucket;
      });
      return Object.entries(grouped).map(([user_id, bucket]) => ({
        id: user_id, user_id,
        rating_avg: Number((bucket.total / bucket.count).toFixed(1)),
        rating_count: bucket.count
      }));
    }
    return toArray(await get(table));
  }

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.sort = null; this.max = null; this.mode = 'select'; this.payload = null; this.one = false; this.wantCount = false; }
    select(_columns, options = {}) { this.wantCount = !!options.count; this.head = !!options.head; return this; }
    eq(field, value) { this.filters.push(row => row[field] === value); return this; }
    neq(field, value) { this.filters.push(row => row[field] !== value); return this; }
    in(field, values) { const set = new Set(values || []); this.filters.push(row => set.has(row[field])); return this; }
    not(field, operator, value) { if (operator === 'is' && value === null) this.filters.push(row => row[field] != null); return this; }
    order(field, options = {}) { this.sort = { field, ascending: options.ascending !== false }; return this; }
    limit(value) { this.max = value; return this; }
    maybeSingle() { this.one = true; return this; }
    single() { this.one = true; return this; }
    insert(payload) { this.mode = 'insert'; this.payload = payload; return this; }
    update(payload) { this.mode = 'update'; this.payload = payload; return this; }
    upsert(payload) { this.mode = 'upsert'; this.payload = payload; return this; }
    then(resolve, reject) { this.execute().then(resolve, reject); }
    async execute() {
      try {
        if (this.mode === 'insert') return await this.executeInsert();
        const rows = await viewRows(this.table);
        let filtered = rows.filter(row => this.filters.every(filter => filter(row)));
        if (this.mode === 'update') {
          await Promise.all(filtered.map(row => patch(`${this.table}/${row.id}`, { ...this.payload, updated_at: now() })));
          filtered = filtered.map(row => ({ ...row, ...this.payload }));
        } else if (this.mode === 'upsert') {
          return await this.executeUpsert(rows);
        }
        if (this.sort) filtered.sort((a, b) => {
          const result = String(a[this.sort.field] || '').localeCompare(String(b[this.sort.field] || ''));
          return this.sort.ascending ? result : -result;
        });
        if (this.max != null) filtered = filtered.slice(0, this.max);
        if (this.head) return { data: null, count: filtered.length, error: null };
        return { data: this.one ? (filtered[0] || null) : filtered, count: this.wantCount ? filtered.length : null, error: null };
      } catch (error) { return { data: null, count: null, error }; }
    }
    async executeInsert() {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const created = [];
      for (const raw of list) {
        const row = { ...raw, created_at: raw.created_at || now(), updated_at: now() };
        let id = row.id;
        delete row.id;
        if (id) await put(`${this.table}/${id}`, row);
        else id = await push(this.table, row);
        const saved = { id, ...row };
        created.push(saved);
        if (this.table === 'items') await autoMatch(id, saved);
        if (this.table === 'trade_offers' && saved.target_item_id) {
          const targetItem = await get(`items/${saved.target_item_id}`);
          if (targetItem && targetItem.owner_id) {
            await createNotification(targetItem.owner_id, 'direct_offer', id, 'وصلك عرض مبادلة جديد', `هناك مستخدم يرغب في مبادلة «${targetItem.title}»`);
          }
        }
      }
      return { data: this.one ? created[0] : created, error: null };
    }
    async executeUpsert(rows) {
      const payload = { ...this.payload };
      let found = null;
      if (this.table === 'trade_offer_items') found = rows.find(row => row.trade_offer_id === payload.trade_offer_id && row.item_id === payload.item_id);
      if (found) { await patch(`${this.table}/${found.id}`, payload); return { data: { ...found, ...payload }, error: null }; }
      const id = await push(this.table, { ...payload, created_at: now() });
      return { data: { id, ...payload }, error: null };
    }
  }

  async function rpc(name, args) {
    const session = currentSession();
    const uid = session && session.user.id;
    if (!uid) return { error: new Error('يجب تسجيل الدخول أولاً') };
    const offerId = args && args.p_trade_offer_id;
    const offer = await get(`trade_offers/${offerId}`);
    const parts = toArray(await get('trade_offer_items')).filter(row => row.trade_offer_id === offerId);
    if (!offer || !parts.some(row => row.offered_by === uid)) return { error: new Error('غير مصرح لك بهذه العملية') };
    try {
      if (name === 'hold_trade_points') {
        const amount = Number(offer.points_amount || 0);
        if (!amount) return { data: null, error: null };
        if (offer.points_payer_id !== uid) throw new Error('أنت لست الطرف المكلّف بالنقاط');
        const ledger = toArray(await get('points_ledger')).filter(row => row.user_id === uid);
        const balance = ledger.reduce((sum, row) => sum + Number(row.amount || 0), 0);
        if (balance < amount) throw new Error('رصيد النقاط غير كافٍ');
        if (!ledger.some(row => row.related_trade_offer_id === offerId && row.transaction_type === 'hold')) {
          await push('points_ledger', { user_id: uid, amount: -amount, transaction_type: 'hold', related_trade_offer_id: offerId, created_at: now() });
        }
      }
      if (name === 'confirm_trade_receipt') {
        if (offer.status !== 'agreed') throw new Error('الصفقة ليست جاهزة للتأكيد');
        await put(`trade_confirmations/${offerId}_${uid}`, { trade_offer_id: offerId, user_id: uid, created_at: now() });
        const confirms = toArray(await get('trade_confirmations')).filter(row => row.trade_offer_id === offerId);
        const participants = [...new Set(parts.map(row => row.offered_by))];
        if (participants.every(id => confirms.some(confirm => confirm.user_id === id))) {
          await patch(`trade_offers/${offerId}`, { status: 'completed', completed_at: now() });
          await Promise.all(parts.map(row => patch(`items/${row.item_id}`, { status: 'completed' })));
          if (Number(offer.points_amount || 0) > 0 && offer.points_payer_id) {
            const recipient = participants.find(id => id !== offer.points_payer_id);
            await push('points_ledger', { user_id: recipient, amount: Number(offer.points_amount), transaction_type: 'trade_earn', related_trade_offer_id: offerId, created_at: now() });
          }
        }
      }
      if (name === 'cancel_trade_offer') {
        if (['completed', 'cancelled'].includes(offer.status)) throw new Error('لا يمكن إلغاء هذه الصفقة');
        await patch(`trade_offers/${offerId}`, { status: 'cancelled', cancelled_at: now() });
        await Promise.all(parts.map(row => patch(`items/${row.item_id}`, { status: 'available' })));
        const ledger = toArray(await get('points_ledger')).filter(row => row.related_trade_offer_id === offerId && row.transaction_type === 'hold');
        await Promise.all(ledger.map(row => push('points_ledger', { user_id: row.user_id, amount: -Number(row.amount), transaction_type: 'release', related_trade_offer_id: offerId, created_at: now() })));
      }
      return { data: null, error: null };
    } catch (error) { return { data: null, error }; }
  }

  window.sb = {
    from: table => new Query(table),
    rpc,
    auth: {
      async getSession() { return { data: { session: currentSession() } }; },
      onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }; },
      async signInWithOtp({ phone }) { pendingPhone = phone; return { error: null }; },
      async verifyOtp({ phone, token }) {
        try {
          if (!/^\d{4,8}$/.test(token)) throw new Error('استخدم رمز دخول من 4 إلى 8 أرقام');
          const normalizedPhone = phone || pendingPhone;
          const uid = await userIdForPhone(normalizedPhone);
          const pinHash = await sha256(`${uid}:${token}`);
          let profile = await get(`profiles/${uid}`);
          if (profile && profile.pin_hash !== pinHash) throw new Error('رمز الدخول غير صحيح');
          if (!profile) {
            profile = { full_name: 'مستخدم جديد', phone_masked: `***${normalizedPhone.slice(-4)}`, pin_hash: pinHash, created_at: now(), updated_at: now() };
            await put(`profiles/${uid}`, profile);
            await push('points_ledger', { user_id: uid, amount: 100, transaction_type: 'signup_bonus', created_at: now() });
          }
          const session = { user: { id: uid, phone: normalizedPhone }, created_at: now() };
          saveSession(session);
          return { data: { session }, error: null };
        } catch (error) { return { data: { session: null }, error }; }
      },
      async signOut() { saveSession(null); return { error: null }; }
    },
    storage: {
      from() {
        return {
          async upload(path, file) { try { uploads.set(path, await compressImage(file)); return { error: null }; } catch (error) { return { error }; } },
          getPublicUrl(path) { return { data: { publicUrl: uploads.get(path) || '' } }; }
        };
      }
    },
    channel(name) {
      const channel = { timer: null, lastIds: new Set(), handler: null, offerId: null,
        on(_event, config, handler) { this.handler = handler; this.offerId = String(config.filter || '').split('eq.')[1]; return this; },
        subscribe() { let ready = false; this.timer = setInterval(async () => { const rows = toArray(await get('messages')).filter(row => row.trade_offer_id === this.offerId); rows.forEach(row => { if (!this.lastIds.has(row.id)) { this.lastIds.add(row.id); if (ready) this.handler && this.handler({ new: row }); } }); ready = true; }, 2500); return this; }
      }; return channel;
    },
    removeChannel(channel) { if (channel && channel.timer) clearInterval(channel.timer); },
    __seed: seedCategories
  };
})();
