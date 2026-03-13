import React from "react";
import type { SuggestedQuestion } from "../types";
import "./SuggestedQuestions.css";

interface Props {
  questions: SuggestedQuestion[];
  onSelect: (text: string) => void;
}

export const SuggestedQuestions: React.FC<Props> = ({ questions, onSelect }) => (
  <div className="suggestions">
    <p className="suggestions-label">常见问题</p>
    <div className="suggestions-grid">
      {questions.map((q) => (
        <button
          key={q.id}
          className="suggestion-chip"
          onClick={() => onSelect(q.text)}
          aria-label={q.text}
        >
          <span className="chip-category">{q.category}</span>
          <span className="chip-text">{q.text}</span>
        </button>
      ))}
    </div>
  </div>
);
