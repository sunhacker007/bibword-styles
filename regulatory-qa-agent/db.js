import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "fcap.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT,
    customer_name TEXT,
    eval_source TEXT DEFAULT 'manual',  -- 'manual' | 'batch'
    aml_score INTEGER,
    aml_decision TEXT,
    aml_decision_level TEXT,
    kyc_tier TEXT,
    kyc_tier_label TEXT,
    triggered_rules TEXT,  -- JSON array string
    ai_analysis TEXT,
    sar_required INTEGER DEFAULT 0,
    sanctions_hit INTEGER DEFAULT 0,
    batch_job_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    filename TEXT,
    total_rows INTEGER DEFAULT 0,
    processed_rows INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',  -- pending | processing | done | error
    error_msg TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER,
    customer_id TEXT,
    customer_name TEXT,
    aml_score INTEGER,
    kyc_tier TEXT,
    risk_level TEXT,  -- high | medium
    status TEXT DEFAULT 'OPEN',  -- OPEN | REVIEWING | CLOSED
    notes TEXT,
    decision TEXT,  -- confirmed | false_positive | escalated
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Evaluations ──────────────────────────────────────────────────────────────

const insertEval = db.prepare(`
  INSERT INTO evaluations
    (customer_id, customer_name, eval_source, aml_score, aml_decision,
     aml_decision_level, kyc_tier, kyc_tier_label, triggered_rules,
     ai_analysis, sar_required, sanctions_hit, batch_job_id)
  VALUES
    (@customer_id, @customer_name, @eval_source, @aml_score, @aml_decision,
     @aml_decision_level, @kyc_tier, @kyc_tier_label, @triggered_rules,
     @ai_analysis, @sar_required, @sanctions_hit, @batch_job_id)
`);

export function saveEvaluation(data) {
  const info = insertEval.run(data);
  return info.lastInsertRowid;
}

// ── Batch Jobs ───────────────────────────────────────────────────────────────

export function createBatchJob(id, filename, totalRows) {
  db.prepare(
    "INSERT INTO batch_jobs (id, filename, total_rows, status) VALUES (?, ?, ?, 'processing')"
  ).run(id, filename, totalRows);
}

export function updateBatchProgress(id, processed) {
  db.prepare("UPDATE batch_jobs SET processed_rows = ? WHERE id = ?").run(processed, id);
}

export function finalizeBatchJob(id, status, errorMsg = null) {
  db.prepare("UPDATE batch_jobs SET status = ?, error_msg = ? WHERE id = ?").run(
    status,
    errorMsg,
    id
  );
}

export function getBatchJob(id) {
  return db.prepare("SELECT * FROM batch_jobs WHERE id = ?").get(id);
}

export function getBatchEvaluations(jobId) {
  return db
    .prepare("SELECT * FROM evaluations WHERE batch_job_id = ? ORDER BY id")
    .all(jobId);
}

// ── Cases ─────────────────────────────────────────────────────────────────────

export function createCase(data) {
  const info = db
    .prepare(
      `INSERT INTO cases (evaluation_id, customer_id, customer_name, aml_score, kyc_tier, risk_level)
       VALUES (@evaluation_id, @customer_id, @customer_name, @aml_score, @kyc_tier, @risk_level)`
    )
    .run(data);
  return info.lastInsertRowid;
}

export function listCases({ status, risk_level, limit = 50, offset = 0 } = {}) {
  let sql = "SELECT * FROM cases WHERE 1=1";
  const params = [];
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (risk_level) { sql += " AND risk_level = ?"; params.push(risk_level); }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function getCase(id) {
  return db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
}

export function updateCase(id, fields) {
  const allowed = ["status", "notes", "decision"];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(id);
  db.prepare(`UPDATE cases SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

// ── Dashboard Stats ───────────────────────────────────────────────────────────

export function getDashboardStats() {
  const amlTotals = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN aml_decision_level='high' THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN aml_decision_level='medium' THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN aml_decision_level='low' THEN 1 ELSE 0 END) as low,
        SUM(sar_required) as sar_required
       FROM evaluations`
    )
    .get();

  const kycTiers = db
    .prepare("SELECT kyc_tier, COUNT(*) as count FROM evaluations WHERE kyc_tier IS NOT NULL GROUP BY kyc_tier")
    .all();

  const caseCounts = db
    .prepare("SELECT status, COUNT(*) as count FROM cases GROUP BY status")
    .all();

  const trend = db
    .prepare(
      `SELECT DATE(created_at) as date,
              COUNT(*) as total,
              SUM(CASE WHEN aml_decision_level='high' THEN 1 ELSE 0 END) as high,
              SUM(CASE WHEN aml_decision_level='medium' THEN 1 ELSE 0 END) as medium
       FROM evaluations
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT 14`
    )
    .all();

  // Rule frequency from JSON strings
  const allRules = db.prepare("SELECT triggered_rules FROM evaluations WHERE triggered_rules IS NOT NULL").all();
  const ruleCount = {};
  for (const row of allRules) {
    try {
      const rules = JSON.parse(row.triggered_rules);
      for (const r of rules) {
        ruleCount[r.id] = (ruleCount[r.id] || 0) + 1;
        if (!ruleCount[r.id + "_name"]) ruleCount[r.id + "_name"] = r.name;
      }
    } catch {}
  }
  const topRules = Object.keys(ruleCount)
    .filter((k) => !k.endsWith("_name"))
    .map((id) => ({ id, name: ruleCount[id + "_name"] || id, count: ruleCount[id] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    aml: { ...amlTotals },
    kyc: { by_tier: Object.fromEntries(kycTiers.map((r) => [r.kyc_tier, r.count])) },
    cases: Object.fromEntries(caseCounts.map((r) => [r.status, r.count])),
    trend: trend.reverse(),
    top_rules: topRules,
  };
}

export default db;
