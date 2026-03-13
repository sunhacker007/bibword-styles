import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load demo data once at startup ────────────────────────────────────────────
const { entries: DEMO_ENTRIES } = JSON.parse(
  readFileSync(join(__dirname, "data/demo-sanctions.json"), "utf-8")
);

// ── Levenshtein distance (for fuzzy name matching) ────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function normalise(s) {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

// ── Demo list check ───────────────────────────────────────────────────────────
function checkDemo(name) {
  const q = normalise(name);
  for (const entry of DEMO_ENTRIES) {
    const allNames = [...entry.names, ...(entry.aliases || [])].map(normalise);
    for (const n of allNames) {
      if (n === q) return { hit: true, matchType: "exact", entry };
      if (levenshtein(q, n) <= 2) return { hit: true, matchType: "fuzzy", entry };
    }
  }
  return { hit: false };
}

// ── Real provider stubs (activate by setting SANCTIONS_PROVIDER env var) ──────

async function checkComplyAdvantage(name) {
  // Activate: SANCTIONS_PROVIDER=complyadvantage COMPLY_ADVANTAGE_API_KEY=xxx
  const apiKey = process.env.COMPLY_ADVANTAGE_API_KEY;
  if (!apiKey) throw new Error("COMPLY_ADVANTAGE_API_KEY not set");

  const resp = await fetch("https://api.complyadvantage.com/searches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${apiKey}`,
    },
    body: JSON.stringify({
      search_term: name,
      fuzziness: 0.6,
      filters: { types: ["sanction", "pep", "warning"] },
    }),
  });
  const data = await resp.json();
  const hits = data?.content?.data?.hits || [];
  if (hits.length > 0) {
    return {
      hit: true,
      matchType: hits[0].match_types?.[0] || "exact",
      entry: { id: hits[0].doc?.id, names: [hits[0].doc?.name], list: hits[0].doc?.sources?.[0]?.name },
    };
  }
  return { hit: false };
}

async function checkWorldCheck(name) {
  // Activate: SANCTIONS_PROVIDER=worldcheck WORLDCHECK_API_KEY=xxx WORLDCHECK_API_SECRET=xxx
  // Refinitiv World-Check One API
  // https://developers.refinitiv.com/en/api-catalog/world-check-one/world-check-one-api
  throw new Error("World-Check integration: set WORLDCHECK_API_KEY and WORLDCHECK_API_SECRET");
}

// ── Public interface ──────────────────────────────────────────────────────────

const PROVIDER = process.env.SANCTIONS_PROVIDER || "demo";

export async function checkSanctions(name) {
  if (!name) return { hit: false };
  try {
    switch (PROVIDER) {
      case "complyadvantage": return await checkComplyAdvantage(name);
      case "worldcheck":      return await checkWorldCheck(name);
      default:                return checkDemo(name);
    }
  } catch (err) {
    console.error("[sanctions] check failed:", err.message);
    return { hit: false, error: err.message };
  }
}
