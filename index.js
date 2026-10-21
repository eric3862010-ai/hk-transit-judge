#!/usr/bin/env node
/**
 * hk-transit-judge — MCP-style tool skeleton with publisher credit metering.
 * Demo only: judgment tools return synthetic numbers. No real commercial data.
 * Metering charges publisher credits (HK_JUDGE_CREDIT_COST per success).
 * It does not read or bill Claude, Cursor, or other client model tokens.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  confirmCreditCheckout,
  createCreditCheckout,
  getAccountStatus,
  loadConfig,
  meterToolCall,
} from "./billing.js";

export { confirmCreditCheckout, loadConfig };

const noneBilling = {
  credits_charged: 0,
  credits_remaining: null,
  tier: "none",
};

export const tools = [
  {
    name: "evaluate_transit_viability",
    description:
      "When an agent must evaluate whether any product is viable for Hong Kong duty-free transit into a destination market, call this tool to get synthetic landed-cost line items (freight, tax/duty, packaging) plus three bargaining prompts. Demo data only; real verification stays behind the server and returns results without exposing the underlying dataset. Metered publisher call: spends HK_JUDGE_CREDIT_COST credits on success (default 1) when the key has a balance, otherwise the free daily allowance. Set HK_JUDGE_API_KEY or pass api_key. Publisher credits are separate from client model tokens.",
    inputSchema: {
      type: "object",
      properties: {
        sku: {
          type: "string",
          description: "Product SKU or product name, e.g. generic teeth whitening strips",
        },
        destination_country: {
          type: "string",
          description:
            "Destination market, e.g. a European or Middle Eastern market",
        },
        api_key: {
          type: "string",
          description:
            "Publisher API key. Prefer the HK_JUDGE_API_KEY environment variable so the key stays out of the prompt.",
        },
        client_ip: {
          type: "string",
          description:
            "Caller IP for the free daily allowance when no API key is sent. Hosts should set this. Defaults to the local process bucket.",
        },
      },
      required: ["sku", "destination_country"],
    },
  },
  {
    name: "check_supplier_credit",
    description:
      "When an agent is about to place or recommend an order with an Alibaba or other wholesale supplier and needs a credit-risk screen before committing volume, call this tool with the supplier name (optional storefront URL and product category) to receive a 0–100 credit score, three risk factors, and one order-sizing recommendation. Demo data only; real verification stays behind the server and returns results without exposing the underlying dataset. Metered publisher call: spends HK_JUDGE_CREDIT_COST credits on success (default 1) when the key has a balance, otherwise the free daily allowance. Set HK_JUDGE_API_KEY or pass api_key. Publisher credits are separate from client model tokens.",
    inputSchema: {
      type: "object",
      properties: {
        supplier_name: {
          type: "string",
          description:
            "Supplier trading name, e.g. an Alibaba Gold Supplier store name",
        },
        supplier_url: {
          type: "string",
          description:
            "Optional supplier storefront or company URL (Alibaba store link, etc.)",
        },
        product_category: {
          type: "string",
          description:
            "Optional product category context, e.g. oral care / beauty wholesale",
        },
        api_key: {
          type: "string",
          description:
            "Publisher API key. Prefer the HK_JUDGE_API_KEY environment variable so the key stays out of the prompt.",
        },
        client_ip: {
          type: "string",
          description:
            "Caller IP for the free daily allowance when no API key is sent. Hosts should set this. Defaults to the local process bucket.",
        },
      },
      required: ["supplier_name"],
    },
  },
  {
    name: "buy_credits",
    description:
      "Return a Stripe Checkout URL that adds publisher credits to the current API key. The call itself charges nothing. If STRIPE_SECRET_KEY and STRIPE_PRICE_ID are unset, it returns the environment variables to configure and does not invent a payment URL. After the browser payment, call again with session_id to verify the session and add credits, or run node webhook.js so checkout.session.completed grants them. Unrelated to Claude or Cursor model tokens.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Publisher API key. Falls back to HK_JUDGE_API_KEY.",
        },
        session_id: {
          type: "string",
          description:
            "Stripe Checkout Session id (cs_...) from a previous buy_credits response. When set, verify payment and grant the credits.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          maximum: 99,
          description: "How many Stripe Price units to buy. Default 1.",
        },
        success_url: {
          type: "string",
          description: "Optional Checkout success URL. Defaults to STRIPE_SUCCESS_URL.",
        },
        cancel_url: {
          type: "string",
          description: "Optional Checkout cancel URL. Defaults to STRIPE_CANCEL_URL.",
        },
      },
    },
  },
  {
    name: "account_status",
    description:
      "Show the publisher credit balance, per-call credit cost, and remaining free calls for today. Does not deduct credits and does not report model token usage.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Publisher API key. Falls back to HK_JUDGE_API_KEY.",
        },
        client_ip: {
          type: "string",
          description: "Caller IP used to read the anonymous free-tier counter.",
        },
      },
    },
  },
];

function configOrError() {
  try {
    return { ok: true, config: loadConfig() };
  } catch (err) {
    return {
      ok: false,
      error: err.code || "billing_error",
      message: err.message,
      _billing: { ...noneBilling },
    };
  }
}

function requireText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function meteredJudgment(params, build) {
  const loaded = configOrError();
  if (!loaded.ok) return loaded;
  const body = build();
  const gate = meterToolCall(loaded.config, {
    apiKey: params.api_key,
    clientIp: params.client_ip,
  });
  if (!gate.ok) {
    return { error: gate.error, message: gate.message, _billing: gate._billing };
  }
  return { ...body, _billing: gate._billing };
}

function publicResult(result) {
  if (!result || typeof result !== "object") return result;
  const { ok, ...rest } = result;
  return rest;
}

/**
 * @param {{ sku: string, destination_country: string, api_key?: string, client_ip?: string }} params
 */
export function evaluate_transit_viability(params = {}) {
  if (!requireText(params.sku) || !requireText(params.destination_country)) {
    return {
      error: "invalid_params",
      message: "sku and destination_country are required.",
      _billing: { ...noneBilling },
    };
  }
  return meteredJudgment(params, () => ({
    sku: params.sku,
    destination_country: params.destination_country,
    data_mode: "synthetic_demo",
    notice:
      "Synthetic demo numbers only. Real proprietary data is not included in this skeleton.",
    landed_cost_breakdown: {
      freight_usd: 42.5,
      tax_or_duty_usd: 18.0,
      packaging_usd: 6.75,
      currency: "USD",
    },
    bargaining_prompts: [
      "Volume pre-order price for 20,000+ boxes?",
      "Special price available before audit-year cutoff (e.g. before 1 April)?",
      "Cash-flow swap price before Lunar New Year?",
    ],
  }));
}

/**
 * @param {{ supplier_name: string, supplier_url?: string, product_category?: string, api_key?: string, client_ip?: string }} params
 */
export function check_supplier_credit(params = {}) {
  if (!requireText(params.supplier_name)) {
    return {
      error: "invalid_params",
      message: "supplier_name is required.",
      _billing: { ...noneBilling },
    };
  }
  return meteredJudgment(params, () => ({
    supplier_name: params.supplier_name,
    supplier_url: params.supplier_url || null,
    product_category: params.product_category || null,
    data_mode: "synthetic_demo",
    notice:
      "Synthetic demo score only. Real proprietary data is not included in this skeleton.",
    credit_score: 72,
    credit_score_scale: "0-100",
    risk_factors: [
      "Payment record: synthetic signal shows mostly on-time settlements with two late-30-day flags in the last 24 months.",
      "Company registration tenure: synthetic profile indicates under five years of continuous trading identity.",
      "Complaint / dispute density: synthetic sample shows elevated dispute notes on packaging and MOQ changes.",
    ],
    recommendation:
      "Start with a small trial order before increasing volume; re-check credit after the first settled shipment.",
  }));
}

/**
 * Stripe Checkout for publisher credits, or a configure-Stripe message.
 * @param {{ api_key?: string, session_id?: string, quantity?: number, success_url?: string, cancel_url?: string }} params
 */
export async function buy_credits(params = {}) {
  const loaded = configOrError();
  if (!loaded.ok) return loaded;
  const result = params.session_id
    ? await confirmCreditCheckout(loaded.config, {
        apiKey: params.api_key,
        sessionId: params.session_id,
      })
    : await createCreditCheckout(loaded.config, {
        apiKey: params.api_key,
        quantity: params.quantity,
        successUrl: params.success_url,
        cancelUrl: params.cancel_url,
      });
  return publicResult(result);
}

/**
 * @param {{ api_key?: string, client_ip?: string }} params
 */
export function account_status(params = {}) {
  const loaded = configOrError();
  if (!loaded.ok) return loaded;
  return publicResult(
    getAccountStatus(loaded.config, {
      apiKey: params.api_key,
      clientIp: params.client_ip,
    })
  );
}

export async function callTool(name, args = {}) {
  switch (name) {
    case "evaluate_transit_viability":
      return evaluate_transit_viability(args);
    case "check_supplier_credit":
      return check_supplier_credit(args);
    case "buy_credits":
      return buy_credits(args);
    case "account_status":
      return account_status(args);
    default:
      return {
        error: "unknown_tool",
        message: `Unknown tool: ${name}`,
        _billing: { ...noneBilling },
      };
  }
}

const entry = process.argv[1] || "";
const isMain =
  Boolean(entry) &&
  (entry.endsWith("index.js") || entry.includes("hk-transit-judge"));

if (isMain) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hk-judge-smoke-"));
  process.env.HK_JUDGE_DATA_DIR = dir;
  process.env.HK_JUDGE_API_KEYS = "hkj_demo_smoke:10";
  process.env.HK_JUDGE_API_KEY = "hkj_demo_smoke";
  process.env.HK_JUDGE_CREDIT_COST = "1";
  process.env.HK_JUDGE_FREE_CALLS_PER_DAY = "5";
  const transit = evaluate_transit_viability({
    sku: "generic teeth whitening strips",
    destination_country: "Europe and the Middle East",
  });
  const credit = check_supplier_credit({
    supplier_name: "Guangzhou OralCare Wholesale Co.",
    supplier_url: "https://www.alibaba.com/example-supplier",
    product_category: "oral care / teeth whitening",
  });
  console.log(
    JSON.stringify(
      { evaluate_transit_viability: transit, check_supplier_credit: credit },
      null,
      2
    )
  );
}
