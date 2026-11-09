// Derived from hekuo5310/nl-invite-auto (Apache-2.0).
// Modified for NodeWarden, manual email invitations without Cron, 2026-11-09.
import { adminRoute } from "./admin.js";
import { handleApplication, statusRequest } from "./applications.js";
import { page } from "./page.js";
import { json, validateConfig } from "./security.js";
import type { Env } from "./types.js";

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
      if (request.method === "POST" && ["/api/applications", "/api/applications/status"].includes(url.pathname)) {
        await validateConfig(request, env);
        return url.pathname.endsWith("/status") ? await statusRequest(request, env) : await handleApplication(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch {
      console.error("Invitation service request failed");
      return json({ message: "服务暂不可用；如已提交申请，请稍后使用邮箱查询。" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
