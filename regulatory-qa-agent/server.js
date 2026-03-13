import http from "http";
import { createRequire } from "module";
import OpenAI from "openai";
import express from "express";
import cors from "cors";
import { runAMLRules } from "./aml.js";
import { assessKYC } from "./kyc.js";
import { checkSanctions } from "./sanctionsService.js";
import { processBatch, generateResultExcel, generateTemplate } from "./batchProcessor.js";
import {
  saveEvaluation,
  createBatchJob,
  getBatchJob,
  listCases,
  getCase,
  updateCase,
  getDashboardStats,
  createCase,
} from "./db.js";

const require = createRequire(import.meta.url);
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
const MODEL = process.env.QWEN_MODEL || "qwen-max";

// ── Regulatory Chat ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一位专业的监管知识问答助手，专注于中国及国际金融监管、法律法规、合规要求等领域。
职责：解答银行、证券、保险、反洗钱、外汇管理、数据合规等监管问题。
要求：专业准确，引用法规条文，简明扼要，使用中文回答。必要时提示咨询专业法律顾问。`;

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    const stream = await client.chat.completions.create({
      model: MODEL, stream: true,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── AML Score ────────────────────────────────────────────────────────────────

app.post("/api/aml/score", async (req, res) => {
  const tx = req.body;

  // Run sanctions check on customer name
  const sc = await checkSanctions(tx.customerName);
  const sanctionsHit = sc.hit;

  const { score, hits, decision, decisionLevel } = runAMLRules({ ...tx, sanctionsHit });

  let analysis = null, sarDraft = null;
  if (score >= 30) {
    const rulesText = hits.map((r) => `[${r.id}] ${r.name}（+${r.score}分）`).join("\n");
    const prompt = `AML合规分析师角色。交易：$${tx.amount} USD，对手方：${tx.counterpartyCountry}，账龄：${tx.accountAgeDays}天，评分：${score}/100。
触发规则：\n${rulesText || "无"}
用中文200字内：1.分析主要风险点 2.是否需要进一步调查${score >= 70 ? "\n另外在【SAR草稿】标题下起草150字以内SAR摘要（含可疑活动描述、触发原因）。" : ""}`;
    try {
      const completion = await client.chat.completions.create({
        model: MODEL, messages: [{ role: "user", content: prompt }],
      });
      const content = completion.choices[0]?.message?.content || "";
      if (score >= 70 && content.includes("【SAR草稿】")) {
        const parts = content.split("【SAR草稿】");
        analysis = parts[0].trim();
        sarDraft = parts[1].replace(/^[：:]\s*/, "").trim();
      } else {
        analysis = content;
      }
    } catch (err) {
      analysis = `AI分析不可用：${err.message}`;
    }
  }

  // Persist evaluation
  const evalId = saveEvaluation({
    customer_id:        tx.customerId || null,
    customer_name:      tx.customerName || null,
    eval_source:        "manual",
    aml_score:          score,
    aml_decision:       decision,
    aml_decision_level: decisionLevel,
    kyc_tier:           null,
    kyc_tier_label:     null,
    triggered_rules:    JSON.stringify(hits),
    ai_analysis:        analysis,
    sar_required:       sarDraft ? 1 : 0,
    sanctions_hit:      sanctionsHit ? 1 : 0,
    batch_job_id:       null,
  });

  // Auto-create case for high risk
  if (decisionLevel === "high") {
    createCase({
      evaluation_id: evalId,
      customer_id:   tx.customerId || null,
      customer_name: tx.customerName || null,
      aml_score:     score,
      kyc_tier:      null,
      risk_level:    "high",
    });
  }

  res.json({ score, hits, decision, decisionLevel, analysis, sarDraft, sanctionsHit });
});

// ── KYC Assess ───────────────────────────────────────────────────────────────

app.post("/api/kyc/assess", async (req, res) => {
  const customer = req.body;

  // Sanctions check if name provided
  if (customer.customerName && !customer.hasSanctionHit) {
    const sc = await checkSanctions(customer.customerName);
    if (sc.hit) customer.hasSanctionHit = true;
  }

  const result = assessKYC(customer);

  const evalId = saveEvaluation({
    customer_id:        customer.customerId || null,
    customer_name:      customer.customerName || null,
    eval_source:        "manual",
    aml_score:          customer.amlScore || null,
    aml_decision:       null,
    aml_decision_level: null,
    kyc_tier:           result.tier,
    kyc_tier_label:     result.tierLabel,
    triggered_rules:    null,
    ai_analysis:        null,
    sar_required:       result.tier === "REJECT" ? 1 : 0,
    sanctions_hit:      customer.hasSanctionHit ? 1 : 0,
    batch_job_id:       null,
  });

  if (result.tier === "EDD" || result.tier === "REJECT") {
    createCase({
      evaluation_id: evalId,
      customer_id:   customer.customerId || null,
      customer_name: customer.customerName || null,
      aml_score:     customer.amlScore || 0,
      kyc_tier:      result.tier,
      risk_level:    result.tier === "REJECT" ? "high" : "medium",
    });
  }

  res.json(result);
});

// ── Sanctions Check ───────────────────────────────────────────────────────────

app.post("/api/sanctions/check", async (req, res) => {
  const { name } = req.body;
  const result = await checkSanctions(name);
  res.json(result);
});

// ── Batch Processing ──────────────────────────────────────────────────────────

app.get("/api/batch/template", (_req, res) => {
  const buffer = generateTemplate();
  res.setHeader("Content-Disposition", "attachment; filename=fcap_batch_template.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

app.post("/api/batch/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "未上传文件" });

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const skipAI = req.body.skipAI === "true";

  // Parse row count for progress tracking
  const require2 = createRequire(import.meta.url);
  const XLSX = require2("xlsx");
  const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });

  createBatchJob(jobId, req.file.originalname, rows.length);

  // Fire-and-forget async processing
  processBatch(jobId, req.file.buffer, req.file.originalname, skipAI ? null : client, MODEL);

  res.json({ jobId, totalRows: rows.length });
});

app.get("/api/batch/status/:jobId", (req, res) => {
  const job = getBatchJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "任务不存在" });
  res.json(job);
});

app.get("/api/batch/download/:jobId", (req, res) => {
  const job = getBatchJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "任务不存在" });
  if (job.status !== "done") return res.status(400).json({ error: "任务尚未完成" });

  const buffer = generateResultExcel(req.params.jobId);
  res.setHeader("Content-Disposition", `attachment; filename=fcap_results_${req.params.jobId}.xlsx`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

// ── Dashboard Stats ───────────────────────────────────────────────────────────

app.get("/api/dashboard/stats", (_req, res) => {
  const stats = getDashboardStats();
  res.json(stats);
});

// ── Case Management ───────────────────────────────────────────────────────────

app.get("/api/cases", (req, res) => {
  const { status, risk_level, limit, offset } = req.query;
  const cases = listCases({
    status, risk_level,
    limit: limit ? parseInt(limit) : 50,
    offset: offset ? parseInt(offset) : 0,
  });
  res.json(cases);
});

app.get("/api/cases/:id", (req, res) => {
  const c = getCase(parseInt(req.params.id));
  if (!c) return res.status(404).json({ error: "案件不存在" });
  res.json(c);
});

app.put("/api/cases/:id", (req, res) => {
  const { status, notes, decision } = req.body;
  updateCase(parseInt(req.params.id), { status, notes, decision });
  const c = getCase(parseInt(req.params.id));
  res.json(c);
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);
server.on("error", (err) => console.error("Server error:", err));
server.listen(PORT, () => console.log(`FCAP API server running on http://localhost:${PORT}`));
setInterval(() => {}, 60000);
