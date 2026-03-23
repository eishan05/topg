export type AgentName = "claude" | "codex";
export type Role = "initiator" | "reviewer";
export type MessageType = "code" | "review" | "debate" | "consensus" | "deadlock" | "user-prompt" | "user-guidance";
export type ConvergenceSignal = "agree" | "disagree" | "partial" | "defer";
export type ArtifactType = "code" | "diff" | "config";

export interface Artifact {
  path: string;
  content: string;
  type: ArtifactType;
}

export interface Message {
  role: Role;
  agent: AgentName;
  turn: number;
  type: MessageType;
  content: string;
  artifacts?: Artifact[];
  convergenceSignal?: ConvergenceSignal;
  timestamp: string;
}

export interface AgentResponse {
  content: string;
  artifacts?: Artifact[];
  convergenceSignal?: ConvergenceSignal;
}

export interface ConversationContext {
  sessionId: string;
  history: Message[];
  workingDirectory: string;
  systemPrompt: string;
}

export interface SessionMeta {
  version: 1;
  sessionId: string;
  status: "active" | "paused" | "completed" | "escalated";
  prompt: string;
  config: OrchestratorConfig;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorConfig {
  startWith: AgentName;
  workingDirectory: string;
  guardrailRounds: number;
  timeoutMs: number;
  outputFormat: "text" | "json";
}

export interface OrchestratorResult {
  type: "consensus" | "escalation";
  sessionId: string;
  rounds: number;
  summary: string;
  messages: Message[];
  artifacts?: Artifact[];
}
