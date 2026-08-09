(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return (root || document).querySelectorAll(sel); };
  var esc = function (s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  var randInt = function (min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; };
  var dateKey = function () {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  var storage = function (k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k));
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return v === undefined ? null : undefined; }
  };

  if (!window.API_BASE) {
    try { window.API_BASE = 'https://recipeverse-backend.khaleely572.workers.dev'; } catch (e) {}
  }

  var TOTAL_SLOTS = 60000;
  var user = storage("rv_user") || null;
  var state = { fridgeItems: null, subscribed: false, balance: 0 };

  /* ---------------- AI budget + throttle ---------------- */
  var aiLogKey = "rv_ai_log";
  function aiToday() {
    var t = null;
    try { t = JSON.parse(localStorage.getItem(aiLogKey)); } catch (e) {}
    if (!t || t.d !== dateKey()) t = { d: dateKey(), c: 0 };
    return t;
  }
  function aiLimit() { return (window.AI_DAILY_LIMIT && window.AI_DAILY_LIMIT > 0) ? window.AI_DAILY_LIMIT : 40; }
  function aiBudgetOk() { return aiToday().c < aiLimit(); }
  function aiRecord() {
    var t = aiToday();
    t.c++;
    try { localStorage.setItem(aiLogKey, JSON.stringify(t)); } catch (e) {}
    renderAiMeter();
  }
  function renderCredits(info) {
    var badge = $("credits-badge");
    var foot = $("ai-meter");
    if (!info) {
      if (badge) badge.classList.add("hidden");
      if (foot) foot.textContent = "";
      return;
    }
    state.subscribed = !!info.subscribed;
    state.balance = info.balance || 0;
    var proBtn = $("pro-btn");
    if (proBtn) proBtn.textContent = state.subscribed ? "Pro on" : "Go Pro";
    if (badge) {
      badge.classList.remove("hidden");
      badge.textContent = (state.subscribed ? "Pro - " : "Credits: ") + info.credits;
      badge.classList.toggle("zero", info.credits <= 0);
    }
    if (foot) foot.textContent = (state.subscribed ? "Pro member - " : "Your credits: ") + info.credits;
  }
  function renderAiMeter() {
    if (!window.API_BASE) {
      var el = $("ai-meter");
      if (el) el.textContent = "Free AI calls used today: " + aiToday().c + " / " + aiLimit() + " (resets at midnight)";
      return;
    }
    var id = getUid();
    if (!id) { renderCredits(null); return; }
    fetch(window.API_BASE + "/api/me", { headers: { "x-user-id": id } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) {
          try { localStorage.removeItem(uidKey); } catch (e) {}
          registerUser().catch(function () {});
          return;
        }
        renderCredits({ credits: d.credits || 0, poolLeft: d.poolLeft || 0, subscribed: !!d.subscribed, balance: d.balance || 0 });
      })
      .catch(function () {});
  }
  var aiChain = Promise.resolve();
  var aiLast = 0;
  function throttled(fn) {
    var p = aiChain.then(function () {
      var gap = state.subscribed ? (window.AI_MIN_GAP_SUB_MS || 1200) : (window.AI_MIN_GAP_MS || 5000);
      var wait = gap - (Date.now() - aiLast);
      if (wait > 0) return new Promise(function (r) { setTimeout(r, wait); });
    }).then(fn).then(function (v) { aiLast = Date.now(); return v; });
    aiChain = p.then(function () {}, function () { aiLast = Date.now(); });
    return p;
  }

  /* ---------------- backend account + credits ---------------- */
  var uidKey = "rv_uid";
  function getUid() {
    try { return localStorage.getItem(uidKey) || ""; } catch (e) { return ""; }
  }
  function setUid(id) {
    try { localStorage.setItem(uidKey, id); } catch (e) {}
  }
  function registerUser() {
    return fetch(window.API_BASE + "/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: user ? user.name : "Guest" })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.userId) setUid(d.userId);
      renderAiMeter();
      return d;
    });
  }
  function ensureUid() {
    var id = getUid();
    return id ? Promise.resolve(id) : registerUser().then(function (d) { return d && d.userId; });
  }

  /* ---------------- theme ---------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("rv_theme", t); } catch (e) {}
    var dark = t === "dark";
    $("icon-sun").style.display = dark ? "none" : "block";
    $("icon-moon").style.display = dark ? "block" : "none";
  }
  var savedTheme = null;
  try { savedTheme = localStorage.getItem("rv_theme"); } catch (e) {}
  applyTheme(savedTheme || "light");
  $("theme-toggle").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
  });

  /* ---------------- nav ---------------- */
  function switchView(name) {
    $$(".view").forEach(function (v) { v.classList.add("hidden"); });
    $("view-" + name).classList.remove("hidden");
    $$(".nav-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.view === name); });
    $("main-nav").classList.remove("open");
    var tg = $("nav-toggle");
    if (tg) tg.setAttribute("aria-expanded", "false");
    window.scrollTo(0, 0);
  }
  $("nav-toggle").addEventListener("click", function () {
    var nav = $("main-nav");
    var open = nav.classList.toggle("open");
    this.setAttribute("aria-expanded", open ? "true" : "false");
  });
  $$(".nav-btn").forEach(function (b) {
    b.addEventListener("click", function () { switchView(b.dataset.view); });
  });
  $$(".tile").forEach(function (t) {
    t.addEventListener("click", function () { switchView(t.dataset.go); });
  });

  /* ---------------- toast ---------------- */
  function toast(msg, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.add("hidden"); }, ms || 3800);
  }

  /* ---------------- selects ---------------- */
  function fillSelect(el, pick) {
    var countries = window.COUNTRIES || window.FALLBACK_COUNTRIES || [];
    el.innerHTML = "";
    countries.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      if (c === pick) o.selected = true;
      el.appendChild(o);
    });
  }
  function ensureSelects() {
    fillSelect($("auth-country"), user ? user.country : "");
    fillSelect($("rotw-country"), user ? user.country : "");
    fillSelect($("profile-country"), user ? user.country : "");
    var gc = $("gen-country");
    gc.innerHTML = "";
    var o = document.createElement("option");
    o.value = "";
    o.textContent = "Surprise me (worldwide)";
    gc.appendChild(o);
    (window.COUNTRIES || window.FALLBACK_COUNTRIES || []).forEach(function (c) {
      var op = document.createElement("option");
      op.value = c;
      op.textContent = c;
      gc.appendChild(op);
    });
    gc.value = "";
  }

  /* ---------------- auth ---------------- */
  function renderUser() {
    var first = ((user && user.name) || "").trim().split(/\s+/)[0] || "";
    $("user-chip").textContent = user ? "Welcome, " + first + " - " + user.country : "";
    $("greet").textContent = user ? "Hello, " + first + "!" : "";
  }
  function finishLogin() {
    $("auth-overlay").classList.add("hidden");
    ensureSelects();
    renderUser();
    updateRotw();
    switchView("home");
  }
  $("auth-submit").addEventListener("click", function () {
    var name = $("auth-name").value.trim();
    if (!name) { toast("Please tell us your name."); return; }
    user = { name: name, country: $("auth-country").value || "United States" };
    storage("rv_user", user);
    finishLogin();
  });
  $("auth-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("auth-submit").click();
  });
  $("profile-btn").addEventListener("click", function () {
    $("profile-name").value = user ? user.name : "";
    $("profile-country").value = user ? user.country : "";
    $("profile-modal").classList.remove("hidden");
  });
  $("profile-close").addEventListener("click", function () { $("profile-modal").classList.add("hidden"); });
  $("profile-save").addEventListener("click", function () {
    var name = $("profile-name").value.trim();
    if (!name) { toast("Name cannot be empty."); return; }
    user = { name: name, country: $("profile-country").value || "United States" };
    storage("rv_user", user);
    $("profile-modal").classList.add("hidden");
    ensureSelects();
    renderUser();
    updateRotw();
    toast("Profile updated.");
  });
  $("profile-logout").addEventListener("click", function () {
    try { localStorage.removeItem("rv_user"); } catch (e) {}
    location.reload();
  });

  /* ---------------- pro subscription ---------------- */
  function proSync() {
    var subBtn = $("pro-subscribe");
    var goBtn = $("pro-go-paypal");
    var manageBtn = $("pro-manage");
    var status = $("pro-status");
    if (state.subscribed) {
      subBtn.classList.add("hidden");
      goBtn.classList.add("hidden");
      manageBtn.classList.remove("hidden");
      status.textContent = "Pro credits in your balance: " + state.balance + ". 1,000 are added each month.";
    } else {
      subBtn.classList.remove("hidden");
      goBtn.classList.add("hidden");
      manageBtn.classList.add("hidden");
      status.textContent = "";
    }
  }
  $("pro-btn").addEventListener("click", function () {
    proSync();
    $("pro-modal").classList.remove("hidden");
  });
  $("pro-close").addEventListener("click", function () {
    $("pro-modal").classList.add("hidden");
    $("pro-go-paypal").classList.add("hidden");
    $("pro-subscribe").classList.remove("hidden");
    $("pro-status").textContent = "";
  });
  $("pro-subscribe").addEventListener("click", function () {
    var status = $("pro-status");
    status.textContent = "Contacting PayPal...";
    ensureUid().then(function (uid) {
      if (!uid) throw new Error("Could not create your credit account first.");
      var here = window.location.origin + window.location.pathname;
      return fetch(window.API_BASE + "/api/pay/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: uid, returnUrl: here, cancelUrl: here })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || d.ok !== true) throw new Error((d && d.error) || "PayPal setup failed.");
        $("pro-go-paypal").dataset.approveUrl = d.approveUrl;
        $("pro-go-paypal").dataset.subId = d.id || "";
        $("pro-subscribe").classList.add("hidden");
        $("pro-go-paypal").classList.remove("hidden");
        status.textContent = "Your PayPal checkout is ready below.";
      });
    }).catch(function (e) {
      status.textContent = (e && e.message) || "Could not reach PayPal setup.";
    });
  });
  $("pro-go-paypal").addEventListener("click", function () {
    var url = this.dataset.approveUrl;
    if (!url) return;
    var status = $("pro-status");
    status.textContent = "Waiting for PayPal...";
    window.open(url, "_blank", "noopener,width=520,height=640");
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var uid = getUid();
      if (!uid) { clearInterval(timer); return; }
      var subId = $("pro-go-paypal").dataset.subId || "";
      fetch(window.API_BASE + "/api/pay/status?subId=" + encodeURIComponent(subId), { headers: { "x-user-id": uid } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok && d.subscribed) {
            clearInterval(timer);
            renderAiMeter();
            proSync();
            closeModal();
            toast("Welcome to Pro! 1,000 credits added.");
          } else if (d && d.ok && d.pending) {
            var msg = "PayPal status: " + d.pending + ". ";
            if (d.pending === "APPROVAL_PENDING") {
              status.textContent = msg + "Finish the approval in the PayPal window and try again in a minute.";
            } else if (d.pending === "APPROVED") {
              status.textContent = msg + "First payment is processing - credits arrive in a minute or two.";
            } else {
              status.textContent = msg + "Waiting...";
            }
          } else if (tries > 80) {
            clearInterval(timer);
            status.textContent = "Still nothing. If PayPal shows an error, tell us the exact message.";
          }
        })
        .catch(function () {});
    }, 3000);
  });
  $("pro-manage").addEventListener("click", function () {
    window.open("https://www.paypal.com/myaccount/autopay/", "_blank", "noopener");
  });

  /* ---------------- Gemini ---------------- */
  function fileToData(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        var m = r.result;
        var i = m.indexOf(",");
        res({ mime: m.slice(5, i), data: m.slice(i + 1) });
      };
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  function extractJSON(text) {
    var t = (text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    var start = -1;
    for (var i = 0; i < t.length; i++) {
      if (t[i] === "{" || t[i] === "[") { start = i; break; }
    }
    if (start === -1) {
      try { return JSON.parse(t); } catch (e) { throw new Error("Could not parse the AI response."); }
    }
    var depth = 0, inStr = false, esc = false;
    for (var j = start; j < t.length; j++) {
      var c = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, j + 1)); } catch (e) { break; }
        }
      }
    }
    throw new Error("Could not parse the AI response.");
  }

  function gemini(key, system, userParts) {
    if (window.API_BASE) {
      return throttled(function () { return backendGemini(key, system, userParts); });
    }
    if (!key) {
      return Promise.reject(new Error("AI service isn't configured for this build yet. Please refresh the page and try again."));
    }
    if (!aiBudgetOk()) {
      return Promise.reject(new Error("You've used up today's free AI budget in this browser - it resets at midnight. Any recipes you already generated are still cached and viewable."));
    }
    aiRecord();
    return throttled(function () { return attemptModels(key, system, userParts); });
  }
  function backendGemini(key, system, userParts) {
    return ensureUid().then(function (uid) {
      if (!uid) throw new Error("Could not create your credit account. Is the backend running?");
      var body = {
        contents: [{ role: "user", parts: [{ text: system }].concat(userParts || []) }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
      };
      return fetch(window.API_BASE + "/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: uid, body: body })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!data || data.ok !== true) {
            throw new Error((data && data.error) || ("Backend error (HTTP " + res.status + ")."));
          }
          renderAiMeterFrom({ credits: data.remaining, poolLeft: data.poolLeft, subscribed: !!data.subscribed, balance: 0 });
          return extractJSON(data.text);
        });
      });
    });
  }
  function renderAiMeterFrom(info) {
    renderCredits(info);
  }
  function attemptModels(key, system, userParts) {
    var models = (window.GEMINI_MODELS && window.GEMINI_MODELS.length) ? window.GEMINI_MODELS : ([window.GEMINI_MODEL] || []);
    var idx = 0;
    function attempt() {
      if (idx >= models.length) {
        return Promise.reject(new Error("The AI service didn't respond. Please try again in a moment."));
      }
      var model = models[idx++];
      var body = {
        contents: [{ role: "user", parts: [{ text: system }].concat(userParts || []) }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
      };
      var url = window.GEMINI_ENDPOINT + "/" + model + ":generateContent?key=" + encodeURIComponent(key);
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 429) {
            throw new Error("The AI is momentarily at capacity (rate limit). Please wait a few seconds and try again.");
          }
          if (!res.ok) {
            var e = new Error((data && data.error && data.error.message) || ("HTTP " + res.status));
            e.retry = true;
            throw e;
          }
          var parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
          var txt = parts.map(function (p) { return p.text || ""; }).join("");
          if (!txt) { var em = new Error("The AI returned an empty result."); em.retry = true; throw em; }
          var cleaned = txt.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
          try { return extractJSON(cleaned); }
          catch (e) { throw new Error("Could not parse the AI response."); }
        });
      }).catch(function (err) {
        if (err && err.message && err.message.indexOf("Failed to fetch") !== -1) {
          err.retry = true;
          err.message = "Network error: could not reach the AI service.";
        }
        if (err && err.retry) return attempt();
        throw err;
      });
    }
    return attempt();
  }
  function visionParts(d) { return [{ inline_data: { mime_type: d.mime, data: d.data } }]; }

  var LOAD_QUOTES = {
    cal: [
      "Counting calories one pixel at a time...",
      "Asking a ghost nutritionist for a second opinion...",
      "The plate is being judged by a very opinionated AI...",
      "Measuring the mystery leftovers...",
      "The scale is trembling with anticipation...",
      "Bribing the AI with a salad to be nice..."
    ],
    fridge: [
      "Opening the fridge door... (the AI is feeling chilly)",
      "Bribing the AI with a carrot...",
      "That container from last week is under review...",
      "Counting eggs that may or may not exist...",
      "The crisper drawer is being interrogated...",
      "Spotting forgotten leftovers in the back row...",
      "The AI is 3 shelves deep and loving it..."
    ],
    rotw: [
      "Consulting the world's best chefs...",
      "Spinning the globe very, very fast...",
      "Asking every grandmother for her secret recipe...",
      "Choosing between 195 countries' cuisines...",
      "The daily special is being decided by AI committee...",
      "Bribing the chef with a fresh baguette...",
      "Checking what the rest of the world is eating..."
    ],
    gen: [
      "Browsing 60,000 recipes...",
      "The AI is reading a cookbook the size of a house...",
      "Pulling the slot-machine lever...",
      "Consulting the culinary oracle...",
      "Sifting through cuisines from A to Z...",
      "Chef AI is warming up its imaginary oven...",
      "Deciding between classic and 'why not'...",
      "The recipe gremlins are on a coffee break..."
    ]
  };

  function startLoader(id, quotes, seconds) {
    var line = $(id);
    var fill = line ? line.querySelector(".loading-fill") : null;
    var label = line ? line.querySelector(".loading-label") : null;
    if (line) line.classList.remove("hidden");
    if (fill) fill.style.width = "0%";
    if (label && quotes && quotes.length) label.textContent = quotes[0];
    var started = Date.now();
    var dur = Math.max(4, seconds || 10) * 1000;
    var qi = 0;
    var qTimer = (quotes && quotes.length > 1) ? setInterval(function () {
      qi = (qi + 1) % quotes.length;
      if (label) label.textContent = quotes[qi];
    }, 2600) : null;
    var fillTimer = setInterval(function () {
      var t = Math.min(1, (Date.now() - started) / dur);
      var eased = 1 - Math.pow(1 - t, 2.6);
      if (fill) fill.style.width = Math.round(eased * 100) + "%";
    }, 120);
    return {
      done: function () {
        clearInterval(qTimer);
        clearInterval(fillTimer);
        if (fill) fill.style.width = "100%";
        setTimeout(function () { if (line) line.classList.add("hidden"); }, 400);
      }
    };
  }
  function errBox(msg) { return '<div class="state">' + esc(msg) + "</div>"; }

  /* ---------------- prompts ---------------- */
  var CAL_SYS = [
    "You are a nutrition expert.",
    "Identify the food shown in the photo or described in the text and give an honest, realistic calorie and macro estimate for a standard serving.",
    'Return JSON: { "items": [ { "name", "serving", "calories_kcal", "protein_g", "carbs_g", "fat_g" } ], "total_kcal", "tip" }.',
    "Use realistic values; when unsure, give a sensible midpoint. Keep names short."
  ].join(" ");

  var FRIDGE_ID_SYS = [
    "You are an expert at inspecting kitchen refrigerators.",
    "Carefully analyze every photo. Look at every shelf, drawer, door bin, jar and container.",
    "Identify EVERY food item you can see, including partially hidden or back-row items. Be thorough.",
    'Return JSON: { "items": [ { "name", "quantity", "condition", "category" } ], "summary" }.',
    'The "summary" field is a short paragraph describing what is in the fridge. If the image is not a fridge or is unclear, say so in "summary" and return an empty "items" array.'
  ].join(" ");

  var FRIDGE_RECIPES_SYS = [
    "You are a professional chef.",
    "The fridge contains ONLY these items (listed below). You may also use common pantry staples: salt, pepper, olive oil, butter, flour, sugar, eggs, garlic, onion, rice, pasta, bread.",
    "Create exactly 3 REAL, well-known recipes that primarily use the fridge items.",
    "Every recipe must have genuine ingredients with quantities and genuinely executable steps, including oven temperature or burner timing where relevant.",
    'Return JSON: { "recipes": [ { "name", "country", "servings", "cook_time_minutes", "difficulty", "description", "ingredients", "steps" } ] }',
    '"ingredients" is an array of strings with quantities. "steps" is an ordered array of instruction strings. Never invent fake steps - only real cooking methods.'
  ].join(" ");

  var GEN_DISCOVER_SYS = [
    "You are a catalog of the world's cuisines.",
    "Given a slot number and optional hints (a country and a keyword), choose ONE real, authentic, iconic dish.",
    "If a country is given, the dish MUST be a genuinely iconic dish of that country.",
    "If a keyword is given, the dish MUST match it exactly - for example the keyword 'cookies' must yield a famous cookie recipe, 'pizza' a real pizza, 'soft cookies' a well-known soft, chewy cookie.",
    "If no hints are given, pick from anywhere on Earth - any country, any cuisine.",
    "Let the slot number pick different countries and dishes so consecutive slots hop across the world.",
    'Return JSON: { "dish", "country" } with the dish name short and its true cuisine/country.'
  ].join(" ");

var GEN_AUTHOR_SYS = [
    "You are a professional chef authoring a real, authentic recipe.",
    "Write the complete recipe for the named dish from its true cuisine, wherever in the world that may be.",
    "It MUST be a real, recognizable dish with genuine ingredients and realistic, executable steps.",
    "Include oven/burner temperatures and timings, and exact-ish quantities.",
    "For baked goods (cookies, cakes, breads), use the famously reliable techniques that guarantee the classic result - for example soft, chewy cookies come from melted butter, an extra egg yolk and chilled dough.",
    'Return JSON: { "name", "country", "servings", "cook_time_minutes", "difficulty", "description", "ingredients", "steps" }.',
    '"ingredients" is an array of strings with quantities. "steps" is an ordered array of instruction strings. Never invent fake steps or fantasy ingredients.'
  ].join(" ");

  var ROTW_SYS = function (country, date) {
    return [
      "You are a chef who selects the Recipe of the Day.",
      "Today's date is " + date + ".",
      "Give ONE real, authentic recipe from the traditional cuisine of " + country + ".",
      "Pick a different famous dish from this cuisine each calendar day (use the date to vary your choice).",
      'Return JSON: { "name", "country", "servings", "cook_time_minutes", "difficulty", "description", "ingredients", "steps" }.',
      "Real ingredients with quantities, real steps with oven/burner temperatures. Never invent fake recipes."
    ].join(" ");
  };

  var RATE_SYS = [
    "You are a professional food critic and plating judge.",
    "Assess the photo of the finished dish for appearance, plating, doneness and effort.",
    'Return JSON: { "score", "verdict", "positives", "improvements", "summary" }.',
    '"score" is a number from 1 to 10. "verdict" is one short phrase. "positives" and "improvements" are arrays of 2-4 short strings each.'
  ].join(" ");

  /* ---------------- recipe rendering ---------------- */
  function recipeMeta(r) {
    var bits = [];
    if (r.country) bits.push(r.country);
    if (r.servings) bits.push("Serves " + r.servings);
    if (r.cook_time_minutes) bits.push(r.cook_time_minutes + " min");
    if (r.difficulty) bits.push(r.difficulty);
    return bits.join(" - ");
  }
  var recipeStore = [];
  var recipeSeq = 0;
  function recipeCardHtml(r, label) {
    var idx = ++recipeSeq;
    recipeStore[idx] = r;
    return (
      '<div class="card recipe-mini">' +
      '<h3>' + esc(r.name || "Recipe") + "</h3>" +
      '<div class="meta">' + esc(recipeMeta(r) || "") + (label ? " - " + esc(label) : "") + "</div>" +
      "<p>" + esc(r.description || "A real, cookable recipe.") + "</p>" +
      '<button class="btn small open-recipe" data-idx="' + idx + '">View &amp; Cook</button>' +
      "</div>"
    );
  }
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".open-recipe") : null;
    if (!btn) return;
    var recipe = recipeStore[Number(btn.getAttribute("data-idx")) || 0];
    if (recipe) openRecipeModal(recipe);
  });
  function openRecipeModal(recipe) {
    state.currentRecipe = recipe;
    var b = $("modal-body");
    var ing = (recipe.ingredients || []).map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("");
    var steps = (recipe.steps || []).map(function (s, idx) { return "<li>" + esc(s) + "</li>"; }).join("");
    b.innerHTML =
      '<div class="meta-line">' + esc(recipeMeta(recipe) || "") + "</div>" +
      "<h2>" + esc(recipe.name || "Recipe") + "</h2>" +
      '<p class="muted">' + esc(recipe.description || "") + "</p>" +
      "<h4>Ingredients</h4><ul>" + (ing || "<li class='muted'>None listed.</li>") + "</ul>" +
      "<h4>Instructions</h4><ol>" + (steps || "<li class='muted'>None listed.</li>") + "</ol>" +
      '<div class="cooked-zone">' +
      '<button id="btn-cooked" class="btn block">Done - I cooked this</button>' +
      '<div id="rate-zone" class="hidden">' +
      '<p class="muted">Nice work! Take a picture of your finished dish for a rating.</p>' +
      '<input id="rate-img" type="file" accept="image/*" capture="environment" />' +
      '<button id="btn-rate" class="btn block" disabled>Rate my dish</button>' +
      '<div id="rate-result"></div>' +
      "</div></div>";
    $("recipe-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    $("btn-cooked").addEventListener("click", function () {
      $("btn-cooked").classList.add("hidden");
      $("rate-zone").classList.remove("hidden");
    });
    var fi = $("rate-img");
    fi.addEventListener("change", function () { $("btn-rate").disabled = !fi.files.length; });
    $("btn-rate").addEventListener("click", function () {
      if (!fi.files[0]) { toast("Add a photo first."); return; }
      rateDish(fi.files[0], $("rate-result"));
    });
  }
  function closeModal() {
    $("recipe-modal").classList.add("hidden");
    $("profile-modal").classList.add("hidden");
    document.body.style.overflow = "";
  }
  $("modal-close").addEventListener("click", closeModal);
  $("recipe-modal").addEventListener("click", function (e) { if (e.target === $("recipe-modal")) closeModal(); });
  $("profile-modal").addEventListener("click", function (e) { if (e.target === $("profile-modal")) $("profile-modal").classList.add("hidden"); });

  function rateDish(file, box) {
    box.innerHTML = '<div class="state">Your dish is being judged...</div>';
    fileToData(file).then(function (d) {
      return gemini(window.KEY_RECIPES, RATE_SYS, [{ text: "Rate this finished dish." }].concat(visionParts(d)));
    }).then(function (out) {
      var score = Number(out.score);
      var color = score >= 8 ? "Excellent" : score >= 6 ? "Good" : score >= 4 ? "Okay" : "Keep practicing";
      box.innerHTML =
        '<div class="rating-line"><span class="score-big">' + (isNaN(score) ? "?" : score) + '/10</span>' +
        "<span>" + esc(out.verdict || color) + "</span></div>" +
        (out.summary ? "<p class='muted'>" + esc(out.summary) + "</p>" : "") +
        (out.positives && out.positives.length ? "<h4>What worked</h4><ul>" + out.positives.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>" : "") +
        (out.improvements && out.improvements.length ? "<h4>Next time</h4><ul>" + out.improvements.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>" : "");
    }).catch(function (e) { box.innerHTML = errBox(e.message); });
  }

  /* ---------------- recipe of the day ---------------- */
  var rotwInflight = null;
  function updateRotw() {
    if (!user) return;
    var country = $("rotw-country").value || (user ? user.country : "United States");
    var key = "rv_rotw_" + country + "_" + dateKey();
    var cached = storage(key);
    $("rotw-card").classList.add("hidden");
    if (cached) { renderRotw(cached); return; }
    if (rotwInflight && rotwInflight.key === key) return;
    $("rotw-note").textContent = "Fresh recipe every day at midnight for " + country + ".";
    var load = startLoader("rotw-loading", LOAD_QUOTES.rotw, 12);
    rotwInflight = { key: key, load: load };
    gemini(window.KEY_RECIPES, ROTW_SYS(country, dateKey()), []).then(function (r) {
      storage(key, r);
      renderRotw(r);
    }).catch(function (e) {
      $("rotw-card").innerHTML = errBox(e.message);
      $("rotw-card").classList.remove("hidden");
    }).finally(function () {
      if (rotwInflight && rotwInflight.key === key) {
        rotwInflight.load.done();
        rotwInflight = null;
      }
    });
  }
  function renderRotw(r) {
    $("rotw-card").innerHTML = recipeCardHtml(r, "Today's pick");
    $("rotw-card").classList.remove("hidden");
  }
  $("rotw-refresh").addEventListener("click", function () {
    var key = "rv_rotw_" + $("rotw-country").value + "_" + dateKey();
    try { localStorage.removeItem(key); } catch (e) {}
    updateRotw();
  });
  $("rotw-country").addEventListener("change", updateRotw);

  function scheduleMidnight() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
    setTimeout(function () { updateRotw(); scheduleMidnight(); }, next - now);
  }
  scheduleMidnight();
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) updateRotw();
  });

  /* ---------------- calorie scanner ---------------- */
  function renderCalorie(out) {
    var items = (out.items || []).map(function (it) {
      return (
        '<div class="result-item"><h4>' + esc(it.name) + "</h4>" +
        '<div class="muted tiny">' + esc(it.serving || "") + "</div>" +
        '<div class="nums">' +
        "<span>Calories <b>" + esc(it.calories_kcal) + " kcal</b></span>" +
        "<span>Protein <b>" + esc(it.protein_g) + " g</b></span>" +
        "<span>Carbs <b>" + esc(it.carbs_g) + " g</b></span>" +
        "<span>Fat <b>" + esc(it.fat_g) + " g</b></span>" +
        "</div></div>"
      );
    }).join("");
    var total = out.total_kcal ? '<div class="big-total">Total approx. ' + esc(out.total_kcal) + " kcal</div>" : "";
    var tip = out.tip ? '<div class="tip-box">' + esc(out.tip) + "</div>" : "";
    $("cal-result").innerHTML = items + total + tip;
  }
  $("cal-scan").addEventListener("click", function () {
    var img = $("cal-img").files[0];
    var text = $("cal-text").value.trim();
    if (!img && !text) { toast("Add a photo or type a food first."); return; }
    var load = startLoader("cal-loading", LOAD_QUOTES.cal, 9);
    $("cal-empty").classList.add("hidden");
    $("cal-result").innerHTML = "";
    var parts = [];
    if (text) parts.push({ text: "Food described: " + text });
    var call = img
      ? fileToData(img).then(function (d) { return gemini(window.KEY_CALORIES, CAL_SYS, parts.concat(visionParts(d))); })
      : gemini(window.KEY_CALORIES, CAL_SYS, parts);
    call.then(function (out) { renderCalorie(out); })
      .catch(function (e) { $("cal-result").innerHTML = errBox(e.message); })
      .then(function () { load.done(); });
  });
  $("cal-img").addEventListener("change", function () {
    var f = $("cal-img").files[0];
    if (!f) return;
    $("cal-preview").classList.remove("hidden");
    $("cal-preview").innerHTML = "";
    var img = document.createElement("img");
    img.src = URL.createObjectURL(f);
    $("cal-preview").appendChild(img);
  });

  /* ---------------- fridge scanner ---------------- */
  $("fridge-img").addEventListener("change", function () {
    var files = $("fridge-img").files;
    $("fridge-preview").innerHTML = "";
    Array.prototype.forEach.call(files, function (f) {
      var img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      $("fridge-preview").appendChild(img);
    });
  });
  $("fridge-scan").addEventListener("click", function () {
    var files = $("fridge-img").files;
    if (!files.length) { toast("Add at least one photo of your fridge."); return; }
    var load = startLoader("fridge-loading", LOAD_QUOTES.fridge, 12);
    $("fridge-items").classList.add("hidden");
    $("fridge-recipes-wrap").classList.add("hidden");
    $("fridge-recipes").disabled = true;
    var tasks = [];
    Array.prototype.forEach.call(files, function (f) { tasks.push(fileToData(f)); });
    Promise.all(tasks).then(function (ds) {
      var parts = [{ text: "Fridge photos attached: " + ds.length + "." }];
      ds.forEach(function (d) { parts = parts.concat(visionParts(d)); });
      return gemini(window.KEY_FRIDGE, FRIDGE_ID_SYS, parts);
    }).then(function (out) {
      load.done();
      state.fridgeItems = out.items || [];
      renderFridgeItems(out);
      if (state.fridgeItems.length) {
        $("fridge-recipes").disabled = false;
        toast("Found " + state.fridgeItems.length + " items in your fridge.");
      } else {
        $("fridge-note").textContent = out.summary || "No items detected.";
        toast("No items detected - try clearer photos.");
      }
    }).catch(function (e) {
      load.done();
      $("fridge-items").classList.remove("hidden");
      $("fridge-items-list").innerHTML = "";
      $("fridge-note").textContent = e.message;
    });
  });
  function renderFridgeItems(out) {
    $("fridge-items").classList.remove("hidden");
    $("fridge-items-list").innerHTML = (out.items || []).map(function (it) {
      var extra = [];
      if (it.quantity) extra.push(it.quantity);
      if (it.condition) extra.push(it.condition);
      return '<span class="chip">' + esc(it.name) + (extra.length ? " - " + esc(extra.join(", ")) : "") + "</span>";
    }).join("");
    $("fridge-note").textContent = out.summary || "";
  }
  $("fridge-recipes").addEventListener("click", function () {
    if (!state.fridgeItems || !state.fridgeItems.length) { toast("Scan the fridge first."); return; }
    var load = startLoader("fridge-loading", LOAD_QUOTES.fridge, 12);
    $("fridge-recipes-wrap").classList.add("hidden");
    var itemNames = state.fridgeItems.map(function (it) {
      return it.name + (it.quantity ? " (" + it.quantity + ")" : "");
    }).join(", ");
    gemini(window.KEY_RECIPES, FRIDGE_RECIPES_SYS, [{ text: "Fridge items: " + itemNames }])
      .then(function (out) {
        load.done();
        var recipes = out.recipes || [];
        var list = $("fridge-recipes-list");
        list.innerHTML = recipes.map(function (r) { return recipeCardHtml(r, "from your fridge"); }).join("");
        $("fridge-recipes-wrap").classList.remove("hidden");
        if (!recipes.length) toast("No recipes returned.");
      })
      .catch(function (e) {
        load.done();
        toast(e.message);
      });
  });

  /* ---------------- generator (60,000 catalog) ---------------- */
  function slotLabel() {
    var s = Math.min(TOTAL_SLOTS, Math.max(1, parseInt($("gen-slot").value, 10) || 1));
    return s.toLocaleString("en-US") + " / " + TOTAL_SLOTS.toLocaleString("en-US");
  }
  function genMeta() {
    var country = $("gen-country").value || "Worldwide surprise";
    $("gen-meta").textContent = "Recipe #" + slotLabel() +
      " - " + country + " - cached locally, nothing stored on a server.";
  }
  function setSlot(v) {
    $("gen-slot").value = Math.min(TOTAL_SLOTS, Math.max(1, v));
    genMeta();
  }
  $("gen-random").addEventListener("click", function () { setSlot(randInt(1, TOTAL_SLOTS)); });
  $("gen-next").addEventListener("click", function () { setSlot((parseInt($("gen-slot").value, 10) || 1) + 1); });
  $("gen-prev").addEventListener("click", function () { setSlot((parseInt($("gen-slot").value, 10) || 1) - 1); });
  $("gen-slot").addEventListener("change", function () { setSlot(parseInt($("gen-slot").value, 10) || 1); });
  $("gen-country").addEventListener("change", genMeta);

  function genCacheKey() {
    return "rv_gen_" + (parseInt($("gen-slot").value, 10) || 1) + "_" +
      ($("gen-word").value.trim() || "any") + "_" + ($("gen-country").value || "any");
  }

$("gen-go").addEventListener("click", function () {
    var slot = parseInt($("gen-slot").value, 10) || 1;
    var keyword = $("gen-word").value.trim();
    var country = $("gen-country").value;
    var key = genCacheKey();
    var cached = storage(key);
    if (cached) { renderGen(cached, key); return; }
    var load = startLoader("gen-loading", LOAD_QUOTES.gen, 20);
    $("gen-result").innerHTML = "";
    var hint = "Slot: " + slot + ".";
    if (country) hint += " Pick a dish that is an iconic dish of " + country + ".";
    if (keyword) hint += " The dish MUST match this keyword: '" + keyword + "'.";
    gemini(window.KEY_GENERAL, GEN_DISCOVER_SYS, [{ text: hint }])
      .then(function (d) {
        var dish = (d.dish || "").trim();
        if (!dish) throw new Error("Could not pick a dish.");
        var cty = (d.country || "").trim();
        return gemini(window.KEY_RECIPES, GEN_AUTHOR_SYS, [{ text: "Dish to author: " + dish + (cty ? " (true cuisine: " + cty + ")" : "") + "." }]);
      })
      .then(function (recipe) {
        load.done();
        storage(key, recipe);
        renderGen(recipe, key);
      })
      .catch(function (e) {
        load.done();
        $("gen-result").innerHTML = errBox(e.message);
      });
  });
  function renderGen(recipe, key) {
    var list = $("gen-result");
    list.innerHTML = recipeCardHtml(recipe, "Recipe #" + slotLabel());
    genMeta();
  }

  /* ---------------- init ---------------- */
  ensureSelects();
  genMeta();
  if (window.API_BASE && !getUid()) {
    registerUser().catch(function () {});
  } else {
    renderAiMeter();
  }
  if (window.API_BASE) {
    setInterval(function () { if (!document.hidden) renderAiMeter(); }, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) renderAiMeter(); });
  }
  if (user) { finishLogin(); } else {
    $("auth-overlay").classList.remove("hidden");
  }
  if (user) switchView("home");
})();
