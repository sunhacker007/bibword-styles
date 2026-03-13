import React, { useState } from "react";
import "./AMLAgent.css";

interface AMLResult {
  score: number;
  hits: { id: string; name: string; score: number }[];
  decision: string;
  decisionLevel: "low" | "medium" | "high";
  analysis: string | null;
  sarDraft: string | null;
}

const COUNTRY_OPTIONS = [
  { value: "SG", label: "新加坡 (SG)" },
  { value: "MY", label: "马来西亚 (MY)" },
  { value: "ID", label: "印度尼西亚 (ID)" },
  { value: "GB", label: "英国 (GB)" },
  { value: "US", label: "美国 (US)" },
  { value: "CN", label: "中国 (CN)" },
  { value: "HK", label: "香港 (HK)" },
  { value: "PH", label: "菲律宾 (PH) [FATF灰名单]" },
  { value: "VN", label: "越南 (VN) [FATF灰名单]" },
  { value: "PK", label: "巴基斯坦 (PK) [FATF灰名单]" },
  { value: "MM", label: "缅甸 (MM) [FATF黑名单]" },
  { value: "KP", label: "朝鲜 (KP) [FATF黑名单]" },
  { value: "IR", label: "伊朗 (IR) [FATF黑名单]" },
];

export function AMLAgent() {
  const [form, setForm] = useState({
    amount: "",
    counterpartyCountry: "SG",
    accountAgeDays: "",
    hourlyTxCount: "",
    percentOutWithin30Min: "",
    customerName: "",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AMLResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/aml/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: parseFloat(form.amount) || 0,
          counterpartyCountry: form.counterpartyCountry,
          accountAgeDays: parseInt(form.accountAgeDays) || 365,
          hourlyTxCount: parseInt(form.hourlyTxCount) || 1,
          percentOutWithin30Min: parseFloat(form.percentOutWithin30Min) || 0,
          customerName: form.customerName,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setLoading(false);
    }
  };

  const scoreColor = (score: number) => {
    if (score < 30) return "#22c55e";
    if (score < 70) return "#f59e0b";
    return "#ef4444";
  };

  return (
    <div className="agent-container">
      <div className="agent-intro">
        <h2>AML Agent · 反洗钱交易评分</h2>
        <p>输入交易信息，规则引擎（Layer 1）即时打分，评分≥30 时 Qwen-Max（Layer 2）深度分析，评分≥70 自动生成 SAR 草稿。</p>
      </div>

      <div className="agent-body">
        <form className="agent-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>交易金额（USD）</label>
            <input
              type="number"
              name="amount"
              value={form.amount}
              onChange={handleChange}
              placeholder="例：9800"
              required
              min="0"
            />
            <span className="form-hint">输入 $9,500–$10,100 将触发规则 A1</span>
          </div>

          <div className="form-group">
            <label>对手方国家</label>
            <select name="counterpartyCountry" value={form.counterpartyCountry} onChange={handleChange}>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>账户开立天数</label>
              <input
                type="number"
                name="accountAgeDays"
                value={form.accountAgeDays}
                onChange={handleChange}
                placeholder="例：15"
                min="0"
              />
              <span className="form-hint">{"< 30 天 + 大额 → 触发 B3"}</span>
            </div>
            <div className="form-group">
              <label>1小时内交易笔数</label>
              <input
                type="number"
                name="hourlyTxCount"
                value={form.hourlyTxCount}
                onChange={handleChange}
                placeholder="例：6"
                min="0"
              />
              <span className="form-hint">{"≥ 5 笔 → 触发 B1"}</span>
            </div>
          </div>

          <div className="form-group">
            <label>30分钟内转出比例（%）</label>
            <input
              type="number"
              name="percentOutWithin30Min"
              value={form.percentOutWithin30Min}
              onChange={handleChange}
              placeholder="例：95"
              min="0"
              max="100"
            />
            <span className="form-hint">{"≥ 90% → 触发 B2 快速入金转出"}</span>
          </div>

          <div className="form-group">
            <label>客户姓名（制裁名单测试）</label>
            <input
              type="text"
              name="customerName"
              value={form.customerName}
              onChange={handleChange}
              placeholder='输入 "sanctions test" 触发制裁命中演示'
            />
          </div>

          <button type="submit" className="submit-btn" disabled={loading || !form.amount}>
            {loading ? <span className="spinner-sm" /> : null}
            {loading ? "分析中..." : "提交评分"}
          </button>
        </form>

        {error && <div className="error-box">⚠️ {error}</div>}

        {result && (
          <div className="result-panel">
            <div className="score-header">
              <div
                className="score-circle"
                style={{ borderColor: scoreColor(result.score), color: scoreColor(result.score) }}
              >
                <span className="score-num">{result.score}</span>
                <span className="score-label">/ 100</span>
              </div>
              <div className="decision-block">
                <div className={`decision-badge decision-${result.decisionLevel}`}>
                  {result.decision}
                </div>
                <div className="decision-hint">
                  {result.decisionLevel === "low" && "评分 < 30，系统自动放行"}
                  {result.decisionLevel === "medium" && "评分 30–69，进入人工复核队列"}
                  {result.decisionLevel === "high" && "评分 ≥ 70，自动阻断并通知合规官"}
                </div>
              </div>
            </div>

            {result.hits.length > 0 ? (
              <div className="rules-section">
                <h4>触发规则（{result.hits.length} 条）</h4>
                <ul className="rules-list">
                  {result.hits.map((h) => (
                    <li key={h.id}>
                      <span className="rule-id">{h.id}</span>
                      <span className="rule-name">{h.name}</span>
                      <span className="rule-score">+{h.score}分</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="no-rules">未触发任何风险规则</div>
            )}

            {result.analysis && (
              <div className="analysis-section">
                <h4>Qwen-Max 深度分析</h4>
                <p>{result.analysis}</p>
              </div>
            )}

            {result.sarDraft && (
              <div className="sar-section">
                <h4>⚠️ SAR 草稿（自动生成）</h4>
                <p className="sar-disclaimer">仅供参考，需合规官审核后提交 MAS SONAR</p>
                <div className="sar-content">{result.sarDraft}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
