import ExcelJS from "exceljs";
import { runAMLRules } from "./aml.js";
import { assessKYC } from "./kyc.js";
import { checkSanctions } from "./sanctionsService.js";
import {
  saveEvaluation,
  createCase,
  updateBatchProgress,
  finalizeBatchJob,
  getBatchEvaluations,
} from "./db.js";

// ── Parse Excel buffer → array of plain objects ───────────────────────────────
async function parseExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = String(cell.value ?? "").toLowerCase().trim();
  });

  const rows = [];
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const obj = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const h = headers[col - 1];
      if (h) obj[h] = cell.value ?? "";
    });
    if (Object.keys(obj).length) rows.push(obj);
  });
  return rows;
}

// ── Input column mapping (case-insensitive) ───────────────────────────────────
function parseRow(raw) {
  const r = {};
  for (const [k, v] of Object.entries(raw)) r[k.toLowerCase().trim()] = v;

  const str = (k, def = "") => String(r[k] ?? def).trim();
  const num = (k, def = 0) => parseFloat(r[k] ?? def) || def;
  const bool = (k) => {
    const v = String(r[k] ?? "").toLowerCase().trim();
    return v === "true" || v === "1" || v === "yes" || v === "y";
  };

  return {
    customerId:            str("customer_id") || str("customerid") || `AUTO_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    customerName:          str("customer_name") || str("customername") || str("name"),
    amount:                num("amount", 0),
    counterpartyCountry:   str("counterparty_country") || str("counterpartycountry") || str("country"),
    accountAgeDays:        num("account_age_days") || num("accountagedays", 365),
    hourlyTxCount:         num("hourly_tx_count") || num("hourlytxcount", 0),
    percentOutWithin30Min: num("percent_out_within_30min") || num("percentoutwithin30min", 0),
    monthlyLimitUSD:       num("monthly_limit_usd") || num("monthlylimitusd", 1000),
    country:               str("country") || str("counterparty_country"),
    productType:           str("product_type") || str("producttype") || "regular",
    isPEP:                 bool("is_pep") || bool("ispep"),
    hasSanctionHit:        bool("has_sanction_hit") || bool("hassanctionhit"),
  };
}

// ── Token-efficient AI analysis (score >= 70 only, 50-token output) ───────────
async function getBatchAIAnalysis(client, model, tx, score, rules) {
  if (!client || score < 70) return null;
  const ruleIds = rules.map((r) => r.id).join(", ");
  const prompt = `AML评分${score}/100，规则：${ruleIds}，金额$${tx.amount}，账龄${tx.accountAgeDays}天。用1句话（50字内）说明主要风险点。`;
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 80,
    });
    return res.choices[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ── Main batch processor ──────────────────────────────────────────────────────
export async function processBatch(jobId, buffer, filename, qwenClient, qwenModel) {
  try {
    const rawRows = await parseExcel(buffer);

    if (!rawRows.length) {
      finalizeBatchJob(jobId, "error", "Excel文件为空或格式不正确");
      return;
    }

    let processed = 0;
    for (const raw of rawRows) {
      const row = parseRow(raw);

      let sanctionsHit = row.hasSanctionHit;
      if (!sanctionsHit && row.customerName) {
        const sc = await checkSanctions(row.customerName);
        sanctionsHit = sc.hit;
      }

      const { score, hits, decision, decisionLevel } = runAMLRules({
        amount: row.amount,
        counterpartyCountry: row.counterpartyCountry,
        accountAgeDays: row.accountAgeDays,
        hourlyTxCount: row.hourlyTxCount,
        percentOutWithin30Min: row.percentOutWithin30Min,
        sanctionsHit,
      });

      const kyc = assessKYC({
        amlScore: score,
        monthlyLimitUSD: row.monthlyLimitUSD,
        country: row.country,
        productType: row.productType,
        isPEP: row.isPEP,
        hasSanctionHit: sanctionsHit,
      });

      const sarRequired = score >= 70 || kyc.tier === "REJECT" ? 1 : 0;
      const aiAnalysis = await getBatchAIAnalysis(qwenClient, qwenModel, row, score, hits);

      const evalId = saveEvaluation({
        customer_id:        row.customerId,
        customer_name:      row.customerName,
        eval_source:        "batch",
        aml_score:          score,
        aml_decision:       decision,
        aml_decision_level: decisionLevel,
        kyc_tier:           kyc.tier,
        kyc_tier_label:     kyc.tierLabel,
        triggered_rules:    JSON.stringify(hits),
        ai_analysis:        aiAnalysis,
        sar_required:       sarRequired,
        sanctions_hit:      sanctionsHit ? 1 : 0,
        batch_job_id:       jobId,
      });

      if (decisionLevel === "high" || kyc.tier === "EDD" || kyc.tier === "REJECT") {
        createCase({
          evaluation_id: evalId,
          customer_id:   row.customerId,
          customer_name: row.customerName,
          aml_score:     score,
          kyc_tier:      kyc.tier,
          risk_level:    decisionLevel === "high" ? "high" : "medium",
        });
      }

      updateBatchProgress(jobId, ++processed);
    }

    finalizeBatchJob(jobId, "done");
  } catch (err) {
    console.error("[batch] processing error:", err);
    finalizeBatchJob(jobId, "error", err.message);
  }
}

// ── Row count helper (for upload endpoint) ────────────────────────────────────
export async function countExcelRows(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  return sheet ? Math.max(0, sheet.rowCount - 1) : 0; // subtract header row
}

// ── Generate result Excel from DB records ─────────────────────────────────────
export async function generateResultExcel(jobId) {
  const rows = getBatchEvaluations(jobId);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("分析结果");

  sheet.columns = [
    { header: "客户ID",       key: "客户ID",       width: 15 },
    { header: "客户姓名",     key: "客户姓名",     width: 15 },
    { header: "AML评分",      key: "AML评分",      width: 10 },
    { header: "AML决策",      key: "AML决策",      width: 12 },
    { header: "风险等级",     key: "风险等级",     width: 10 },
    { header: "触发规则",     key: "触发规则",     width: 22 },
    { header: "KYC层级",      key: "KYC层级",      width: 10 },
    { header: "KYC层级说明",  key: "KYC层级说明",  width: 16 },
    { header: "需要SAR",      key: "需要SAR",      width: 10 },
    { header: "制裁名单命中", key: "制裁名单命中", width: 14 },
    { header: "AI分析",       key: "AI分析",       width: 45 },
    { header: "评估时间",     key: "评估时间",     width: 20 },
  ];

  // Bold header row
  sheet.getRow(1).font = { bold: true };

  for (const r of rows) {
    let rules = "";
    try { rules = JSON.parse(r.triggered_rules || "[]").map((x) => x.id).join(", "); } catch {}
    sheet.addRow({
      "客户ID":       r.customer_id,
      "客户姓名":     r.customer_name,
      "AML评分":      r.aml_score,
      "AML决策":      r.aml_decision,
      "风险等级":     r.aml_decision_level,
      "触发规则":     rules,
      "KYC层级":      r.kyc_tier,
      "KYC层级说明":  r.kyc_tier_label,
      "需要SAR":      r.sar_required ? "是" : "否",
      "制裁名单命中": r.sanctions_hit ? "是" : "否",
      "AI分析":       r.ai_analysis || "",
      "评估时间":     r.created_at,
    });
  }

  return wb.xlsx.writeBuffer();
}

// ── Generate input template Excel ─────────────────────────────────────────────
export async function generateTemplate() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("客户数据");

  sheet.columns = [
    { header: "customer_id",              key: "customer_id",              width: 14 },
    { header: "customer_name",            key: "customer_name",            width: 16 },
    { header: "amount",                   key: "amount",                   width: 12 },
    { header: "counterparty_country",     key: "counterparty_country",     width: 20 },
    { header: "account_age_days",         key: "account_age_days",         width: 16 },
    { header: "hourly_tx_count",          key: "hourly_tx_count",          width: 16 },
    { header: "percent_out_within_30min", key: "percent_out_within_30min", width: 22 },
    { header: "monthly_limit_usd",        key: "monthly_limit_usd",        width: 18 },
    { header: "country",                  key: "country",                  width: 10 },
    { header: "product_type",             key: "product_type",             width: 14 },
    { header: "is_pep",                   key: "is_pep",                   width: 10 },
    { header: "has_sanction_hit",         key: "has_sanction_hit",         width: 16 },
  ];

  sheet.getRow(1).font = { bold: true };

  const samples = [
    { customer_id: "C001", customer_name: "张三",           amount: 9800,  counterparty_country: "SG", account_age_days: 15,  hourly_tx_count: 3, percent_out_within_30min: 20, monthly_limit_usd: 5000,  country: "SG", product_type: "regular", is_pep: "false", has_sanction_hit: "false" },
    { customer_id: "C002", customer_name: "李四",           amount: 52000, counterparty_country: "IR", account_age_days: 5,   hourly_tx_count: 8, percent_out_within_30min: 95, monthly_limit_usd: 80000, country: "CN", product_type: "BNPL",    is_pep: "true",  has_sanction_hit: "false" },
    { customer_id: "C003", customer_name: "sanctions test", amount: 200,   counterparty_country: "MY", account_age_days: 200, hourly_tx_count: 1, percent_out_within_30min: 0,  monthly_limit_usd: 300,   country: "MY", product_type: "regular", is_pep: "false", has_sanction_hit: "false" },
  ];
  samples.forEach((s) => sheet.addRow(s));

  return wb.xlsx.writeBuffer();
}
