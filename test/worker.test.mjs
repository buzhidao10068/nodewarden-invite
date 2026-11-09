import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Script } from "node:vm";
import { build } from "esbuild";
import { Miniflare, NoOpLog, Response as WorkerResponse } from "miniflare";

const bindings = {
  NODEWARDEN_URL: "https://vault.test", NODEWARDEN_CLIENT_ID: "user.test-admin",
  NODEWARDEN_CLIENT_SECRET: randomBytes(32).toString("base64"), NODEWARDEN_MASTER_PASSWORD_HASH: randomBytes(32).toString("base64"),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), HASH_SALT: "test-salt-".repeat(8),
  TURNSTILE_SECRET: randomBytes(32).toString("hex"), TURNSTILE_SITE_KEY: randomBytes(16).toString("hex"),
  ADMIN_TOKEN: randomBytes(32).toString("hex"), DAILY_INVITE_LIMIT: "3", INVITE_EXPIRES_IN_HOURS: "1",
};
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const bundle = (options) => build({ bundle: true, write: false, format: "esm", target: "es2022", logLevel: "silent", ...options });
const utilities = await bundle({ stdin: { contents: 'export * from "./src/store.ts"; export * from "./src/security.ts"; export * from "./src/dedup.ts";', resolveDir: process.cwd() }, platform: "node" });
const helpers = await import(`data:text/javascript;base64,${Buffer.from(utilities.outputFiles[0].text).toString("base64")}`);
let mf, db, mode, calls, invites;
const asJson = (body, status = 200) => new WorkerResponse(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const freshText = () => [...randomBytes(300)].map((n, i) => String.fromCodePoint(0x4e00 + n * 20 + i)).join("");
function submission(overrides = {}) {
  return { applicationId: randomUUID(), receipt: randomBytes(32).toString("hex"), application: freshText(), fingerprint: randomBytes(32).toString("hex"), turnstileToken: "test-response", ...overrides };
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
const apply = (input, options) => request("/api/applications", input, options);
const status = (input, receipt = input.receipt) => request(`/api/applications/${input.applicationId}/status`, { receipt });
const count = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const record = (input) => db.prepare("SELECT * FROM nw_applications WHERE id = ?").bind(input.applicationId).first();

before(async () => {
  const worker = await bundle({ entryPoints: ["src/index.ts"], platform: "browser" });
  mf = new Miniflare({ modules: true, script: worker.outputFiles[0].text, compatibilityDate: "2026-07-30", d1Databases: ["DB"], bindings, log: new NoOpLog(),
    async outboundService(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.text();
      calls.push({ url: url.href, method: request.method, body, authorization: request.headers.get("authorization") });
      if (url.hostname === "challenges.cloudflare.com") return asJson({ success: mode !== "turnstile-fail", hostname: mode === "wrong-host" ? "other.test" : "invite.test", action: "apply" });
      if (url.pathname === "/identity/connect/token") return asJson({ access_token: "test-access-token", expires_in: 3600 });
      if (url.pathname === "/api/admin/invites" && request.method === "GET") return asJson({ data: invites, continuationToken: null });
      if (url.pathname === "/api/admin/invites" && request.method === "POST") {
        if (mode === "definite-fail") return asJson({}, 400);
        if (mode === "unauthorized") return asJson({}, 401);
        const invite = { code: randomBytes(20).toString("hex"), status: "active", usedBy: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), inviteLink: "https://untrusted.test/" };
        invites.push(invite);
        if (mode === "unknown") return asJson({}, 500);
        if (mode === "malformed") return asJson({ code: invite.code });
        return asJson(invite, 201);
      }
      if (url.pathname.startsWith("/api/admin/invites/") && request.method === "DELETE") {
        invites = invites.filter((invite) => invite.code !== url.pathname.split("/").at(-1));
        return new WorkerResponse(null, { status: 204 });
      }
      if (url.pathname.endsWith("/status") && request.method === "PUT") return asJson({ status: "banned" });
      throw new Error(`Unexpected outbound request: ${url}`);
    },
  });
  db = await mf.getD1Database("DB");
  // Keep trigger bodies together when using the D1 exec helper.
  await db.exec(schema.replace(/^--.*$/gm, "").replace(/\n/g, " "));
});
beforeEach(async () => {
  mode = "success"; calls = []; invites = [];
  await db.exec("DELETE FROM nw_admin_audit; DELETE FROM nw_rate_limits; DELETE FROM nw_quota_reservations; DELETE FROM nw_daily_quota; DELETE FROM nw_eligibility; DELETE FROM nw_daily_attempts; DELETE FROM nw_applications;");
});
after(async () => { if (mf) await mf.dispose(); });

test("success uses API-key token flow, expiry, encrypted storage and secret receipt", async () => {
  const input = submission();
  const result = await apply(input);
  assert.equal(result.status, 200, JSON.stringify({ result, calls })); assert.equal(result.body.status, "succeeded");
  assert.equal(result.body.inviteLink, `https://vault.test/?invite=${invites[0].code}`);
  assert.deepEqual([...new Set(calls.map((call) => new URL(call.url).hostname))].sort(), ["challenges.cloudflare.com", "vault.test"]);
  const tokenCall = calls.find((call) => call.url.endsWith("/identity/connect/token"));
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get("grant_type"), "client_credentials"); assert.equal(form.get("scope"), "api");
  assert.equal(form.get("client_id"), bindings.NODEWARDEN_CLIENT_ID); assert.equal(form.get("client_secret"), bindings.NODEWARDEN_CLIENT_SECRET);
  const issue = calls.find((call) => call.url.endsWith("/api/admin/invites") && call.method === "POST");
  assert.deepEqual(JSON.parse(issue.body), { expiresInHours: 1, masterPasswordHash: bindings.NODEWARDEN_MASTER_PASSWORD_HASH });
  assert.equal(issue.authorization, "Bearer test-access-token");
  const row = await record(input);
  assert.ok(row.encrypted_invite); assert.ok(!row.encrypted_invite.includes(invites[0].code)); assert.notEqual(row.receipt_hash, input.receipt);
  assert.equal((await status(input)).body.inviteLink, result.body.inviteLink);
  assert.equal((await status(input, "a".repeat(64))).status, 404);
  assert.equal((await apply(input)).body.inviteLink, result.body.inviteLink);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/admin/invites") && c.method === "POST").length, 1);
  assert.equal((await request("/internal/applications")).status, 404);
  assert.equal((await request("/internal/applications", undefined, { admin: true })).body.data.length, 1);
});

test("D1 concurrent reservations enforce daily quota and roll back all partial writes", async () => {
  const env = { ...bindings, DB: db };
  const attempts = Array.from({ length: 12 }, (_, i) => ({ id: randomUUID(), receipt_hash: `r${i}`, ip_hash: `i${i}`, fingerprint_hash: `f${i}`, day: helpers.beijingDay(), application_text: freshText(), created_at: new Date().toISOString() }));
  const results = await Promise.allSettled(attempts.map((app) => helpers.reserve(app, env)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(await count("nw_applications"), 3); assert.equal(await count("nw_quota_reservations"), 3);
  assert.equal(await count("nw_daily_attempts"), 6); assert.equal(await count("nw_eligibility"), 6);
  const publicQuota = (await request("/api/daily-status")).body;
  assert.deepEqual([publicQuota.limit, publicQuota.available], [3, 0]);
  await db.prepare("UPDATE nw_daily_quota SET quota_limit = 5").run();
  assert.equal((await request("/api/daily-status")).body.limit, 5);
});

test("concurrent same IP/device and cross-midnight requests cannot acquire duplicate eligibility", async () => {
  const env = { ...bindings, DB: db };
  const app = { id: randomUUID(), receipt_hash: "r", ip_hash: "same-ip", fingerprint_hash: "same-device", day: "2026-11-08", application_text: freshText(), created_at: new Date().toISOString() };
  const results = await Promise.allSettled([helpers.reserve(app, env), helpers.reserve({ ...app, id: randomUUID() }, env)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(helpers.reserve({ ...app, id: randomUUID(), day: "2026-11-09", fingerprint_hash: "new-device" }, env));
  await assert.rejects(helpers.reserve({ ...app, id: randomUUID(), day: "2026-11-09", ip_hash: "new-ip" }, env));
  assert.equal(await count("nw_applications"), 1);
});

test("rejection retains today's attempt while releasing eligibility and quota", async () => {
  const original = submission();
  assert.equal((await apply(original, { ip: "203.0.113.2" })).body.status, "succeeded");
  const input = submission({ application: original.application }); const result = await apply(input);
  assert.equal(result.status, 403); assert.equal(result.body.status, "rejected");
  assert.equal(await count("nw_daily_attempts"), 4); assert.equal(await count("nw_quota_reservations"), 1); assert.equal(await count("nw_eligibility"), 2);
  assert.equal((await apply(submission())).status, 429);
  assert.equal(await count("nw_applications"), 2);
});

test("one character, one Unicode code point and trimmed input can receive invitations", async () => {
  for (const [index, application] of ["密", "🔐", " \n甲\t "].entries()) {
    const input = submission({ application });
    const result = await apply(input, { ip: `203.0.113.${index + 1}` });
    assert.equal(result.body.status, "succeeded", JSON.stringify(result));
    assert.equal((await record(input)).application_text, application.trim());
  }
});

test("5000 Unicode code points are accepted and 5001 are rejected", async () => {
  assert.equal((await apply(submission({ application: "🔐".repeat(5001) }))).status, 400);
  const input = submission({ application: "🔐".repeat(5000) });
  assert.equal((await apply(input)).body.status, "succeeded");
  assert.equal([...(await record(input)).application_text].length, 5000);
});

test("single character normalized duplicates are still rejected", async () => {
  assert.equal((await apply(submission({ application: "Ａ" }))).body.status, "succeeded");
  const duplicate = submission({ application: "a" });
  assert.equal((await apply(duplicate, { ip: "203.0.113.2" })).body.status, "rejected");
  assert.equal((await record(duplicate)).error_code, "duplicate");
});

test("existing databases with an unused legacy column work without migration", async () => {
  await db.exec("ALTER TABLE nw_applications ADD COLUMN ai_approved INTEGER CHECK(ai_approved IN (0,1)); CREATE INDEX nw_applications_approved ON nw_applications(ai_approved, id);");
  try {
    // Reapplying the new schema must preserve existing data and nullable legacy fields.
    await db.exec(schema.replace(/^--.*$/gm, "").replace(/\n/g, " "));
    const input = submission();
    assert.equal((await apply(input)).body.status, "succeeded");
    const detail = await request(`/internal/applications/${input.applicationId}`, undefined, { admin: true });
    assert.equal(detail.status, 200);
    assert.ok(!Object.hasOwn(detail.body.application, "ai_approved"));
    assert.equal((await request("/internal/applications", undefined, { admin: true })).body.data.length, 1);
    assert.equal((await apply(submission({ application: input.application }), { ip: "203.0.113.2" })).body.status, "rejected");
    assert.equal((await status(input)).body.status, "succeeded");
  } finally {
    await db.exec("DROP INDEX nw_applications_approved; ALTER TABLE nw_applications DROP COLUMN ai_approved;");
  }
});

for (const failure of ["unknown", "malformed"]) test(`${failure} creation holds reservation and retries never create another invitation`, async () => {
  mode = failure;
  const input = submission(); const result = await apply(input);
  assert.equal(result.status, 202); assert.equal(result.body.status, "uncertain");
  assert.equal(invites.length, 1); assert.equal(await count("nw_quota_reservations"), 1); assert.equal(await count("nw_eligibility"), 2);
  await apply(input); await status(input);
  assert.equal(invites.length, 1);
  const path = `/internal/applications/${input.applicationId}`;
  assert.equal((await request(`${path}/release`, { confirm: "NO_USABLE_INVITE_REMAINS" }, { admin: true })).status, 409);
  assert.equal((await request(`${path}/recover`, { code: invites[0].code, confirm: "INVITE_BELONGS_TO_THIS_APPLICATION" }, { admin: true })).body.status, "succeeded");
  assert.equal((await status(input)).body.status, "succeeded");
});

test("definite upstream rejection releases reservations", async () => {
  mode = "definite-fail"; const result = await apply(submission());
  assert.equal(result.body.status, "failed"); assert.equal(invites.length, 0);
  assert.equal(await count("nw_quota_reservations"), 0); assert.equal(await count("nw_daily_attempts"), 0); assert.equal(await count("nw_eligibility"), 0);
});

test("manual release requires elapsed review/creation deadline and explicit confirmation", async () => {
  mode = "unknown";
  const input = submission(); await apply(input);
  const path = `/internal/applications/${input.applicationId}/release`;
  await db.prepare("UPDATE nw_applications SET resolve_after = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), input.applicationId).run();
  assert.equal((await request(path, {}, { admin: true })).status, 400);
  // An operator must inspect/revoke the upstream invitation before confirming release.
  invites = [];
  assert.equal((await request(path, { confirm: "NO_USABLE_INVITE_REMAINS" }, { admin: true })).status, 200);
  assert.equal((await record(input)).error_code, "admin_released");
  assert.equal(await count("nw_quota_reservations"), 0); assert.equal(await count("nw_daily_attempts"), 0); assert.equal(await count("nw_eligibility"), 0);
  const stale = { id: randomUUID(), receipt_hash: "stale-receipt", ip_hash: "stale-ip", fingerprint_hash: "stale-device", day: helpers.beijingDay(), application_text: freshText(), created_at: new Date(Date.now() - 180000).toISOString() };
  await helpers.reserve(stale, { ...bindings, DB: db });
  const stalePath = `/internal/applications/${stale.id}/release`;
  assert.equal((await request(stalePath, { confirm: "NO_USABLE_INVITE_REMAINS" }, { admin: true })).status, 200);
  mode = "success"; assert.equal((await apply(submission())).body.status, "succeeded");
});

test("recovery cannot associate an invitation already assigned to another application", async () => {
  await apply(submission());
  const assigned = invites[0].code;
  mode = "unknown";
  const pending = submission(); await apply(pending, { ip: "203.0.113.2" });
  const result = await request(`/internal/applications/${pending.applicationId}/recover`, { code: assigned, confirm: "INVITE_BELONGS_TO_THIS_APPLICATION" }, { admin: true });
  assert.equal(result.status, 409);
  assert.equal((await record(pending)).status, "uncertain");
  assert.equal(await count("nw_quota_reservations"), 2);
});

test("issuing text duplicates reject before creation while technical failures allow reusing one's text", async () => {
  const input = submission(); mode = "definite-fail";
  assert.equal((await apply(input)).body.status, "failed");
  mode = "success";
  const retry = submission({ application: input.application });
  assert.equal((await apply(retry)).body.status, "succeeded");
  const issueCalls = calls.filter((call) => call.url.endsWith("/api/admin/invites") && call.method === "POST").length;
  const duplicate = submission({ application: input.application });
  assert.equal((await apply(duplicate, { ip: "203.0.113.2" })).body.status, "rejected");
  assert.equal((await record(duplicate)).error_code, "duplicate");
  assert.equal(calls.filter((call) => call.url.endsWith("/api/admin/invites") && call.method === "POST").length, issueCalls);
  assert.equal(await count("nw_quota_reservations"), 1);
});

test("401 creation is not automatically retried and invalidates the cached token", async () => {
  const warmup = submission(); await apply(warmup);
  calls = [];
  await db.exec("DELETE FROM nw_admin_audit; DELETE FROM nw_quota_reservations; DELETE FROM nw_daily_quota; DELETE FROM nw_eligibility; DELETE FROM nw_daily_attempts; DELETE FROM nw_applications;");
  mode = "unauthorized"; assert.equal((await apply(submission())).body.status, "failed");
  assert.equal(calls.filter((c) => c.url.endsWith("/api/admin/invites")).length, 1);
  mode = "success"; await apply(submission());
  assert.equal(calls.filter((c) => c.url.endsWith("/identity/connect/token")).length, 1);
});

test("Turnstile hostname and rejection are enforced before reserving or issuing", async () => {
  for (const failure of ["wrong-host", "turnstile-fail"]) {
    mode = failure; assert.equal((await apply(submission())).status, 403);
  }
  assert.equal(await count("nw_applications"), 0); assert.equal(calls.filter((c) => new URL(c.url).hostname === "vault.test").length, 0);
});

test("input limits, source protection and submission rate limit reject before issuance", async () => {
  for (const application of ["", " \n\t "]) assert.equal((await apply(submission({ application }))).status, 400);
  assert.equal((await apply(submission({ application: "长".repeat(5001) }))).status, 400);
  assert.equal((await apply(submission(), { origin: "https://other.test" })).status, 403);
  mode = "turnstile-fail";
  for (let n = 0; n < 5; n++) assert.equal((await apply(submission())).status, 403);
  assert.equal((await apply(submission())).status, 429);
  assert.equal(await count("nw_applications"), 0);
});

test("administrator can revoke unused invite or ban its registered user with explicit confirmation", async () => {
  const input = submission(); await apply(input);
  const path = `/internal/applications/${input.applicationId}`;
  invites[0].usedBy = "registered-user";
  assert.equal((await request(`${path}/revoke`, {}, { admin: true })).status, 409);
  assert.equal((await request(`${path}/ban`, {}, { admin: true })).status, 409);
  assert.equal((await request(`${path}/ban`, { confirm: "BAN_REGISTERED_USER" }, { admin: true })).status, 200);
  const ban = calls.find((c) => c.method === "PUT");
  assert.ok(ban.url.endsWith("/users/registered-user/status")); assert.equal(JSON.parse(ban.body).status, "banned");
  invites[0].usedBy = null;
  assert.equal((await request(`${path}/revoke`, {}, { admin: true })).status, 200);
  assert.equal(invites.length, 0); assert.equal(await count("nw_eligibility"), 2);
});

test("AES-GCM binds ciphertext to the application, text normalization and Beijing day boundaries", async () => {
  const encrypted = await helpers.encrypt({ code: "secret" }, "app-1", bindings);
  assert.deepEqual(await helpers.decrypt(encrypted, "app-1", bindings), { code: "secret" });
  await assert.rejects(helpers.decrypt(encrypted, "app-2", bindings));
  assert.equal(helpers.overlap("ＡＢＣ，测试申请！", "abc测试申请"), 1);
  assert.equal(helpers.beijingDay(new Date("2026-11-08T15:59:59Z")), "2026-11-08");
  assert.equal(helpers.beijingDay(new Date("2026-11-08T16:00:00Z")), "2026-11-09");
  await assert.rejects(helpers.readBody(new Request("https://invite.test", { method: "POST", body: JSON.stringify({ text: "x".repeat(48000) }) })), /Body too large/);
});

test("page inline script parses and response contains no server secrets", async () => {
  const response = await mf.dispatchFetch("https://invite.test/"); const html = await response.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  new Script(scripts[0][1]);
  assert.ok(html.includes("申请说明（1–5000 个字符）"));
  assert.ok(html.includes("0 / 5000"));
  assert.ok(!html.includes("AI"));
  // Exercise the same inline submit handler used in the browser at both limits.
  const nodes = new Map();
  const listeners = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", hidden: false, addEventListener: (event, handler) => listeners.set(`${id}:${event}`, handler) });
    return nodes.get(id);
  };
  const { runInNewContext } = await import("node:vm");
  let sent;
  runInNewContext(scripts[0][1], {
    document: { getElementById: node }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: "test", language: "zh-CN", hardwareConcurrency: 4 }, screen: { width: 100, height: 100 },
    Intl, TextEncoder, crypto: globalThis.crypto, window: {},
    fetch: async (url, options) => {
      if (url === "/api/daily-status") return { ok: true, json: async () => ({ available: 3, limit: 3 }) };
      sent = JSON.parse(options.body);
      return { json: async () => ({ status: "succeeded", message: "已生成" }) };
    },
  });
  node("application").value = " \t ";
  await listeners.get("form:submit")({ preventDefault() {} });
  assert.equal(sent, undefined);
  assert.equal(node("result").textContent, "请填写 1–5000 个字符。");
  node("application").value = "🔐".repeat(5001);
  await listeners.get("form:submit")({ preventDefault() {} });
  assert.equal(sent, undefined);
  node("application").value = "🔐";
  listeners.get("application:input")();
  assert.equal(node("count").textContent, "1 / 5000");
  await listeners.get("form:submit")({ preventDefault() {} });
  assert.equal(sent.application, "🔐");
  for (const secret of [bindings.NODEWARDEN_CLIENT_SECRET, bindings.NODEWARDEN_MASTER_PASSWORD_HASH, bindings.ADMIN_TOKEN]) assert.ok(!html.includes(secret));
  assert.ok(response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
});
