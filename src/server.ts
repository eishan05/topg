import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "./session.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface TopgServerOptions {
  port: number;
  sessionManager: SessionManager;
}

export function createTopgServer(opts: TopgServerOptions) {
  const { sessionManager } = opts;

  // Resolve static files relative to project root, NOT __dirname.
  // After tsc build, __dirname will be dist/, but static assets stay in src/web/public/.
  const projectRoot = path.resolve(__dirname, "..");
  const publicDir = path.join(projectRoot, "src", "web", "public");

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // API routes
    if (pathname === "/api/sessions" && req.method === "GET") {
      const sessions = sessionManager.listSessions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const sessionId = sessionMatch[1];
      try {
        const data = sessionManager.load(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
      return;
    }

    // Static file serving
    let filePath: string;
    if (pathname === "/") {
      filePath = path.join(publicDir, "index.html");
    } else {
      // Directory traversal protection: resolve and verify it stays within publicDir
      const resolved = path.resolve(publicDir, pathname.slice(1));
      if (!resolved.startsWith(publicDir)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      filePath = resolved;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  return {
    httpServer,
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(opts.port, "127.0.0.1", () => {
          const addr = httpServer.address();
          if (addr && typeof addr === "object") {
            resolve(addr.port);
          } else {
            reject(new Error("Failed to get server address"));
          }
        });
      });
    },
    close() {
      httpServer.close();
    },
  };
}
