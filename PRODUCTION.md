# First paid-credit test

This file is the operator checklist for charging a real (or Stripe test-mode) card against `@hk-judge/transit-engine` 0.2.0. The package does not publish itself and does not contain secrets.

Judgment output stays synthetic. The free daily allowance stays on unless you set `HK_JUDGE_FREE_CALLS_PER_DAY=0`.

## Ledger

Balances are only the local file `credits.json` inside `HK_JUDGE_DATA_DIR` (default `./data`, gitignored). The raw API key is not stored. The account id is the SHA-256 of the key.

That file is the system of record for this package:

- Losing the file loses balances and which Checkout Sessions were already applied.
- `buy_credits` writes a pending session before the customer pays. The webhook grants only sessions that pending record still holds, on the same directory.
- Two processes writing the file at the same time can overwrite each other. For this test, do not leave a long-running tool host and the webhook writing together. Create the Checkout Session, let that process exit, then let the webhook be the only writer while the card is charged.

A later release can replace the file with a database. This test does not.

## Environment variables

Set these in the process environment or in a gitignored `.env` that you load yourself. `.env.example` lists the names with empty values. Do not commit real values.

### Required before `buy_credits` returns a Checkout URL

| Variable | Example shape | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_...` or `sk_live_...` | Bearer token for the Stripe API. Never commit it. |
| `STRIPE_PRICE_ID` | `price_...` | One-time Price created in the Stripe Dashboard. |
| `HK_JUDGE_STRIPE_PRICE_ID` | `price_...` | Alias used only when `STRIPE_PRICE_ID` is empty. |

### Required before the webhook will start

| Variable | Example shape | Notes |
| --- | --- | --- |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Signing secret from `stripe listen` or the Dashboard endpoint. The listener refuses to start without it. |
| `STRIPE_SECRET_KEY` | `sk_test_...` | Also required at startup. The handler re-fetches the Checkout Session and does not trust the event body for payment status. |

### Pack size and return URLs

| Variable | Default | Notes |
| --- | --- | --- |
| `HK_JUDGE_CREDITS_PER_CHECKOUT` | `1000` | Credits granted per Price quantity. |
| `HK_JUDGE_MAX_CREDITS_PER_CHECKOUT` | `1000000` | Hard cap for one checkout. |
| `STRIPE_SUCCESS_URL` | `https://igoaltrading.com/?credits=success&session_id={CHECKOUT_SESSION_ID}` | Leave `{CHECKOUT_SESSION_ID}` unencoded so Stripe can substitute it. |
| `STRIPE_CANCEL_URL` | `https://igoaltrading.com/?credits=cancel` | Browser cancel URL. |

### Keys, free path, and the ledger directory

| Variable | Default | Notes |
| --- | --- | --- |
| `HK_JUDGE_DATA_DIR` | `./data` | Shared by the process that calls `buy_credits` and the webhook. |
| `HK_JUDGE_API_KEYS` | empty | Seed `key:credits`. Use `0` to start on the free allowance. |
| `HK_JUDGE_KEYS_FILE` | empty | Same seed from a file outside git. |
| `HK_JUDGE_API_KEY` | empty | Consumer key for this process. |
| `HK_JUDGE_CREDIT_COST` | `1` | Credits per successful judgment. |
| `HK_JUDGE_FREE_CALLS_PER_DAY` | `5` | Free successes per UTC day. `0` turns the allowance off. |

### Webhook bind

| Variable | Default | Notes |
| --- | --- | --- |
| `HK_JUDGE_WEBHOOK_HOST` | `127.0.0.1` | Set `0.0.0.0` only when you intend to expose the port. |
| `HK_JUDGE_WEBHOOK_PORT` | `8787` | TCP port. |
| `HK_JUDGE_WEBHOOK_PATH` | `/stripe/webhook` | POST path Stripe should call. |

## Human steps

1. In the Stripe Dashboard, test mode first, create a Product and a **one-time** Price. Copy `price_...` into `STRIPE_PRICE_ID`. The dollar amount is whatever you set on that Price. This repo does not set a price.
2. Copy the secret key into `STRIPE_SECRET_KEY` in the shell or a gitignored env file. Do not put it in the repo.
3. Mint a publisher key and seed it so checkout has an account to attach to:

   ```bash
   openssl rand -hex 24
   export HK_JUDGE_API_KEYS="hkj_paste_the_hex_here:0"
   export HK_JUDGE_API_KEY="hkj_paste_the_hex_here"
   export HK_JUDGE_DATA_DIR="/var/lib/hk-judge"
   mkdir -p "$HK_JUDGE_DATA_DIR"
   ```

4. Create the Checkout Session from a short-lived process (so it is not still writing the ledger when the webhook runs). One way:

   ```bash
   node --input-type=module -e '
     import { buy_credits } from "./index.js";
     const result = await buy_credits({ quantity: 1 });
     console.log(JSON.stringify(result, null, 2));
   '
   ```

   Copy `checkout_url` and `session_id`. Do not pay yet.

5. Start the webhook with the **same** `HK_JUDGE_DATA_DIR`, `STRIPE_SECRET_KEY`, and key seed:

   ```bash
   npm run webhook
   ```

   It listens on `http://127.0.0.1:8787/stripe/webhook` unless you change the bind variables. `GET /health` returns `{ "ok": true }`.

6. Give Stripe a signing secret:
   - Local: `stripe listen --forward-to localhost:8787/stripe/webhook`
   - Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET` and restart `npm run webhook`.
   - Public host: Dashboard → Developers → Webhooks → add endpoint `https://<your-host>/stripe/webhook`, event **`checkout.session.completed`**, then use that endpoint's signing secret the same way.

7. Open `checkout_url` and pay. In test mode the card is `4242 4242 4242 4242`, any future expiry, any CVC.

8. Stripe POSTs `checkout.session.completed`. The handler:
   - rejects a missing, stale (older than 5 minutes), or mismatched `Stripe-Signature` with HTTP 400
   - ignores every other event type with HTTP 200 and does not change balances
   - calls `confirmCreditCheckout` with `operatorGrant: true`
   - that call fetches `GET /v1/checkout/sessions/{id}` and adds the pending pack only when `payment_status` is `paid` and `amount_total` is greater than 0
   - a second delivery of the same session returns `already_applied` and does not add credits again

9. Check the balance:

   ```bash
   node --input-type=module -e '
     import { account_status } from "./index.js";
     console.log(JSON.stringify(await account_status(), null, 2));
   '
   ```

   Then call `evaluate_transit_viability`. A paid balance spends `HK_JUDGE_CREDIT_COST` and still returns the synthetic demo (freight 42.5 / tax 18.0 / packaging 6.75, destination wording “Europe and the Middle East”).

10. A person publishes 0.2.0 to npm when they choose to. Nothing in this package runs `npm publish`.

If the webhook is down, the fallback is `buy_credits({ session_id })` with the same API key that opened checkout. The tool cannot set `operatorGrant`.

## What stays free

No API key, or a known key whose balance is `0`, still gets `HK_JUDGE_FREE_CALLS_PER_DAY` successful synthetic calls per UTC day. Configuring Stripe does not remove that path.
