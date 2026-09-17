/* Badilni secure client adapter.
 * Authentication is handled by Firebase Auth. All application data is accessed
 * through the Badilni Cloudflare API, never directly from the browser.
 */
(function () {
  'use strict';

  const FIREBASE_API_KEY = 'AIzaSyBsnryD1ZtvjzumatCCVN-QpRAMR4_IG7M';
  const API_URL = (window.BADILNI_PUSH_CONFIG && window.BADILNI_PUSH_CONFIG.apiURL) || 'https://badilni.turki-k69.workers.dev/api';
  const SESSION_KEY = 'badilni_secure_session_v2';
  const PENDING_PROFILE_KEY = 'badilni_pending_profile_v2';
  const listeners = new Set();
  const uploads = new Map();

  const now = () => new Date().toISOString();
  const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
  const currentSession = () => readJson(SESSION_KEY);

  function saveSession(session) {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
    listeners.forEach(listener => listener(session ? 'SIGNED_IN' : 'SIGNED_OUT', session));
  }

  function authError(code) {
    code = String(code || '').split(' : ')[0];
    const map = {
      EMAIL_EXISTS: 'البريد الإلكتروني مسجل مسبقاً',
      EMAIL_NOT_FOUND: 'لا يوجد حساب بهذا البريد',
      INVALID_PASSWORD: 'كلمة المرور غير صحيحة',
      INVALID_LOGIN_CREDENTIALS: 'البريد أو كلمة المرور غير صحيحة',
      USER_DISABLED: 'هذا الحساب موقوف',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'محاولات كثيرة، حاول لاحقاً',
      WEAK_PASSWORD: 'استخدم كلمة مرور من 8 أحرف على الأقل',
      INVALID_EMAIL: 'أدخل بريداً إلكترونياً صحيحاً',
      EMAIL_NOT_VERIFIED: 'تحقق من بريدك الإلكتروني أولاً',
      INVALID_OOB_CODE: 'الرابط غير صالح أو انتهت صلاحيته',
      EXPIRED_OOB_CODE: 'انتهت صلاحية الرابط، اطلب رسالة جديدة',
      PASSWORD_LOGIN_DISABLED: 'تسجيل الدخول بكلمة المرور غير متاح حالياً'
    };
    return new Error(map[code] || 'تعذّر إكمال تسجيل الدخول');
  }

  async function firebaseAuth(endpoint, body, form = false) {
    const url = form
      ? `https://securetoken.googleapis.com/v1/${endpoint}?key=${FIREBASE_API_KEY}`
      : `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${FIREBASE_API_KEY}`;
    const headers = { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
    if (endpoint === 'accounts:sendOobCode') headers['X-Firebase-Locale'] = 'ar';
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: form ? new URLSearchParams(body) : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw authError(data?.error?.message || 'AUTH_FAILED');
    return data;
  }

  function sessionFromAuth(data) {
    return {
      user: { id: data.localId || data.user_id, email: data.email || '' },
      idToken: data.idToken || data.id_token,
      refreshToken: data.refreshToken || data.refresh_token,
      expiresAt: Date.now() + (Number(data.expiresIn || data.expires_in || 3600) * 1000) - 60000,
      created_at: now()
    };
  }

  async function refreshSession() {
    const session = currentSession();
    if (!session?.refreshToken) return null;
    if (session.expiresAt && session.expiresAt > Date.now()) return session;
    try {
      const refreshed = await firebaseAuth('token', { grant_type: 'refresh_token', refresh_token: session.refreshToken }, true);
      const next = { ...sessionFromAuth(refreshed), user: { ...session.user, id: refreshed.user_id } };
      saveSession(next);
      return next;
    } catch (_) {
      saveSession(null);
      return null;
    }
  }

  async function api(action, payload = {}) {
    const session = await refreshSession();
    if (!session?.idToken) throw new Error('يجب تسجيل الدخول أولاً');
    const response = await fetch(`${API_URL}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.idToken}` },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) saveSession(null);
    if (!response.ok) throw new Error(data.error || `تعذّر الاتصال بالخادم (${response.status})`);
    return data;
  }

  async function compressImage(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('الملف المختار ليس صورة');
    if (file.size > 8 * 1024 * 1024) throw new Error('حجم الصورة أكبر من 8 ميجابايت');
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const element = new Image(); element.onload = () => resolve(element); element.onerror = reject; element.src = source;
    });
    const scale = Math.min(1, 1000 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  class Query {
    constructor(table) {
      this.table = table; this.filters = []; this.sort = null; this.max = null;
      this.mode = 'select'; this.payload = null; this.one = false; this.wantCount = false; this.head = false;
    }
    select(_columns, options = {}) { this.wantCount = !!options.count; this.head = !!options.head; return this; }
    eq(field, value) { this.filters.push({ op: 'eq', field, value }); return this; }
    neq(field, value) { this.filters.push({ op: 'neq', field, value }); return this; }
    in(field, values) { this.filters.push({ op: 'in', field, value: values || [] }); return this; }
    not(field, operator, value) { this.filters.push({ op: 'not', field, operator, value }); return this; }
    order(field, options = {}) { this.sort = { field, ascending: options.ascending !== false }; return this; }
    limit(value) { this.max = value; return this; }
    maybeSingle() { this.one = true; return this; }
    single() { this.one = true; return this; }
    insert(payload) { this.mode = 'insert'; this.payload = payload; return this; }
    update(payload) { this.mode = 'update'; this.payload = payload; return this; }
    delete() { this.mode = 'delete'; return this; }
    upsert(payload) { this.mode = 'upsert'; this.payload = payload; return this; }
    then(resolve, reject) { this.execute().then(resolve, reject); }
    async execute() {
      try {
        const result = await api('query', {
          table: this.table, mode: this.mode, payload: this.payload, filters: this.filters,
          sort: this.sort, max: this.max, one: this.one, wantCount: this.wantCount, head: this.head
        });
        return { data: result.data ?? null, count: result.count ?? null, error: null };
      } catch (error) { return { data: null, count: null, error }; }
    }
  }

  window.sb = {
    from: table => new Query(table),
    async rpc(name, args) { try { return { data: (await api('rpc', { name, args })).data || null, error: null }; } catch (error) { return { data: null, error }; } },
    auth: {
      async getSession() { return { data: { session: await refreshSession() } }; },
      onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }; },
      async signUpWithEmail({ email, password, birthDate, acceptedTerms }) {
        try {
          if (!acceptedTerms) throw new Error('يجب الموافقة على الشروط وسياسة الخصوصية');
          const birthday = new Date(`${birthDate}T00:00:00Z`);
          const ageDate = new Date(); ageDate.setUTCFullYear(ageDate.getUTCFullYear() - 13);
          if (!birthDate || Number.isNaN(birthday.getTime()) || birthday > ageDate) throw new Error('يجب أن يكون عمرك 13 سنة أو أكثر');
          const result = await firebaseAuth('accounts:signUp', { email: email.trim().toLowerCase(), password, returnSecureToken: true });
          const pendingProfile = { birth_date: birthDate, terms_version: '2026-09', accepted_at: now() };
          localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(pendingProfile));
          await firebaseAuth('accounts:update', { idToken: result.idToken, displayName: `badilni:${birthDate}:2026-09`, returnSecureToken: false });
          await firebaseAuth('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: result.idToken, continueUrl: 'https://byyassmin.com/badilni/' });
          return { data: { needsVerification: true }, error: null };
        } catch (error) { return { data: null, error }; }
      },
      async signInWithPassword({ email, password }) {
        try {
          const result = await firebaseAuth('accounts:signInWithPassword', { email: email.trim().toLowerCase(), password, returnSecureToken: true });
          const lookup = await firebaseAuth('accounts:lookup', { idToken: result.idToken });
          const user = lookup.users && lookup.users[0];
          if (!user?.emailVerified) {
            await firebaseAuth('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: result.idToken, continueUrl: 'https://byyassmin.com/badilni/' }).catch(() => {});
            throw authError('EMAIL_NOT_VERIFIED');
          }
          const session = sessionFromAuth({ ...result, email: user.email, localId: user.localId });
          saveSession(session);
          let pending = readJson(PENDING_PROFILE_KEY);
          const recovery = String(user.displayName || '').match(/^badilni:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2})$/);
          if (!pending && recovery) pending = { birth_date: recovery[1], terms_version: recovery[2], accepted_at: now() };
          if (pending) {
            await api('profile', pending);
            localStorage.removeItem(PENDING_PROFILE_KEY);
          }
          return { data: { session }, error: null };
        } catch (error) { return { data: { session: null }, error }; }
      },
      async sendPasswordReset(email) {
        try { await firebaseAuth('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email: email.trim().toLowerCase(), continueUrl: 'https://byyassmin.com/badilni/' }); return { error: null }; }
        catch (error) { return { error }; }
      },
      async applyEmailAction(oobCode) {
        try {
          if (!oobCode) throw new Error('الرابط غير مكتمل');
          const data = await firebaseAuth('accounts:update', { oobCode, returnSecureToken: false });
          return { data, error: null };
        } catch (error) { return { data: null, error }; }
      },
      async checkPasswordResetCode(oobCode) {
        try {
          if (!oobCode) throw new Error('الرابط غير مكتمل');
          const data = await firebaseAuth('accounts:resetPassword', { oobCode });
          return { data, error: null };
        } catch (error) { return { data: null, error }; }
      },
      async confirmPasswordReset(oobCode, newPassword) {
        try {
          if (!oobCode) throw new Error('الرابط غير مكتمل');
          if (!newPassword || newPassword.length < 8) throw new Error('استخدم كلمة مرور من 8 أحرف على الأقل');
          const data = await firebaseAuth('accounts:resetPassword', { oobCode, newPassword });
          return { data, error: null };
        } catch (error) { return { data: null, error }; }
      },
      async signOut() { saveSession(null); return { error: null }; },
      async deleteAccount() { try { await api('delete-account'); saveSession(null); return { error: null }; } catch (error) { return { error }; } }
    },
    storage: {
      from() { return {
        async upload(path, file) { try { uploads.set(path, await compressImage(file)); return { error: null }; } catch (error) { return { error }; } },
        getPublicUrl(path) { return { data: { publicUrl: uploads.get(path) || '' } }; }
      }; }
    },
    channel(name) {
      const channel = { timer: null, seen: new Set(), handler: null, offerId: null,
        on(_event, config, handler) { this.handler = handler; this.offerId = String(config.filter || '').split('eq.')[1]; return this; },
        subscribe() { let ready = false; this.timer = setInterval(async () => {
          const result = await new Query('messages').select('*').eq('trade_offer_id', this.offerId).execute();
          (result.data || []).forEach(row => { if (!this.seen.has(row.id)) { this.seen.add(row.id); if (ready) this.handler?.({ new: row }); } }); ready = true;
        }, 3000); return this; }
      }; return channel;
    },
    removeChannel(channel) { if (channel?.timer) clearInterval(channel.timer); },
    async registerPushToken(record) { return api('push-token', record); },
    __seed: async () => {}
  };
})();
