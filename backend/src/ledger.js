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
    this.kv = ctx.storage.kv || ctx.storage;
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
    return {
      ok: !!u,
      credits: u ? u.credits : 0,
      usedToday: meta.calls,
      poolLeft: Math.max(this.DAILY_CAP - meta.calls, 0)
    };
  }

  async proxyAI({ userId, model, gemBody }) {
    await this.ensureMeta();
    const meta = await this.getJson("meta");
    if (meta.calls >= this.DAILY_CAP) {
      return { status: "pool_empty", error: "Today's shared credit pool is used up. It refills at midnight." };
    }
    const users = (await this.getJson("users")) || {};
    const u = users[userId];
    if (!u) return { status: "no_user", error: "Unknown user. Please refresh the page." };
    if (u.credits < 1) {
      return { status: "no_credits", error: "You're out of credits. Credits refill when the daily pool resets." };
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
          us[userId].credits = Math.max(0, us[userId].credits - 1);
          us[userId].lastSeen = Date.now();
          await this.setJson("users", us);
        }
        return {
          status: "ok",
          text,
          remaining: us[userId] ? us[userId].credits : 0,
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