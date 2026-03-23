import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import type { Message, SessionMeta, OrchestratorConfig } from "./types.js";

export interface SessionData {
  meta: SessionMeta;
  messages: Message[];
}

export class SessionManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(
      process.env.TOPG_HOME ?? path.join(os.homedir(), ".topg"),
      "sessions"
    );
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId);
  }

  create(prompt: string, config: OrchestratorConfig): SessionMeta {
    const sessionId = nanoid(12);
    const dir = this.sessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      version: 1,
      sessionId,
      status: "active",
      prompt,
      config,
      createdAt: now,
      updatedAt: now,
    };

    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, "transcript.jsonl"), "");
    return meta;
  }

  appendMessage(sessionId: string, message: Message): void {
    const transcriptPath = path.join(this.sessionDir(sessionId), "transcript.jsonl");
    fs.appendFileSync(transcriptPath, JSON.stringify(message) + "\n");
    this.touchUpdatedAt(sessionId);
  }

  load(sessionId: string): SessionData {
    const dir = this.sessionDir(sessionId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const meta: SessionMeta = JSON.parse(
      fs.readFileSync(path.join(dir, "meta.json"), "utf-8")
    );

    const transcriptPath = path.join(dir, "transcript.jsonl");
    const raw = fs.readFileSync(transcriptPath, "utf-8").trim();
    const messages: Message[] = raw
      ? raw.split("\n").map((line) => JSON.parse(line))
      : [];

    return { meta, messages };
  }

  updateStatus(sessionId: string, status: SessionMeta["status"]): void {
    const metaPath = path.join(this.sessionDir(sessionId), "meta.json");
    const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.status = status;
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  saveSummary(sessionId: string, summary: string): void {
    const summaryPath = path.join(this.sessionDir(sessionId), "summary.md");
    fs.writeFileSync(summaryPath, summary);
  }

  private touchUpdatedAt(sessionId: string): void {
    const metaPath = path.join(this.sessionDir(sessionId), "meta.json");
    const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  listSessions(): SessionMeta[] {
    if (!fs.existsSync(this.baseDir)) return [];
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const sessions: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.baseDir, entry.name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        sessions.push(meta);
      } catch {
        // skip corrupted sessions
      }
    }
    return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  deleteSession(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  filterSessions(opts: { statuses?: SessionMeta["status"][]; olderThan?: Date }): SessionMeta[] {
    return this.listSessions().filter((s) => {
      if (opts.statuses && !opts.statuses.includes(s.status)) return false;
      if (opts.olderThan && new Date(s.updatedAt) >= opts.olderThan) return false;
      return true;
    });
  }

  updatePrompt(sessionId: string, prompt: string): void {
    const metaPath = path.join(this.sessionDir(sessionId), "meta.json");
    const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.prompt = prompt;
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}
