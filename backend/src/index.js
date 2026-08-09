import { CreditLedger } from "./ledger.js";

export { CreditLedger };

const ALLOWED_ORIGINS = [
  "https://recipverse.vercel.app",
  "https://khaleely572-sudo.github.io"
];

function originOk(request) {
  const o = request.headers.get("origin");
  if (!o || o === "null") return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
  return ALLOWED_ORIGINS.indexOf(o) !== -1;
}

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

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
}

const UID_RE = /^u[0-9]+$/;

async function readJson(request, maxBytes) {
  const text = await request.text().catch(() => "");
  if (!text) return "empty";
  if (text.length > maxBytes) return "too_large";
  try { return JSON.parse(text); } catch (e) { return "bad_json"; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/pay/webhook" && request.method === "POST") {
      const parsed = await readJson(request, 512 * 1024);
      if (parsed === "too_large") return json({ ok: false, error: "Request too large." }, 413);
      if (parsed === "empty" || parsed === "bad_json" || !parsed) {
        return json({ ok: false, error: "Invalid webhook payload." }, 400);
      }
      const id = env.LEDGER.idFromName("global");
      const stub = env.LEDGER.get(id);
      return json(await stub.handlePayWebhook(parsed));
    }

    if (!originOk(request)) {
      return json({ ok: false, error: "Origin not allowed." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const id = env.LEDGER.idFromName("global");
    const stub = env.LEDGER.get(id);
    const ip = clientIp(request);

    if (path === "/" || path === "/api/health") {
      return json({ ok: true, service: "recipeverse-backend" });
    }

    if (path === "/api/register" && request.method === "POST") {
      if (!(await stub.rate("reg|" + ip, 10))) {
        return json({ ok: false, error: "Too many registrations. Try again in a minute." }, 429);
      }
      const parsed = await readJson(request, 64 * 1024);
      if (parsed === "too_large") return json({ ok: false, error: "Request too large." }, 413);
      if (parsed !== "empty" && parsed !== "bad_json" && parsed) {
        const body = parsed;
        const name = String(body.name || "Guest").replace(/[<>&"']/g, "").slice(0, 60);
        const result = await stub.register(name);
        return json({ ok: true, userId: result.userId, credits: result.credits, poolLeft: result.poolLeft });
      }
      return json({ ok: false, error: "Invalid request." }, 400);
    }

    if (path === "/api/me" && request.method === "GET") {
      const userId = request.headers.get("x-user-id") || "";
      if (!UID_RE.test(userId)) return json({ ok: false, error: "Invalid user id." }, 400);
      if (!(await stub.rate("me|" + ip, 120))) {
        return json({ ok: false, error: "Too many requests. Try again in a minute." }, 429);
      }
      return json(await stub.me(userId));
    }

    if (path === "/api/ai" && request.method === "POST") {
      const parsed = await readJson(request, 2 * 1024 * 1024);
      if (parsed === "too_large") return json({ ok: false, error: "Request too large." }, 413);
      if (parsed === "empty" || parsed === "bad_json" || !parsed || !parsed.body) {
        return json({ ok: false, error: "Invalid request." }, 400);
      }
      const userId = String(parsed.userId || "");
      if (!UID_RE.test(userId)) return json({ ok: false, error: "Invalid user id." }, 400);
      const sub = await stub.isSub(userId);
      const lim = sub ? 120 : 30;
      if (!(await stub.rate((sub ? "aip|" : "ai|") + ip, lim))) {
        return json({ ok: false, error: "Too many requests. Try again in a moment." }, 429);
      }
      const gemBody = parsed.body;
      const model = /^[a-z0-9.\-]+$/.test(String(parsed.model || "")) ? String(parsed.model) : "";
      const result = await stub.proxyAI({ userId, model, gemBody });
      if (result.status !== "ok") {
        return json({ ok: false, error: result.error, reason: result.status }, 402);
      }
      return json({
        ok: true,
        text: result.text,
        remaining: result.remaining,
        subscribed: !!result.subscribed,
        usedToday: result.usedToday,
        poolLeft: result.poolLeft
      });
    }

    if (path === "/api/pay/subscribe" && request.method === "POST") {
      if (!(await stub.rate("sub|" + ip, 10))) {
        return json({ ok: false, error: "Too many attempts. Try again in a minute." }, 429);
      }
      const parsed = await readJson(request, 64 * 1024);
      if (parsed === "too_large") return json({ ok: false, error: "Request too large." }, 413);
      const userId = String((parsed && parsed.userId) || "");
      if (!UID_RE.test(userId)) return json({ ok: false, error: "Invalid user id." }, 400);
      const returnUrl = String(parsed.returnUrl || "");
      const cancelUrl = String(parsed.cancelUrl || "");
      const safe = (u) => /^https:\/\/(recipverse\.vercel\.app|localhost|127\.0\.0\.1)(:\d+)?\//.test(u) ? u : "";
      const rurl = safe(returnUrl) || "https://recipverse.vercel.app/";
      const curl = safe(cancelUrl) || "https://recipverse.vercel.app/";
      try {
        const sub = await stub.createSubscription({ userId, returnUrl: rurl, cancelUrl: curl });
        await stub.setPendingSub(userId, sub.id);
        return json({ ok: true, id: sub.id, approveUrl: sub.approveUrl });
      } catch (e) {
        return json({ ok: false, error: e && e.message ? e.message : "PayPal setup failed." }, 500);
      }
    }

    if (path === "/api/pay/confirm" && request.method === "POST") {
      const parsed = await readJson(request, 64 * 1024);
      if (parsed === "too_large") return json({ ok: false, error: "Request too large." }, 413);
      const userId = String((parsed && parsed.userId) || "");
      const subId = String((parsed && parsed.subId) || "");
      if (!UID_RE.test(userId) || !subId) return json({ ok: false, error: "Invalid user id." }, 400);
      const r = await stub.activateSubscription(subId, userId);
      if (!r.ok) return json({ ok: false, error: r.error }, 402);
      return json({ ok: true, subscribed: true, credits: r.credits, balance: r.balance });
    }

    if (path === "/api/pay/status" && request.method === "GET") {
      const userId = request.headers.get("x-user-id") || "";
      const subId = url.searchParams.get("subId") || "";
      if (!UID_RE.test(userId)) return json({ ok: false, error: "Invalid user id." }, 400);
      return json(await stub.statusOrActivate(userId, subId));
    }

    if (path === "/api/pay/test" && request.method === "POST" && env.CHECKOUT_TEST === "1") {
      const parsed = await readJson(request, 64 * 1024);
      const userId = String((parsed && parsed.userId) || "");
      if (!UID_RE.test(userId)) return json({ ok: false, error: "Invalid user id." }, 400);
      return json(await stub.setSubscription(userId, "test-sub-" + Date.now()));
    }

    return json({ ok: false, error: "Not found." }, 404);
  }
};