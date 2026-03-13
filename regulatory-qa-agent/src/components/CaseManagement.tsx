import { useState, useEffect, useCallback } from "react";
import "./CaseManagement.css";

interface Case {
  id: number;
  customer_id: string;
  customer_name: string;
  aml_score: number;
  kyc_tier: string;
  risk_level: "high" | "medium";
  status: "OPEN" | "REVIEWING" | "CLOSED";
  notes: string;
  decision: string;
  created_at: string;
  updated_at: string;
}

const STATUS_LABEL: Record<string, string> = { OPEN: "待处理", REVIEWING: "审查中", CLOSED: "已关闭" };
const STATUS_COLOR: Record<string, string> = { OPEN: "#ef4444", REVIEWING: "#f59e0b", CLOSED: "#22c55e" };

function RiskBadge({ level }: { level: string }) {
  const color = level === "high" ? "#ef4444" : "#f59e0b";
  return <span className="risk-badge" style={{ color, borderColor: color }}>{level === "high" ? "高风险" : "中风险"}</span>;
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? "#ef4444" : score >= 30 ? "#f59e0b" : "#22c55e";
  return (
    <div className="score-bar-wrap" title={`AML 评分 ${score}`}>
      <div className="score-bar" style={{ width: `${score}%`, background: color }} />
      <span className="score-label" style={{ color }}>{score}</span>
    </div>
  );
}

export function CaseManagement() {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("");
  const [selected, setSelected] = useState<Case | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editDecision, setEditDecision] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = filterStatus ? `?status=${filterStatus}` : "";
    const res = await fetch(`/api/cases${qs}`);
    const data = await res.json();
    setCases(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [filterStatus]);

  useEffect(() => { load(); }, [load]);

  const openDetail = (c: Case) => {
    setSelected(c);
    setEditNotes(c.notes || "");
    setEditDecision(c.decision || "");
  };

  const saveCase = async (newStatus?: string) => {
    if (!selected) return;
    setSaving(true);
    const body: Partial<Case> = { notes: editNotes, decision: editDecision || undefined };
    if (newStatus) body.status = newStatus as Case["status"];
    await fetch(`/api/cases/${selected.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    setSelected(null);
    load();
  };

  const openCount = cases.filter((c) => c.status === "OPEN").length;
  const reviewCount = cases.filter((c) => c.status === "REVIEWING").length;

  return (
    <div className="cm-wrap">
      <div className="cm-header">
        <div>
          <h2 className="cm-title">案件管理</h2>
          <p className="cm-desc">
            高风险 AML 记录（评分 ≥ 70）及 EDD / REJECT KYC 记录自动入案
          </p>
        </div>
        <div className="cm-summary">
          <span className="cm-badge cm-badge--open">待处理 {openCount}</span>
          <span className="cm-badge cm-badge--review">审查中 {reviewCount}</span>
        </div>
      </div>

      {/* Filters */}
      <div className="cm-filters">
        {["", "OPEN", "REVIEWING", "CLOSED"].map((s) => (
          <button
            key={s}
            className={`filter-btn ${filterStatus === s ? "filter-btn--active" : ""}`}
            onClick={() => setFilterStatus(s)}
          >
            {s ? STATUS_LABEL[s] : "全部"}
          </button>
        ))}
        <button className="filter-refresh" onClick={load}>刷新</button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="cm-loading">加载中…</div>
      ) : cases.length === 0 ? (
        <div className="cm-empty">
          <div className="cm-empty-icon">📋</div>
          <p>暂无案件记录</p>
          <p className="cm-empty-hint">进行批量分析或单条高风险评估后，案件将自动创建</p>
        </div>
      ) : (
        <div className="cm-table-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>案件 ID</th>
                <th>客户</th>
                <th>AML 评分</th>
                <th>KYC 层级</th>
                <th>风险</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} className={`cm-row cm-row--${c.status.toLowerCase()}`}>
                  <td className="cm-id">#{c.id}</td>
                  <td className="cm-customer">
                    <div className="customer-name">{c.customer_name || "—"}</div>
                    <div className="customer-id">{c.customer_id || ""}</div>
                  </td>
                  <td><ScoreBar score={c.aml_score || 0} /></td>
                  <td>
                    {c.kyc_tier ? (
                      <span className={`tier-badge tier-badge--${c.kyc_tier.toLowerCase()}`}>{c.kyc_tier}</span>
                    ) : "—"}
                  </td>
                  <td><RiskBadge level={c.risk_level} /></td>
                  <td>
                    <span className="status-pill" style={{ color: STATUS_COLOR[c.status], borderColor: STATUS_COLOR[c.status] }}>
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <td className="cm-date">{c.created_at?.slice(0, 10)}</td>
                  <td>
                    <button className="detail-btn" onClick={() => openDetail(c)}>处理</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="cm-overlay" onClick={() => setSelected(null)}>
          <div className="cm-panel" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <div>
                <h3 className="panel-title">案件 #{selected.id}</h3>
                <span className="panel-customer">{selected.customer_name || "未知客户"}</span>
              </div>
              <button className="panel-close" onClick={() => setSelected(null)}>✕</button>
            </div>

            <div className="panel-meta">
              <div className="meta-item"><span>AML 评分</span><strong style={{ color: selected.aml_score >= 70 ? "#ef4444" : "#f59e0b" }}>{selected.aml_score}</strong></div>
              <div className="meta-item"><span>KYC 层级</span><strong>{selected.kyc_tier || "—"}</strong></div>
              <div className="meta-item"><span>当前状态</span><strong style={{ color: STATUS_COLOR[selected.status] }}>{STATUS_LABEL[selected.status]}</strong></div>
              <div className="meta-item"><span>创建时间</span><strong>{selected.created_at?.slice(0, 16).replace("T", " ")}</strong></div>
            </div>

            <div className="panel-field">
              <label>决策</label>
              <select value={editDecision} onChange={(e) => setEditDecision(e.target.value)}>
                <option value="">待定</option>
                <option value="confirmed">确认可疑</option>
                <option value="false_positive">误报关闭</option>
                <option value="escalated">升级 CCO</option>
              </select>
            </div>

            <div className="panel-field">
              <label>调查备注</label>
              <textarea
                rows={4}
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="记录调查过程、证据、决策依据…"
              />
            </div>

            <div className="panel-actions">
              {selected.status === "OPEN" && (
                <button className="panel-btn panel-btn--review" onClick={() => saveCase("REVIEWING")} disabled={saving}>
                  转入审查
                </button>
              )}
              {(selected.status === "OPEN" || selected.status === "REVIEWING") && (
                <button className="panel-btn panel-btn--close" onClick={() => saveCase("CLOSED")} disabled={saving}>
                  关闭案件
                </button>
              )}
              <button className="panel-btn panel-btn--save" onClick={() => saveCase()} disabled={saving}>
                {saving ? "保存中…" : "保存备注"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
