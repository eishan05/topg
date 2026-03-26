export type AgentName = "claude" | "codex";

// --- Session types ---

export type SessionType = "debate" | "collaborate";
export type SessionStatus = "active" | "paused" | "completed" | "escalated" | "closed";

export interface SessionMeta {
  version: 1;
  sessionId: string;
  type: SessionType;
  status: SessionStatus;
  agent?: AgentName;
  prompt: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// --- Artifact types ---

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

// --- Codex configuration ---

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

// --- Convergence ---

export type ConvergenceSignal = "agree" | "disagree" | "partial" | "defer";

// --- Agent communication ---

export interface AgentResponse {
  content: string;
  artifacts?: Artifact[];
  toolActivities?: ToolActivity[];
  convergenceSignal?: ConvergenceSignal;
}

export interface Message {
  role: string;
  agent: AgentName;
  turn: number;
  type: string;
  content: string;
  artifacts?: Artifact[];
  toolActivities?: ToolActivity[];
  convergenceSignal?: ConvergenceSignal;
  timestamp: string;
}

export interface ConversationContext {
  sessionId: string;
  history: Message[];
  workingDirectory: string;
  systemPrompt: string;
}
