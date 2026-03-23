import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexAdapter } from "../../src/adapters/codex-adapter.js";
import type { ConversationContext } from "../../src/types.js";

// Track what options were passed to startThread
let lastThreadOptions: any = null;

// Mock the codex SDK
vi.mock("@openai/codex-sdk", () => {
  const mockThread = {
    run: vi.fn().mockResolvedValue({
      finalResponse: "Here is my code review.\n[CONVERGENCE: partial]",
      items: [
        {
          id: "cmd-1",
          type: "command_execution",
          command: "cat src/index.ts",
          aggregated_output: "file contents here",
          exit_code: 0,
          status: "completed",
        },
        {
          id: "fc-1",
          type: "file_change",
          changes: [{ path: "src/app.ts", kind: "update" }],
          status: "completed",
        },
        {
          id: "ws-1",
          type: "web_search",
          query: "typescript best practices",
        },
        {
          id: "msg-1",
          type: "agent_message",
          text: "Here is my code review.\n[CONVERGENCE: partial]",
        },
      ],
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
    }),
  };
  return {
    Codex: class MockCodex {
      startThread = vi.fn((opts: any) => {
        lastThreadOptions = opts;
        return Promise.resolve(mockThread);
      });
    },
  };
});

describe("CodexAdapter", () => {
  const ctx: ConversationContext = {
    sessionId: "test-123",
    history: [],
    workingDirectory: "/tmp",
    systemPrompt: "You are a reviewer.",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lastThreadOptions = null;
  });

  it("should send a prompt and parse the response", async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.send("Review this code", ctx);

    expect(result.content).toContain("Here is my code review");
    expect(result.convergenceSignal).toBe("partial");
  });

  it("should have name 'codex'", () => {
    const adapter = new CodexAdapter();
    expect(adapter.name).toBe("codex");
  });

  it("should pass default thread options with capabilities enabled", async () => {
    const adapter = new CodexAdapter();
    await adapter.send("Review this code", ctx);

    expect(lastThreadOptions).toEqual({
      workingDirectory: "/tmp",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      webSearchMode: "live",
      networkAccessEnabled: true,
    });
  });

  it("should pass custom sandbox and web search options", async () => {
    const adapter = new CodexAdapter(120_000, {
      sandboxMode: "danger-full-access",
      webSearchMode: "live",
      networkAccessEnabled: true,
      model: "o3",
      modelReasoningEffort: "high",
    });
    await adapter.send("Review this code", ctx);

    expect(lastThreadOptions.sandboxMode).toBe("danger-full-access");
    expect(lastThreadOptions.webSearchMode).toBe("live");
    expect(lastThreadOptions.networkAccessEnabled).toBe(true);
    expect(lastThreadOptions.model).toBe("o3");
    expect(lastThreadOptions.modelReasoningEffort).toBe("high");
  });

  it("should extract tool activities from items", async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.send("Review this code", ctx);

    expect(result.toolActivities).toBeDefined();
    expect(result.toolActivities).toHaveLength(3);

    // Command execution
    const cmd = result.toolActivities!.find((a) => a.type === "command_execution");
    expect(cmd).toBeDefined();
    if (cmd?.type === "command_execution") {
      expect(cmd.command).toBe("cat src/index.ts");
      expect(cmd.exitCode).toBe(0);
    }

    // File change
    const fc = result.toolActivities!.find((a) => a.type === "file_change");
    expect(fc).toBeDefined();
    if (fc?.type === "file_change") {
      expect(fc.changes).toHaveLength(1);
      expect(fc.changes[0].path).toBe("src/app.ts");
    }

    // Web search
    const ws = result.toolActivities!.find((a) => a.type === "web_search");
    expect(ws).toBeDefined();
    if (ws?.type === "web_search") {
      expect(ws.query).toBe("typescript best practices");
    }
  });

  it("should not include agent_message items in tool activities", async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.send("Review this code", ctx);

    const msgActivity = result.toolActivities?.find((a) => (a as any).type === "agent_message");
    expect(msgActivity).toBeUndefined();
  });

  it("should allow runtime config updates", async () => {
    const adapter = new CodexAdapter(120_000, { webSearchMode: "disabled", networkAccessEnabled: false });
    adapter.updateConfig({ webSearchMode: "cached", networkAccessEnabled: true });
    await adapter.send("Review this code", ctx);

    expect(lastThreadOptions.webSearchMode).toBe("cached");
    expect(lastThreadOptions.networkAccessEnabled).toBe(true);
  });

  it("should not include webSearchMode when disabled", async () => {
    const adapter = new CodexAdapter(120_000, { webSearchMode: "disabled" });
    await adapter.send("Review this code", ctx);

    expect(lastThreadOptions.webSearchMode).toBeUndefined();
  });

  it("should pass additional directories when configured", async () => {
    const adapter = new CodexAdapter(120_000, {
      additionalDirectories: ["/home/user/libs", "/opt/shared"],
    });
    await adapter.send("Review this code", ctx);

    expect(lastThreadOptions.additionalDirectories).toEqual(["/home/user/libs", "/opt/shared"]);
  });
});
