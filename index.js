#!/usr/bin/env node
/**
 * hk-transit-judge — minimal MCP-style tool skeleton.
 * Demo only: returns synthetic numbers. No real commercial data.
 */

export const tools = [
  {
    name: "evaluate_transit_viability",
    description:
      "Hong Kong duty-free transit judgment for a SKU entering a destination country. Returns synthetic landed-cost line items and three bargaining prompts. Demo data only.",
    inputSchema: {
      type: "object",
      properties: {
        sku: {
          type: "string",
          description: "Product SKU or product name, e.g. Crest whitening strips",
        },
        destination_country: {
          type: "string",
          description: "ISO country name or code, e.g. United Kingdom or GB",
        },
      },
      required: ["sku", "destination_country"],
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

// Minimal CLI smoke test when run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") ||
    process.argv[1].includes("hk-transit-judge"));

if (isMain) {
  const demo = evaluate_transit_viability({
    sku: "Crest whitening strips",
    destination_country: "United Kingdom",
  });
  console.log(JSON.stringify(demo, null, 2));
}
