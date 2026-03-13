import React, { useState, useRef, useEffect, useCallback } from "react";
import { MessageBubble } from "./components/MessageBubble";
import { SuggestedQuestions } from "./components/SuggestedQuestions";
import { AMLAgent } from "./components/AMLAgent";
import { KYCAgent } from "./components/KYCAgent";
import type { Message, SuggestedQuestion } from "./types";
import "./App.css";

const SUGGESTED: SuggestedQuestion[] = [
  { id: "1", category: "银行监管", text: "银行资本充足率的计算方法和最低要求是什么？" },
  { id: "2", category: "证券监管", text: "上市公司信息披露的主要法规要求有哪些？" },
  { id: "3", category: "反洗钱", text: "金融机构反洗钱客户尽职调查的核心要求？" },
  { id: "4", category: "保险监管", text: "保险公司偿付能力监管框架（偿二代）的主要内容？" },
  { id: "5", category: "外汇管理", text: "跨境资金流动的外汇管理政策有哪些要点？" },
  { id: "6", category: "数据合规", text: "金融机构数据安全和个人信息保护的主要合规要求？" },
];

function genId() {
  return Math.random().toString(36).slice(2);
}

type Tab = "chat" | "aml" | "kyc";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("aml");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = {
      id: genId(),
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };

    const assistantId = genId();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setLoading(true);

    const history = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: trimmed },
    ];

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + parsed.text }
                    : m
                )
              );
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未知错误";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `⚠️ 请求失败：${msg}`, isStreaming: false }
            : m
        )
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, isStreaming: false } : m
        )
      );
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [messages, loading]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleSelect = (text: string) => {
    setInput(text);
    inputRef.current?.focus();
  };

  const handleClear = () => {
    setMessages([]);
    setInput("");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="header-logo" aria-hidden="true">F</div>
          <div>
            <h1 className="header-title">FCAP · Fintech Compliance & Risk Platform</h1>
            <p className="header-subtitle">AML Agent · KYC Agent · 监管知识问答</p>
          </div>
        </div>
        <div className="header-right">
          <span className="status-dot" aria-hidden="true" />
          <span className="status-text">Demo</span>
          {activeTab === "chat" && messages.length > 0 && (
            <button className="clear-btn" onClick={handleClear} aria-label="清除对话">
              清除
            </button>
          )}
        </div>
      </header>

      <nav className="tab-nav">
        <button
          className={`tab-btn ${activeTab === "aml" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("aml")}
        >
          <span className="tab-icon">🔍</span>
          AML Agent
          <span className="tab-tag">反洗钱评分</span>
        </button>
        <button
          className={`tab-btn ${activeTab === "kyc" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("kyc")}
        >
          <span className="tab-icon">👤</span>
          KYC Agent
          <span className="tab-tag">客户尽职调查</span>
        </button>
        <button
          className={`tab-btn ${activeTab === "chat" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("chat")}
        >
          <span className="tab-icon">💬</span>
          监管问答
          <span className="tab-tag">知识库</span>
        </button>
      </nav>

      {activeTab === "aml" && (
        <main className="tab-content">
          <AMLAgent />
        </main>
      )}

      {activeTab === "kyc" && (
        <main className="tab-content">
          <KYCAgent />
        </main>
      )}

      {activeTab === "chat" && (
        <>
          <main className="chat-area" role="log" aria-live="polite" aria-label="对话记录">
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-icon" aria-hidden="true">⚖️</div>
                <h2 className="welcome-title">监管知识问答助手</h2>
                <p className="welcome-desc">
                  专注于金融监管、合规政策、法律法规领域<br />
                  涵盖银行、证券、保险、外汇、反洗钱等方向
                </p>
                <SuggestedQuestions questions={SUGGESTED} onSelect={handleSelect} />
              </div>
            ) : (
              <div className="messages">
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </main>

          <footer className="input-area">
            {messages.length > 0 && !loading && (
              <div className="quick-suggestions">
                {SUGGESTED.slice(0, 3).map((q) => (
                  <button
                    key={q.id}
                    className="quick-chip"
                    onClick={() => handleSelect(q.text)}
                  >
                    {q.category}
                  </button>
                ))}
              </div>
            )}
            <div className="input-row">
              <textarea
                ref={inputRef}
                className="input-box"
                placeholder="请输入您的监管合规问题..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
                rows={1}
                aria-label="输入问题"
              />
              <button
                className="send-btn"
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || loading}
                aria-label="发送"
              >
                {loading ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </button>
            </div>
            <p className="input-hint">按 Enter 发送 · Shift+Enter 换行 · 本助手仅供参考，不构成法律建议</p>
          </footer>
        </>
      )}
    </div>
  );
}
