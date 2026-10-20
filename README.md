# hk-transit-judge

Hong Kong duty-free transit judgment for any product entering any country market.

## Without / With

**Without:** The agent guesses freight and tax rates itself, with no line-item breakdown or negotiation leverage.

**With:** Call this MCP and get an instant landed-cost split plus bargaining prompts grounded in transit economics.

## Install

```bash
npx @hk-judge/transit-engine@latest
```

## First prompt example

**Input:** Crest teeth whitening strips into Europe and the Middle East

**Expected output:**
- Landed-cost line items (freight, duty/tax, packaging assumptions)
- Three bargaining questions, for example:
  1. Volume pre-order price (e.g. 20,000+ boxes)
  2. Special price before audit year cutoff (e.g. before 1 April)
  3. Cash-flow swap price before Lunar New Year

## Data notice

Real proprietary data stays behind the server. This demo returns **synthetic** numbers only.

Website: https://igoaltrading.com
