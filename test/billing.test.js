import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  confirmCreditCheckout,
  createCreditCheckout,
  getAccountStatus,
  hashApiKey,
  loadConfig,
  meterToolCall,
} from "../billing.js";
import { tools } from "../index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const day = new Date("2026-10-20T15:00:00.000Z");
const nextDay = new Date("2026-10-21T00:30:00.000Z");

function tempConfig(extra = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hk-judge-test-"));
  const config = loadConfig({
    HK_JUDGE_DATA_DIR: dataDir,
    HK_JUDGE_CREDIT_COST: "1",
    HK_JUDGE_FREE_CALLS_PER_DAY: "2",
    HK_JUDGE_API_KEYS: "hkj_test_paid:3,hkj_test_empty:0",
    HK_JUDGE_CREDITS_PER_CHECKOUT: "25",
    ...extra,
  });
  return { config, dataDir };
}

function ledger(dataDir) {
  return JSON.parse(readFileSync(path.join(dataDir, "credits.json"), "utf8"));
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe("publisher credits", () => {
  it("keeps the published tool names and adds billing helpers", () => {
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["evaluate_transit_viability", "check_supplier_credit", "buy_credits", "account_status"]
    );
  });

  it("deducts the configured cost from a seeded key and leaves synthetic calls to the tools", () => {
    const { config, dataDir } = tempConfig({ HK_JUDGE_CREDIT_COST: "2" });
    const first = meterToolCall(config, { apiKey: "hkj_test_paid", now: day });
    assert.equal(first.ok, true);
    assert.deepEqual(first._billing, {
      credits_charged: 2,
      credits_remaining: 1,
      tier: "paid",
    });
    const second = meterToolCall(config, { apiKey: "hkj_test_paid", now: day });
    assert.equal(second.ok, false);
    assert.equal(second.error, "payment_required");
    assert.equal(second._billing.credits_remaining, 1);
    assert.equal(second._billing.credits_charged, 0);
    const status = getAccountStatus(config, { apiKey: "hkj_test_paid", now: day });
    assert.equal(status.free_calls_used_today, 0);
    const raw = readFileSync(path.join(dataDir, "credits.json"), "utf8");
    assert.equal(raw.includes("hkj_test_paid"), false);
    assert.equal(raw.includes(hashApiKey("hkj_test_paid")), true);
    assert.match(raw, /Production should use a real database/);
  });

  it("uses a per-key free allowance only after paid credits are gone", () => {
    const { config } = tempConfig();
    const results = [
      meterToolCall(config, { apiKey: "hkj_test_empty", now: day }),
      meterToolCall(config, { apiKey: "hkj_test_empty", now: day }),
      meterToolCall(config, { apiKey: "hkj_test_empty", now: day }),
    ];
    assert.equal(results[0]._billing.tier, "free");
    assert.equal(results[0]._billing.credits_charged, 0);
    assert.equal(results[0]._billing.free_calls_remaining_today, 1);
    assert.equal(results[1]._billing.free_calls_remaining_today, 0);
    assert.equal(results[2].ok, false);
    assert.equal(results[2].error, "payment_required");
    assert.equal(JSON.stringify(results[2]).includes("freight_usd"), false);
    const rolled = meterToolCall(config, { apiKey: "hkj_test_empty", now: nextDay });
    assert.equal(rolled.ok, true);
    assert.equal(rolled._billing.tier, "free");
  });

  it("rate limits anonymous callers per IP and rejects unknown keys", () => {
    const { config, dataDir } = tempConfig({ HK_JUDGE_FREE_CALLS_PER_DAY: "1" });
    const a = meterToolCall(config, { clientIp: "203.0.113.10", now: day });
    const b = meterToolCall(config, { clientIp: "203.0.113.11", now: day });
    const blocked = meterToolCall(config, { clientIp: "203.0.113.10", now: day });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(blocked.error, "payment_required");
    const unknown = meterToolCall(config, { apiKey: "hkj_not_seeded", now: day });
    assert.equal(unknown.error, "invalid_api_key");
    const raw = readFileSync(path.join(dataDir, "credits.json"), "utf8");
    assert.equal(raw.includes("203.0.113.10"), false);
    assert.equal(raw.includes("hkj_not_seeded"), false);
    assert.equal(Object.keys(ledger(dataDir).accounts).length, 2);
  });

  it("does not reset an existing balance when the seed is repeated", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "hk-judge-reseed-"));
    const first = loadConfig({
      HK_JUDGE_DATA_DIR: dataDir,
      HK_JUDGE_API_KEYS: "hkj_test_paid:3",
      HK_JUDGE_CREDIT_COST: "1",
      HK_JUDGE_FREE_CALLS_PER_DAY: "5",
    });
    meterToolCall(first, { apiKey: "hkj_test_paid", now: day });
    const second = loadConfig({
      HK_JUDGE_DATA_DIR: dataDir,
      HK_JUDGE_API_KEYS: "hkj_test_paid:999",
      HK_JUDGE_CREDIT_COST: "1",
      HK_JUDGE_FREE_CALLS_PER_DAY: "5",
    });
    const status = getAccountStatus(second, { apiKey: "hkj_test_paid", now: day });
    assert.equal(status.credits_remaining, 2);
  });

  it("lets a keys file set the initial balance", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "hk-judge-keys-"));
    const keysFile = path.join(dataDir, "keys.json");
    writeFileSync(keysFile, JSON.stringify({ hkj_from_file: 7 }));
    const config = loadConfig({
      HK_JUDGE_DATA_DIR: dataDir,
      HK_JUDGE_API_KEYS: "hkj_from_file:1",
      HK_JUDGE_KEYS_FILE: keysFile,
    });
    const status = getAccountStatus(config, { apiKey: "hkj_from_file" });
    assert.equal(status.credits_remaining, 7);
    assert.equal(status._billing.credits_charged, 0);
  });

  it("returns a configure-Stripe message and does not invent a URL", async () => {
    const { config } = tempConfig();
    const result = await createCreditCheckout(config, { apiKey: "hkj_test_empty" });
    assert.equal(result.error, "stripe_not_configured");
    assert.equal(result.configured, false);
    assert.equal(JSON.stringify(result).includes("checkout.stripe.com"), false);
    assert.ok(result.required_env.includes("STRIPE_SECRET_KEY"));
    assert.ok(result.required_env.includes("STRIPE_PRICE_ID"));
    assert.match(result.message, /Configure Stripe/);
    const status = getAccountStatus(config, { apiKey: "hkj_test_empty" });
    assert.equal(status.credits_remaining, 0);
  });

  it("creates a Checkout URL and grants credits once after payment", async () => {
    const { config } = tempConfig({
      STRIPE_SECRET_KEY: "sk_test_replace_me",
      STRIPE_PRICE_ID: "price_test_pack",
    });
    const fetchImpl = async (url, opts = {}) => {
      if (url === "https://api.stripe.com/v1/checkout/sessions" && opts.method === "POST") {
        assert.match(opts.body, /success_url=.*\{CHECKOUT_SESSION_ID\}/);
        assert.equal(opts.body.includes("%7BCHECKOUT_SESSION_ID%7D"), false);
        assert.match(opts.headers.Authorization, /^Bearer sk_test_replace_me$/);
        return jsonResponse({
          id: "cs_test_paidpack",
          url: "https://checkout.stripe.com/c/pay/cs_test_paidpack",
        });
      }
      if (url === "https://api.stripe.com/v1/checkout/sessions/cs_test_paidpack") {
        return jsonResponse({
          id: "cs_test_paidpack",
          payment_status: "paid",
          amount_total: 500,
          client_reference_id: hashApiKey("hkj_test_empty"),
          metadata: { api_key_hash: hashApiKey("hkj_test_empty"), credits: "1" },
        });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const created = await createCreditCheckout(config, {
      apiKey: "hkj_test_empty",
      quantity: 2,
      fetchImpl,
    });
    assert.equal(created.checkout_url, "https://checkout.stripe.com/c/pay/cs_test_paidpack");
    assert.equal(created.credits_to_grant, 50);
    assert.equal(created._billing.credits_charged, 0);
    const applied = await confirmCreditCheckout(config, {
      apiKey: "hkj_test_empty",
      sessionId: "cs_test_paidpack",
      fetchImpl,
    });
    assert.equal(applied.credits_added, 50);
    assert.equal(applied.credits_remaining, 50);
    assert.equal(applied._billing.tier, "paid");
    const again = await confirmCreditCheckout(config, {
      apiKey: "hkj_test_empty",
      sessionId: "cs_test_paidpack",
      fetchImpl,
    });
    assert.equal(again.already_applied, true);
    assert.equal(again.credits_remaining, 50);
    const paidCall = meterToolCall(config, { apiKey: "hkj_test_empty", now: day });
    assert.equal(paidCall._billing.tier, "paid");
    assert.equal(paidCall._billing.credits_remaining, 49);
  });

  it("grants from a webhook-style operator confirm without the raw key", async () => {
    const { config } = tempConfig({
      STRIPE_SECRET_KEY: "sk_test_replace_me",
      STRIPE_PRICE_ID: "price_test_pack",
    });
    const fetchImpl = async (url, opts = {}) => {
      if (opts.method === "POST") {
        return jsonResponse({
          id: "cs_test_hook",
          url: "https://checkout.stripe.com/c/pay/cs_test_hook",
        });
      }
      return jsonResponse({
        id: "cs_test_hook",
        payment_status: "paid",
        amount_total: 1000,
        client_reference_id: hashApiKey("hkj_test_empty"),
        metadata: { api_key_hash: hashApiKey("hkj_test_empty"), credits: "25" },
      });
    };
    await createCreditCheckout(config, { apiKey: "hkj_test_empty", fetchImpl });
    const granted = await confirmCreditCheckout(config, {
      sessionId: "cs_test_hook",
      operatorGrant: true,
      fetchImpl,
    });
    assert.equal(granted.credits_added, 25);
    assert.equal(granted.credits_remaining, 25);
    const again = await confirmCreditCheckout(config, {
      sessionId: "cs_test_hook",
      operatorGrant: true,
      fetchImpl,
    });
    assert.equal(again.already_applied, true);
    assert.equal(again.credits_remaining, 25);
    const sneaky = await confirmCreditCheckout(config, {
      apiKey: "hkj_test_paid",
      sessionId: "cs_test_hook",
      fetchImpl,
    });
    assert.equal(sneaky.error, "unknown_session");
    assert.equal(getAccountStatus(config, { apiKey: "hkj_test_paid" }).credits_remaining, 3);
  });

  it("refuses an unpaid session and a session opened for another key", async () => {
    const { config } = tempConfig({
      STRIPE_SECRET_KEY: "sk_test_replace_me",
      STRIPE_PRICE_ID: "price_test_pack",
    });
    let paymentStatus = "unpaid";
    const fetchImpl = async (url, opts = {}) => {
      if (opts.method === "POST") {
        return jsonResponse({ id: "cs_test_wait", url: "https://checkout.stripe.com/c/pay/cs_test_wait" });
      }
      return jsonResponse({
        id: "cs_test_wait",
        payment_status: paymentStatus,
        amount_total: paymentStatus === "paid" ? 500 : 0,
        client_reference_id: hashApiKey("hkj_test_empty"),
        metadata: { api_key_hash: hashApiKey("hkj_test_empty") },
      });
    };
    await createCreditCheckout(config, { apiKey: "hkj_test_empty", fetchImpl });
    const unpaid = await confirmCreditCheckout(config, {
      apiKey: "hkj_test_empty",
      sessionId: "cs_test_wait",
      fetchImpl,
    });
    assert.equal(unpaid.error, "payment_incomplete");
    assert.equal(getAccountStatus(config, { apiKey: "hkj_test_empty" }).credits_remaining, 0);
    paymentStatus = "paid";
    const wrongKey = await confirmCreditCheckout(config, {
      apiKey: "hkj_test_paid",
      sessionId: "cs_test_wait",
      fetchImpl,
    });
    assert.equal(wrongKey.error, "unknown_session");
    assert.equal(getAccountStatus(config, { apiKey: "hkj_test_paid" }).credits_remaining, 3);
  });
});

describe("public tool flow", () => {
  it("goes from free calls to a Stripe pack and back to paid calls", () => {
    const scriptPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "hk-judge-flow-")),
      "run.mjs"
    );
    const entry = path.join(repoRoot, "index.js");
    writeFileSync(
      scriptPath,
      `
        const dir = ${JSON.stringify(path.dirname(scriptPath))};
        process.env.HK_JUDGE_DATA_DIR = dir;
        process.env.HK_JUDGE_API_KEYS = "hkj_flow:0";
        process.env.HK_JUDGE_API_KEY = "hkj_flow";
        process.env.HK_JUDGE_FREE_CALLS_PER_DAY = "1";
        process.env.HK_JUDGE_CREDIT_COST = "1";
        process.env.HK_JUDGE_CREDITS_PER_CHECKOUT = "10";
        delete process.env.STRIPE_SECRET_KEY;
        delete process.env.STRIPE_PRICE_ID;
        delete process.env.HK_JUDGE_STRIPE_PRICE_ID;
        const { callTool } = await import(${JSON.stringify(entry)});
        const { hashApiKey } = await import(${JSON.stringify(path.join(repoRoot, "billing.js"))});
        const hash = hashApiKey("hkj_flow");
        globalThis.fetch = async (url, opts = {}) => {
          const payload = url.endsWith("/v1/checkout/sessions") && opts.method === "POST"
            ? { id: "cs_test_flow", url: "https://checkout.stripe.com/c/pay/cs_test_flow" }
            : url.endsWith("/v1/checkout/sessions/cs_test_flow")
              ? {
                  id: "cs_test_flow",
                  payment_status: "paid",
                  amount_total: 100,
                  client_reference_id: hash,
                  metadata: { api_key_hash: hash, credits: "1" },
                }
              : null;
          if (!payload) throw new Error("unexpected " + url);
          return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
        };
        const first = await callTool("evaluate_transit_viability", {
          sku: "generic teeth whitening strips",
          destination_country: "Europe and the Middle East",
        });
        const blocked = await callTool("check_supplier_credit", {
          supplier_name: "Guangzhou OralCare Wholesale Co.",
        });
        const configure = await callTool("buy_credits", {});
        process.env.STRIPE_SECRET_KEY = "sk_test_replace_me";
        process.env.STRIPE_PRICE_ID = "price_test_pack";
        const bought = await callTool("buy_credits", { quantity: 1, operator_grant: true });
        const confirmed = await callTool("buy_credits", {
          session_id: bought.session_id,
          operator_grant: true,
        });
        const resumed = await callTool("check_supplier_credit", {
          supplier_name: "Guangzhou OralCare Wholesale Co.",
        });
        const invalid = await callTool("evaluate_transit_viability", { sku: " " });
        const status = await callTool("account_status", {});
        console.log(JSON.stringify({ first, blocked, configure, bought, confirmed, resumed, invalid, status }));
      `
    );
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.first.destination_country, "Europe and the Middle East");
    assert.equal(body.first.landed_cost_breakdown.freight_usd, 42.5);
    assert.equal(body.first._billing.tier, "free");
    assert.equal(body.first._billing.credits_charged, 0);
    assert.equal(body.first._billing.free_calls_remaining_today, 0);
    assert.equal(body.blocked.error, "payment_required");
    assert.equal(Object.hasOwn(body.blocked, "credit_score"), false);
    assert.equal(body.configure.error, "stripe_not_configured");
    assert.equal(JSON.stringify(body.configure).includes("checkout.stripe.com"), false);
    assert.equal(body.bought.checkout_url, "https://checkout.stripe.com/c/pay/cs_test_flow");
    assert.equal(body.bought._billing.credits_charged, 0);
    assert.equal(body.confirmed.credits_added, 10);
    assert.equal(body.resumed.credit_score, 72);
    assert.deepEqual(body.resumed._billing, {
      credits_charged: 1,
      credits_remaining: 9,
      tier: "paid",
    });
    assert.equal(body.invalid.error, "invalid_params");
    assert.equal(body.status.credits_remaining, 9);
    assert.equal(JSON.stringify(body).toLowerCase().includes("prompt_tokens"), false);
  });
});

describe("synthetic demo smoke", () => {
  it("prints the two judgment tools with Europe and the Middle East wording and paid billing", () => {
    const result = spawnSync(process.execPath, ["index.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        STRIPE_SECRET_KEY: "sk_test_should_not_be_called",
        HK_JUDGE_API_KEY: "hkj_live_should_not_be_used",
        HK_JUDGE_DATA_DIR: repoRoot,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const transit = body.evaluate_transit_viability;
    const credit = body.check_supplier_credit;
    assert.equal(transit.destination_country, "Europe and the Middle East");
    assert.equal(transit.sku, "generic teeth whitening strips");
    assert.deepEqual(transit.landed_cost_breakdown, {
      freight_usd: 42.5,
      tax_or_duty_usd: 18.0,
      packaging_usd: 6.75,
      currency: "USD",
    });
    assert.deepEqual(transit.bargaining_prompts, [
      "Volume pre-order price for 20,000+ boxes?",
      "Special price available before audit-year cutoff (e.g. before 1 April)?",
      "Cash-flow swap price before Lunar New Year?",
    ]);
    assert.equal(transit.data_mode, "synthetic_demo");
    assert.equal(credit.supplier_name, "Guangzhou OralCare Wholesale Co.");
    assert.equal(credit.credit_score, 72);
    assert.equal(credit.credit_score_scale, "0-100");
    assert.equal(credit.risk_factors.length, 3);
    assert.match(credit.recommendation, /small trial order/);
    assert.deepEqual(transit._billing, {
      credits_charged: 1,
      credits_remaining: 9,
      tier: "paid",
    });
    assert.deepEqual(credit._billing, {
      credits_charged: 1,
      credits_remaining: 8,
      tier: "paid",
    });
    const serialized = JSON.stringify(body).toLowerCase();
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens", "llm_tokens"]) {
      assert.equal(serialized.includes(field), false);
    }
    assert.equal(result.stdout.includes("hkj_demo_smoke"), false);
    assert.equal(result.stdout.includes("sk_test_should_not_be_called"), false);
    assert.equal(result.stdout.toLowerCase().includes("crest"), false);
  });
});
