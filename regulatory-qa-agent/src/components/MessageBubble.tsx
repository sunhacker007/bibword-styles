import React from "react";
import type { Message } from "../types";
import "./MessageBubble.css";

interface Props {
  message: Message;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export const MessageBubble: React.FC<Props> = ({ message }) => {
  const isUser = message.role === "user";

  return (
    <div className={`message-row ${isUser ? "user-row" : "assistant-row"}`}>
      {!isUser && (
        <div className="avatar assistant-avatar" aria-label="监管助手">
          <span>监</span>
        </div>
      )}
      <div className={`bubble ${isUser ? "user-bubble" : "assistant-bubble"}`}>
        <div className="bubble-content">
          {message.content}
          {message.isStreaming && <span className="cursor" aria-hidden="true" />}
        </div>
        <div className="bubble-time">{formatTime(message.timestamp)}</div>
      </div>
      {isUser && (
        <div className="avatar user-avatar" aria-label="用户">
          <span>我</span>
        </div>
      )}
    </div>
  );
};
