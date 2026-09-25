const CACHE = 'badilni-v5.3.1-mobile-viewport';
const ASSETS = ['./', './index.html', './secure-store.js', './push-config.js', './push.js', './theme-v3.css', './privacy.html', './terms.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];

try {
  importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey:'AIzaSyBsnryD1ZtvjzumatCCVN-QpRAMR4_IG7M', authDomain:'world-cup-2026-d3091.firebaseapp.com',
    projectId:'world-cup-2026-d3091', messagingSenderId:'830204361101', appId:'1:830204361101:web:f3a23c0fa41bb809d365c4'
  });
  firebase.messaging().onBackgroundMessage(payload => {
    if (payload && payload.notification) return;
    const data=payload?.data||{};
    self.registration.showNotification(data.title||'بادلني',{body:data.body||'لديك عرض مبادلة جديد',icon:'./icon-192.png',badge:'./icon-192.png',tag:`badilni-${data.notificationId||'offer'}`,data:{url:data.url||'./?open=mine'}});
  });
} catch (_) {}

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const freshRequest = new Request(event.request, {cache:'no-store'});
  event.respondWith(fetch(freshRequest).then(response => {
    const copy = response.clone();
    if (response.ok && new URL(event.request.url).origin === self.location.origin) caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html'))));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url ? event.notification.data.url : './';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(windows => {
    const existing = windows[0];
    if (existing){ existing.focus(); existing.navigate(target); return; }
    return clients.openWindow(target);
  }));
});
