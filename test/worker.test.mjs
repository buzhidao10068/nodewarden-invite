import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Script, runInNewContext } from "node:vm";
import { build } from "esbuild";
import { Miniflare, NoOpLog, Response as WorkerResponse } from "miniflare";

const bindings = {
  NODEWARDEN_URL: "https://vault.test", NODEWARDEN_CLIENT_ID: "user.test-admin",
  NODEWARDEN_CLIENT_SECRET: randomBytes(32).toString("base64"), NODEWARDEN_MASTER_PASSWORD_HASH: randomBytes(32).toString("base64"),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), HASH_SALT: "test-salt-".repeat(8),
  TURNSTILE_SECRET: randomBytes(32).toString("hex"), TURNSTILE_SITE_KEY: randomBytes(16).toString("hex"),
  ADMIN_TOKEN: randomBytes(32).toString("hex"),
};
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const legacySchema = await readFile(new URL("./legacy-schema.sql", import.meta.url), "utf8");
const sql = (text) => text.replace(/^--.*$/gm, "").replace(/\n/g, " ");
const bundle = (options) => build({ bundle: true, write: false, format: "esm", target: "es2022", logLevel: "silent", ...options });
const utilities = await bundle({ stdin: { contents: 'export * from "./src/store.ts"; export * from "./src/security.ts"; export * from "./src/dedup.ts"; export { normalizeEmail } from "./src/applications.ts";', resolveDir: process.cwd() }, platform: "node" });
const helpers = await import(`data:text/javascript;base64,${Buffer.from(utilities.outputFiles[0].text).toString("base64")}`);
let mf, db, workerScript, mode, calls, invites;
const asJson = (body, status = 200) => new WorkerResponse(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const freshText = () => [...randomBytes(300)].map((n, i) => String.fromCodePoint(0x4e00 + n * 20 + i)).join("");
function submission(overrides = {}) {
  return { applicationId: randomUUID(), email: `${randomUUID()}@example.com`, application: freshText(), fingerprint: randomBytes(32).toString("hex"), turnstileToken: "test-response", ...overrides };
}
async function request(path, body, { ip = "203.0.113.1", admin = false, method = body === undefined ? "GET" : "POST", origin } = {}) {
  const response = await mf.dispatchFetch(`https://invite.test${path}`, {
    method, headers: { "CF-Connecting-IP": ip, ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(admin ? { authorization: `Bearer ${bindings.ADMIN_TOKEN}` } : {}), ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : { message: text } };
}
async function browser(path, { instance = mf, cookie, body, method = body === undefined ? "GET" : "POST", origin = "https://invite.test", ip = "203.0.113.10", token } = {}) {
  const response = await instance.dispatchFetch(`https://invite.test${path}`, { method,
    headers: { "CF-Connecting-IP": ip, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text,
    cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
const login = (options = {}) => browser("/admin/api/session", { body: { token: bindings.ADMIN_TOKEN }, ...options });
const apply = (input, options) => request("/api/applications", input, options);
const status = (email, options) => request("/api/applications/status", { email }, options);
const count = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const record = (input) => db.prepare("SELECT * FROM nw_applications WHERE id = ?").bind(input.applicationId).first();
const action = (input, name, body = {}) => request(`/internal/applications/${input.applicationId}/${name}`, body, { admin: true });
const sent = (input, extra = {}) => action(input, "sent", { confirm: "INVITATION_EMAIL_SENT", ...extra });
function upstreamInvite() {
  const invite = { code: randomBytes(20).toString("hex"), status: "active", usedBy: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), inviteLink: "https://untrusted.test/" };
  invites.push(invite);
  return invite;
}

before(async () => {
  const worker = await bundle({ entryPoints: ["src/index.ts"], platform: "browser" });
  workerScript = worker.outputFiles[0].text;
  mf = new Miniflare({ modules: true, script: workerScript, compatibilityDate: "2026-07-30", d1Databases: ["DB", "LEGACY"], bindings, log: new NoOpLog(),
    async outboundService(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.text();
      calls.push({ url: url.href, method: request.method, body, authorization: request.headers.get("authorization") });
      if (url.hostname === "challenges.cloudflare.com") return asJson({ success: mode !== "turnstile-fail", hostname: mode === "wrong-host" ? "other.test" : "invite.test", action: "apply" });
      if (url.pathname === "/identity/connect/token") return asJson({ access_token: "test-access-token", expires_in: 3600 });
      if (url.pathname === "/api/admin/invites" && request.method === "GET") return asJson({ data: invites, continuationToken: null });
      if (url.pathname.startsWith("/api/admin/invites/") && request.method === "DELETE") {
        invites = invites.filter((invite) => invite.code !== url.pathname.split("/").at(-1));
        return new WorkerResponse(null, { status: 204 });
      }
      if (url.pathname.endsWith("/status") && request.method === "PUT") return asJson({ status: "banned" });
      throw new Error(`Unexpected outbound request: ${url}`);
    },
  });
  db = await mf.getD1Database("DB");
  await db.exec(sql(schema));
});
beforeEach(async () => {
  mode = "success"; calls = []; invites = [];
  await db.exec("DELETE FROM nw_admin_audit; DELETE FROM nw_rate_limits; DELETE FROM nw_application_emails; DELETE FROM nw_eligibility; DELETE FROM nw_daily_attempts; DELETE FROM nw_applications;");
});
after(async () => { if (mf) await mf.dispose(); });

test("submission stores normalized email for manual review without creating or exposing invitations", async () => {
  const input = submission({ email: "  Applicant@Example.COM  " });
  const result = await apply(input);
  assert.equal(result.status, 200); assert.equal(result.body.status, "reviewing");
  assert.match(result.body.message, /管理员.*邮件/);
  assert.deepEqual(Object.keys(result.body).sort(), ["message", "status"]);
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), ["challenges.cloudflare.com"]);
  assert.equal((await record(input)).encrypted_invite, null);
  const email = await db.prepare("SELECT * FROM nw_application_emails WHERE application_id = ?").bind(input.applicationId).first();
  assert.equal(email.email, "applicant@example.com"); assert.notEqual(email.email_hash, email.email);
  assert.equal((await status("APPLICANT@example.com")).body.status, "reviewing");
  assert.equal((await apply(input)).body.status, "reviewing"); assert.equal(await count("nw_applications"), 1);
  assert.equal((await request("/internal/applications")).status, 404);
  const list = await request("/internal/applications", undefined, { admin: true });
  assert.equal(list.body.data[0].email, "applicant@example.com");
  const detail = await request(`/internal/applications/${input.applicationId}`, undefined, { admin: true });
  assert.equal(detail.body.application.application_text, input.application);
  assert.ok(!Object.hasOwn(detail.body.application, "receipt_hash"));
  assert.ok(!Object.hasOwn(detail.body.application, "email_hash"));
});

test("email validation rejects missing and malformed addresses before storage", async () => {
  for (const email of [undefined, "", "a", "a@localhost", "a@@b.com", ["a b", "example.com"].join("@"), [".a", "example.com"].join("@"), ["a.", "example.com"].join("@"), ["a", "-b.com"].join("@"), "a@b..com", `${"x".repeat(65)}@a.com`, `${"x".repeat(250)}@a.com`]) {
    assert.equal((await apply(submission({ email }))).status, 400, String(email));
  }
  assert.equal(await count("nw_applications"), 0); assert.equal(calls.length, 0);
  assert.equal(helpers.normalizeEmail(" Name+tag@Example.com "), "name+tag@example.com");
  assert.equal((await status("invalid")).status, 400);
});

test("more than three distinct applicants can apply, and the old daily status route is removed", async () => {
  for (let index = 1; index <= 8; index++) assert.equal((await apply(submission(), { ip: `203.0.113.${index}` })).body.status, "reviewing");
  assert.equal(await count("nw_applications"), 8);
  assert.equal((await request("/api/daily-status")).status, 404);
  assert.equal(calls.filter(call => new URL(call.url).hostname === "vault.test").length, 0);
});

test("concurrent IP, device and email collisions roll back partial applications", async () => {
  const env = { ...bindings, DB: db };
  const now = new Date().toISOString();
  const app = { id: randomUUID(), email: "a@example.com", email_hash: "email-a", ip_hash: "ip-a", fingerprint_hash: "device-a", day: "2026-11-08", application_text: freshText(), created_at: now };
  const results = await Promise.allSettled([helpers.reserve(app, env), helpers.reserve({ ...app, id: randomUUID() }, env)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(helpers.reserve({ ...app, id: randomUUID(), email: "b@example.com", email_hash: "email-b", day: "2026-11-09", fingerprint_hash: "new-device" }, env));
  await assert.rejects(helpers.reserve({ ...app, id: randomUUID(), email: "c@example.com", email_hash: "email-c", day: "2026-11-09", ip_hash: "new-ip" }, env));
  await assert.rejects(helpers.reserve({ ...app, id: randomUUID(), ip_hash: "new-ip", fingerprint_hash: "new-device" }, env));
  assert.equal(await count("nw_applications"), 1); assert.equal(await count("nw_application_emails"), 1);
  assert.equal(await count("nw_daily_attempts"), 2); assert.equal(await count("nw_eligibility"), 2);
});

test("duplicate email and mismatched application ID cannot create or change an application", async () => {
  const input = submission(); await apply(input);
  assert.equal((await apply(submission({ email: input.email }), { ip: "203.0.113.2" })).status, 409);
  assert.equal((await apply(submission({ applicationId: input.applicationId }), { ip: "203.0.113.3" })).status, 409);
  assert.equal(await count("nw_applications"), 1);
  assert.equal((await status("unknown@example.com")).body.status, "not_found");
  assert.equal((await request(`/api/applications/${input.applicationId}/status`, { receipt: "a".repeat(64) })).status, 404);
});

test("one character, Unicode code points and trimmed input are accepted", async () => {
  for (const [index, application] of ["密", "🔼", " \n申\t "].entries()) {
    const input = submission({ application });
    assert.equal((await apply(input, { ip: `203.0.113.${index + 1}` })).body.status, "reviewing");
    assert.equal((await record(input)).application_text, application.trim());
  }
  assert.equal((await apply(submission({ application: "🔼".repeat(5001) }), { ip: "203.0.113.5" })).status, 400);
  const input = submission({ application: "🔼".repeat(5000) });
  assert.equal((await apply(input, { ip: "203.0.113.5" })).body.status, "reviewing");
  assert.equal([...(await record(input)).application_text].length, 5000);
});

test("administrator marks mail sent only after confirmation, and email lookup exposes only status", async () => {
  const input = submission(); await apply(input);
  assert.equal((await action(input, "sent")).status, 400);
  assert.equal((await record(input)).status, "reviewing");
  assert.equal((await sent(input, { reason: "private administrator note" })).body.status, "succeeded");
  const result = await status(input.email);
  assert.deepEqual(Object.keys(result.body).sort(), ["message", "status"]);
  assert.equal(result.body.status, "succeeded");
  assert.ok(!JSON.stringify(result.body).includes("private"));
  assert.ok(!JSON.stringify(result.body).includes(input.email));
  assert.equal((await sent(input)).status, 409);
  assert.equal((await apply(submission(), { ip: "203.0.113.1" })).status, 429);
  assert.ok(await count("nw_admin_audit") >= 1);
});

test("manual rejection releases pending identity but retains the IP and device daily attempt", async () => {
  const input = submission(); await apply(input);
  assert.equal((await action(input, "reject", { reason: "private reviewer note" })).body.status, "rejected");
  assert.equal(await count("nw_eligibility"), 0); assert.equal(await count("nw_daily_attempts"), 2);
  assert.equal((await apply(submission())).status, 429);
  assert.ok(!JSON.stringify((await status(input.email)).body).includes("private"));
  const retry = submission({ email: input.email });
  assert.equal((await apply(retry, { ip: "203.0.113.2" })).body.status, "reviewing");
  // Two applications may share a millisecond; lookup must return the later insert.
  await db.prepare("UPDATE nw_applications SET created_at = ? WHERE id = ?").bind((await record(input)).created_at, retry.applicationId).run();
  assert.equal((await status(input.email)).body.status, "reviewing");
});

test("text duplicated from a sent application is rejected before manual review", async () => {
  const input = submission({ application: "Ａ" }); await apply(input); await sent(input);
  const duplicate = submission({ application: "a" });
  assert.equal((await apply(duplicate, { ip: "203.0.113.2" })).body.status, "rejected");
  assert.equal((await record(duplicate)).error_code, "duplicate");
  assert.equal(await count("nw_eligibility"), 2); assert.equal(await count("nw_daily_attempts"), 4);
});

test("known technical failures release eligibility and allow the same text and email to be retried", async () => {
  const input = submission(); await apply(input);
  assert.equal(await helpers.finishReview(input.applicationId, "failed", "temporary", "check_unavailable", { ...bindings, DB: db }), true);
  assert.equal(await count("nw_eligibility"), 0); assert.equal(await count("nw_daily_attempts"), 0);
  assert.equal((await apply(submission({ email: input.email, application: input.application }))).body.status, "reviewing");
});

test("upgrade preserves legacy data and removes obsolete issuance accounting; schema is repeatable", async () => {
  const legacy = await mf.getD1Database("LEGACY");
  await legacy.exec(sql(legacySchema));
  const id = randomUUID();
  await legacy.prepare("INSERT INTO nw_applications (id, receipt_hash, ip_hash, fingerprint_hash, day, application_text, status, created_at, updated_at) VALUES (?, 'old-receipt', 'old-ip', 'old-device', '2026-11-08', 'legacy', 'succeeded', ?, ?)")
    .bind(id, new Date().toISOString(), new Date().toISOString()).run();
  await legacy.exec("INSERT INTO nw_daily_quota VALUES ('2026-11-08', 3);");
  await legacy.prepare("INSERT INTO nw_quota_reservations VALUES (?, '2026-11-08')").bind(id).run();
  await legacy.exec(sql(schema)); await legacy.exec(sql(schema));
  const row = await helpers.load(id, { ...bindings, DB: legacy });
  assert.equal(row.application_text, "legacy"); assert.equal(row.status, "succeeded"); assert.equal(row.email, null);
  assert.equal((await legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('nw_daily_quota','nw_quota_reservations','nw_enforce_quota')").first()).n, 0);
  const app = { id: randomUUID(), email: "new@example.com", email_hash: "new-email", ip_hash: "new-ip", fingerprint_hash: "new-device", day: "2026-11-09", application_text: freshText(), created_at: new Date().toISOString() };
  await helpers.reserve(app, { ...bindings, DB: legacy });
  assert.equal((await helpers.load(app.id, { ...bindings, DB: legacy })).email, app.email);
});

test("manual release requires elapsed deadline and confirmation and allows reapplication", async () => {
  const input = submission(); await apply(input);
  assert.equal((await action(input, "release", { confirm: "NO_USABLE_INVITE_REMAINS" })).status, 409);
  await db.prepare("UPDATE nw_applications SET created_at = ? WHERE id = ?").bind(new Date(Date.now() - 180000).toISOString(), input.applicationId).run();
  assert.equal((await action(input, "release")).status, 400);
  assert.equal((await action(input, "release", { confirm: "NO_USABLE_INVITE_REMAINS" })).status, 200);
  assert.equal(await count("nw_eligibility"), 0); assert.equal(await count("nw_daily_attempts"), 0);
  assert.equal((await apply(submission({ email: input.email }))).body.status, "reviewing");
});

test("optional invite linking is administrator-only and never leaks a registration link to email lookup", async () => {
  const input = submission(); await apply(input); const invite = upstreamInvite();
  assert.equal((await sent(input, { code: invite.code })).body.status, "succeeded");
  const row = await record(input);
  assert.ok(row.encrypted_invite); assert.ok(!row.encrypted_invite.includes(invite.code));
  const detail = await request(`/internal/applications/${input.applicationId}`, undefined, { admin: true });
  assert.equal(detail.body.upstream.inviteLink, `https://vault.test/?invite=${invite.code}`);
  const result = JSON.stringify((await status(input.email)).body);
  assert.ok(!result.includes(invite.code)); assert.ok(!result.includes("inviteLink"));
  const second = submission(); await apply(second, { ip: "203.0.113.2" });
  assert.equal((await sent(second, { code: invite.code })).status, 409);
  assert.equal((await record(second)).status, "reviewing");
});

test("legacy ambiguous invitations can still be recovered and released by an administrator", async () => {
  const input = submission(); await apply(input); const invite = upstreamInvite();
  await db.prepare("UPDATE nw_applications SET status = 'uncertain', issue_started_at = ?, resolve_after = ? WHERE id = ?")
    .bind(new Date().toISOString(), new Date(Date.now() - 1000).toISOString(), input.applicationId).run();
  assert.equal((await action(input, "recover", { code: invite.code, confirm: "INVITE_BELONGS_TO_THIS_APPLICATION" })).body.status, "succeeded");
  assert.equal((await status(input.email)).body.status, "succeeded");
  const pending = submission(); await apply(pending, { ip: "203.0.113.2" });
  await db.prepare("UPDATE nw_applications SET status = 'uncertain', issue_started_at = ?, resolve_after = ? WHERE id = ?")
    .bind(new Date().toISOString(), new Date(Date.now() - 1000).toISOString(), pending.applicationId).run();
  assert.equal((await action(pending, "recover", { code: invite.code, confirm: "INVITE_BELONGS_TO_THIS_APPLICATION" })).status, 409);
  assert.equal((await action(pending, "release", { confirm: "NO_USABLE_INVITE_REMAINS" })).status, 200);
});

test("administrator can revoke linked unused invites or ban their registered users", async () => {
  const input = submission(); await apply(input); const invite = upstreamInvite(); await sent(input, { code: invite.code });
  invite.usedBy = "registered-user";
  assert.equal((await action(input, "revoke")).status, 409);
  assert.equal((await action(input, "ban")).status, 409);
  assert.equal((await action(input, "ban", { confirm: "BAN_REGISTERED_USER" })).status, 200);
  const ban = calls.find(c => c.method === "PUT");
  assert.ok(ban.url.endsWith("/users/registered-user/status")); assert.equal(JSON.parse(ban.body).status, "banned");
  invite.usedBy = null;
  assert.equal((await action(input, "revoke")).status, 200);
  assert.equal(invites.length, 0); assert.equal(await count("nw_eligibility"), 2);
});

test("Turnstile and origin checks happen before storing applications", async () => {
  for (const failure of ["wrong-host", "turnstile-fail"]) { mode = failure; assert.equal((await apply(submission())).status, 403); }
  assert.equal((await apply(submission(), { origin: "https://other.test" })).status, 403);
  assert.equal((await status("a@example.com", { origin: "https://other.test" })).status, 403);
  assert.equal(await count("nw_applications"), 0);
});

test("submission and status lookup rate limits are independent and enforced", async () => {
  mode = "turnstile-fail";
  for (let n = 0; n < 5; n++) assert.equal((await apply(submission())).status, 403);
  assert.equal((await apply(submission())).status, 429);
  for (let n = 0; n < 10; n++) assert.equal((await status("a@example.com")).status, 200);
  assert.equal((await status("a@example.com")).status, 429);
  assert.equal(await count("nw_applications"), 0);
});

test("manual-only deployment works without NodeWarden API credentials or invitation encryption key", async () => {
  const manual = new Miniflare({ modules: true, script: workerScript, compatibilityDate: "2026-07-30", d1Databases: ["DB"],
    bindings: { HASH_SALT: bindings.HASH_SALT, ADMIN_TOKEN: bindings.ADMIN_TOKEN, ALLOW_INSECURE_LOCAL_DEV: "true" }, log: new NoOpLog() });
  try {
    await (await manual.getD1Database("DB")).exec(sql(schema));
    const input = submission();
    const response = await manual.dispatchFetch("http://localhost/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal((await response.json()).status, "reviewing");
  } finally { await manual.dispose(); }
});

test("AES-GCM binds ciphertext to the application and Beijing day boundaries still protect daily IP attempts", async () => {
  const encrypted = await helpers.encrypt({ code: "secret" }, "app-1", bindings);
  assert.deepEqual(await helpers.decrypt(encrypted, "app-1", bindings), { code: "secret" });
  await assert.rejects(helpers.decrypt(encrypted, "app-2", bindings));
  assert.equal(helpers.overlap("ＡＢＣ，测试申请！", "abc测试申请"), 1);
  assert.equal(helpers.beijingDay(new Date("2026-11-08T15:59:59Z")), "2026-11-08");
  assert.equal(helpers.beijingDay(new Date("2026-11-08T16:00:00Z")), "2026-11-09");
  await assert.rejects(helpers.readBody(new Request("https://invite.test", { method: "POST", body: JSON.stringify({ text: "x".repeat(48000) }) })), /Body too large/);
});

test("page submits email and Unicode explanation, queries by email, and contains no quota, receipt or server secrets", async () => {
  const response = await mf.dispatchFetch("https://invite.test/"); const html = await response.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1); new Script(scripts[0][1]);
  assert.ok(html.includes("申请说明（1–5000 个字符）")); assert.ok(html.includes("管理员会手动通过邮件发送邀请码"));
  for (const removed of ["AI", "今日剩余名额", "申请回执", "localStorage", "为什么需要密码管理服务", "本服务保存申请文字"]) assert.ok(!html.includes(removed), removed);
  const nodes = new Map(), listeners = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", hidden: false, addEventListener: (event, handler) => listeners.set(`${id}:${event}`, handler) });
    return nodes.get(id);
  };
  const requests = [];
  runInNewContext(scripts[0][1], {
    document: { getElementById: node }, navigator: { userAgent: "test", language: "zh-CN", hardwareConcurrency: 4 }, screen: { width: 100, height: 100 },
    Intl, TextEncoder, crypto: globalThis.crypto, window: {},
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { json: async () => ({ status: "reviewing", message: "等待审核" }) }; },
  });
  node("email").value = " Applicant@Example.COM "; node("application").value = " \t ";
  await listeners.get("form:submit")({ preventDefault() {} }); assert.equal(requests.length, 0);
  assert.equal(node("result").textContent, "请填写 1–5000 个字符。");
  node("application").value = "🔼".repeat(5001);
  await listeners.get("form:submit")({ preventDefault() {} }); assert.equal(requests.length, 0);
  node("application").value = "🔼"; listeners.get("application:input")(); assert.equal(node("count").textContent, "1 / 5000");
  await listeners.get("form:submit")({ preventDefault() {} });
  assert.equal(requests[0].body.application, "🔼"); assert.equal(requests[0].body.email, "applicant@example.com");
  assert.equal(Object.hasOwn(requests[0].body, "receipt"), false);
  await listeners.get("query-form:submit")({ preventDefault() {} });
  assert.equal(requests[1].url, "/api/applications/status"); assert.deepEqual(requests[1].body, { email: "applicant@example.com" });
  for (const secret of [bindings.NODEWARDEN_CLIENT_SECRET, bindings.NODEWARDEN_MASTER_PASSWORD_HASH, bindings.ADMIN_TOKEN]) assert.ok(!html.includes(secret));
  assert.ok(response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
});

test("admin HTML uses per-request CSP nonces and never embeds credentials or applicant data", async () => {
  const input = submission(); await apply(input);
  const response = await browser("/admin"), second = await browser("/admin");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const nonce = response.body.match(/<script nonce="([^"]+)">/)[1];
  assert.ok(response.headers.get("content-security-policy").includes(`'nonce-${nonce}'`));
  assert.ok(!second.body.includes(nonce));
  new Script(response.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
  assert.match(response.body, /管理员登录/); assert.match(response.body, /标记邮件已发送/);
  for (const secret of [bindings.ADMIN_TOKEN, bindings.NODEWARDEN_CLIENT_SECRET, bindings.NODEWARDEN_MASTER_PASSWORD_HASH, input.email, input.application]) assert.ok(!response.body.includes(secret));
  assert.ok(!response.body.includes("localStorage")); assert.ok(!response.body.includes("sessionStorage"));
  assert.equal((await browser("/admin/api/applications")).status, 401);
  assert.equal((await request("/internal/applications")).status, 404);
});

test("browser session supports review actions and shares state with the unchanged Bearer API", async () => {
  const authenticated = await login(); const cookie = authenticated.cookie;
  assert.equal(authenticated.status, 200); assert.ok(cookie);
  const setCookie = authenticated.headers.get("set-cookie");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Max-Age=28800", "Path=/"]) assert.ok(setCookie.includes(flag));
  assert.ok(!setCookie.includes(bindings.ADMIN_TOKEN));
  assert.equal((await browser("/admin/api/session", { cookie })).status, 200);
  const first = submission(); await apply(first);
  const list = await browser("/admin/api/applications?status=reviewing", { cookie });
  assert.equal(list.body.data[0].email, first.email);
  const detail = await browser(`/admin/api/applications/${first.applicationId}`, { cookie });
  assert.equal(detail.body.application.application_text, first.application);
  const markSent = await browser(`/admin/api/applications/${first.applicationId}/sent`, { cookie, body: { confirm: "INVITATION_EMAIL_SENT", reason: "web note" } });
  assert.equal(markSent.body.status, "succeeded");
  assert.equal((await request(`/internal/applications/${first.applicationId}`, undefined, { admin: true })).body.application.reason, "web note");
  assert.equal((await browser("/admin/api/applications?status=reviewing", { cookie })).body.data.length, 0);
  const second = submission(); await apply(second, { ip: "203.0.113.2" });
  assert.equal((await browser(`/admin/api/applications/${second.applicationId}/reject`, { cookie, body: {} })).body.status, "rejected");
  const third = submission(); await apply(third, { ip: "203.0.113.3" });
  await db.prepare("UPDATE nw_applications SET created_at = ? WHERE id = ?").bind(new Date(Date.now() - 180000).toISOString(), third.applicationId).run();
  assert.equal((await browser(`/admin/api/applications/${third.applicationId}/release`, { cookie, body: { confirm: "NO_USABLE_INVITE_REMAINS" } })).status, 200);
  assert.equal((await record(third)).status, "failed");
  const logout = await browser("/admin/api/session", { cookie, method: "DELETE" });
  assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await browser("/admin/api/session", { cookie: logout.cookie })).status, 401);
  assert.equal((await request("/internal/applications", undefined, { admin: true })).status, 200);
});

test("admin cookies reject forgery, expiry, cross-origin writes and cross-channel authentication", async () => {
  const cookie = (await login()).cookie;
  const input = submission(); await apply(input);
  const path = `/admin/api/applications/${input.applicationId}/sent`, body = { confirm: "INVITATION_EMAIL_SENT" };
  assert.equal((await browser(path, { cookie, body, origin: "https://evil.test" })).status, 403);
  assert.equal((await browser(path, { cookie, body, origin: null })).status, 401);
  assert.equal((await record(input)).status, "reviewing");
  assert.equal((await browser("/internal/applications", { cookie })).status, 404);
  assert.equal((await browser("/admin/api/applications", { token: bindings.ADMIN_TOKEN })).status, 401);
  const last = cookie.at(-1) === "0" ? "1" : "0";
  assert.equal((await browser("/admin/api/session", { cookie: cookie.slice(0, -1) + last })).status, 401);
  const payload = `${Math.floor(Date.now() / 1000) - 1}.${randomUUID()}`;
  const signature = createHmac("sha256", bindings.ADMIN_TOKEN).update(`nw-admin-session-v1:${payload}`).digest("hex");
  const cookieKey = cookie.slice(0, cookie.indexOf("="));
  assert.equal((await browser("/admin/api/session", { cookie: `${cookieKey}=${payload}.${signature}` })).status, 401);
  assert.equal((await login({ body: { token: "wrong" } })).status, 401);
  assert.equal((await login({ origin: null })).status, 403);
  assert.equal((await login({ origin: "https://evil.test" })).status, 403);
});

test("administrator login is rate limited independently of application submission", async () => {
  for (let index = 0; index < 5; index++) assert.equal((await login({ body: { token: "incorrect" } })).status, 401);
  assert.equal((await login()).status, 429);
  assert.equal((await apply(submission())).body.status, "reviewing");
});

test("web, api and both modes independently enforce which administrator entry points are enabled", async () => {
  for (const access of ["web", "api", "both"]) {
    const instance = new Miniflare({ modules: true, script: workerScript, compatibilityDate: "2026-07-30", d1Databases: ["DB"], bindings: { ...bindings, ADMIN_ACCESS_MODE: access }, log: new NoOpLog() });
    try {
      await (await instance.getD1Database("DB")).exec(sql(schema));
      assert.equal((await browser("/admin", { instance })).status, access === "api" ? 404 : 200);
      assert.equal((await browser("/internal/applications", { instance, token: bindings.ADMIN_TOKEN })).status, access === "web" ? 404 : 200);
      const session = await login({ instance });
      assert.equal(session.status, access === "api" ? 404 : 200);
      assert.equal((await browser("/admin/api/applications", { instance, cookie: session.cookie })).status, access === "api" ? 404 : 200);
    } finally { await instance.dispose(); }
  }
});

test("server status filtering and pagination include old pending applications beyond the first fifty", async () => {
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO nw_applications (id, ip_hash, fingerprint_hash, day, application_text, status, created_at, updated_at) VALUES (?, 'ip', 'device', '2026-11-09', 'legacy', ?, ?, ?)");
  await db.batch(Array.from({ length: 53 }, (_, index) => insert.bind(randomUUID(), index < 52 ? "reviewing" : "rejected", now, now)));
  const first = await request("/internal/applications?status=reviewing", undefined, { admin: true });
  assert.equal(first.body.data.length, 50); assert.equal(first.body.nextOffset, 50);
  const second = await request("/internal/applications?status=reviewing&offset=50", undefined, { admin: true });
  assert.equal(second.body.data.length, 2);
  assert.equal((await request("/internal/applications?status=rejected", undefined, { admin: true })).body.data.length, 1);
  assert.equal((await request("/internal/applications?status=invalid", undefined, { admin: true })).status, 400);
});

test("an unavailable upstream invite does not hide the administrator application detail", async () => {
  const input = submission(); await apply(input);
  await db.prepare("UPDATE nw_applications SET encrypted_invite = 'unreadable-legacy-data' WHERE id = ?").bind(input.applicationId).run();
  const result = await request(`/internal/applications/${input.applicationId}`, undefined, { admin: true });
  assert.equal(result.status, 200); assert.equal(result.body.application.email, input.email);
  assert.equal(result.body.upstream, null); assert.ok(result.body.upstreamWarning);
  assert.ok(!JSON.stringify(result.body).includes("unreadable-legacy-data"));
});

test("browser page safely renders untrusted text and requires confirmation for every mutation", async () => {
  const html = (await browser("/admin")).body;
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const nodes = new Map(), requests = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: id === "status-filter" ? "reviewing" : "", hidden: false, disabled: false, children: [], handlers: {}, textContent: "",
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      set innerHTML(_value) { throw new Error("Untrusted content must never use innerHTML"); },
    });
    return nodes.get(id);
  };
  const item = { id: randomUUID(), email: "review@example.com", status: "reviewing", created_at: new Date(Date.now() - 180000).toISOString(), updated_at: new Date().toISOString(), application_text: '<img src=x onerror="alert(1)">', reason: "private note" };
  let authenticated = false, confirm = false;
  const context = { document: { getElementById: node, createElement: () => node(randomUUID()) }, window: { confirm: () => confirm },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method || "GET", body: options.body && JSON.parse(options.body), options });
      if (url.endsWith("/session")) {
        if (options.method === "POST") authenticated = true;
        if (options.method === "DELETE") authenticated = false;
        return { ok: authenticated || options.method === "DELETE", status: authenticated ? 200 : 401, json: async () => authenticated ? { authenticated: true } : { message: "请登录" } };
      }
      if (url.includes("?")) return { ok: true, status: 200, json: async () => ({ data: [item] }) };
      if ((options.method || "GET") === "POST") { item.status = "succeeded"; return { ok: true, status: 200, json: async () => ({ status: "succeeded" }) }; }
      return { ok: true, status: 200, json: async () => ({ application: item, upstream: null }) };
    },
  };
  runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  node("token").value = bindings.ADMIN_TOKEN;
  await node("login-form").handlers.submit({ preventDefault() {} });
  assert.equal(node("token").value, ""); assert.equal(node("app").hidden, false);
  const detailButton = node("rows").children[0].children[2].children[0];
  await detailButton.handlers.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(node("detail-text").textContent, item.application_text);
  const mutations = () => requests.filter(request => request.url.endsWith("/sent"));
  await node("mark-sent").handlers.click(); assert.equal(mutations().length, 0);
  confirm = true; node("note").value = "approved";
  await node("mark-sent").handlers.click(); assert.equal(mutations().length, 1);
  assert.deepEqual(mutations()[0].body, { confirm: "INVITATION_EMAIL_SENT", reason: "approved" });
  assert.equal(node("mark-sent").disabled, true);
  assert.equal(mutations()[0].options.credentials, "same-origin");
  assert.ok(!mutations()[0].options.headers.authorization);
  await node("logout").handlers.click(); assert.equal(node("app").hidden, true);
  assert.equal(node("rows").children.length, 0); assert.equal(node("detail-text").textContent, "");
});
