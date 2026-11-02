// Badilni background push registration via Firebase Cloud Messaging.
(function(){
  const CDN='https://www.gstatic.com/firebasejs/11.10.0';
  let modulesPromise=null, messaging=null, registration=null, foregroundBound=false, nativeBound=false;

  function config(){ return window.BADILNI_PUSH_CONFIG || {}; }
  function native(){ return window.Capacitor?.isNativePlatform?.()===true; }
  function nativePlugin(){ return window.Capacitor?.Plugins?.FirebaseMessaging || null; }
  function nativePlatform(){ return window.Capacitor?.getPlatform?.() || 'native'; }
  function supported(){ return native() ? !!nativePlugin() : ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window); }
  function standalone(){ return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone===true; }
  function currentUser(){ return window.getBadilniPushUser?.() || null; }
  function modules(){ return modulesPromise ||= Promise.all([import(`${CDN}/firebase-app.js`),import(`${CDN}/firebase-messaging.js`)]); }
  async function sw(){
    registration ||= await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    await navigator.serviceWorker.ready;
    return registration;
  }
  async function client(){
    if(messaging) return messaging;
    const [appMod,msgMod]=await modules();
    let app; try{ app=appMod.getApp(); }catch(_){ app=appMod.initializeApp(config()); }
    messaging=msgMod.getMessaging(app);
    if(!foregroundBound){
      msgMod.onMessage(messaging,async payload=>{
        const row={title:payload?.notification?.title||payload?.data?.title||'بادلني',body:payload?.notification?.body||payload?.data?.body||'لديك عرض جديد'};
        try{ (await sw()).showNotification(row.title,{body:row.body,icon:'./icon-192.png',badge:'./icon-192.png',tag:payload?.data?.notificationId||'badilni-offer',data:{url:'./?open=mine'}}); }catch(_){}
        if(typeof window.loadNotifications==='function') window.loadNotifications(false).catch(()=>{});
      });
      foregroundBound=true;
    }
    return {messaging,msgMod};
  }
  async function hash(value){
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function save(token,platform){
    const user=currentUser(); if(!user) throw new Error('LOGIN_REQUIRED');
    const key=await hash(token);
    const record={token,userId:user.id,enabled:true,app:'badilni',platform:platform||(/iPhone|iPad|iPod/i.test(navigator.userAgent)?'ios-webapp':'web'),updatedAt:Date.now()};
    if(!window.sb?.registerPushToken) throw new Error('TOKEN_SAVE_FAILED');
    await window.sb.registerPushToken(record);
    localStorage.setItem('badilni_push_token_key',key);
    localStorage.setItem('badilni_push_token',token);
    localStorage.setItem('badilni_push_enabled','1');
  }
  async function bindNative(){
    if(nativeBound) return;
    const plugin=nativePlugin(); if(!plugin) throw new Error('UNSUPPORTED');
    await plugin.addListener('tokenReceived',event=>{ if(event?.token&&currentUser()) save(event.token,nativePlatform()).catch(()=>{}); });
    await plugin.addListener('notificationReceived',()=>{ if(typeof window.loadNotifications==='function') window.loadNotifications(false).catch(()=>{}); });
    await plugin.addListener('notificationActionPerformed',()=>{ if(typeof window.loadNotifications==='function') window.loadNotifications(false).catch(()=>{}); });
    nativeBound=true;
  }
  async function enable(){
    if(!supported()) throw new Error('UNSUPPORTED');
    if(native()){
      const plugin=nativePlugin(); await bindNative();
      let permission=await plugin.checkPermissions();
      if(permission.receive==='prompt'||permission.receive==='prompt-with-rationale') permission=await plugin.requestPermissions();
      if(permission.receive!=='granted') throw new Error('PERMISSION_DENIED');
      if(nativePlatform()==='android') await plugin.createChannel({id:'badilni-offers',name:'عروض بادلني',description:'عروض المبادلة ورسائل التفاوض',importance:4,visibility:1}).catch(()=>{});
      const result=await plugin.getToken();
      if(!result?.token) throw new Error('NO_TOKEN');
      await save(result.token,nativePlatform());
      return true;
    }
    if(/iPhone|iPad|iPod/i.test(navigator.userAgent) && !standalone()) throw new Error('IOS_INSTALL_REQUIRED');
    const permission=await Notification.requestPermission();
    if(permission!=='granted') throw new Error('PERMISSION_DENIED');
    const reg=await sw(), c=await client();
    const token=await c.msgMod.getToken(c.messaging,{vapidKey:config().vapidKey,serviceWorkerRegistration:reg});
    if(!token) throw new Error('NO_TOKEN');
    await save(token);
    return true;
  }
  async function refresh(){
    if(native()){
      if(localStorage.getItem('badilni_push_enabled')!=='1'||!currentUser()||!supported()) return false;
      try{ await bindNative(); const result=await nativePlugin().getToken(); if(result?.token) await save(result.token,nativePlatform()); return !!result?.token; }catch(_){ return false; }
    }
    if(Notification.permission!=='granted'||localStorage.getItem('badilni_push_enabled')!=='1'||!currentUser()) return false;
    try{
      const reg=await sw(), c=await client();
      const token=await c.msgMod.getToken(c.messaging,{vapidKey:config().vapidKey,serviceWorkerRegistration:reg});
      if(token) await save(token);
      return !!token;
    }catch(_){ return false; }
  }
  async function disable(){
    const token=localStorage.getItem('badilni_push_token');
    const platform=native()?nativePlatform():(/iPhone|iPad|iPod/i.test(navigator.userAgent)?'ios-webapp':'web');
    if(token&&window.sb?.registerPushToken) await window.sb.registerPushToken({token,enabled:false,platform}).catch(()=>{});
    if(native()&&nativePlugin()) await nativePlugin().deleteToken().catch(()=>{});
    localStorage.removeItem('badilni_push_enabled');
    localStorage.removeItem('badilni_push_token');
  }
  window.badilniPush={enable,refresh,disable,supported};
})();
