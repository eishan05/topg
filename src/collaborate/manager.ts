import type { AgentAdapter } from "../core/adapters/agent-adapter.js";
import { SessionManager } from "../core/session.js";
import type { AgentName, Message } from "../core/types.js";
import type {
  CollaborateConfig,
  CollaborateStartResult,
  CollaborateSendResult,
  CollaborateEndResult,
  CollaborateListItem,
} from "./types.js";
import { collaboratorSystemPrompt, formatCollaboratePrompt } from "./prompts.js";

export class CollaborationManager {
  private adapter: AgentAdapter;
  private session: SessionManager;
  private config: CollaborateConfig;

  constructor(adapter: AgentAdapter, session: SessionManager, config: CollaborateConfig) {
    this.adapter = adapter;
    this.session = session;
    this.config = config;
  }

  async start(prompt: string): Promise<CollaborateStartResult> {
    const callerAgent: AgentName = this.config.with === "codex" ? "claude" : "codex";
    const meta = this.session.create(
      prompt,
      "collaborate",
      this.config as unknown as Record<string, unknown>,
      this.config.with
    );

    const systemPrompt = collaboratorSystemPrompt(callerAgent);
    const fullPrompt = formatCollaboratePrompt(systemPrompt, [], prompt);

    const callerMsg: Message = {
      role: "caller",
      agent: callerAgent,
      turn: 1,
      type: "request",
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    this.session.appendMessage(meta.sessionId, callerMsg);

    const response = await this.adapter.send(fullPrompt, {
      sessionId: meta.sessionId,
      history: [callerMsg],
      workingDirectory: this.config.workingDirectory,
      systemPrompt,
    });

    const collabMsg: Message = {
      role: "collaborator",
      agent: this.config.with,
      turn: 1,
      type: "response",
      content: response.content,
      artifacts: response.artifacts,
      toolActivities: response.toolActivities,
      timestamp: new Date().toISOString(),
    };
    this.session.appendMessage(meta.sessionId, collabMsg);

    return {
      sessionId: meta.sessionId,
      agent: this.config.with,
      response: response.content,
      artifacts: response.artifacts,
    };
  }

  async send(sessionId: string, message: string): Promise<CollaborateSendResult> {
    const { meta, messages } = this.session.load(sessionId);

    if (meta.type !== "collaborate") {
      throw new Error(`Session ${sessionId} is not a collaborate session`);
    }
    if (meta.status !== "active") {
      throw new Error(`Session is not active: ${sessionId} (status: ${meta.status})`);
    }

    const callerAgent: AgentName = this.config.with === "codex" ? "claude" : "codex";
    const turn = Math.max(...messages.map((m) => m.turn), 0) + 1;

    const callerMsg: Message = {
      role: "caller",
      agent: callerAgent,
      turn,
      type: "request",
      content: message,
      timestamp: new Date().toISOString(),
    };
    this.session.appendMessage(sessionId, callerMsg);

    const systemPrompt = collaboratorSystemPrompt(callerAgent);
    const fullPrompt = formatCollaboratePrompt(systemPrompt, [...messages, callerMsg], message);

    const response = await this.adapter.send(fullPrompt, {
      sessionId,
      history: [...messages, callerMsg],
      workingDirectory: this.config.workingDirectory,
      systemPrompt,
    });

    const collabMsg: Message = {
      role: "collaborator",
      agent: this.config.with,
      turn,
      type: "response",
      content: response.content,
      artifacts: response.artifacts,
      toolActivities: response.toolActivities,
      timestamp: new Date().toISOString(),
    };
    this.session.appendMessage(sessionId, collabMsg);

    return {
      sessionId,
      response: response.content,
      artifacts: response.artifacts,
    };
  }

  async end(sessionId: string): Promise<CollaborateEndResult> {
    const { meta, messages } = this.session.load(sessionId);
    this.session.updateStatus(sessionId, "closed");
    return {
      sessionId,
      status: "closed",
      messageCount: messages.length,
    };
  }

  async list(activeOnly?: boolean): Promise<CollaborateListItem[]> {
    const sessions = this.session.filterSessions({
      type: "collaborate",
      ...(activeOnly ? { statuses: ["active"] } : {}),
    });

    return sessions.map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent!,
      status: s.status,
      createdAt: s.createdAt,
      lastMessageAt: s.updatedAt,
    }));
  }

  resolveSessionId(sessionIdOrLast: string): string {
    if (sessionIdOrLast === "--last") {
      const sessions = this.session.filterSessions({ type: "collaborate" });
      if (sessions.length === 0) {
        throw new Error("No collaboration sessions found");
      }
      return sessions[0].sessionId;
    }
    return sessionIdOrLast;
  }
}
