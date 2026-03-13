export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
}

export interface SuggestedQuestion {
  id: string;
  text: string;
  category: string;
}
