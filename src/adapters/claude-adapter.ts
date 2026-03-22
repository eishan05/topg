import { spawn } from "node:child_process";
import { parseConvergenceTag } from "../convergence.js";
import type { AgentName, AgentResponse, ConversationContext } from "../types.js";
import type { AgentAdapter } from "./agent-adapter.js";

export class ClaudeAdapter implements AgentAdapter {
  name: AgentName = "claude";
  private timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  async send(prompt: string, context: ConversationContext, signal?: AbortSignal): Promise<AgentResponse> {
    const fullPrompt = prompt;

    return new Promise((resolve, reject) => {
      const proc = spawn("claude", ["-p", fullPrompt, "--output-format", "json"], {
        cwd: context.workingDirectory,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Claude adapter timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      if (signal) {
        if (signal.aborted) {
          proc.kill("SIGTERM");
          clearTimeout(timeout);
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          proc.kill("SIGTERM");
          clearTimeout(timeout);
          reject(new Error("aborted"));
        }, { once: true });
      }

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (signal?.aborted) return;
        if (code !== 0) {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const content = parsed.result ?? parsed.content ?? stdout;
          const convergenceSignal = parseConvergenceTag(content);
          resolve({
            content,
            convergenceSignal: convergenceSignal ?? undefined,
          });
        } catch {
          const convergenceSignal = parseConvergenceTag(stdout);
          resolve({
            content: stdout,
            convergenceSignal: convergenceSignal ?? undefined,
          });
        }
      });
    });
  }
}
