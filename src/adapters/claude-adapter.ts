import { spawn } from "node:child_process";
import { parseConvergenceTag } from "../convergence.js";
import type { AgentName, AgentResponse, ConversationContext, StreamChunkCallback } from "../types.js";
import type { AgentAdapter } from "./agent-adapter.js";

export class ClaudeAdapter implements AgentAdapter {
  name: AgentName = "claude";
  private timeoutMs: number;
  private yolo: boolean;

  constructor(timeoutMs = 120_000, yolo = false) {
    this.timeoutMs = timeoutMs;
    this.yolo = yolo;
  }

  async send(prompt: string, context: ConversationContext, signal?: AbortSignal, onChunk?: StreamChunkCallback): Promise<AgentResponse> {
    const fullPrompt = prompt;

    return new Promise((resolve, reject) => {
      const args = ["-p", fullPrompt, "--output-format", "stream-json"];
      if (this.yolo) {
        args.push("--dangerously-skip-permissions");
      }

      const proc = spawn("claude", args, {
        cwd: context.workingDirectory,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      let fullContent = "";
      let resultContent: string | null = null;
      let lineBuffer = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();

        // Process complete lines (NDJSON — one JSON object per line)
        let newlineIdx: number;
        while ((newlineIdx = lineBuffer.indexOf("\n")) !== -1) {
          const line = lineBuffer.slice(0, newlineIdx).trim();
          lineBuffer = lineBuffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const event = JSON.parse(line);

            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              const text = event.delta.text;
              fullContent += text;
              onChunk?.(text);
            } else if (event.type === "result") {
              resultContent = event.result ?? null;
            }
          } catch {
            // Skip malformed lines
          }
        }
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

        // Flush any remaining data in lineBuffer (e.g. final line without trailing \n)
        const remaining = lineBuffer.trim();
        if (remaining) {
          try {
            const event = JSON.parse(remaining);
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              fullContent += event.delta.text;
              onChunk?.(event.delta.text);
            } else if (event.type === "result") {
              resultContent = event.result ?? null;
            }
          } catch { /* ignore malformed trailing data */ }
        }

        // Prefer the result event's content (authoritative), fall back to accumulated deltas
        const content = resultContent ?? fullContent;
        const convergenceSignal = parseConvergenceTag(content);
        resolve({
          content,
          convergenceSignal: convergenceSignal ?? undefined,
        });
      });
    });
  }
}
