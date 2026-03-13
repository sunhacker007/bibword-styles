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

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);

server.on("error", (err) => {
  console.error("Server error:", err);
});

server.listen(PORT, () => {
  console.log(`监管知识问答 API server running on http://localhost:${PORT}`);
});

// keep-alive: prevents empty event loop exit
setInterval(() => {}, 60000);
