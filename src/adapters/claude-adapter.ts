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
      // --verbose is required when using --output-format stream-json with -p
      const args = ["-p", fullPrompt, "--output-format", "stream-json", "--verbose"];
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
      // Track how much text we've already emitted as chunks so we can compute deltas.
      // The CLI emits cumulative "assistant" events (not incremental deltas), so we
      // diff against the previous snapshot to determine new text.
      let emittedLen = 0;

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

            // The CLI emits "assistant" events containing cumulative message content.
            // Each event's message.content is an array of blocks; we extract text blocks.
            if (event.type === "assistant") {
              const contentBlocks = event.message?.content;
              if (Array.isArray(contentBlocks)) {
                let text = "";
                for (const block of contentBlocks) {
                  if (block.type === "text") {
                    text += block.text;
                  }
                }
                if (text.length > emittedLen) {
                  const delta = text.slice(emittedLen);
                  emittedLen = text.length;
                  fullContent = text;
                  onChunk?.(delta);
                }
              }
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
            if (event.type === "assistant") {
              const contentBlocks = event.message?.content;
              if (Array.isArray(contentBlocks)) {
                let text = "";
                for (const block of contentBlocks) {
                  if (block.type === "text") {
                    text += block.text;
                  }
                }
                if (text.length > emittedLen) {
                  const delta = text.slice(emittedLen);
                  emittedLen = text.length;
                  fullContent = text;
                  onChunk?.(delta);
                }
              }
            } else if (event.type === "result") {
              resultContent = event.result ?? null;
            }
          } catch { /* ignore malformed trailing data */ }
        }

        // Prefer the result event's content (authoritative), fall back to accumulated text
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
