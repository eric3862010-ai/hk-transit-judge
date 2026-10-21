#!/usr/bin/env node
/**
 * Minimal Stripe webhook for the first paid-credit test.
 * Node http only. No Stripe SDK.
 *
 * Listens for checkout.session.completed, checks Stripe-Signature with
 * STRIPE_WEBHOOK_SECRET, then calls confirmCreditCheckout({ operatorGrant: true }).
 * The grant still re-fetches the Checkout Session with STRIPE_SECRET_KEY and
 * adds credits only when Stripe reports payment_status=paid and a positive amount.
 */

import http from "node:http";
import crypto from "node:crypto";
import { confirmCreditCheckout, loadConfig } from "./billing.js";

export const DEFAULT_WEBHOOK_PATH = "/stripe/webhook";
export const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_BODY_BYTES = 1_048_576;

function signatureFailure(error, message) {
  return { ok: false, error, message };
}

/**
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the endpoint secret.
 * @param {Buffer | string} rawBody
 * @param {string} signatureHeader
 * @param {string} secret
 * @param {{ toleranceSeconds?: number, now?: number }} [options]
 */
export function verifyStripeSignature(rawBody, signatureHeader, secret, options = {}) {
  if (!secret) {
    return signatureFailure(
      "webhook_secret_missing",
      "Set STRIPE_WEBHOOK_SECRET. Unsigned events are refused."
    );
  }
  if (typeof signatureHeader !== "string" || signatureHeader.trim() === "") {
    return signatureFailure("invalid_signature", "Missing Stripe-Signature header.");
  }
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowMs = options.now ?? Date.now();
  let timestamp = "";
  const signatures = [];
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) {
    return signatureFailure("invalid_signature", "Stripe-Signature is missing t or v1.");
  }
  const ageSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > toleranceSeconds) {
    return signatureFailure(
      "invalid_signature",
      "Stripe-Signature timestamp is outside the tolerance window."
    );
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const match = signatures.some((sig) => {
    const got = Buffer.from(sig, "utf8");
    if (got.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(got, expectedBuf);
  });
  if (!match) {
    return signatureFailure(
      "invalid_signature",
      "Stripe-Signature did not match STRIPE_WEBHOOK_SECRET."
    );
  }
  return { ok: true };
}

function httpStatusForGrant(result) {
  if (result.ok) return 200;
  const retry = new Set([
    "stripe_error",
    "billing_error",
    "ledger_invalid",
    "stripe_not_configured",
    "payment_incomplete",
  ]);
  return retry.has(result.error) ? 500 : 200;
}

/**
 * Verify one webhook delivery and grant credits when the event is a completed checkout.
 * @param {ReturnType<typeof loadConfig>} config
 */
export async function handleStripeWebhook(
  config,
  { rawBody, signatureHeader, fetchImpl, now, toleranceSeconds } = {}
) {
  const verified = verifyStripeSignature(rawBody, signatureHeader, config.stripeWebhookSecret, {
    now,
    toleranceSeconds,
  });
  if (!verified.ok) {
    return {
      status: 400,
      body: { received: false, error: verified.error, message: verified.message },
    };
  }
  let event;
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
    event = JSON.parse(text);
  } catch {
    return {
      status: 400,
      body: { received: false, error: "invalid_payload", message: "Webhook body is not JSON." },
    };
  }
  if (!event || event.object !== "event" || typeof event.type !== "string") {
    return {
      status: 400,
      body: { received: false, error: "invalid_payload", message: "Webhook body is not a Stripe event." },
    };
  }
  if (event.type !== "checkout.session.completed") {
    return { status: 200, body: { received: true, ignored: true, type: event.type } };
  }
  const sessionId = event.data?.object?.id;
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return {
      status: 400,
      body: {
        received: false,
        error: "invalid_payload",
        message: "checkout.session.completed is missing data.object.id.",
      },
    };
  }
  const result = await confirmCreditCheckout(config, {
    sessionId,
    operatorGrant: true,
    fetchImpl,
  });
  if (!result.ok) {
    return {
      status: httpStatusForGrant(result),
      body: {
        received: true,
        granted: false,
        error: result.error,
        message: result.message,
      },
    };
  }
  return {
    status: 200,
    body: {
      received: true,
      granted: result.already_applied !== true,
      already_applied: Boolean(result.already_applied),
      credits_added: result.credits_added,
      credits_remaining: result.credits_remaining,
    },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error("Webhook body exceeds 1 MiB.");
        err.code = "payload_too_large";
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ fetchImpl?: typeof fetch, toleranceSeconds?: number, path?: string }} [options]
 */
export function createWebhookServer(config, options = {}) {
  const webhookPath = options.path || process.env.HK_JUDGE_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/health") {
      send(200, { ok: true, service: "hk-judge-stripe-webhook" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== webhookPath) {
      send(404, { error: "not_found" });
      return;
    }
    let rawBody;
    try {
      rawBody = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      const status = err.code === "payload_too_large" ? 413 : 400;
      send(status, { received: false, error: err.code || "invalid_payload", message: err.message });
      return;
    }
    const headerValue = req.headers["stripe-signature"];
    const signatureHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    try {
      const result = await handleStripeWebhook(config, {
        rawBody,
        signatureHeader,
        fetchImpl: options.fetchImpl,
        toleranceSeconds: options.toleranceSeconds,
      });
      send(result.status, result.body);
    } catch (err) {
      send(500, {
        received: false,
        error: "billing_error",
        message: err.message || "Webhook handler failed.",
      });
    }
  });
}

/**
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ port?: number, host?: string, path?: string, fetchImpl?: typeof fetch }} [options]
 */
export function startWebhookServer(config, options = {}) {
  const port = options.port ?? Number(process.env.HK_JUDGE_WEBHOOK_PORT || 8787);
  const host = options.host ?? (process.env.HK_JUDGE_WEBHOOK_HOST || "127.0.0.1");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(new Error("HK_JUDGE_WEBHOOK_PORT must be an integer from 0 to 65535."));
  }
  const server = createWebhookServer(config, options);
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

function webhookMain() {
  const entry = process.argv[1] || "";
  return Boolean(entry) && (entry.endsWith("webhook.js") || entry.includes("hk-judge-webhook"));
}

if (webhookMain()) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!config.stripeWebhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is required. Refusing to start an unsigned webhook.");
    process.exit(1);
  }
  if (!config.stripeSecret) {
    console.error(
      "STRIPE_SECRET_KEY is required so checkout.session.completed can be re-verified with Stripe."
    );
    process.exit(1);
  }
  const host = process.env.HK_JUDGE_WEBHOOK_HOST || "127.0.0.1";
  const pathName = process.env.HK_JUDGE_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;
  startWebhookServer(config, { host, path: pathName })
    .then((server) => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : "";
      console.log(`hk-judge stripe webhook listening on http://${host}:${port}${pathName}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
