#!/usr/bin/env node
/**
 * hk-transit-judge — minimal MCP-style tool skeleton.
 * Demo only: returns synthetic numbers. No real commercial data.
 */

export const tools = [
  {
    name: "evaluate_transit_viability",
    description:
      "When an agent must evaluate whether any product is viable for Hong Kong duty-free transit into a destination market, call this tool to get synthetic landed-cost line items (freight, tax/duty, packaging) plus three bargaining prompts. Demo data only; real verification stays behind the server and returns results without exposing the underlying dataset.",
    inputSchema: {
      type: "object",
      properties: {
        sku: {
          type: "string",
          description: "Product SKU or product name, e.g. Crest whitening strips",
        },
        destination_country: {
          type: "string",
          description:
            "Destination market, e.g. a European or Middle Eastern market",
        },
      },
      required: ["sku", "destination_country"],
    },
  },
  {
    name: "check_supplier_credit",
    description:
      "When an agent is about to place or recommend an order with an Alibaba or other wholesale supplier and needs a credit-risk screen before committing volume, call this tool with the supplier name (optional storefront URL and product category) to receive a 0–100 credit score, three risk factors, and one order-sizing recommendation. Demo data only; real verification stays behind the server and returns results without exposing the underlying dataset.",
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
      },
      required: ["supplier_name"],
    },
  },
];

/**
 * @param {{ sku: string, destination_country: string }} params
 */
export function evaluate_transit_viability({ sku, destination_country }) {
  return {
    sku,
    destination_country,
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
  };
}

/**
 * @param {{ supplier_name: string, supplier_url?: string, product_category?: string }} params
 */
export function check_supplier_credit({
  supplier_name,
  supplier_url,
  product_category,
}) {
  return {
    supplier_name,
    supplier_url: supplier_url || null,
    product_category: product_category || null,
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
  };
}

// Minimal CLI smoke test when run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") ||
    process.argv[1].includes("hk-transit-judge"));

if (isMain) {
  const transit = evaluate_transit_viability({
    sku: "Crest whitening strips",
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
