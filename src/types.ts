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

// --- Tool activity tracking ---

export type ToolActivityType = "command_execution" | "file_change" | "mcp_tool_call" | "web_search";

export interface CommandActivity {
  type: "command_execution";
  command: string;
  output: string;
  exitCode?: number;
}

export interface FileChangeActivity {
  type: "file_change";
  changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
}

export interface McpCallActivity {
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments: unknown;
  error?: string;
}

export interface WebSearchActivity {
  type: "web_search";
  query: string;
}

export type ToolActivity = CommandActivity | FileChangeActivity | McpCallActivity | WebSearchActivity;

// --- Codex-specific configuration ---

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WebSearchMode = "disabled" | "cached" | "live";
export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";

export interface CodexConfig {
  sandboxMode: SandboxMode;
  webSearchMode: WebSearchMode;
  networkAccessEnabled: boolean;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  approvalPolicy: ApprovalMode;
  additionalDirectories?: string[];
}

export const DEFAULT_CODEX_CONFIG: CodexConfig = {
  sandboxMode: "workspace-write",
  webSearchMode: "live",
  networkAccessEnabled: true,
  approvalPolicy: "never",
};

// --- Core types ---

export interface Message {
  role: Role;
  agent: AgentName;
  turn: number;
  type: MessageType;
  content: string;
  artifacts?: Artifact[];
  toolActivities?: ToolActivity[];
  convergenceSignal?: ConvergenceSignal;
  timestamp: string;
}

export interface AgentResponse {
  content: string;
  artifacts?: Artifact[];
  toolActivities?: ToolActivity[];
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
  codex: CodexConfig;
  yolo?: boolean;
}

export interface OrchestratorResult {
  type: "consensus" | "escalation";
  sessionId: string;
  rounds: number;
  summary: string;
  messages: Message[];
  artifacts?: Artifact[];
}
