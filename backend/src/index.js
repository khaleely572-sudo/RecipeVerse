import { CreditLedger } from "./ledger.js";

export { CreditLedger };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-user-id",
  "Access-Control-Max-Age": "86400"
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", ...CORS }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const id = env.LEDGER.idFromName("global");
    const stub = env.LEDGER.get(id);

    if (path === "/" || path === "/api/health") {
      return json({ ok: true, service: "recipeverse-backend" });
    }

    if (path === "/api/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "Guest").slice(0, 60);
      const result = await stub.register(name);
      return json({ ok: true, userId: result.userId, credits: result.credits, poolLeft: result.poolLeft });
    }

    if (path === "/api/me" && request.method === "GET") {
      const userId = request.headers.get("x-user-id") || "";
      return json(await stub.me(userId));
    }

    if (path === "/api/ai" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !body.body) return json({ ok: false, error: "Invalid request." }, 400);
      const userId = String(body.userId || "");
      const gemBody = body.body;
      const model = body.model || "";
      const result = await stub.proxyAI({ userId, model, gemBody });
      if (result.status !== "ok") {
        return json({ ok: false, error: result.error, reason: result.status }, 402);
      }
      return json({
        ok: true,
        text: result.text,
        remaining: result.remaining,
        usedToday: result.usedToday,
        poolLeft: result.poolLeft
      });
    }

    return json({ ok: false, error: "Not found." }, 404);
  }
};