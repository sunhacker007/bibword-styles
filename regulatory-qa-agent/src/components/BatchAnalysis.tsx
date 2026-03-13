import { useState, useRef, useCallback } from "react";
import "./BatchAnalysis.css";

interface BatchJob {
  id: string;
  filename: string;
  total_rows: number;
  processed_rows: number;
  status: "pending" | "processing" | "done" | "error";
  error_msg?: string;
}

export function BatchAnalysis() {
  const [job, setJob] = useState<BatchJob | null>(null);
  const [dragging, setDragging] = useState(false);
  const [skipAI, setSkipAI] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollStatus = useCallback((jobId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/batch/status/${jobId}`);
        const data: BatchJob = await res.json();
        setJob(data);
        if (data.status === "done" || data.status === "error") stopPolling();
      } catch {}
    }, 1500);
  }, []);

  const uploadFile = async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setError("请上传 .xlsx 或 .xls 格式文件");
      return;
    }
    setError(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("skipAI", String(skipAI));
    try {
      const res = await fetch("/api/batch/upload", { method: "POST", body: form });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setJob({ id: data.jobId, filename: file.name, total_rows: data.totalRows, processed_rows: 0, status: "processing" });
      pollStatus(data.jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = "";
  };

  const downloadResult = () => {
    if (!job) return;
    window.location.href = `/api/batch/download/${job.id}`;
  };

  const downloadTemplate = () => {
    window.location.href = "/api/batch/template";
  };

  const reset = () => {
    stopPolling();
    setJob(null);
    setError(null);
  };

  const progress = job ? Math.round((job.processed_rows / Math.max(job.total_rows, 1)) * 100) : 0;

  return (
    <div className="batch-wrap">
      <div className="batch-header">
        <div>
          <h2 className="batch-title">批量 AML / KYC 分析</h2>
          <p className="batch-desc">上传客户数据 Excel，自动完成 AML 评分 + KYC 分层 + 制裁名单筛查，结果导出 Excel</p>
        </div>
        <button className="template-btn" onClick={downloadTemplate}>下载输入模板</button>
      </div>

      {!job && (
        <>
          <div className="skip-ai-row">
            <label className="skip-ai-label">
              <input type="checkbox" checked={skipAI} onChange={(e) => setSkipAI(e.target.checked)} />
              <span>跳过 AI 分析（节省 Token，仅运行规则引擎）</span>
            </label>
          </div>

          <div
            className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={onFileChange} />
            <div className="drop-icon">📂</div>
            <p className="drop-text">{uploading ? "上传中…" : "拖拽 Excel 文件到此处，或点击选择文件"}</p>
            <p className="drop-hint">支持 .xlsx / .xls，最大 10MB</p>
          </div>

          {error && <div className="batch-error">{error}</div>}
        </>
      )}

      {job && (
        <div className="job-card">
          <div className="job-meta">
            <span className="job-filename">{job.filename}</span>
            <span className={`job-status job-status--${job.status}`}>
              {job.status === "processing" && "处理中…"}
              {job.status === "done" && "完成"}
              {job.status === "error" && "出错"}
              {job.status === "pending" && "等待中"}
            </span>
          </div>

          <div className="progress-bar-wrap">
            <div className="progress-bar" style={{ width: `${progress}%` }} />
          </div>
          <div className="progress-text">
            {job.processed_rows} / {job.total_rows} 条已处理（{progress}%）
          </div>

          {job.status === "error" && job.error_msg && (
            <div className="batch-error">{job.error_msg}</div>
          )}

          {job.status === "done" && (
            <div className="batch-summary">
              <div className="summary-stat">
                <span className="stat-num">{job.total_rows}</span>
                <span className="stat-label">总记录数</span>
              </div>
              <div className="summary-stat">
                <span className="stat-num">{job.processed_rows}</span>
                <span className="stat-label">已分析</span>
              </div>
            </div>
          )}

          <div className="job-actions">
            {job.status === "done" && (
              <button className="download-btn" onClick={downloadResult}>下载结果 Excel</button>
            )}
            <button className="reset-btn" onClick={reset}>重新上传</button>
          </div>
        </div>
      )}

      <div className="batch-note">
        <strong>字段说明：</strong> AI 分析仅对 AML 评分 ≥ 70 的高风险记录触发，以节省 Token。高风险记录将自动创建案件进入案件管理。
      </div>
    </div>
  );
}
