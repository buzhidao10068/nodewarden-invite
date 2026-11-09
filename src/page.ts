export function page(siteKey?: string): string {
  const key = siteKey && /^[0-9a-z_-]+$/i.test(siteKey) ? siteKey : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NodeWarden 邀请申请</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:700px;margin:6vh auto;padding:0 22px;line-height:1.7}h1{font-size:1.8rem}input,textarea,button{box-sizing:border-box;font:inherit;border-radius:8px;padding:12px}input,textarea{width:100%;border:1px solid #94a3b8;margin:6px 0 14px}textarea{min-height:220px}button{cursor:pointer;border:0;background:#166534;color:#fff;margin:12px 12px 0 0}button:disabled{opacity:.5;cursor:wait}small{display:block;color:#77837c}#result,#query-result{white-space:pre-wrap;overflow-wrap:anywhere}.notice{font-size:.9rem}#lookup{padding:18px;border:1px solid #94a3b8;border-radius:10px;margin-top:28px}h2{font-size:1.2rem}
</style></head><body><h1>NodeWarden 邀请申请</h1>
<p>申请由管理员人工审核。审核通过后，管理员会手动通过邮件发送邀请码，请填写可以正常收信的邮箱。</p>
<form id="form"><label for="email">邮箱</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="用于接收管理员发送的邀请邮件">
<label for="application">申请说明（1–5000 个字符）</label><textarea id="application" required></textarea><small id="count">0 / 5000</small>
${key ? `<div class="cf-turnstile" data-sitekey="${key}" data-action="apply"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
<button id="submit" type="submit">提交申请</button></form>
<p id="result" role="status" aria-live="polite"></p>
<section id="lookup"><h2>查询申请状态</h2><p class="notice">使用提交申请时填写的邮箱查询。邀请码由管理员通过邮件发送。</p>
<form id="query-form"><label for="query-email">申请邮箱</label><input id="query-email" name="email" type="email" required maxlength="254" autocomplete="email"><button id="query" type="submit">用邮箱查询</button></form>
<p id="query-result" role="status" aria-live="polite"></p></section>
<script>
const el=id=>document.getElementById(id),text=el('application'),email=el('email'),submit=el('submit'),result=el('result'),queryEmail=el('query-email'),queryButton=el('query'),queryResult=el('query-result');
let busy=false,queryBusy=false,attempt=null;
text.addEventListener('input',()=>{el('count').textContent=Array.from(text.value.trim()).length+' / 5000'});
function validEmail(value){return value.length<=254&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)}
async function fingerprint(){const parts=[navigator.userAgent,navigator.language,screen.width+'x'+screen.height,Intl.DateTimeFormat().resolvedOptions().timeZone,navigator.hardwareConcurrency].join('|');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(parts))),x=>x.toString(16).padStart(2,'0')).join('')}
el('form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const address=email.value.trim().toLowerCase(),application=text.value.trim();if(!validEmail(address)){result.textContent='请填写有效的邮箱地址。';return}if(Array.from(application).length<1||Array.from(application).length>5000){result.textContent='请填写 1–5000 个字符。';return}busy=true;submit.disabled=true;result.textContent='正在提交申请…';queryEmail.value=address;
try{if(!attempt||attempt.email!==address||attempt.application!==application)attempt={applicationId:crypto.randomUUID(),email:address,application};const r=await fetch('/api/applications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...attempt,fingerprint:await fingerprint(),turnstileToken:window.turnstile&&window.turnstile.getResponse()})});const d=await r.json();result.textContent=d.message||'服务暂不可用，请稍后使用邮箱查询。';if(d.status==='failed'||d.status==='rejected')attempt=null;}catch{result.textContent='连接中断，请先在下方使用邮箱查询。未查到申请时，可以刷新人机验证后重新提交。'}finally{busy=false;submit.disabled=false;if(window.turnstile)window.turnstile.reset()}});
el('query-form').addEventListener('submit',async event=>{event.preventDefault();if(queryBusy)return;const address=queryEmail.value.trim().toLowerCase();if(!validEmail(address)){queryResult.textContent='请填写有效的邮箱地址。';return}queryBusy=true;queryButton.disabled=true;queryResult.textContent='正在查询…';try{const r=await fetch('/api/applications/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:address})});const d=await r.json();queryResult.textContent=d.message||'查询失败，请稍后再试。'}catch{queryResult.textContent='网络暂不可用，请稍后查询。'}finally{queryBusy=false;queryButton.disabled=false}});
</script></body></html>`;
}
