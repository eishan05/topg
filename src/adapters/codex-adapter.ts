import { Codex } from "@openai/codex-sdk";
import type { ThreadOptions, ThreadItem } from "@openai/codex-sdk";
import { parseConvergenceTag } from "../convergence.js";
import type {
  AgentName,
  AgentResponse,
  CodexConfig,
  ConversationContext,
  ToolActivity,
} from "../types.js";
import type { AgentAdapter } from "./agent-adapter.js";

export class CodexAdapter implements AgentAdapter {
  name: AgentName = "codex";
  private client: Codex;
  private timeoutMs: number;
  private codexConfig: CodexConfig;

  constructor(timeoutMs = 120_000, codexConfig?: Partial<CodexConfig>, yolo = false) {
    this.client = new Codex();
    this.timeoutMs = timeoutMs;

    if (yolo) {
      // In yolo mode, override to maximum permissions
      this.codexConfig = {
        sandboxMode: "danger-full-access",
        webSearchMode: codexConfig?.webSearchMode ?? "live",
        networkAccessEnabled: true,
        approvalPolicy: "never",
        model: codexConfig?.model,
        modelReasoningEffort: codexConfig?.modelReasoningEffort,
        additionalDirectories: codexConfig?.additionalDirectories,
      };
    } else {
      this.codexConfig = {
        sandboxMode: codexConfig?.sandboxMode ?? "workspace-write",
        webSearchMode: codexConfig?.webSearchMode ?? "live",
        networkAccessEnabled: codexConfig?.networkAccessEnabled ?? true,
        approvalPolicy: codexConfig?.approvalPolicy ?? "never",
        model: codexConfig?.model,
        modelReasoningEffort: codexConfig?.modelReasoningEffort,
        additionalDirectories: codexConfig?.additionalDirectories,
      };
    }
  }

  /**
   * Update codex configuration at runtime (e.g. from REPL /config).
   */
  updateConfig(partial: Partial<CodexConfig>): void {
    Object.assign(this.codexConfig, partial);
  }

  async send(prompt: string, context: ConversationContext, signal?: AbortSignal): Promise<AgentResponse> {
    const fullPrompt = prompt;

    const threadOpts: ThreadOptions = {
      workingDirectory: context.workingDirectory,
      sandboxMode: this.codexConfig.sandboxMode,
      approvalPolicy: this.codexConfig.approvalPolicy,
    };

    // Conditionally set optional fields
    if (this.codexConfig.model) {
      threadOpts.model = this.codexConfig.model;
    }
    if (this.codexConfig.modelReasoningEffort) {
      threadOpts.modelReasoningEffort = this.codexConfig.modelReasoningEffort;
    }
    if (this.codexConfig.webSearchMode !== "disabled") {
      threadOpts.webSearchMode = this.codexConfig.webSearchMode;
    }
    if (this.codexConfig.networkAccessEnabled) {
      threadOpts.networkAccessEnabled = true;
    }
    if (this.codexConfig.additionalDirectories?.length) {
      threadOpts.additionalDirectories = this.codexConfig.additionalDirectories;
    }

    const thread = await this.client.startThread(threadOpts);

    const result = await Promise.race([
      thread.run(fullPrompt, signal ? { signal } : undefined),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Codex adapter timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
      ),
    ]);

    const content = result.finalResponse ?? String(result);
    const convergenceSignal = parseConvergenceTag(content);
    const toolActivities = extractToolActivities(result.items);

    return {
      content,
      toolActivities: toolActivities.length > 0 ? toolActivities : undefined,
      convergenceSignal: convergenceSignal ?? undefined,
    };
  }
}

/**
 * Extract structured tool activity from Codex thread items.
 */
function extractToolActivities(items: ThreadItem[]): ToolActivity[] {
  const activities: ToolActivity[] = [];

  for (const item of items) {
    switch (item.type) {
      case "command_execution":
        activities.push({
          type: "command_execution",
          command: item.command,
          output: item.aggregated_output,
          exitCode: item.exit_code,
        });
        break;

      case "file_change":
        activities.push({
          type: "file_change",
          changes: item.changes.map((c) => ({
            path: c.path,
            kind: c.kind,
          })),
        });
        break;

      case "mcp_tool_call":
        activities.push({
          type: "mcp_tool_call",
          server: item.server,
          tool: item.tool,
          arguments: item.arguments,
          error: item.error?.message,
        });
        break;

      case "web_search":
        activities.push({
          type: "web_search",
          query: item.query,
        });
        break;

      // agent_message, reasoning, todo_list, error — not tracked as tool activity
    }
  }

  return activities;
}
