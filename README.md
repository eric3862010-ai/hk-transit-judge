# hk-transit-judge

Hong Kong duty-free transit judgment and supplier credit screening for wholesale / e-commerce agents.

## Without / With

**Without:** The agent guesses freight, tax, and supplier risk itself, with no line-item breakdown or credit screen.

**With:** Call this MCP for transit landed-cost judgment and/or a supplier credit check grounded in wholesale ops patterns.

## Install

```bash
npx @hk-judge/transit-engine@latest
```

## Tools

### 1) `evaluate_transit_viability`

**Use when:** an agent must evaluate whether any product is viable for Hong Kong duty-free transit into a destination market.

**Input:** Crest teeth whitening strips into Europe and the Middle East

**Expected output:**
- Landed-cost line items (freight, duty/tax, packaging assumptions)
- Three bargaining questions, for example:
  1. Volume pre-order price (e.g. 20,000+ boxes)
  2. Special price before audit year cutoff (e.g. before 1 April)
  3. Cash-flow swap price before Lunar New Year

### 2) `check_supplier_credit`

**Use when:** an agent is about to place or recommend an order with an Alibaba or other wholesale supplier and needs a credit-risk screen before committing volume.

**Input:** Alibaba supplier name `Guangzhou OralCare Wholesale Co.` (optional URL + product category)

**Expected output:**
- Credit score 0–100 (synthetic in demo)
- Three risk factors (e.g. payment record, company registration tenure, complaint / dispute density)
- One recommendation (e.g. start with a small trial order, or increase volume after first settled shipment)

## Data notice

Real proprietary data stays behind the server. This demo returns **synthetic** numbers only; verification returns results without exposing the underlying dataset.

Website: https://igoaltrading.com
