import React, { useState } from "react";
import "./KYCAgent.css";

interface KYCResult {
  tier: "SDD" | "CDD" | "EDD" | "REJECT";
  tierLabel: string;
  reason: string;
  action: string;
  checks: string[];
  targetTime: string;
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

const TIER_META = {
  SDD: { color: "#22c55e", bg: "#dcfce7", label: "SDD · 简化尽职调查" },
  CDD: { color: "#f59e0b", bg: "#fef3c7", label: "CDD · 标准尽职调查" },
  EDD: { color: "#ef4444", bg: "#fee2e2", label: "EDD · 强化尽职调查" },
  REJECT: { color: "#7c3aed", bg: "#ede9fe", label: "直接拒绝" },
};

export function KYCAgent() {
  const [form, setForm] = useState({
    amlScore: "",
    monthlyLimitUSD: "",
    country: "SG",
    productType: "regular",
    isPEP: false,
    hasSanctionHit: false,
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KYCResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const target = e.target as HTMLInputElement;
    const value = target.type === "checkbox" ? target.checked : target.value;
    setForm((prev) => ({ ...prev, [target.name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/kyc/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amlScore: parseInt(form.amlScore) || 0,
          monthlyLimitUSD: parseFloat(form.monthlyLimitUSD) || 0,
          country: form.country,
          productType: form.productType,
          isPEP: form.isPEP,
          hasSanctionHit: form.hasSanctionHit,
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

  const meta = result ? TIER_META[result.tier] : null;

  return (
    <div className="agent-container">
      <div className="agent-intro">
        <h2>KYC Agent · 客户尽职调查层级判定</h2>
        <p>输入客户风险信息，系统自动判断适用 SDD / CDD / EDD 层级，并给出所需核查清单。覆盖 MAS（SG）、BNM（MY）、OJK（ID）、FCA（UK）合规要求。</p>
      </div>

      <div className="agent-body">
        <form className="agent-form" onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="form-group">
              <label>AML 评分（0–100）</label>
              <input
                type="number"
                name="amlScore"
                value={form.amlScore}
                onChange={handleChange}
                placeholder="例：45"
                min="0"
                max="100"
                required
              />
              <span className="form-hint">{"< 20 SDD；20–69 CDD；≥ 70 EDD"}</span>
            </div>
            <div className="form-group">
              <label>月交易限额（USD）</label>
              <input
                type="number"
                name="monthlyLimitUSD"
                value={form.monthlyLimitUSD}
                onChange={handleChange}
                placeholder="例：2000"
                min="0"
                required
              />
              <span className="form-hint">{"≤ $500 SDD；$500–$50k CDD；> $50k EDD"}</span>
            </div>
          </div>

          <div className="form-group">
            <label>注册国家</label>
            <select name="country" value={form.country} onChange={handleChange}>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>产品类型</label>
            <select name="productType" value={form.productType} onChange={handleChange}>
              <option value="regular">普通账户 / 汇款</option>
              <option value="BNPL">BNPL（先买后付）</option>
              <option value="loan">信贷产品</option>
              <option value="investment">投资产品</option>
            </select>
            <span className="form-hint">BNPL 须至少 CDD（MAS 特别要求）</span>
          </div>

          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="isPEP"
                checked={form.isPEP}
                onChange={handleChange}
              />
              <span>PEP（政治公众人物）身份</span>
              <span className="form-hint">直接触发 EDD</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="hasSanctionHit"
                checked={form.hasSanctionHit}
                onChange={handleChange}
              />
              <span>制裁名单命中</span>
              <span className="form-hint">直接拒绝 + 冻结账户</span>
            </label>
          </div>

          <button type="submit" className="submit-btn" disabled={loading || !form.amlScore || !form.monthlyLimitUSD}>
            {loading ? <span className="spinner-sm" /> : null}
            {loading ? "判定中..." : "判定 KYC 层级"}
          </button>
        </form>

        {error && <div className="error-box">⚠️ {error}</div>}

        {result && meta && (
          <div className="result-panel">
            <div
              className="tier-banner"
              style={{ background: meta.bg, borderColor: meta.color, color: meta.color }}
            >
              <div className="tier-name">{meta.label}</div>
              <div className="tier-reason">{result.reason}</div>
            </div>

            <div className="result-card">
              <div className="result-row">
                <span className="result-icon">⚡</span>
                <div>
                  <div className="result-label">推荐行动</div>
                  <div className="result-value">{result.action}</div>
                </div>
              </div>
              <div className="result-row">
                <span className="result-icon">⏱</span>
                <div>
                  <div className="result-label">处理时长目标</div>
                  <div className="result-value">{result.targetTime}</div>
                </div>
              </div>
            </div>

            {result.checks.length > 0 && (
              <div className="checks-card">
                <h4>必须完成的核查项目（{result.checks.length} 项）</h4>
                <ul className="checks-list">
                  {result.checks.map((c, i) => (
                    <li key={i}>
                      <span className="check-num">{i + 1}</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="compliance-note">
              <span>📋</span>
              <span>记录须保存 <strong>6年</strong>（FCA MLR2017 Regulation 40 标准，适用全市场）</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
