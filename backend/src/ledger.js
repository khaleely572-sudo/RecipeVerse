import { DurableObject } from "cloudflare:workers";

export class CreditLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.KEYS = ["KEY_CALORIES", "KEY_FRIDGE", "KEY_GENERAL", "KEY_RECIPES"];
    this.MODELS = [
      "gemini-flash-latest",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-2.5-flash",
      "gemini-2.0-flash"
    ];
    this.DAILY_CAP = 1500;
    this.MIN_CREDITS = 20;
    this.MAX_CREDITS = 100;
    this.SUB_CREDITS = 1000;
    this.kv = ctx.storage.kv || ctx.storage;
  }

  paypalBase() {
    return this.env.PAYPAL_MODE === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
  }

  monthKey() {
    return new Date().toISOString().slice(0, 7);
  }

  async paypalToken() {
    const cached = await this.kv.get("pay_token");
    if (cached) {
      const t = JSON.parse(cached);
      if (t && t.exp > Date.now()) return t.token;
    }
    const clientId = this.env.PAYPAL_CLIENT_ID;
    const secret = this.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !secret) throw new Error("PayPal isn't configured yet. The owner needs to add the PayPal API credentials.");
    const res = await fetch(this.paypalBase() + "/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(clientId + ":" + secret),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error("PayPal auth failed: " + (data.error_description || ("HTTP " + res.status)));
    }
    await this.kv.put("pay_token", JSON.stringify({ token: data.access_token, exp: Date.now() + (parseInt(data.expires_in, 10) - 60) * 1000 }));
    return data.access_token;
  }

  async createSubscription({ userId, returnUrl, cancelUrl }) {
    const plan = this.env.PAYPAL_PLAN_ID;
    if (!plan) throw new Error("No PayPal subscription plan is configured on the server yet.");
    const token = await this.paypalToken();
    const res = await fetch(this.paypalBase() + "/v1/billing/subscriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_id: plan,
        custom_id: userId,
        application_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: "SUBSCRIBE_NOW"
        }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      throw new Error("PayPal could not create the subscription: " + (data.message || ("HTTP " + res.status)));
    }
    const approve = (data.links || []).find((l) => l.rel === "approve");
    return { id: data.id, approveUrl: approve ? approve.link : null };
  }

  async getSubscription(subId) {
    const token = await this.paypalToken();
    const res = await fetch(this.paypalBase() + "/v1/billing/subscriptions/" + encodeURIComponent(subId), {
      headers: { Authorization: "Bearer " + token }
    });
    return res.json().catch(() => ({}));
  }

  async setSubscription(userId, subId) {
    const users = (await this.getJson("users")) || {};
    const u = users[userId];
    if (!u) return { ok: false, error: "Unknown user." };
    const already = u.sub && u.sub.active && u.sub.subId === subId;
    if (!already) {
      u.balance = (u.balance || 0) + this.SUB_CREDITS;
    }
    u.sub = {
      active: true,
      subId,
      since: already ? u.sub.since : Date.now(),
      lastRenewMonth: this.monthKey(),
      plan: this.env.PAYPAL_PLAN_ID || "pro"
    };
    u.lastSeen = Date.now();
    await this.setJson("users", users);
    return { ok: true, subscribed: true, balance: u.balance, credits: u.balance + (u.credits || 0) };
  }

  async ensureSubRenew(userId) {
    const users = (await this.getJson("users")) || {};
    const u = users[userId];
    if (!u || !(u.sub && u.sub.active)) return false;
    const mk = this.monthKey();
    if (u.sub.lastRenewMonth === mk) return false;
    u.sub.lastRenewMonth = mk;
    u.balance = (u.balance || 0) + this.SUB_CREDITS;
    await this.setJson("users", users);
    return true;
  }

  async activateSubscription(subId, expectedUserId) {
    if (!this.env.PAYPAL_PLAN_ID) {
      return { ok: false, error: "Payments aren't configured yet on the server." };
    }
    const sub = await this.getSubscription(subId);
    if (!sub || !sub.id) return { ok: false, error: "PayPal couldn't verify this subscription." };
    const status = sub.status || "";
    if (["ACTIVE", "APPROVED", "APPROVAL_PENDING"].indexOf(status) === -1) {
      return { ok: false, error: "The subscription isn't active yet (status: " + status + ")." };
    }
    const planId = sub.plan_id || (sub.plan && sub.plan.id);
    if (this.env.PAYPAL_PLAN_ID && planId && planId !== this.env.PAYPAL_PLAN_ID) {
      return { ok: false, error: "This subscription is for a different plan." };
    }
    const customId = sub.custom_id;
    const userId = customId && /^u[0-9]+$/.test(customId)
      ? customId
      : (expectedUserId && /^u[0-9]+$/.test(expectedUserId) ? expectedUserId : null);
    if (!userId) return { ok: false, error: "Couldn't match the subscription to your account." };
    return this.setSubscription(userId, subId);
  }

  async handlePayWebhook(body) {
    if (body && (body.event_type === "BILLING.SUBSCRIPTION.ACTIVATED" || body.event_type === "BILLING.SUBSCRIPTION.APPROVED" || body.event_type === "PAYMENT.SALE.COMPLETED") && !this.env.PAYPAL_PLAN_ID) {
      return { ok: false, error: "Payments aren't configured yet - webhook ignored." };
    }
    const eventId = body && (body.id || (body.resource && body.resource.id));
    if (!eventId) return { ok: false, error: "Missing webhook event id." };
    const seen = await this.kv.get("webhook:" + eventId);
    if (seen) return { ok: true, duplicate: true };
    await this.kv.put("webhook:" + eventId, "1");
    const resource = (body && body.resource) || {};
    const subId = resource.id || resource.subscription_id || resource.billing_agreement_id;
    if (!subId) return { ok: false, error: "No subscription id in event." };
    const planId = resource.plan_id || (resource.plan && resource.plan.id);
    if (this.env.PAYPAL_PLAN_ID && planId && planId !== this.env.PAYPAL_PLAN_ID) {
      return { ok: false, error: "Plan mismatch." };
    }
    let userId = resource.custom_id || "";
    if (!/^u[0-9]+$/.test(userId)) {
      const users = (await this.getJson("users")) || {};
      for (const k of Object.keys(users)) {
        if (users[k].sub && users[k].sub.subId === subId) { userId = k; break; }
      }
    }
    if (!/^u[0-9]+$/.test(userId)) return { ok: false, error: "Couldn't match the subscription to an account." };
    const eventType = (body && body.event_type) || "";
    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED" || eventType === "BILLING.SUBSCRIPTION.APPROVED") {
      return this.setSubscription(userId, subId);
    }
    if (eventType === "PAYMENT.SALE.COMPLETED") {
      await this.ensureSubRenew(userId);
      const users = (await this.getJson("users")) || {};
      const u = users[userId];
      if (u && !(u.sub && u.sub.active)) {
        u.sub = { active: true, subId, since: Date.now(), lastRenewMonth: this.monthKey(), plan: this.env.PAYPAL_PLAN_ID || "pro" };
        await this.setJson("users", users);
      }
      return { ok: true };
    }
    return { ok: true, skipped: true };
  }

  async isSub(userId) {
    const users = (await this.getJson("users")) || {};
    const u = users[userId];
    return !!(u && u.sub && u.sub.active);
  }

  async getJson(key) {
    const val = await this.kv.get(key);
    return val == null ? undefined : JSON.parse(val);
  }

  async setJson(key, value) {
    await this.kv.put(key, JSON.stringify(value));
  }

  today() {
    return new Date().toISOString().slice(0, 10);
  }

  pad(n) { return String(n).padStart(2, "0"); }

  minuteKey() {
    const n = new Date();
    return this.today() + "T" + this.pad(n.getUTCHours()) + ":" + this.pad(n.getUTCMinutes());
  }

  async rate(key, limit) {
    const k = "rate:" + key + ":" + this.minuteKey();
    let cur = 0;
    const raw = await this.kv.get(k);
    if (raw) cur = parseInt(raw, 10) || 0;
    cur += 1;
    await this.kv.put(k, String(cur));
    return cur <= limit;
  }

  fairShare(poolLeft, activeUsers) {
    const raw = Math.floor(poolLeft / Math.max(activeUsers, 1));
    return Math.min(this.MAX_CREDITS, Math.max(this.MIN_CREDITS, raw));
  }

  async ensureMeta() {
    let meta = await this.getJson("meta");
    if (!meta || meta.date !== this.today()) {
      meta = { date: this.today(), calls: 0, keyCalls: {} };
      const users = (await this.getJson("users")) || {};
      const n = Object.keys(users).length;
      if (n) {
        const share = this.fairShare(this.DAILY_CAP, n);
        for (const id of Object.keys(users)) {
          users[id].credits = Math.max(users[id].credits, share);
        }
        await this.setJson("users", users);
      }
      await this.setJson("meta", meta);
      try {
        const list = await this.kv.list({ prefix: "rate:" });
        if (list && list.keys) {
          const today = this.today();
          for (const entry of list.keys) {
            if (entry.name && entry.name.indexOf(today) === -1) {
              await this.kv.delete(entry.name);
            }
          }
        }
      } catch (e) {}
      try {
        const list = await this.kv.list({ prefix: "webhook:" });
        if (list && list.keys) {
          const today = this.today();
          for (const entry of list.keys) {
            if (entry.name && entry.name.indexOf(today) === -1) {
              await this.kv.delete(entry.name);
            }
          }
        }
      } catch (e) {}
    }
    return meta;
  }

  async register(name) {
    await this.ensureMeta();
    const users = (await this.getJson("users")) || {};
    const meta = await this.getJson("meta");
    const active = Object.keys(users).length;
    const poolLeft = Math.max(this.DAILY_CAP - meta.calls, 0);
    const credits = this.fairShare(poolLeft, active + 1);
    const seq = (await this.getJson("seq")) || 1;
    const userId = "u" + seq;
    users[userId] = { name, credits, registered: Date.now(), lastSeen: Date.now() };
    await this.setJson("users", users);
    await this.setJson("seq", seq + 1);
    return { userId, credits, poolLeft };
  }

  async me(userId) {
    await this.ensureMeta();
    const users = (await this.getJson("users")) || {};
    const u = users[userId];
    const meta = await this.getJson("meta");
    const subscribed = !!(u && u.sub && u.sub.active);
    if (u) await this.ensureSubRenew(userId);
    return {
      ok: !!u,
      credits: u ? (u.balance || 0) + (u.credits || 0) : 0,
      balance: u ? (u.balance || 0) : 0,
      subscribed,
      usedToday: meta.calls,
      poolLeft: Math.max(this.DAILY_CAP - meta.calls, 0)
    };
  }

  async proxyAI({ userId, model, gemBody }) {
    await this.ensureMeta();
    const meta = await this.getJson("meta");
    const users = (await this.getJson("users")) || {};
    const u = users[userId];
    if (!u) return { status: "no_user", error: "Unknown user. Please refresh the page." };
    await this.ensureSubRenew(userId);
    const subscribed = !!(u.sub && u.sub.active);
    if (!subscribed && meta.calls >= this.DAILY_CAP) {
      return { status: "pool_empty", error: "Today's shared credit pool is used up. It refills at midnight." };
    }
    if (u.credits < 1 && !(subscribed && u.balance >= 1)) {
      return {
        status: "no_credits",
        error: subscribed
          ? "Your Pro balance is used up for now."
          : "You're out of credits. Credits refill when the daily pool resets."
      };
    }

    const models = model && this.MODELS.indexOf(model) !== -1 ? [model].concat(this.MODELS) : this.MODELS;
    const keyOrder = [...this.KEYS].sort((a, b) => (meta.keyCalls[a] || 0) - (meta.keyCalls[b] || 0));
    let lastErr = "";

    for (const modelName of models) {
      for (const k of keyOrder) {
        const key = this.env[k];
        if (!key) { lastErr = "Missing server key " + k; continue; }
        const url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + encodeURIComponent(key);
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(gemBody)
          });
        } catch (e) {
          lastErr = "Network error reaching Gemini.";
          continue;
        }
        if (res.status === 429) { lastErr = "Rate-limited"; continue; }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
          lastErr = msg;
          if (msg.indexOf("model") !== -1 || msg.indexOf("models/") !== -1 || msg.indexOf("no longer available") !== -1 || msg.indexOf("not found") !== -1) break;
          continue;
        }
        const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        const text = parts.map((p) => p.text || "").join("");
        if (!text) { lastErr = "Empty Gemini response."; continue; }

        meta.calls += 1;
        meta.keyCalls[k] = (meta.keyCalls[k] || 0) + 1;
        await this.setJson("meta", meta);
        const us = (await this.getJson("users")) || {};
        if (us[userId]) {
          if (subscribed && (us[userId].balance || 0) >= 1) {
            us[userId].balance -= 1;
          } else {
            us[userId].credits = Math.max(0, us[userId].credits - 1);
          }
          us[userId].lastSeen = Date.now();
          await this.setJson("users", us);
        }
        return {
          status: "ok",
          text,
          remaining: us[userId] ? (us[userId].balance || 0) + (us[userId].credits || 0) : 0,
          subscribed: !!us[userId].sub,
          usedToday: meta.calls,
          poolLeft: Math.max(this.DAILY_CAP - meta.calls, 0)
        };
      }
    }

    if (lastErr.indexOf("rate") !== -1 || lastErr.indexOf("429") !== -1) {
      return { status: "pool_empty", error: "All API keys are temporarily rate-limited. Try again in a minute." };
    }
    return { status: "gemini_error", error: lastErr || "Gemini failed." };
  }
}