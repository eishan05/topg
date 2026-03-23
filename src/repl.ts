import { createInterface } from "node:readline";
import chalk from "chalk";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { Orchestrator } from "./orchestrator.js";
import type { OrchestratorCallbacks } from "./orchestrator.js";
import { SessionManager } from "./session.js";
import { createTopgServer } from "./server.js";
import type { AgentName, CodexConfig, Message, OrchestratorConfig, OrchestratorResult } from "./types.js";

// --- Command parsing ---

export interface ParsedCommand {
  command: string;
  args: string;
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed.slice(1), args: "" };
  }
  return {
    command: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

function isUserInputMessage(message: Message): boolean {
  return message.type === "user-prompt" || message.type === "user-guidance";
}

export function selectTranscriptMessages(messages: Message[]): Message[] {
  const agentMessages = messages.filter((message) => !isUserInputMessage(message));
  const lastUserPromptIdx = [...messages].reverse().findIndex((message) => message.type === "user-prompt");
  const startIdx = lastUserPromptIdx >= 0 ? messages.length - lastUserPromptIdx : 0;
  const roundMessages = messages.slice(startIdx).filter((message) => !isUserInputMessage(message));
  return roundMessages.length > 0 ? roundMessages : agentMessages;
}

// --- Spinner ---

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  start(message: string, turn: number, maxTurns: number): void;
  update(message: string, turn: number, maxTurns: number): void;
  stop(): void;
}

export function createSpinner(write: (text: string) => void): Spinner {
  let frameIdx = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentMessage = "";
  let currentTurn = 0;
  let currentMax = 0;

  function render() {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    const turnDisplay = currentTurn > currentMax
      ? "escalating..."
      : `turn ${currentTurn}/${currentMax}`;
    write(`\r${frame} ${currentMessage} ${turnDisplay}`);
    frameIdx++;
  }

  return {
    start(message, turn, maxTurns) {
      currentMessage = message;
      currentTurn = turn;
      currentMax = maxTurns;
      frameIdx = 0;
      if (interval) clearInterval(interval);
      interval = setInterval(render, 80);
      render();
    },
    update(message, turn, maxTurns) {
      currentMessage = message;
      currentTurn = turn;
      currentMax = maxTurns;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      write("\r\x1b[K");
    },
  };
}

// --- REPL State ---

interface ReplState {
  sessionId: string;
  messages: Message[];
  roundIndex: number;
  roundStartTurn: number;
  config: OrchestratorConfig;
  lastResult: OrchestratorResult | null;
  debateInProgress: boolean;
  escalationPending: boolean;
}

// --- REPL ---

export interface ReplOptions {
  dashboard?: boolean;
}

export async function startRepl(
  config: OrchestratorConfig,
  resumeSessionId?: string,
  options?: ReplOptions
): Promise<void> {
  const session = new SessionManager();
  const yolo = !!config.yolo;
  const claude = new ClaudeAdapter(config.timeoutMs, yolo);
  const codex = new CodexAdapter(config.timeoutMs, config.codex, yolo);

  const spinner = createSpinner((text) => process.stderr.write(text));

  // Start the web dashboard server in the background (unless --no-dashboard)
  const enableDashboard = options?.dashboard !== false;
  let server: ReturnType<typeof createTopgServer> | null = null;
  let dashboardUrl: string | null = null;

  if (enableDashboard) {
    server = createTopgServer({ port: 0, sessionManager: session });
    try {
      const dashboardPort = await server.start();
      dashboardUrl = `http://localhost:${dashboardPort}`;
    } catch {
      process.stderr.write(chalk.dim("Dashboard unavailable (port binding failed)\n"));
      server = null;
    }
  }

  let serverClosed = false;
  function closeServer() {
    if (server && !serverClosed) {
      serverClosed = true;
      server.close();
    }
  }

  let abortController: AbortController | null = null;

  // State must be declared before callbacks so they can reference state
  const state: ReplState = {
    sessionId: "",
    messages: [],
    roundIndex: 0,
    roundStartTurn: 1,
    config,
    lastResult: null,
    debateInProgress: false,
    escalationPending: false,
  };

  let dashboardHintShown = false;

  const callbacks: OrchestratorCallbacks = {
    onTurnStart: (turn, agent, role) => {
      const label = agent === "claude"
        ? chalk.magenta("Claude")
        : chalk.green("Codex");
      const relativeTurn = turn - state.roundStartTurn + 1;
      if (role === "escalation") {
        spinner.update(`${label} (${role}) responding...`, state.config.guardrailRounds + 1, state.config.guardrailRounds);
      } else {
        spinner.start(`${label} (${role}) responding...`, relativeTurn, state.config.guardrailRounds);
      }
      server?.broadcast({ type: "turn.start", sessionId: state.sessionId, turn, agent, role });
    },
    onTurnComplete: (message) => {
      server?.broadcast({ type: "turn.complete", sessionId: state.sessionId, message });
    },
  };

  let orchestrator = new Orchestrator(claude, codex, session, config, callbacks);

  // Load or create session
  if (resumeSessionId) {
    const loaded = session.load(resumeSessionId);
    state.sessionId = resumeSessionId;
    state.messages = loaded.messages;
    state.roundStartTurn = Math.max(...loaded.messages.map((m) => m.turn), 0) + 1;
    state.config = { ...config, ...loaded.meta.config };
    codex.updateConfig(state.config.codex);
    // If launched with --yolo, re-apply yolo overrides so a saved session
    // can never downgrade permissions below what yolo guarantees.
    if (yolo) {
      codex.updateConfig({
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        networkAccessEnabled: true,
      });
    }
    orchestrator = new Orchestrator(claude, codex, session, state.config, callbacks);
    session.updateStatus(resumeSessionId, "active");
  } else {
    const meta = session.create("(interactive session)", config);
    state.sessionId = meta.sessionId;
    server?.broadcast({ type: "sessions.list", sessions: session.listSessions() });
  }

  // Welcome banner
  process.stderr.write(`\n${chalk.bold("topg")} — inter-agent collaboration\n`);
  if (yolo) {
    process.stderr.write(chalk.red.bold("WARNING: --yolo mode enabled. All permission checks are disabled.\n"));
  }
  process.stderr.write(`Session: ${chalk.dim(state.sessionId)}\n`);
  process.stderr.write(`Agents: ${chalk.magenta("Claude")} vs ${chalk.green("Codex")} (${state.config.startWith} goes first)\n`);
  const cx = state.config.codex;
  const capabilities: string[] = [];
  if (cx.sandboxMode !== "read-only") capabilities.push(`sandbox:${cx.sandboxMode}`);
  if (cx.webSearchMode !== "disabled") capabilities.push(`web:${cx.webSearchMode}`);
  if (cx.networkAccessEnabled) capabilities.push("network");
  if (capabilities.length > 0) {
    process.stderr.write(`Codex: ${chalk.dim(capabilities.join(", "))}\n`);
  }
  if (dashboardUrl) {
    process.stderr.write(`Dashboard: ${chalk.cyan(dashboardUrl)}\n`);
  }
  process.stderr.write(`Type a prompt to start a debate, or ${chalk.dim("/help")} for commands.\n\n`);

  // Readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: chalk.bold("topg> "),
  });

  // --- Slash command handlers ---
  const commands = new Map<string, (args: string) => void | Promise<void>>();

  commands.set("quit", () => {
    session.updateStatus(state.sessionId, "paused");
    closeServer();
    process.stderr.write(`\nSession paused. Resume with: ${chalk.dim(`topg --resume ${state.sessionId}`)}\n`);
    rl.close();
    process.exit(0);
  });

  commands.set("help", () => {
    process.stderr.write(chalk.dim([
      "",
      "  /quit              Exit the REPL",
      "  /transcript        Show full transcript of last round",
      "  /history           Show summary of all rounds",
      "  /sessions          List all saved sessions",
      "  /resume <id>       Switch to a different session",
      "  /steer <text>      Provide guidance after escalation",
      "  /status            Show current session info",
      "  /dashboard         Open the live dashboard",
      "  /config [key] [val] View or change settings",
      "  /help              Show this help",
      "",
    ].join("\n")) + "\n");
  });

  commands.set("status", () => {
    process.stderr.write(chalk.dim([
      "",
      `  Session:    ${state.sessionId}`,
      `  Rounds:     ${state.roundIndex}`,
      `  Start with: ${state.config.startWith}`,
      `  Guardrail:  ${state.config.guardrailRounds} rounds`,
      `  Timeout:    ${state.config.timeoutMs / 1000}s per turn`,
      `  Last:       ${state.lastResult ? state.lastResult.type : "none"}`,
      "",
    ].join("\n")) + "\n");
  });

  commands.set("transcript", () => {
    if (state.messages.length === 0) {
      process.stderr.write(chalk.dim("  No messages yet.\n\n"));
      return;
    }
    const msgs = selectTranscriptMessages(state.messages);

    process.stderr.write("\n");
    for (const msg of msgs) {
      const label = msg.agent === "claude"
        ? chalk.magenta("Claude")
        : chalk.green("Codex");
      process.stderr.write(`  ${chalk.dim(`[Turn ${msg.turn}]`)} ${label} (${msg.role}):\n`);
      process.stderr.write(`  ${msg.content.split("\n").join("\n  ")}\n\n`);
    }
  });

  commands.set("history", () => {
    if (state.roundIndex === 0) {
      process.stderr.write(chalk.dim("  No rounds yet.\n\n"));
      return;
    }
    process.stderr.write("\n");
    const userPrompts = state.messages.filter((m) => m.type === "user-prompt");
    for (let i = 0; i < userPrompts.length; i++) {
      const promptSnippet = userPrompts[i].content.replace(`[USER PROMPT #${i + 1}]: `, "").slice(0, 60);
      const outcome = state.lastResult && i === userPrompts.length - 1 ? state.lastResult.type : "completed";
      process.stderr.write(chalk.dim(`  Round ${i + 1}: "${promptSnippet}" → ${outcome}\n`));
    }
    process.stderr.write("\n");
  });

  commands.set("sessions", () => {
    const allSessions = session.listSessions();
    if (allSessions.length === 0) {
      process.stderr.write(chalk.dim("  No sessions found.\n\n"));
      return;
    }
    process.stderr.write("\n");
    for (const s of allSessions) {
      const current = s.sessionId === state.sessionId ? chalk.green(" (current)") : "";
      const date = new Date(s.updatedAt).toLocaleDateString();
      const snippet = s.prompt.slice(0, 50);
      process.stderr.write(chalk.dim(`  ${s.sessionId}  ${date}  ${s.status.padEnd(10)}  "${snippet}"${current}\n`));
    }
    process.stderr.write("\n");
  });

  commands.set("resume", (args) => {
    const targetId = args.trim();
    if (!targetId) {
      process.stderr.write(chalk.dim("  Usage: /resume <sessionId>\n\n"));
      return;
    }
    try {
      const loaded = session.load(targetId);
      state.sessionId = targetId;
      state.messages = loaded.messages;
      state.roundIndex = loaded.messages.filter((m) => m.type === "user-prompt").length;
      state.roundStartTurn = Math.max(...loaded.messages.map((m) => m.turn), 0) + 1;
      state.lastResult = null;
      state.escalationPending = false;
      Object.assign(state.config, loaded.meta.config);
      codex.updateConfig(state.config.codex);
      // If launched with --yolo, re-apply yolo overrides so a saved session
      // can never downgrade permissions below what yolo guarantees.
      if (yolo) {
        codex.updateConfig({
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          networkAccessEnabled: true,
        });
      }
      orchestrator = new Orchestrator(claude, codex, session, state.config, callbacks);
      session.updateStatus(targetId, "active");
      server?.broadcast({ type: "sessions.list", sessions: session.listSessions() });
      process.stderr.write(`  Switched to session ${chalk.dim(targetId)} (${state.roundIndex} rounds)\n\n`);
    } catch {
      process.stderr.write(chalk.red(`  Session not found: ${targetId}\n\n`));
    }
  });

  commands.set("steer", async (args) => {
    const guidance = args.trim();
    if (!guidance) {
      process.stderr.write(chalk.dim("  Usage: /steer <your guidance>\n\n"));
      return;
    }
    if (!state.escalationPending || !state.lastResult) {
      process.stderr.write(chalk.dim("  No pending escalation to steer. Submit a new prompt instead.\n\n"));
      return;
    }
    state.debateInProgress = true;
    state.escalationPending = false;
    abortController = new AbortController();
    spinner.start("Resuming with guidance...", 1, state.config.guardrailRounds);
    try {
      const result = await orchestrator.continueWithGuidance(
        state.lastResult,
        guidance,
        state.sessionId,
        abortController.signal
      );
      spinner.stop();
      state.debateInProgress = false;
      state.lastResult = result;
      state.messages = result.messages;
      state.roundStartTurn = Math.max(...state.messages.map((m) => m.turn), 0) + 1;
      server?.broadcast({ type: "debate.result", sessionId: state.sessionId, result });
      server?.broadcast({ type: "sessions.list", sessions: session.listSessions() });

      if (result.type === "consensus") {
        process.stderr.write(chalk.green("✓") + ` Consensus reached (${result.rounds} rounds)\n\n`);
      } else {
        process.stderr.write(chalk.yellow("⚠") + ` Escalation (${result.rounds} rounds, no convergence)\n\n`);
        state.escalationPending = true;
      }
      console.log(result.summary);
    } catch (err) {
      spinner.stop();
      state.debateInProgress = false;
      if ((err as Error).message === "aborted") {
        state.messages = state.messages.filter((m) => m.turn < state.roundStartTurn);
        process.stderr.write(chalk.dim("\n  Debate interrupted.\n\n"));
      } else {
        process.stderr.write(chalk.red(`  Error: ${(err as Error).message}\n\n`));
      }
    }
  });

  commands.set("config", (args) => {
    const parts = args.trim().split(/\s+/);
    if (!args.trim()) {
      const cx = state.config.codex;
      process.stderr.write(chalk.dim([
        "",
        "  General:",
        `    startWith:       ${state.config.startWith}`,
        `    guardrailRounds: ${state.config.guardrailRounds}`,
        `    timeoutMs:       ${state.config.timeoutMs}`,
        `    outputFormat:    ${state.config.outputFormat}`,
        "",
        "  Codex:",
        `    codex.sandbox:    ${cx.sandboxMode}`,
        `    codex.webSearch:  ${cx.webSearchMode}`,
        `    codex.network:    ${cx.networkAccessEnabled}`,
        `    codex.model:      ${cx.model ?? "(default)"}`,
        `    codex.reasoning:  ${cx.modelReasoningEffort ?? "(default)"}`,
        `    codex.approval:   ${cx.approvalPolicy}`,
        "",
      ].join("\n")) + "\n");
      return;
    }
    const [key, value] = parts;

    // General config
    if (key === "startWith" && (value === "claude" || value === "codex")) {
      state.config.startWith = value;
      orchestrator = new Orchestrator(claude, codex, session, state.config, callbacks);
      process.stderr.write(chalk.dim(`  startWith set to ${value}\n\n`));
    } else if (key === "guardrailRounds" && !isNaN(parseInt(value, 10))) {
      state.config.guardrailRounds = parseInt(value, 10);
      process.stderr.write(chalk.dim(`  guardrailRounds set to ${value}\n\n`));
    } else if (key === "timeoutMs" && !isNaN(parseInt(value, 10))) {
      state.config.timeoutMs = parseInt(value, 10);
      process.stderr.write(chalk.dim(`  timeoutMs set to ${value}\n\n`));

    // Codex config
    } else if (key === "codex.sandbox" && ["read-only", "workspace-write", "danger-full-access"].includes(value)) {
      state.config.codex.sandboxMode = value as CodexConfig["sandboxMode"];
      codex.updateConfig({ sandboxMode: state.config.codex.sandboxMode });
      process.stderr.write(chalk.dim(`  codex.sandbox set to ${value}\n\n`));
    } else if (key === "codex.webSearch" && ["disabled", "cached", "live"].includes(value)) {
      state.config.codex.webSearchMode = value as CodexConfig["webSearchMode"];
      codex.updateConfig({ webSearchMode: state.config.codex.webSearchMode });
      process.stderr.write(chalk.dim(`  codex.webSearch set to ${value}\n\n`));
    } else if (key === "codex.network" && (value === "true" || value === "false")) {
      state.config.codex.networkAccessEnabled = value === "true";
      codex.updateConfig({ networkAccessEnabled: state.config.codex.networkAccessEnabled });
      process.stderr.write(chalk.dim(`  codex.network set to ${value}\n\n`));
    } else if (key === "codex.model") {
      state.config.codex.model = value || undefined;
      codex.updateConfig({ model: state.config.codex.model });
      process.stderr.write(chalk.dim(`  codex.model set to ${value || "(default)"}\n\n`));
    } else if (key === "codex.reasoning" && ["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
      state.config.codex.modelReasoningEffort = value as CodexConfig["modelReasoningEffort"];
      codex.updateConfig({ modelReasoningEffort: state.config.codex.modelReasoningEffort });
      process.stderr.write(chalk.dim(`  codex.reasoning set to ${value}\n\n`));
    } else if (key === "codex.approval" && ["never", "on-request", "on-failure", "untrusted"].includes(value)) {
      state.config.codex.approvalPolicy = value as CodexConfig["approvalPolicy"];
      codex.updateConfig({ approvalPolicy: state.config.codex.approvalPolicy });
      process.stderr.write(chalk.dim(`  codex.approval set to ${value}\n\n`));
    } else {
      process.stderr.write(chalk.dim(`  Unknown config key or invalid value: ${key} ${value ?? ""}\n\n`));
    }
  });

  commands.set("dashboard", () => {
    if (dashboardUrl) {
      process.stderr.write(`\n  ${chalk.cyan(dashboardUrl)}\n\n`);
    } else {
      process.stderr.write(chalk.dim("  Dashboard is not running.\n\n"));
    }
  });

  // --- Debate submission ---
  async function submitPrompt(prompt: string) {
    state.roundIndex++;
    state.escalationPending = false;

    const userMsg: Message = {
      role: "initiator",
      agent: "claude",
      turn: state.roundStartTurn,
      type: "user-prompt",
      content: `[USER PROMPT #${state.roundIndex}]: ${prompt}`,
      timestamp: new Date().toISOString(),
    };
    state.messages.push(userMsg);
    session.appendMessage(state.sessionId, userMsg);
    state.roundStartTurn = Math.max(...state.messages.map((m) => m.turn), 0) + 1;

    if (state.roundIndex === 1) {
      session.updatePrompt(state.sessionId, prompt);
      server?.broadcast({ type: "sessions.list", sessions: session.listSessions() });
    }

    state.debateInProgress = true;
    abortController = new AbortController();
    spinner.start(
      `${chalk.magenta("Claude")} (initiator) responding...`,
      1,
      state.config.guardrailRounds
    );
    if (!dashboardHintShown && dashboardUrl) {
      process.stderr.write(`\n  ${chalk.dim('Watch the debate live at')} ${chalk.cyan(dashboardUrl)}\n\n`);
      dashboardHintShown = true;
    }

    try {
      const result = await orchestrator.runWithHistory(
        prompt,
        state.messages,
        state.sessionId,
        abortController.signal
      );
      spinner.stop();
      state.debateInProgress = false;
      state.lastResult = result;
      state.messages = result.messages;
      state.roundStartTurn = Math.max(...state.messages.map((m) => m.turn), 0) + 1;
      server?.broadcast({ type: "debate.result", sessionId: state.sessionId, result });
      server?.broadcast({ type: "sessions.list", sessions: session.listSessions() });

      if (result.type === "consensus") {
        process.stderr.write(chalk.green("✓") + ` Consensus reached (${result.rounds} rounds)\n\n`);
        console.log(result.summary);
      } else {
        process.stderr.write(chalk.yellow("⚠") + ` Escalation (${result.rounds} rounds, no convergence)\n\n`);
        console.log(result.summary);
        state.escalationPending = true;
        process.stderr.write(chalk.dim("\nProvide guidance with /steer <text>, or submit a new prompt.\n\n"));
      }
    } catch (err) {
      spinner.stop();
      state.debateInProgress = false;
      if ((err as Error).message === "aborted") {
        state.messages = state.messages.filter((m) => m.turn < state.roundStartTurn);
        process.stderr.write(chalk.dim("\n  Debate interrupted.\n\n"));
      } else {
        process.stderr.write(chalk.red(`  Error: ${(err as Error).message}\n\n`));
      }
    }
  }

  // --- Ctrl+C handling ---
  rl.on("SIGINT", () => {
    if (state.debateInProgress && abortController) {
      abortController.abort();
    } else {
      session.updateStatus(state.sessionId, "paused");
      closeServer();
      process.stderr.write(`\n\nSession paused. Resume with: ${chalk.dim(`topg --resume ${state.sessionId}`)}\n`);
      process.exit(0);
    }
  });

  // --- Main loop ---
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    const cmd = parseCommand(trimmed);
    if (cmd) {
      const handler = commands.get(cmd.command);
      if (handler) {
        await handler(cmd.args);
      } else {
        process.stderr.write(chalk.dim(`  Unknown command: /${cmd.command}. Type /help for available commands.\n\n`));
      }
    } else {
      await submitPrompt(trimmed);
    }

    rl.prompt();
  }

  // EOF / readline close
  session.updateStatus(state.sessionId, "paused");
  closeServer();
  process.stderr.write(`\nSession paused. Resume with: ${chalk.dim(`topg --resume ${state.sessionId}`)}\n`);
}

// Note: No askGuidance helper — inline guidance uses /steer command
// to avoid readline question/iterator conflicts. After escalation,
// the user is prompted to use /steer <text> from the main prompt.
