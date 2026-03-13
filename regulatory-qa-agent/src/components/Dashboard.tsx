import { useState, useEffect } from "react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import "./Dashboard.css";

interface Stats {
  aml: { total: number; high: number; medium: number; low: number; sar_required: number };
  kyc: { by_tier: Record<string, number> };
  cases: Record<string, number>;
  trend: { date: string; total: number; high: number; medium: number }[];
  top_rules: { id: string; name: string; count: number }[];
}

const TIER_COLORS: Record<string, string> = {
  SDD: "#22c55e", CDD: "#f59e0b", EDD: "#ef4444", REJECT: "#7c3aed",
};
const PIE_COLORS = ["#22c55e", "#f59e0b", "#ef4444", "#7c3aed"];

function KpiCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-value" style={color ? { color } : {}}>{value ?? 0}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/stats");
      setStats(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="dash-loading">加载中…</div>;
  if (!stats) return <div className="dash-loading">数据加载失败</div>;

  const { aml, kyc, cases, trend, top_rules } = stats;

  const tierData = Object.entries(kyc.by_tier || {}).map(([name, value]) => ({ name, value }));
  const totalEval = aml.total || 0;

  return (
    <div className="dash-wrap">
      <div className="dash-topbar">
        <h2 className="dash-title">合规风控总览</h2>
        <button className="dash-refresh" onClick={load}>刷新</button>
      </div>

      {/* KPI row */}
      <div className="kpi-row">
        <KpiCard label="总评估次数" value={totalEval} />
        <KpiCard label="高风险记录" value={aml.high || 0} sub={`占比 ${totalEval ? Math.round(((aml.high||0)/totalEval)*100) : 0}%`} color="#ef4444" />
        <KpiCard label="需人工复核" value={aml.medium || 0} color="#f59e0b" />
        <KpiCard label="SAR 待处理" value={aml.sar_required || 0} color="#a78bfa" />
        <KpiCard label="待处理案件" value={(cases.OPEN || 0) + (cases.REVIEWING || 0)} color="#60a5fa" />
      </div>

      <div className="dash-grid">
        {/* Trend chart */}
        <div className="dash-card dash-card--wide">
          <h3 className="card-title">风险趋势（近14天）</h3>
          {trend.length === 0 ? (
            <div className="no-data">暂无数据，请先进行批量分析或单条评估</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }} labelStyle={{ color: "#e2e8f0" }} />
                <Legend />
                <Line type="monotone" dataKey="total" name="总计" stroke="#60a5fa" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="high" name="高风险" stroke="#ef4444" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="medium" name="中风险" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* KYC tier pie */}
        <div className="dash-card">
          <h3 className="card-title">KYC 层级分布</h3>
          {tierData.length === 0 ? (
            <div className="no-data">暂无 KYC 数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={tierData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" nameKey="name" label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ""} ${Math.round((percent ?? 0)*100)}%`} labelLine={false}>
                  {tierData.map((_, i) => (
                    <Cell key={i} fill={TIER_COLORS[tierData[i].name] || PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Rule frequency bar */}
        <div className="dash-card dash-card--wide">
          <h3 className="card-title">规则触发频率 TOP 8</h3>
          {top_rules.length === 0 ? (
            <div className="no-data">暂无规则触发记录</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={top_rules} margin={{ top: 5, right: 10, left: -20, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="id" tick={{ fill: "#64748b", fontSize: 12 }} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }}
                  formatter={(value, _, props) => [value, props.payload.name]}
                />
                <Bar dataKey="count" name="触发次数" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Case status */}
        <div className="dash-card">
          <h3 className="card-title">案件状态</h3>
          <div className="case-status-list">
            {[
              { key: "OPEN",      label: "待处理", color: "#ef4444" },
              { key: "REVIEWING", label: "审查中", color: "#f59e0b" },
              { key: "CLOSED",    label: "已关闭", color: "#22c55e" },
            ].map(({ key, label, color }) => (
              <div className="case-status-row" key={key}>
                <div className="case-status-dot" style={{ background: color }} />
                <span className="case-status-label">{label}</span>
                <span className="case-status-count" style={{ color }}>{cases[key] || 0}</span>
              </div>
            ))}
            <div className="case-status-row case-status-row--total">
              <span className="case-status-label">合计</span>
              <span className="case-status-count">
                {(cases.OPEN || 0) + (cases.REVIEWING || 0) + (cases.CLOSED || 0)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
