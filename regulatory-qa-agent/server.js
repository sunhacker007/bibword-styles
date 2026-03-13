import http from "http";
import OpenAI from "openai";
import express from "express";
import cors from "cors";

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("exit", (code) => {
  console.error("Process exiting with code:", code);
  console.error(new Error("exit stack").stack);
});

const app = express();
app.use(cors());
app.use(express.json());

// Qwen (DashScope) OpenAI-compatible client
const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

const SYSTEM_PROMPT = `你是一位专业的监管知识问答助手，专注于中国及国际金融监管、法律法规、合规要求等领域。

你的职责包括：
1. 解答监管法规相关问题（如银行监管、证券监管、保险监管、反洗钱等）
2. 提供合规建议和风险提示
3. 解读监管政策文件和法规条款
4. 分析监管趋势和变化
5. 回答关于PBOC、CBIRC、CSRC、SAFE等监管机构的政策问题

回答要求：
- 专业准确，引用相关法规条文
- 简明扼要，重点突出
- 如涉及最新政策，说明信息可能需要核实
- 使用中文回答
- 必要时提示用户咨询专业法律顾问`;

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await client.chat.completions.create({
      model: process.env.QWEN_MODEL || "qwen-max",
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── AML Rule Engine ───────────────────────────────────────────────────────────

const FATF_BLACKLIST = ["IR", "KP", "MM", "YE"];
const FATF_GREYLIST = ["PK", "SY", "TR", "VN", "PH", "NG", "EG", "TZ", "BF"];
// Demo sanctions list (not real - for demonstration only)
const DEMO_SANCTIONS = ["sanctions test", "demo blocked", "test ofac"];

function runAMLRules(tx) {
  const {
    amount,
    counterpartyCountry,
    accountAgeDays,
    hourlyTxCount,
    percentOutWithin30Min,
    customerName,
  } = tx;

  const hits = [];
  let score = 0;

  // A1: Amount near CTR threshold
  if ((amount >= 9500 && amount <= 9999) || (amount >= 10001 && amount <= 10100)) {
    hits.push({ id: "A1", name: "单笔金额接近CTR申报门槛 ($10,000)", score: 25 });
    score += 25;
  }

  // A2: Large single transaction (demo: > $50,000 as proxy for 5x average)
  if (amount > 50000) {
    hits.push({ id: "A2", name: "单笔大额异常（超均值5倍）", score: 20 });
    score += 20;
  }

  // B1: High frequency in 1 hour
  if (hourlyTxCount >= 5) {
    hits.push({ id: "B1", name: `短时高频交易（1小时内 ${hourlyTxCount} 笔）`, score: 18 });
    score += 18;
  }

  // B2: Quick fund transfer out
  if (percentOutWithin30Min >= 90) {
    hits.push({ id: "B2", name: `快速入金转出（30分钟内转出 ${percentOutWithin30Min}%）`, score: 22 });
    score += 22;
  }

  // B3: New account large transaction
  if (accountAgeDays < 30 && amount > 5000) {
    hits.push({ id: "B3", name: `新账户大额交易（账户 ${accountAgeDays} 天，金额 $${amount}）`, score: 15 });
    score += 15;
  }

  // G1: FATF blacklist
  if (FATF_BLACKLIST.includes(counterpartyCountry)) {
    hits.push({ id: "G1", name: `FATF黑名单国家对手方（${counterpartyCountry}）`, score: 30 });
    score += 30;
  }

  // G2: FATF greylist
  if (FATF_GREYLIST.includes(counterpartyCountry)) {
    hits.push({ id: "G2", name: `FATF灰名单国家对手方（${counterpartyCountry}）`, score: 15 });
    score += 15;
  }

  // I1: Sanctions check (demo only)
  if (customerName && DEMO_SANCTIONS.includes(customerName.toLowerCase().trim())) {
    hits.push({ id: "I1", name: "制裁名单命中（演示）", score: 40 });
    score += 40;
  }

  score = Math.min(score, 100);

  let decision, decisionLevel;
  if (score < 30) {
    decision = "放行";
    decisionLevel = "low";
  } else if (score < 70) {
    decision = "人工复核";
    decisionLevel = "medium";
  } else {
    decision = "自动阻断";
    decisionLevel = "high";
  }

  return { score, hits, decision, decisionLevel };
}

// POST /api/aml/score
app.post("/api/aml/score", async (req, res) => {
  const tx = req.body;
  const { score, hits, decision, decisionLevel } = runAMLRules(tx);

  const needsQwen = score >= 30;
  let analysis = null;
  let sarDraft = null;

  if (needsQwen) {
    const rulesText = hits.map((r) => `- [${r.id}] ${r.name}（+${r.score}分）`).join("\n");
    const prompt = `你是一位AML合规分析师。以下是一笔交易的风险评估结果：

交易金额：$${tx.amount} USD
对手方国家：${tx.counterpartyCountry}
账户开立天数：${tx.accountAgeDays}天
规则引擎评分：${score}/100
触发规则：
${rulesText || "无"}

请用中文，简洁地（200字以内）：
1. 分析该交易的主要风险点
2. 给出是否需要进一步调查的建议

${score >= 70 ? "另外，请在【SAR草稿】标题下，起草一份简短的可疑活动报告摘要（150字以内），包含：可疑活动描述、触发原因。" : ""}`;

    try {
      const completion = await client.chat.completions.create({
        model: process.env.QWEN_MODEL || "qwen-max",
        messages: [{ role: "user", content: prompt }],
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

  res.json({ score, hits, decision, decisionLevel, analysis, sarDraft });
});

// ─── KYC Assessment ────────────────────────────────────────────────────────────

function assessKYC(customer) {
  const { amlScore, monthlyLimitUSD, country, productType, isPEP, hasSanctionHit } = customer;

  if (hasSanctionHit) {
    return {
      tier: "REJECT",
      tierLabel: "直接拒绝",
      reason: "制裁名单精确命中",
      action: "立即冻结账户，30日内评估是否提交SAR",
      checks: [],
      targetTime: "N/A",
    };
  }

  if (isPEP || amlScore >= 70 || monthlyLimitUSD > 50000 || FATF_BLACKLIST.includes(country)) {
    const reasons = [];
    if (isPEP) reasons.push("PEP身份确认");
    if (amlScore >= 70) reasons.push(`AML评分 ${amlScore} ≥ 70`);
    if (monthlyLimitUSD > 50000) reasons.push(`月交易限额 $${monthlyLimitUSD} > $50,000`);
    if (FATF_BLACKLIST.includes(country)) reasons.push(`注册国 ${country} 为FATF黑名单`);

    return {
      tier: "EDD",
      tierLabel: "强化尽职调查",
      reason: reasons.join("；"),
      action: "需要合规官（CCO）审批，48小时内完成",
      checks: [
        "CDD全套文件",
        "财富来源证明（税单/工资单/营业执照，需2份证明文件）",
        "业务关系目的声明（预期交易频率和金额）",
        "高级管理层审批签字",
        "每6个月定期复核",
      ],
      targetTime: "目标处理时长：2个工作日内",
    };
  }

  const isSDD =
    amlScore < 20 &&
    monthlyLimitUSD <= 500 &&
    !FATF_GREYLIST.includes(country) &&
    !FATF_BLACKLIST.includes(country) &&
    productType !== "BNPL" &&
    !isPEP;

  if (isSDD) {
    return {
      tier: "SDD",
      tierLabel: "简化尽职调查",
      reason: `AML低风险评分（${amlScore}）、低额度（$${monthlyLimitUSD}/月）、低风险司法管辖区`,
      action: "全自动处理，无需人工介入",
      checks: [
        "有效政府颁发ID（OCR验证，置信度≥92%）",
        "手机号OTP验证（6位数字，5分钟有效）",
        "设备指纹采集",
        "制裁名单精确匹配（姓名+出生日期）",
      ],
      targetTime: "目标完成时长：< 3分钟（P50 < 90秒）",
    };
  }

  // CDD (default)
  const cddReasons = [];
  if (amlScore >= 20) cddReasons.push(`AML评分 ${amlScore}`);
  if (monthlyLimitUSD > 500) cddReasons.push(`月交易限额 $${monthlyLimitUSD}`);
  if (FATF_GREYLIST.includes(country)) cddReasons.push(`注册国 ${country} 为FATF灰名单`);
  if (productType === "BNPL") cddReasons.push("BNPL产品（MAS特别要求）");

  return {
    tier: "CDD",
    tierLabel: "标准尽职调查",
    reason: cddReasons.join("；") || "默认标准核查",
    action: "AI自动处理，置信度<85%时转人工复核",
    checks: [
      "有效政府颁发ID（OCR + MRZ码校验 + 防伪检测）",
      "地址证明（近3个月账单/官方信件）",
      "自拍活体检测（眨眼+点头，防GAN换脸攻击）",
      "PEP数据库筛查（本人+直系家属）",
      "制裁名单模糊匹配（Levenshtein距离≤2）",
      "业务性质声明（职业类别、收入来源）",
    ],
    targetTime: "目标完成时长：P50 < 25分钟",
  };
}

// POST /api/kyc/assess
app.post("/api/kyc/assess", (req, res) => {
  const result = assessKYC(req.body);
  res.json(result);
});

// ──────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);

server.on("error", (err) => {
  console.error("Server error:", err);
});

server.listen(PORT, () => {
  console.log(`FCAP API server running on http://localhost:${PORT}`);
});

// keep-alive: prevents empty event loop exit
setInterval(() => {}, 60000);
