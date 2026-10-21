/**
 * Publisher credit ledger for @hk-judge/transit-engine.
 *
 * Demo store: JSON file under HK_JUDGE_DATA_DIR, keyed by SHA-256 of the API
 * key. Balances never store the raw key. Production should use a real
 * database and grant credits from a verified Stripe webhook.
 *
 * This module meters publisher credits per successful tool call. It does not
 * read or bill Claude, Cursor, or any other client model tokens.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_SUCCESS_URL =
  "https://igoaltrading.com/?credits=success&session_id={CHECKOUT_SESSION_ID}";
const DEFAULT_CANCEL_URL = "https://igoaltrading.com/?credits=cancel";
const SESSION_ID_RE = /^cs_[A-Za-z0-9_]+$/;
const PRICE_ID_RE = /^price_[A-Za-z0-9_]+$/;

export function hashApiKey(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function billingError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function parseNonNegInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function parseCredits(value) {
  let credits = value;
  if (typeof credits === "string" && credits.trim() !== "") {
    const asNumber = Number(credits.trim());
    if (Number.isInteger(asNumber)) credits = asNumber;
  }
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits < 0) {
    throw new Error("Seed credits must be a non-negative integer.");
  }
  return credits;
}

/**
 * @param {string} raw JSON object, or comma-separated key:credits / key=credits pairs.
 * @returns {{ key: string, credits: number }[]}
 */
export function parseKeySeed(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Key seed JSON could not be parsed.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Key seed JSON must be an object of key to credits.");
    }
    const useNestedKeys =
      parsed.keys &&
      typeof parsed.keys === "object" &&
      !Array.isArray(parsed.keys) &&
      Object.keys(parsed).length === 1;
    const map = useNestedKeys ? parsed.keys : parsed;
    return Object.entries(map).map(([key, credits]) => {
      const trimmed = String(key).trim();
      if (!trimmed) throw new Error("Key seed entries need a non-empty API key.");
      return { key: trimmed, credits: parseCredits(credits) };
    });
  }
  const seeds = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const match = entry.match(/^(.*):(\d+)$/) || entry.match(/^(.*)=(\d+)$/);
    if (!match || !match[1].trim()) {
      throw new Error(
        "HK_JUDGE_API_KEYS entries must be key:credits (credits are a non-negative integer)."
      );
    }
    seeds.push({ key: match[1].trim(), credits: Number(match[2]) });
  }
  return seeds;
}

function readKeySeedsFromFile(keysFile) {
  let raw;
  try {
    raw = readFileSync(keysFile, "utf8");
  } catch {
    throw billingError(
      "keys_file_invalid",
      "HK_JUDGE_KEYS_FILE could not be read. Check the path and permissions."
    );
  }
  try {
    return parseKeySeed(raw);
  } catch {
    throw billingError(
      "keys_file_invalid",
      'HK_JUDGE_KEYS_FILE must be JSON {"your-api-key": 100} or comma-separated key:credits pairs.'
    );
  }
}

/**
 * Read billing settings from the environment (or a test env object) at call time.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const keysFile = env.HK_JUDGE_KEYS_FILE || "";
  let envSeeds = [];
  if (env.HK_JUDGE_API_KEYS) {
    try {
      envSeeds = parseKeySeed(env.HK_JUDGE_API_KEYS);
    } catch (err) {
      throw billingError("keys_invalid", err.message);
    }
  }
  const fileSeeds = keysFile ? readKeySeedsFromFile(keysFile) : [];
  const creditsPerCheckout = parsePositiveInt(env.HK_JUDGE_CREDITS_PER_CHECKOUT, 1000);
  const maxCreditsPerCheckout = parsePositiveInt(
    env.HK_JUDGE_MAX_CREDITS_PER_CHECKOUT,
    1_000_000
  );
  if (creditsPerCheckout > maxCreditsPerCheckout) {
    throw billingError(
      "invalid_params",
      "HK_JUDGE_CREDITS_PER_CHECKOUT exceeds HK_JUDGE_MAX_CREDITS_PER_CHECKOUT."
    );
  }
  return {
    dataDir: env.HK_JUDGE_DATA_DIR || path.join(process.cwd(), "data"),
    creditCost: parsePositiveInt(env.HK_JUDGE_CREDIT_COST, 1),
    freeCallsPerDay: parseNonNegInt(env.HK_JUDGE_FREE_CALLS_PER_DAY, 5),
    envSeeds,
    fileSeeds,
    stripeSecret: env.STRIPE_SECRET_KEY || "",
    stripePriceId: env.STRIPE_PRICE_ID || env.HK_JUDGE_STRIPE_PRICE_ID || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    successUrl: env.STRIPE_SUCCESS_URL || DEFAULT_SUCCESS_URL,
    cancelUrl: env.STRIPE_CANCEL_URL || DEFAULT_CANCEL_URL,
    creditsPerCheckout,
    maxCreditsPerCheckout,
    apiKey: env.HK_JUDGE_API_KEY || "",
    clientIp: env.HK_JUDGE_CLIENT_IP || "",
  };
}

function billingMeta(creditsCharged, creditsRemaining, tier, extra) {
  return {
    credits_charged: creditsCharged,
    credits_remaining: creditsRemaining,
    tier,
    ...extra,
  };
}

function freshStore() {
  return {
    schema: 1,
    production_note:
      "Demo ledger keyed by SHA-256 of each API key. Production should use a real database and grant credits from a Stripe webhook.",
    accounts: {},
    anonymous: {},
  };
}

function storeFile(config) {
  return path.join(config.dataDir, "credits.json");
}

function normalizeAccount(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    throw billingError("ledger_invalid", "Credit ledger account shape is invalid. Refusing to overwrite it.");
  }
  if (!Number.isInteger(account.credits) || account.credits < 0) {
    throw billingError(
      "ledger_invalid",
      "Credit ledger has a non-integer balance. Refusing to change it."
    );
  }
  if (!account.free_days || typeof account.free_days !== "object" || Array.isArray(account.free_days)) {
    account.free_days = {};
  }
  if (
    !account.fulfilled_sessions ||
    typeof account.fulfilled_sessions !== "object" ||
    Array.isArray(account.fulfilled_sessions)
  ) {
    account.fulfilled_sessions = {};
  }
  if (
    !account.pending_sessions ||
    typeof account.pending_sessions !== "object" ||
    Array.isArray(account.pending_sessions)
  ) {
    account.pending_sessions = {};
  }
  return account;
}

function applySeeds(store, config) {
  const merged = new Map();
  for (const seed of [...config.envSeeds, ...config.fileSeeds]) {
    merged.set(hashApiKey(seed.key), seed.credits);
  }
  for (const [hash, credits] of merged) {
    if (!store.accounts[hash]) {
      store.accounts[hash] = normalizeAccount({
        credits,
        free_days: {},
        fulfilled_sessions: {},
        pending_sessions: {},
      });
    }
  }
}

function withStore(config, mutator) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  const file = storeFile(config);
  let store;
  if (existsSync(file)) {
    try {
      store = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw billingError(
        "ledger_invalid",
        "Credit ledger could not be parsed. Refusing to overwrite it. Fix or replace the file in HK_JUDGE_DATA_DIR."
      );
    }
  } else {
    store = freshStore();
  }
  if (!store || typeof store !== "object" || Array.isArray(store) || typeof store.accounts !== "object" || !store.accounts) {
    throw billingError("ledger_invalid", "Credit ledger has an unexpected shape. Refusing to overwrite it.");
  }
  if (!store.anonymous || typeof store.anonymous !== "object" || Array.isArray(store.anonymous)) {
    store.anonymous = {};
  }
  store.production_note = freshStore().production_note;
  store.schema = 1;
  for (const account of Object.values(store.accounts)) normalizeAccount(account);
  applySeeds(store, config);
  const result = mutator(store);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return result;
}

function runBilling(config, fn) {
  try {
    return withStore(config, fn);
  } catch (err) {
    return {
      ok: false,
      error: err.code || "billing_error",
      message: err.message || "Billing store error.",
      _billing: billingMeta(0, null, "none"),
    };
  }
}

function dayKey(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(date.getTime())) {
    throw billingError("invalid_params", "now must be a valid date.");
  }
  return date.toISOString().slice(0, 10);
}

function readExplicitString(value, label) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw billingError("invalid_params", `${label} must be a string.`);
  }
  return value.trim();
}

function resolveApiKey(config, explicit) {
  const fromArg = readExplicitString(explicit, "api_key");
  const fromEnv = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  return fromArg || fromEnv;
}

function resolveClientIp(config, explicit) {
  const fromArg = readExplicitString(explicit, "client_ip");
  const fromEnv = typeof config.clientIp === "string" ? config.clientIp.trim() : "";
  return fromArg || fromEnv || "local";
}

function freeSnapshot(record, day, limit) {
  const used = record?.free_days?.[day] || 0;
  return {
    used,
    remaining: Math.max(0, limit - used),
  };
}

function consumeFree(record, day, config, creditsRemaining) {
  const limit = config.freeCallsPerDay;
  const used = record.free_days?.[day] || 0;
  if (limit > 0 && used < limit) {
    record.free_days = { [day]: used + 1 };
    return {
      ok: true,
      _billing: billingMeta(0, creditsRemaining, "free", {
        free_calls_remaining_today: limit - (used + 1),
      }),
    };
  }
  record.free_days = { [day]: used };
  const message =
    limit === 0
      ? "Paid credits are required for this call. The free daily allowance is off (HK_JUDGE_FREE_CALLS_PER_DAY=0). Call buy_credits to add credits."
      : `Free daily allowance is used (${limit} call(s) per UTC day). Call buy_credits to add credits and continue.`;
  return {
    ok: false,
    error: "payment_required",
    message,
    _billing: billingMeta(0, creditsRemaining, "free", { free_calls_remaining_today: 0 }),
  };
}

/**
 * Deduct publisher credits for one successful metered tool call.
 * Known keys with a balance pay HK_JUDGE_CREDIT_COST. A known key with a zero
 * balance, or a caller with no key, uses the free daily allowance.
 */
export function meterToolCall(config, { apiKey, clientIp, now } = {}) {
  return runBilling(config, (store) => {
    const day = dayKey(now || new Date());
    const key = resolveApiKey(config, apiKey);
    if (key) {
      const hash = hashApiKey(key);
      const account = store.accounts[hash];
      if (!account) {
        return {
          ok: false,
          error: "invalid_api_key",
          message:
            "API key was not recognised. Publishers seed keys with HK_JUDGE_API_KEYS or HK_JUDGE_KEYS_FILE. Consumers set HK_JUDGE_API_KEY or pass api_key.",
          _billing: billingMeta(0, null, "none"),
        };
      }
      const cost = config.creditCost;
      if (account.credits >= cost) {
        account.credits -= cost;
        return { ok: true, _billing: billingMeta(cost, account.credits, "paid") };
      }
      if (account.credits > 0) {
        return {
          ok: false,
          error: "payment_required",
          message: `This key has ${account.credits} publisher credit(s) and the call costs ${cost}. Call buy_credits to add credits. The judgment was withheld.`,
          _billing: billingMeta(0, account.credits, "paid"),
        };
      }
      return consumeFree(account, day, config, account.credits);
    }
    const ipHash = hashApiKey(`ip:${resolveClientIp(config, clientIp)}`);
    if (!store.anonymous[ipHash]) store.anonymous[ipHash] = { free_days: {} };
    return consumeFree(store.anonymous[ipHash], day, config, 0);
  });
}

export function getAccountStatus(config, { apiKey, clientIp, now } = {}) {
  return runBilling(config, (store) => {
    const day = dayKey(now || new Date());
    const key = resolveApiKey(config, apiKey);
    if (key) {
      const hash = hashApiKey(key);
      const account = store.accounts[hash];
      if (!account) {
        return {
          ok: false,
          error: "invalid_api_key",
          message:
            "API key was not recognised. Publishers seed keys with HK_JUDGE_API_KEYS or HK_JUDGE_KEYS_FILE. Consumers set HK_JUDGE_API_KEY or pass api_key.",
          _billing: billingMeta(0, null, "none"),
        };
      }
      const free = freeSnapshot(account, day, config.freeCallsPerDay);
      const tier = account.credits > 0 ? "paid" : "free";
      return {
        ok: true,
        api_key_recognized: true,
        credits_remaining: account.credits,
        credit_cost: config.creditCost,
        free_calls_per_day: config.freeCallsPerDay,
        free_calls_used_today: free.used,
        free_calls_remaining_today: free.remaining,
        tier,
        _billing: billingMeta(
          0,
          account.credits,
          tier,
          tier === "free" ? { free_calls_remaining_today: free.remaining } : {}
        ),
      };
    }
    const ipHash = hashApiKey(`ip:${resolveClientIp(config, clientIp)}`);
    const free = freeSnapshot(store.anonymous[ipHash], day, config.freeCallsPerDay);
    return {
      ok: true,
      api_key_recognized: false,
      credits_remaining: 0,
      credit_cost: config.creditCost,
      free_calls_per_day: config.freeCallsPerDay,
      free_calls_used_today: free.used,
      free_calls_remaining_today: free.remaining,
      tier: "free",
      _billing: billingMeta(0, 0, "free", { free_calls_remaining_today: free.remaining }),
    };
  });
}

function parseQuantity(value) {
  if (value === undefined || value === null || value === "") return 1;
  if (typeof value !== "number" && typeof value !== "string") {
    throw billingError("invalid_params", "quantity must be an integer from 1 to 99.");
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    throw billingError("invalid_params", "quantity must be an integer from 1 to 99.");
  }
  return n;
}

function assertHttpUrl(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw billingError("invalid_params", `${label} must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw billingError("invalid_params", `${label} must be an absolute http(s) URL.`);
  }
  return url;
}

function stripeConfigured(config) {
  return Boolean(config.stripeSecret && config.stripePriceId);
}

function stripeConfigMessage() {
  return "Configure Stripe before selling credits. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID (HK_JUDGE_STRIPE_PRICE_ID is accepted). Optional: STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL, HK_JUDGE_CREDITS_PER_CHECKOUT (credits granted per Price quantity, default 1000). No Checkout Session was created and no card was charged.";
}

function stripeMissingResult(creditsRemaining, tier) {
  return {
    ok: false,
    configured: false,
    error: "stripe_not_configured",
    message: stripeConfigMessage(),
    required_env: ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"],
    optional_env: [
      "HK_JUDGE_STRIPE_PRICE_ID",
      "STRIPE_SUCCESS_URL",
      "STRIPE_CANCEL_URL",
      "HK_JUDGE_CREDITS_PER_CHECKOUT",
      "STRIPE_WEBHOOK_SECRET",
    ],
    _billing: billingMeta(0, creditsRemaining, tier),
  };
}

function formEncode(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, "+");
}

function encodeFormField(key, value, preservePlaceholder = false) {
  if (!preservePlaceholder) return `${formEncode(key)}=${formEncode(value)}`;
  const placeholder = "{CHECKOUT_SESSION_ID}";
  const marker = "__CHECKOUT_SESSION_ID__";
  const replaced = String(value).split(placeholder).join(marker);
  const encoded = formEncode(replaced).split(formEncode(marker)).join(placeholder);
  return `${formEncode(key)}=${encoded}`;
}

async function stripeRequest(config, urlPath, { method = "GET", body, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw billingError("stripe_unavailable", "This Node runtime has no fetch. Use Node.js 18 or newer.");
  }
  let res;
  try {
    res = await fetchFn(`https://api.stripe.com${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.stripeSecret}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw billingError("stripe_error", "Could not reach Stripe. No credits were changed.");
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw billingError("stripe_error", "Stripe returned a non-JSON response. No credits were changed.");
  }
  if (!res.ok) {
    const message = data?.error?.message || `Stripe request failed (${res.status}).`;
    throw billingError("stripe_error", message);
  }
  return data;
}

function requireKnownKey(config, store, apiKey) {
  const key = resolveApiKey(config, apiKey);
  if (!key) {
    return {
      ok: false,
      error: "api_key_required",
      message:
        "buy_credits needs a publisher API key so credits land on an account. Set HK_JUDGE_API_KEY or pass api_key. Seed that key with HK_JUDGE_API_KEYS or HK_JUDGE_KEYS_FILE (use 0 credits if the balance starts empty).",
      _billing: billingMeta(0, null, "none"),
    };
  }
  const hash = hashApiKey(key);
  const account = store.accounts[hash];
  if (!account) {
    return {
      ok: false,
      error: "invalid_api_key",
      message:
        "API key was not recognised. Publishers seed keys with HK_JUDGE_API_KEYS or HK_JUDGE_KEYS_FILE. Consumers set HK_JUDGE_API_KEY or pass api_key.",
      _billing: billingMeta(0, null, "none"),
    };
  }
  return { ok: true, hash, account, tier: account.credits > 0 ? "paid" : "free" };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Create a Stripe Checkout Session for a credit pack.
 * Returns a configure-Stripe message when the secret or price id is absent.
 */
export async function createCreditCheckout(
  config,
  { apiKey, quantity, successUrl, cancelUrl, fetchImpl } = {}
) {
  let prepared;
  try {
    prepared = await withStore(config, (store) => {
      const known = requireKnownKey(config, store, apiKey);
      if (!known.ok) return known;
      if (!stripeConfigured(config)) {
        return stripeMissingResult(known.account.credits, known.tier);
      }
      if (!PRICE_ID_RE.test(config.stripePriceId)) {
        throw billingError(
          "stripe_not_configured",
          "STRIPE_PRICE_ID must be a Stripe Price id such as price_123. No Checkout Session was created."
        );
      }
      const qty = parseQuantity(quantity);
      const credits = config.creditsPerCheckout * qty;
      if (credits > config.maxCreditsPerCheckout) {
        throw billingError(
          "invalid_params",
          "That quantity grants more credits than HK_JUDGE_MAX_CREDITS_PER_CHECKOUT allows."
        );
      }
      const success = assertHttpUrl(successUrl || config.successUrl, "success_url");
      const cancel = assertHttpUrl(cancelUrl || config.cancelUrl, "cancel_url");
      return { ok: true, hash: known.hash, credits, qty, success, cancel, tier: known.tier, balance: known.account.credits };
    });
  } catch (err) {
    return {
      ok: false,
      error: err.code || "billing_error",
      message: err.message || "Billing store error.",
      _billing: billingMeta(0, null, "none"),
    };
  }
  if (!prepared.ok || prepared.configured === false) return prepared;

  const body = [
    encodeFormField("mode", "payment"),
    encodeFormField("success_url", prepared.success, true),
    encodeFormField("cancel_url", prepared.cancel),
    encodeFormField("client_reference_id", prepared.hash),
    encodeFormField("line_items[0][price]", config.stripePriceId),
    encodeFormField("line_items[0][quantity]", prepared.qty),
    encodeFormField("metadata[api_key_hash]", prepared.hash),
    encodeFormField("metadata[credits]", prepared.credits),
  ].join("&");

  let session;
  try {
    session = await stripeRequest(config, "/v1/checkout/sessions", {
      method: "POST",
      body,
      fetchImpl,
    });
  } catch (err) {
    return {
      ok: false,
      configured: true,
      error: err.code || "stripe_error",
      message: err.message || "Stripe request failed. No credits were changed.",
      _billing: billingMeta(0, prepared.balance, prepared.tier),
    };
  }
  if (!session.id || !SESSION_ID_RE.test(session.id) || !session.url) {
    return {
      ok: false,
      configured: true,
      error: "stripe_error",
      message: "Stripe did not return a Checkout URL. No credits were changed.",
      _billing: billingMeta(0, prepared.balance, prepared.tier),
    };
  }

  try {
    return withStore(config, (store) => {
      const account = store.accounts[prepared.hash];
      if (!account) {
        throw billingError(
          "ledger_invalid",
          "The API key disappeared from the local ledger before the checkout could be recorded. Do not pay this session."
        );
      }
      normalizeAccount(account);
      account.pending_sessions[session.id] = {
        credits: prepared.credits,
        created_at: new Date().toISOString(),
      };
      const tier = account.credits > 0 ? "paid" : "free";
      return {
        ok: true,
        configured: true,
        checkout_url: session.url,
        session_id: session.id,
        credits_to_grant: prepared.credits,
        message:
          "Open checkout_url and pay in the browser. This call did not charge a card and did not deduct publisher credits. After payment, run the webhook (node webhook.js) on the same HK_JUDGE_DATA_DIR, or call buy_credits again with this session_id and the same API key. The webhook grants credits on checkout.session.completed.",
        _billing: billingMeta(0, account.credits, tier),
      };
    });
  } catch (err) {
    return {
      ok: false,
      configured: true,
      error: err.code || "billing_error",
      message: `${err.message || "The local ledger could not record this checkout."} Do not pay session ${session.id}.`,
      session_id: session.id,
      _billing: billingMeta(0, prepared.balance, prepared.tier),
    };
  }
}

/**
 * Verify a paid Checkout Session and grant the credits recorded locally when
 * the session was created. Pass the consumer API key from buy_credits.
 * Webhook handlers that hold STRIPE_SECRET_KEY may set operatorGrant instead
 * of presenting the raw key. Tool arguments cannot enable operatorGrant.
 */
export async function confirmCreditCheckout(
  config,
  { apiKey, sessionId, operatorGrant = false, fetchImpl } = {}
) {
  let sessionKey = "";
  try {
    sessionKey = readExplicitString(sessionId, "session_id");
  } catch (err) {
    return {
      ok: false,
      error: err.code || "invalid_params",
      message: err.message,
      _billing: billingMeta(0, null, "none"),
    };
  }
  if (!SESSION_ID_RE.test(sessionKey) || sessionKey.length > 255) {
    return {
      ok: false,
      error: "invalid_params",
      message: "session_id must be a Stripe Checkout Session id (cs_...).",
      _billing: billingMeta(0, null, "none"),
    };
  }
  if (!config.stripeSecret) {
    const missing = stripeMissingResult(null, "none");
    missing.message =
      "Configure Stripe before confirming a payment. Set STRIPE_SECRET_KEY so the paid Checkout Session can be verified. No credits were added.";
    return missing;
  }

  let session;
  try {
    session = await stripeRequest(
      config,
      `/v1/checkout/sessions/${encodeURIComponent(sessionKey)}`,
      { fetchImpl }
    );
  } catch (err) {
    return {
      ok: false,
      error: err.code || "stripe_error",
      message: err.message || "Stripe request failed. No credits were changed.",
      _billing: billingMeta(0, null, "none"),
    };
  }

  return runBilling(config, (store) => {
    let hash = "";
    if (operatorGrant) {
      const found = Object.entries(store.accounts).find(([, account]) => account.pending_sessions?.[sessionKey] || account.fulfilled_sessions?.[sessionKey]);
      if (!found) {
        return {
          ok: false,
          error: "unknown_session",
          message:
            "This Checkout Session is not in the local ledger. Credits are only granted for sessions buy_credits recorded. No credits were added.",
          _billing: billingMeta(0, null, "none"),
        };
      }
      hash = found[0];
    } else {
      const known = requireKnownKey(config, store, apiKey);
      if (!known.ok) return known;
      hash = known.hash;
    }
    const account = normalizeAccount(store.accounts[hash]);
    if (account.fulfilled_sessions[sessionKey]) {
      const tier = account.credits > 0 ? "paid" : "free";
      return {
        ok: true,
        already_applied: true,
        credits_added: 0,
        credits_remaining: account.credits,
        message: "This Checkout Session was already applied. The balance is unchanged.",
        _billing: billingMeta(0, account.credits, tier),
      };
    }
    const pending = account.pending_sessions[sessionKey];
    if (!pending || !Number.isInteger(pending.credits) || pending.credits < 1) {
      return {
        ok: false,
        error: "unknown_session",
        message:
          "No pending checkout for this session belongs to the current API key. No credits were added.",
        _billing: billingMeta(0, account.credits, account.credits > 0 ? "paid" : "free"),
      };
    }
    const metaHash = session.metadata?.api_key_hash || "";
    const ref = session.client_reference_id || "";
    if ((metaHash && !safeEqual(metaHash, hash)) || (ref && !safeEqual(ref, hash))) {
      return {
        ok: false,
        error: "session_key_mismatch",
        message: "This Checkout Session belongs to a different API key. No credits were added.",
        _billing: billingMeta(0, account.credits, account.credits > 0 ? "paid" : "free"),
      };
    }
    if (session.payment_status !== "paid" || !(Number(session.amount_total) > 0)) {
      return {
        ok: false,
        error: "payment_incomplete",
        message: `Checkout is not paid yet (payment_status: ${session.payment_status || "unknown"}). Finish payment in the browser, then confirm this session_id. No credits were added.`,
        _billing: billingMeta(0, account.credits, account.credits > 0 ? "paid" : "free"),
      };
    }
    if (pending.credits > config.maxCreditsPerCheckout) {
      return {
        ok: false,
        error: "invalid_params",
        message: "The pending pack exceeds HK_JUDGE_MAX_CREDITS_PER_CHECKOUT. No credits were added.",
        _billing: billingMeta(0, account.credits, account.credits > 0 ? "paid" : "free"),
      };
    }
    account.credits += pending.credits;
    delete account.pending_sessions[sessionKey];
    account.fulfilled_sessions[sessionKey] = new Date().toISOString();
    return {
      ok: true,
      already_applied: false,
      credits_added: pending.credits,
      credits_remaining: account.credits,
      session_id: sessionKey,
      message: "Payment verified. Publisher credits were added to this API key.",
      _billing: billingMeta(0, account.credits, "paid"),
    };
  });
}
