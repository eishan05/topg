import type { AgentName, CodexConfig, Artifact } from "../core/types.js";

export interface CollaborateConfig {
  with: AgentName;
  workingDirectory: string;
  timeoutMs: number;
  outputFormat: "text" | "json";
  codex: CodexConfig;
  yolo?: boolean;
}

export interface CollaborateStartResult {
  sessionId: string;
  agent: AgentName;
  response: string;
  artifacts?: Artifact[];
}

export interface CollaborateSendResult {
  sessionId: string;
  response: string;
  artifacts?: Artifact[];
}

export interface CollaborateEndResult {
  sessionId: string;
  status: "closed";
  messageCount: number;
}

export interface CollaborateListItem {
  sessionId: string;
  agent: AgentName;
  status: string;
  createdAt: string;
  lastMessageAt: string;
}
