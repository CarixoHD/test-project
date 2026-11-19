// Regenerates src/server/llm/prices.json from the models.dev catalogue (docs/decisions/0003).
// Usage: node scripts/update-prices.mjs   (needs network; never run by tests)
// Keeps base-tier token prices (USD per 1M tokens) for the providers Vibecode supports.
// Context-length tiers and audio prices are dropped; web search prices live in pricing.ts.
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://models.dev/api.json';
const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'];
const OUT = new URL('../src/server/llm/prices.json', import.meta.url);
const TIMEOUT_MS = 30_000;

/** models.dev cost field → our Price field. */
const FIELDS = [
  ['input', 'input'],
  ['output', 'output'],
  ['cache_read', 'cacheRead'],
  ['cache_write', 'cacheWrite'],
  ['reasoning', 'reasoning'],
];

const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function toPrice(cost) {
  if (!isObject(cost) || !isRate(cost.input) || !isRate(cost.output)) return undefined;
  const price = {};
  for (const [from, to] of FIELDS) if (isRate(cost[from])) price[to] = cost[from];
  return price;
}

function buildTable(api, fetchedAt) {
  if (!isObject(api)) throw new Error(`${SOURCE}: expected a JSON object`);
  const providers = {};
  for (const id of PROVIDERS) {
    const models = api[id]?.models;
    if (!isObject(models)) throw new Error(`${SOURCE}: provider "${id}" is missing`);
    const prices = {};
    for (const modelId of Object.keys(models).sort()) {
      const price = toPrice(models[modelId]?.cost);
      if (price !== undefined) prices[modelId] = price;
    }
    providers[id] = prices;
  }
  return { source: SOURCE, fetchedAt, providers };
}

async function main() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
  const table = buildTable(await res.json(), new Date().toISOString());
  writeFileSync(OUT, `${JSON.stringify(table, null, 2)}\n`);
  const counts = PROVIDERS.map((p) => `${p}=${Object.keys(table.providers[p]).length}`);
  console.log(`wrote ${OUT.pathname} (${counts.join(', ')})`);
}

main().catch((err) => {
  console.error(`update-prices failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
