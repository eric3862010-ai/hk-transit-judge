import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createCreditCheckout, hashApiKey, loadConfig } from "../billing.js";
import { handleStripeWebhook, verifyStripeSignature, createWebhookServer } from "../webhook.js";

const now = Date.parse("2026-10-20T16:00:00.000Z");
const secret = "whsec_test_signing_secret";

function tempConfig(extra = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hk-judge-hook-"));
  const config = loadConfig({
    HK_JUDGE_DATA_DIR: dataDir,
    HK_JUDGE_API_KEYS: "hkj_test_empty:0",
    HK_JUDGE_CREDITS_PER_CHECKOUT: "25",
    STRIPE_SECRET_KEY: "sk_test_replace_me",
    STRIPE_PRICE_ID: "price_test_pack",
    STRIPE_WEBHOOK_SECRET: secret,
    ...extra,
  });
  return { config, dataDir };
}

function sign(raw, timestampSec, signingSecret = secret) {
  const v1 = crypto.createHmac("sha256", signingSecret).update(`${timestampSec}.${raw}`).digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}

function paidFetch(sessionId) {
  return async (url, opts = {}) => {
    if (opts.method === "POST") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            id: sessionId,
            url: `https://checkout.stripe.com/c/pay/${sessionId}`,
          });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          id: sessionId,
          payment_status: "paid",
          amount_total: 500,
          client_reference_id: hashApiKey("hkj_test_empty"),
          metadata: { api_key_hash: hashApiKey("hkj_test_empty"), credits: "25" },
        });
      },
    };
  };
}

describe("stripe webhook", () => {
  it("reads STRIPE_WEBHOOK_SECRET into config and rejects a bad signature", () => {
    const { config } = tempConfig();
    assert.equal(config.stripeWebhookSecret, secret);
    const raw = '{"id":"evt_test"}';
    const bad = verifyStripeSignature(raw, sign(raw, 1, "whsec_other"), secret, { now });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "invalid_signature");
    const missing = verifyStripeSignature(raw, sign(raw, Math.floor(now / 1000)), "", { now });
    assert.equal(missing.error, "webhook_secret_missing");
  });

  it("grants the pending pack on a signed checkout.session.completed event", async () => {
    const { config } = tempConfig();
    const fetchImpl = paidFetch("cs_test_webhookpack");
    const created = await createCreditCheckout(config, {
      apiKey: "hkj_test_empty",
      fetchImpl,
    });
    assert.equal(created.session_id, "cs_test_webhookpack");
    const event = {
      id: "evt_test_completed",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_webhookpack", object: "checkout.session" } },
    };
    const raw = JSON.stringify(event);
    const header = sign(raw, Math.floor(now / 1000));
    const result = await handleStripeWebhook(config, {
      rawBody: raw,
      signatureHeader: header,
      fetchImpl,
      now,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.granted, true);
    assert.equal(result.body.credits_added, 25);
    assert.equal(result.body.credits_remaining, 25);
    const replay = await handleStripeWebhook(config, {
      rawBody: raw,
      signatureHeader: header,
      fetchImpl,
      now,
    });
    assert.equal(replay.body.already_applied, true);
    assert.equal(replay.body.credits_remaining, 25);
  });

  it("does not grant when the signature is wrong or the event is unrelated", async () => {
    const { config } = tempConfig();
    const fetchImpl = paidFetch("cs_test_webhookskip");
    await createCreditCheckout(config, { apiKey: "hkj_test_empty", fetchImpl });
    const completed = {
      id: "evt_test_bad",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_webhookskip" } },
    };
    const raw = JSON.stringify(completed);
    const rejected = await handleStripeWebhook(config, {
      rawBody: raw,
      signatureHeader: sign(raw, Math.floor(now / 1000), "whsec_wrong"),
      fetchImpl,
      now,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.granted, undefined);
    const other = JSON.stringify({
      id: "evt_test_other",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_test" } },
    });
    const ignored = await handleStripeWebhook(config, {
      rawBody: other,
      signatureHeader: sign(other, Math.floor(now / 1000)),
      fetchImpl,
      now,
    });
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body.ignored, true);
    const { getAccountStatus } = await import("../billing.js");
    assert.equal(getAccountStatus(config, { apiKey: "hkj_test_empty" }).credits_remaining, 0);
  });

  it("serves POST /stripe/webhook over HTTP", async () => {
    const { config } = tempConfig();
    const fetchImpl = paidFetch("cs_test_httppack");
    await createCreditCheckout(config, { apiKey: "hkj_test_empty", fetchImpl });
    const server = createWebhookServer(config, { fetchImpl });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const event = JSON.stringify({
      id: "evt_test_http",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_httppack" } },
    });
    const header = sign(event, Math.floor(Date.now() / 1000));
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/stripe/webhook",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": header,
            "content-length": Buffer.byteLength(event),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          });
        }
      );
      req.on("error", reject);
      req.end(event);
    });
    server.close();
    assert.equal(response.status, 200);
    assert.equal(response.body.granted, true);
    assert.equal(response.body.credits_added, 25);
  });
});
