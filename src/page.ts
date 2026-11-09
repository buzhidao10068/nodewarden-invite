export function page(siteKey?: string): string {
  const key = siteKey && /^[0-9a-z_-]+$/i.test(siteKey) ? siteKey : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NodeWarden 邀请码申请</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:700px;margin:6vh auto;padding:0 22px;line-height:1.7}h1{font-size:1.8rem}textarea,button{box-sizing:border-box;font:inherit;border-radius:8px;padding:12px}textarea{width:100%;min-height:220px;border:1px solid #94a3b8}button{cursor:pointer;border:0;background:#166534;color:#fff;margin:12px 12px 0 0}button:disabled{opacity:.5;cursor:wait}.quota{padding:12px 18px;border:1px solid #86a891;border-radius:10px}small{display:block;color:#77837c}#result{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#228454}.notice{font-size:.9rem}#recovery{padding:12px;border:1px solid #94a3b8;border-radius:8px;margin-top:16px}#recovery input{box-sizing:border-box;width:100%;padding:8px;font:inherit}
</style></head><body><p class="quota" id="quota" role="status">正在读取今日名额…</p><h1>NodeWarden 邀请码申请</h1>
<p>请简要说明你的申请需求，至少填写 1 个字符。不需要提供任何真实密码、密钥或保险库内容。</p>
<p class="notice">同一 IP 或设备每天可提交一次申请，成功领取后不能再次领取。共用网络可能受到限制。邀请码仅可使用一次，页面会显示具体到期时间。</p>
<form id="form"><label for="application">申请说明（1–5000 个字符）</label><textarea id="application" required placeholder="请独立说明你的个人需求与使用计划"></textarea><small id="count">0 / 5000</small>
${key ? `<div class="cf-turnstile" data-sitekey="${key}" data-action="apply"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
<p class="notice">申请会进行文本查重；本服务保存申请文字、领取记录及经加盐哈希处理的 IP 和设备标识。请勿填写密码或密钥。</p>
<button id="submit" type="submit">提交申请</button><button id="check" type="button" hidden>查询上次申请</button><button id="new" type="button" hidden>重新填写申请</button></form>
<p id="result" role="status" aria-live="polite"></p><a id="invite" hidden target="_blank" rel="noopener noreferrer">打开 NodeWarden 注册页面</a>
<details id="recovery"><summary>保存或恢复申请回执</summary><p>查询需要申请 ID 和秘密回执。请妥善保存，勿转发给他人。浏览器会尽量在本机保存副本。</p><label for="saved">回执（ID.秘密回执）</label><input id="saved" autocomplete="off"><button id="restore" type="button">用此回执查询</button></details>
<script>
const el=id=>document.getElementById(id),text=el('application'),submit=el('submit'),check=el('check'),again=el('new'),result=el('result'),link=el('invite'),saved=el('saved');
let receipt=null,busy=false,retrySame=false;
function remember(value){receipt=value;retrySame=false;submit.textContent='提交申请';saved.value=value?value.applicationId+'.'+value.receipt:'';try{if(value)localStorage.setItem('nw-invite-receipt',JSON.stringify(value));else localStorage.removeItem('nw-invite-receipt')}catch{}check.hidden=!value;submit.disabled=!!value;}
try{const v=JSON.parse(localStorage.getItem('nw-invite-receipt'));if(v&&typeof v.applicationId==='string'&&typeof v.receipt==='string')remember(v)}catch{}
text.addEventListener('input',()=>{el('count').textContent=Array.from(text.value.trim()).length+' / 5000'});
async function quota(){try{const r=await fetch('/api/daily-status');if(!r.ok)throw Error();const d=await r.json();el('quota').textContent='今日剩余名额：'+d.available+' / '+d.limit+'（北京时间每日 00:00 切换）'}catch{el('quota').textContent='暂时无法读取今日名额'}}quota();
async function fingerprint(){const parts=[navigator.userAgent,navigator.language,screen.width+'x'+screen.height,Intl.DateTimeFormat().resolvedOptions().timeZone,navigator.hardwareConcurrency].join('|');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(parts))),x=>x.toString(16).padStart(2,'0')).join('')}
function show(d){retrySame=false;submit.disabled=!!receipt;submit.textContent='提交申请';link.hidden=true;result.textContent=d.message||'服务暂不可用，请稍后查询。';again.hidden=!['failed','rejected'].includes(d.status);if(d.inviteLink){link.href=d.inviteLink;link.hidden=false;result.textContent+='\\n有效期至：'+new Date(d.expiresAt).toLocaleString();again.hidden=true}quota()}
async function query(){if(!receipt||busy)return;busy=true;check.disabled=true;try{const r=await fetch('/api/applications/'+encodeURIComponent(receipt.applicationId)+'/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receipt:receipt.receipt})});const d=await r.json();show(d);if(r.status===404){again.hidden=true;retrySame=true;submit.disabled=false;submit.textContent='重新提交原申请';result.textContent='暂未查到申请或回执无效。可核对回执、填写说明并刷新人机验证，使用同一回执重新提交。';}}catch{result.textContent='网络暂不可用，请保留回执并稍后查询。'}finally{busy=false;check.disabled=false}}
check.addEventListener('click',query);
again.addEventListener('click',()=>{if(busy)return;remember(null);again.hidden=true;link.hidden=true;result.textContent='可重新填写；查重拒绝仍占用当天的申请次数。';if(window.turnstile)window.turnstile.reset()});
el('restore').addEventListener('click',()=>{if(busy)return;const v=saved.value.trim().split('.');if(v.length!==2||!/^[a-f0-9-]{36}$/i.test(v[0])||!/^[a-f0-9]{64}$/.test(v[1])){result.textContent='回执格式无效。';return}remember({applicationId:v[0],receipt:v[1]});query()});
el('form').addEventListener('submit',async event=>{event.preventDefault();if((receipt&&!retrySame)||busy)return;const application=text.value.trim();if(Array.from(application).length<1||Array.from(application).length>5000){result.textContent='请填写 1–5000 个字符。';return}busy=true;submit.disabled=true;again.hidden=true;result.textContent='正在处理，请保留回执并耐心等待…';try{const device=await fingerprint();if(!receipt)remember({applicationId:crypto.randomUUID(),receipt:Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('')});retrySame=false;const r=await fetch('/api/applications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...receipt,application,fingerprint:device,turnstileToken:window.turnstile&&window.turnstile.getResponse()})});show(await r.json())}catch{result.textContent=receipt?'连接中断，请保留回执并点击“查询上次申请”。':'此浏览器无法完成安全验证，请使用支持 HTTPS 与 Web Crypto 的浏览器。';if(!receipt)submit.disabled=false;}finally{busy=false;if(window.turnstile)window.turnstile.reset()}});
if(receipt){result.textContent='已找到本机保存的回执，可查询上次申请。';}
</script></body></html>`;
}
