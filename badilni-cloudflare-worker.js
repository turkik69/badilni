// Add this logic to the existing Cloudflare Worker using the same
// FIREBASE_SERVICE_ACCOUNT_JSON secret as the Champions League push worker.
const PROJECT_ID='world-cup-2026-d3091';
const DATABASE_URL='https://world-cup-2026-d3091-default-rtdb.europe-west1.firebasedatabase.app';
const APP_URL='https://byyassmin.com/badilni/';
const APP_ICON=`${APP_URL}icon-192.png`;

function json(data,status=200){ return new Response(JSON.stringify(data,null,2),{status,headers:{'content-type':'application/json; charset=utf-8'}}); }
function b64(input){ const bytes=typeof input==='string'?new TextEncoder().encode(input):new Uint8Array(input); let s=''; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
function pem(p){ const raw=p.replace('-----BEGIN PRIVATE KEY-----','').replace('-----END PRIVATE KEY-----','').replace(/\s/g,''); const bin=atob(raw),out=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i); return out.buffer; }
async function accessToken(env){
  const sa=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON||'{}');
  if(!sa.client_email||!sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing');
  const now=Math.floor(Date.now()/1000), header={alg:'RS256',typ:'JWT'}, payload={iss:sa.client_email,scope:'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600};
  const unsigned=`${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  const key=await crypto.subtle.importKey('pkcs8',pem(sa.private_key),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned));
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${unsigned}.${b64(sig)}`})});
  const data=await r.json(); if(!r.ok||!data.access_token) throw new Error(`OAuth failed: ${JSON.stringify(data)}`); return data.access_token;
}
async function dbGet(path,token){ const r=await fetch(`${DATABASE_URL}/${path}.json`,{headers:{Authorization:`Bearer ${token}`}}); if(!r.ok)throw new Error(`GET ${path}: ${r.status}`); return r.json(); }
async function dbPatch(path,value,token){ const r=await fetch(`${DATABASE_URL}/${path}.json`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value)}); if(!r.ok)throw new Error(`PATCH ${path}: ${r.status}`); }
async function send(deviceToken,n,token){
  const r=await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({message:{token:deviceToken,notification:{title:n.title||'بادلني',body:n.body||'لديك عرض مبادلة جديد'},data:{type:String(n.type||'direct_offer'),notificationId:String(n.id),relatedId:String(n.related_id||''),url:APP_URL},webpush:{fcm_options:{link:APP_URL},notification:{icon:APP_ICON,badge:APP_ICON,tag:`badilni-${n.id}`,renotify:true}}}})});
  const data=await r.json().catch(()=>({})); return {ok:r.ok,status:r.status,data};
}
async function processBadilni(env){
  const token=await accessToken(env);
  const [rawNotifications,tokens,dispatch]=await Promise.all([dbGet('badilni/notifications',token),dbGet('badilniPushTokens',token),dbGet('badilniPushDispatch',token)]);
  const notifications=Object.entries(rawNotifications||{}).map(([id,n])=>({id,...n})).filter(n=>n.type==='direct_offer'&&n.user_id).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))).slice(-30);
  let sent=0,failed=0,skipped=0;
  for(const n of notifications){
    const targets=Object.entries(tokens||{}).filter(([,t])=>t?.enabled!==false&&t?.userId===n.user_id);
    for(const [key,t] of targets){
      if(dispatch?.[n.id]?.[key]?.done){ skipped++; continue; }
      const result=await send(t.token,n,token); result.ok?sent++:failed++;
      await dbPatch(`badilniPushDispatch/${n.id}/${key}`,{done:result.ok,status:result.status,at:Date.now()},token);
      if([404,410].includes(result.status)) await dbPatch(`badilniPushTokens/${key}`,{enabled:false,updatedAt:Date.now()},token);
    }
  }
  return {sent,failed,skipped,notifications:notifications.length};
}
export default {
  async fetch(request,env){ try{return json({ok:true,service:'Badilni Push',...(await processBadilni(env))});}catch(error){return json({ok:false,error:error.message},500);} },
  async scheduled(_event,env,ctx){ ctx.waitUntil(processBadilni(env).then(x=>console.log(JSON.stringify(x))).catch(console.error)); }
};
