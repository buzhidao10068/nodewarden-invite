// Derived from hekuo5310/nl-invite-auto (Apache-2.0).
// Modified for NodeWarden, on-demand issuance and transaction-based reservations, 2026-11-09.
import { adminRoute } from "./admin.js";
import { dailyStatus, handleApplication, statusRequest } from "./applications.js";
import { page } from "./page.js";
import { json, validateConfig } from "./security.js";
import { dailyLimit, expiryHours, type Env } from "./types.js";

export type { Env } from "./types.js";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (request.method === "POST" && origin && origin !== url.origin) return json({ message: "请求来源无效。" }, 403);
      if (request.method === "GET" && url.pathname === "/") return new Response(page(env.TURNSTILE_SITE_KEY), { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      } });
      if (url.pathname.startsWith("/internal/")) return await adminRoute(request, env);
      if (request.method === "GET" && url.pathname === "/api/daily-status") return await dailyStatus(env);
      const status = url.pathname.match(/^\/api\/applications\/([a-f0-9-]{36})\/status$/i);
      if (request.method === "POST" && status) return await statusRequest(request, status[1], env);
      if (request.method === "POST" && url.pathname === "/api/applications") {
        await validateConfig(request, env);
        dailyLimit(env); expiryHours(env);
        return await handleApplication(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch {
      // Do not include provider responses, bearer tokens, passwords or invitation codes in logs.
      console.error("Invitation service request failed");
      return json({ message: "服务暂不可用；如已提交申请，请保留回执并稍后查询。" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
