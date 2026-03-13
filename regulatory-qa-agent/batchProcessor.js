import { createRequire } from "module";
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

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

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
    customerId:           str("customer_id") || str("customerid") || `AUTO_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    customerName:         str("customer_name") || str("customername") || str("name"),
    amount:               num("amount", 0),
    counterpartyCountry:  str("counterparty_country") || str("counterpartycountry") || str("country"),
    accountAgeDays:       num("account_age_days") || num("accountagedays", 365),
    hourlyTxCount:        num("hourly_tx_count") || num("hourlytxcount", 0),
    percentOutWithin30Min:num("percent_out_within_30min") || num("percentoutwithin30min", 0),
    monthlyLimitUSD:      num("monthly_limit_usd") || num("monthlylimitusd", 1000),
    country:              str("country") || str("counterparty_country"),
    productType:          str("product_type") || str("producttype") || "regular",
    isPEP:                bool("is_pep") || bool("ispep"),
    hasSanctionHit:       bool("has_sanction_hit") || bool("hassanctionhit"),
  };
}

// ── Token-efficient AI analysis (batch mode: score >= 70 only) ───────────────
async function getBatchAIAnalysis(client, model, tx, score, rules) {
  if (!client || score < 70) return null;
  const ruleIds = rules.map((r) => r.id).join(", ");
  const prompt = `AML评分${score}/100，规则触发：${ruleIds}，金额$${tx.amount}，账龄${tx.accountAgeDays}天。用1句话（50字内）说明主要风险点。`;
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
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!rows.length) {
      finalizeBatchJob(jobId, "error", "Excel文件为空或格式不正确");
      return;
    }

    let processed = 0;
    for (const raw of rows) {
      const row = parseRow(raw);

      // Sanctions check
      let sanctionsHit = row.hasSanctionHit;
      let sanctionsDetail = null;
      if (!sanctionsHit && row.customerName) {
        const sc = await checkSanctions(row.customerName);
        sanctionsHit = sc.hit;
        sanctionsDetail = sc.entry || null;
      }

      // AML
      const amlInput = {
        amount: row.amount,
        counterpartyCountry: row.counterpartyCountry,
        accountAgeDays: row.accountAgeDays,
        hourlyTxCount: row.hourlyTxCount,
        percentOutWithin30Min: row.percentOutWithin30Min,
        sanctionsHit,
      };
      const { score, hits, decision, decisionLevel } = runAMLRules(amlInput);

      // KYC
      const kycInput = {
        amlScore: score,
        monthlyLimitUSD: row.monthlyLimitUSD,
        country: row.country,
        productType: row.productType,
        isPEP: row.isPEP,
        hasSanctionHit: sanctionsHit,
      };
      const kyc = assessKYC(kycInput);

      const sarRequired = score >= 70 || kyc.tier === "REJECT" ? 1 : 0;

      // AI analysis only for high-risk (token saving)
      const aiAnalysis = await getBatchAIAnalysis(
        qwenClient, qwenModel, row, score, hits
      );

      // Save to DB
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

      // Auto-create case for high-risk records
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

// ── Generate result Excel from DB records ─────────────────────────────────────
export function generateResultExcel(jobId) {
  const rows = getBatchEvaluations(jobId);
  const data = rows.map((r) => {
    let rules = "";
    try { rules = JSON.parse(r.triggered_rules || "[]").map((x) => x.id).join(", "); } catch {}
    return {
      客户ID:       r.customer_id,
      客户姓名:     r.customer_name,
      AML评分:      r.aml_score,
      AML决策:      r.aml_decision,
      风险等级:     r.aml_decision_level,
      触发规则:     rules,
      KYC层级:      r.kyc_tier,
      KYC层级说明:  r.kyc_tier_label,
      需要SAR:      r.sar_required ? "是" : "否",
      制裁名单命中: r.sanctions_hit ? "是" : "否",
      AI分析:       r.ai_analysis || "",
      评估时间:     r.created_at,
    };
  });

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "分析结果");

  // Column widths
  ws["!cols"] = [12, 15, 10, 12, 10, 20, 10, 15, 10, 12, 40, 20].map((w) => ({ wch: w }));

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ── Generate input template Excel ─────────────────────────────────────────────
export function generateTemplate() {
  const headers = [
    { customer_id: "C001", customer_name: "张三", amount: 9800,
      counterparty_country: "SG", account_age_days: 15,
      hourly_tx_count: 3, percent_out_within_30min: 20,
      monthly_limit_usd: 5000, country: "SG",
      product_type: "regular", is_pep: "false", has_sanction_hit: "false" },
    { customer_id: "C002", customer_name: "李四", amount: 52000,
      counterparty_country: "IR", account_age_days: 5,
      hourly_tx_count: 8, percent_out_within_30min: 95,
      monthly_limit_usd: 80000, country: "CN",
      product_type: "BNPL", is_pep: "true", has_sanction_hit: "false" },
    { customer_id: "C003", customer_name: "sanctions test", amount: 200,
      counterparty_country: "MY", account_age_days: 200,
      hourly_tx_count: 1, percent_out_within_30min: 0,
      monthly_limit_usd: 300, country: "MY",
      product_type: "regular", is_pep: "false", has_sanction_hit: "false" },
  ];

  const ws = XLSX.utils.json_to_sheet(headers);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "客户数据");
  ws["!cols"] = Array(12).fill({ wch: 22 });
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
