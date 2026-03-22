import { Codex } from "@openai/codex-sdk";
import { parseConvergenceTag } from "../convergence.js";
import type { AgentName, AgentResponse, ConversationContext } from "../types.js";
import type { AgentAdapter } from "./agent-adapter.js";

export class CodexAdapter implements AgentAdapter {
  name: AgentName = "codex";
  private client: Codex;
  private timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.client = new Codex();
    this.timeoutMs = timeoutMs;
  }

  async send(prompt: string, context: ConversationContext, signal?: AbortSignal): Promise<AgentResponse> {
    const fullPrompt = prompt;

    const thread = await this.client.startThread({
      workingDirectory: context.workingDirectory,
    });

    const result = await Promise.race([
      thread.run(fullPrompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Codex adapter timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
      ),
      ...(signal
        ? [new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error("aborted"));
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })]
        : []),
    ]);

    const content = result.finalResponse ?? String(result);
    const convergenceSignal = parseConvergenceTag(content);

    return {
      content,
      convergenceSignal: convergenceSignal ?? undefined,
    };
  }
}
