# hk-transit-judge

Hong Kong duty-free transit judgment and supplier credit screening for ordinary everyday use.

You do not need to be a merchant or run a business. In the AI era, anyone can do this work — across departments, across skills, and across professions. What used to need a specialist in freight, tax, or supplier credit is now a tool call. Keep this MCP in your toolkit and your speed doubles whenever you need it, anytime, anywhere.

This package is a **synthetic demo only**. The numbers it returns are demo figures. Version **0.2.0** adds publisher API-key credits for `evaluate_transit_viability` and `check_supplier_credit`.

Publisher credits are a separate meter from Claude, Cursor, and other client model tokens. This package never reads those tokens and never puts a token field on a tool result.

`mcpName` is `com.igoaltrading/hk-transit-judge`. `publishConfig.access` is `public`. This checkout does not publish itself to npm.

## Pricing flow

1. **Get a key.** The publisher mints a key and seeds a starting balance (use `0` when the key should begin on the free allowance). There is no hosted signup in this package.
2. **Set the key.** The consumer sets `HK_JUDGE_API_KEY`, or passes `api_key` on a tool call.
3. **Free limited calls.** With no key, calls use a per-IP daily allowance. A known key whose paid balance is `0` uses the same allowance counted on that key.
4. **Paid calls spend credits.** Each successful `evaluate_transit_viability` or `check_supplier_credit` deducts `HK_JUDGE_CREDIT_COST` credits (default **1**) while the balance covers the cost. A positive balance smaller than the cost does not partially debit and does not fall through to the free allowance.
5. **Allowance used up.** The tool returns `payment_required` and omits the judgment.
6. **`buy_credits`.** Returns a Stripe Checkout URL when Stripe is configured. The tool call itself does not charge a card and does not deduct credits. Without Stripe env vars it returns a configure-Stripe message and no fake payment URL.
7. **Resume.** After the browser payment, either the webhook in [PRODUCTION.md](PRODUCTION.md) grants the pack, or call `buy_credits` again with `session_id`. Paid calls work again.

`buy_credits` and `account_status` are free. Failed validation does not spend credits. A call that the meter rejects does not include the judgment payload.

## Without / With

**Without:** The call waits on a specialist, or you guess freight, tax, and supplier risk yourself, with no line-item breakdown and no credit screen.

**With:** Anyone — any department, any skill, any profession — calls this MCP and gets a transit landed-cost judgment and/or a supplier credit check. With it in your toolkit, your speed doubles whenever you need it. Demo outputs are synthetic only.

## Install

This repository is version 0.2.0 and is not published by the pull request. Until a person publishes it, run the checkout:

```bash
node index.js
```

The last published package on npm is still the 0.1.x line:

```bash
npm i @hk-judge/transit-engine@0.1.2 && node node_modules/@hk-judge/transit-engine/index.js
```

`node index.js` (and the `hk-transit-judge` bin) prints a hermetic smoke demo. It uses a temporary ledger and the fixture key `hkj_demo_smoke` (10 credits). It does not read your live ledger and it does not print the key. Library and MCP hosts should import the module and set the env vars below instead of relying on that smoke path.

## Tools

### 1) `evaluate_transit_viability`

**Use when:** an agent must evaluate whether any product is viable for Hong Kong duty-free transit into a destination market.

**Input:** generic teeth whitening strips into Europe and the Middle East

**Expected output:**
- Landed-cost line items (freight, duty/tax, packaging assumptions). The synthetic demo figures stay `freight_usd` 42.5, `tax_or_duty_usd` 18.0, `packaging_usd` 6.75.
- Three bargaining questions, for example:
  1. Volume pre-order price (e.g. 20,000+ boxes)
  2. Special price before audit year cutoff (e.g. before 1 April)
  3. Cash-flow swap price before Lunar New Year
- `_billing` with `credits_charged`, `credits_remaining`, and `tier` (`paid` or `free`)

### 2) `check_supplier_credit`

**Use when:** an agent is about to place or recommend an order with an Alibaba or other wholesale supplier and needs a credit-risk screen before committing volume.

**Input:** Alibaba supplier name `Guangzhou OralCare Wholesale Co.` (optional URL + product category)

**Expected output:**
- Credit score 0–100 (synthetic demo score **72**)
- Three risk factors (payment record, company registration tenure, complaint / dispute density)
- One recommendation (start with a small trial order, then re-check after the first settled shipment)
- `_billing` with `credits_charged`, `credits_remaining`, and `tier`

### 3) `buy_credits` (free)

Returns a Stripe Checkout URL for the current API key when `STRIPE_SECRET_KEY` and a Price id are set. Optional `quantity` (1–99, default 1) is the number of Price units. Credits granted = `HK_JUDGE_CREDITS_PER_CHECKOUT` × quantity (default 1000 each).

Pass `session_id` (`cs_...`) after payment if you are not running the webhook. The package loads that Checkout Session from Stripe and, when `payment_status` is `paid` and the amount is positive, adds the pack it recorded locally for that session. Confirming the same session twice does not add credits twice.

If Stripe is not configured, the tool returns `stripe_not_configured` and names the env vars to set. It does not invent a checkout URL.

### 4) `account_status` (free)

Balance, per-call cost, and today's free-call remainder. Charges nothing.

## How to mint and set an API key

Publishers create a key locally. `openssl rand -hex 24` is enough. Seed it before the process serves traffic:

```bash
export HK_JUDGE_API_KEYS="hkj_replace_me:100"
```

Or point at a file that stays **out of git** (`keys.json` is gitignored):

```json
{
  "hkj_replace_me": 100
}
```

```bash
export HK_JUDGE_KEYS_FILE="./keys.json"
```

A starting balance of `0` is valid: the key is recognised and uses the free daily allowance until someone buys credits. When both the env var and the file list the same key, the file's starting balance wins for the **first** insert only. Later edits do not raise or lower a balance that is already in the ledger. Top-ups go through Stripe.

Consumers put the key in the host environment (preferred) or pass `api_key` on the call.

```bash
export HK_JUDGE_API_KEY="hkj_replace_me"
export HK_JUDGE_DATA_DIR="/var/lib/hk-judge"
```

A Claude or Cursor MCP host that should meter real callers needs to import this package and register `tools` with `callTool`, then put `HK_JUDGE_API_KEY` (and the seed / data dir) in that process environment. For a host with many users, pass `api_key` and `client_ip` on each call.

```javascript
import { callTool } from "@hk-judge/transit-engine";

const judged = await callTool("evaluate_transit_viability", {
  sku: "generic teeth whitening strips",
  destination_country: "Europe and the Middle East",
});
```

Claude and Cursor still bill their own model tokens for the chat. Those tokens are a separate meter. This package only sees its publisher credit ledger.

## Free tier and paid credits

| | Free | Paid |
| --- | --- | --- |
| Who | No key (counted per caller IP, or the single `local` bucket when the host does not pass one), or a known key with **0** paid credits (counted per key) | Known key whose balance covers `HK_JUDGE_CREDIT_COST` |
| Allowance | `HK_JUDGE_FREE_CALLS_PER_DAY` successes per UTC day (default **5**). `0` turns the allowance off | Balance in the local ledger |
| Charge | `credits_charged: 0`, `tier: "free"` | `credits_charged` is the configured cost, `tier: "paid"` |
| After the limit | `payment_required`. Judgment body is omitted | Same, once the balance no longer covers the cost |

A positive balance smaller than the cost does **not** fall through to the free allowance and does not partially debit. `buy_credits` is the way to continue.

Anonymous free calls hash the client IP before writing the ledger. Hosts should pass `client_ip` (or `HK_JUDGE_CLIENT_IP`). Without it, every anonymous caller in that process shares the `local` bucket.

## Credit cost

`HK_JUDGE_CREDIT_COST` is a positive integer, default `1`, and applies to each successful `evaluate_transit_viability` and `check_supplier_credit`. The same cost is used for both tools. Values below 1 are ignored and the default stays 1. The dollar price of a credit pack is the Stripe Price you create, not a number hard-coded here.

Each successful metered result includes:

```json
"_billing": {
  "credits_charged": 1,
  "credits_remaining": 99,
  "tier": "paid"
}
```

Free successes add `free_calls_remaining_today`. There is no token, prompt, or completion field.

## Stripe

`buy_credits` uses the Stripe Checkout Sessions API over HTTPS (`fetch`). There is no Stripe SDK dependency. The first real card test is written up in [PRODUCTION.md](PRODUCTION.md), including the webhook listener (`npm run webhook`).

| Variable | Role |
| --- | --- |
| `STRIPE_SECRET_KEY` | Secret key used only as a bearer token to Stripe. Never commit it. |
| `STRIPE_PRICE_ID` | Price id (`price_...`) for one credit pack. |
| `HK_JUDGE_STRIPE_PRICE_ID` | Alias of `STRIPE_PRICE_ID` when you want a package-scoped name. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) for `node webhook.js`. Never commit it. |
| `STRIPE_SUCCESS_URL` | Browser return URL. Default `https://igoaltrading.com/?credits=success&session_id={CHECKOUT_SESSION_ID}`. Leave `{CHECKOUT_SESSION_ID}` unencoded in the env value so Stripe can substitute it. |
| `STRIPE_CANCEL_URL` | Browser cancel URL. Default `https://igoaltrading.com/?credits=cancel`. |
| `HK_JUDGE_CREDITS_PER_CHECKOUT` | Credits granted for one unit of that Price. Default `1000`. |
| `HK_JUDGE_MAX_CREDITS_PER_CHECKOUT` | Safety cap for one checkout. Default `1000000`. |

Create the Price in Stripe (test mode or live). This package does not invent a payment when those variables are missing.

The webhook verifies `Stripe-Signature`, accepts `checkout.session.completed`, and calls `confirmCreditCheckout` with `operatorGrant: true`. That flag is a server-side API. The `buy_credits` tool cannot set it. The handler must use the same `HK_JUDGE_DATA_DIR` that created the session, because the pack size is stored in the local pending-checkout record. `confirmCreditCheckout` still fetches the session from Stripe and grants only when `payment_status` is `paid` and the amount is positive.

```javascript
import { confirmCreditCheckout, loadConfig } from "@hk-judge/transit-engine";

const result = await confirmCreditCheckout(loadConfig(), {
  sessionId: event.data.object.id,
  operatorGrant: true,
});
```

The demo confirm path also works from the tool: `buy_credits({ session_id: "cs_..." })` with the same API key that opened checkout.

## Local ledger

Balances live in `credits.json` under `HK_JUDGE_DATA_DIR` (default `./data`, gitignored). Accounts are keyed by the SHA-256 of the API key. The raw key is not written. File mode is `0600`.

**This file is a demo ledger.** Losing it loses balances and the record of which Checkout Sessions were already applied. Two processes writing the same file at the same time can overwrite each other. [PRODUCTION.md](PRODUCTION.md) lists the exact env vars and the single-writer procedure for a first card payment.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `HK_JUDGE_API_KEY` | Consumer key for this process | empty (anonymous free tier) |
| `HK_JUDGE_API_KEYS` | Seed `key:credits` pairs, comma-separated, or a JSON object | empty |
| `HK_JUDGE_KEYS_FILE` | Same seed data from a file | empty |
| `HK_JUDGE_CREDIT_COST` | Credits charged per successful judgment call | `1` |
| `HK_JUDGE_FREE_CALLS_PER_DAY` | Free successes per UTC day per key or per IP | `5` |
| `HK_JUDGE_DATA_DIR` | Directory for `credits.json` | `./data` |
| `HK_JUDGE_CLIENT_IP` | Anonymous free-tier identity when a call omits `client_ip` | `local` |
| `HK_JUDGE_CREDITS_PER_CHECKOUT` | Credits in one Stripe Price unit | `1000` |
| `STRIPE_SECRET_KEY` | Stripe secret key | unset |
| `STRIPE_PRICE_ID` | Stripe Price id | unset |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | unset |

## Data notice

Real proprietary data stays behind the server. This demo returns **synthetic** numbers only; verification returns results without exposing the underlying dataset. Demo destinations stay “Europe and the Middle East”. Demo products stay generic (teeth whitening strips, oral care, beauty wholesale). No brand names are used in the demo path.

Website: https://igoaltrading.com

## License

MIT
