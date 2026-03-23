import type { AgentAdapter } from "./adapters/agent-adapter.js";
import type { Message, OrchestratorConfig, OrchestratorResult, AgentName } from "./types.js";
import { detectConvergence, checkDiffStability } from "./convergence.js";
import { initiatorPrompt, reviewerPrompt, rebuttalPrompt, escalationPrompt, userGuidancePrompt, formatTurnPrompt } from "./prompts.js";
import { formatConsensus, formatEscalation } from "./formatter.js";
import { SessionManager } from "./session.js";

export type TurnCallback = (turn: number, agent: AgentName, role: string) => void;
export type TurnCompleteCallback = (message: Message) => void;

export interface OrchestratorCallbacks {
  onTurnStart?: TurnCallback;
  onTurnComplete?: TurnCompleteCallback;
}

export class Orchestrator {
  private agentA: AgentAdapter;
  private agentB: AgentAdapter;
  private session: SessionManager;
  private config: OrchestratorConfig;
  private onTurnStart?: TurnCallback;
  private onTurnComplete?: TurnCompleteCallback;

  constructor(
    agentA: AgentAdapter,
    agentB: AgentAdapter,
    session: SessionManager,
    config: OrchestratorConfig,
    callbacks?: OrchestratorCallbacks
  ) {
    this.agentA = config.startWith === agentA.name ? agentA : agentB;
    this.agentB = config.startWith === agentA.name ? agentB : agentA;
    this.config = config;
    this.session = session;
    this.onTurnStart = callbacks?.onTurnStart;
    this.onTurnComplete = callbacks?.onTurnComplete;
  }

  async run(userPrompt: string): Promise<OrchestratorResult> {
    const meta = this.session.create(userPrompt, this.config);
    const messages: Message[] = [];
    let turn = 0;

    // Turn 1: Initiator
    turn++;
    this.onTurnStart?.(turn, this.agentA.name, "initiator");
    const initResponse = await this.agentA.send(
      formatTurnPrompt(initiatorPrompt(this.agentB.name), [], userPrompt),
      {
        sessionId: meta.sessionId,
        history: messages,
        workingDirectory: this.config.workingDirectory,
        systemPrompt: initiatorPrompt(this.agentB.name),
      }
    );

    const initMsg = this.toMessage("initiator", this.agentA.name, turn, "code", initResponse);
    messages.push(initMsg);
    this.session.appendMessage(meta.sessionId, initMsg);
    this.onTurnComplete?.(initMsg);

    // Turn 2+: Review loop
    let currentReviewer = this.agentB;
    let currentInitiator = this.agentA;

    while (turn < this.config.guardrailRounds) {
      turn++;

      // Reviewer turn
      const isFirstReview = turn === 2;
      const sysPrompt = isFirstReview
        ? reviewerPrompt(currentInitiator.name)
        : rebuttalPrompt(currentInitiator.name);

      this.onTurnStart?.(turn, currentReviewer.name, isFirstReview ? "reviewer" : "rebuttal");
      const reviewResponse = await currentReviewer.send(
        formatTurnPrompt(sysPrompt, messages, userPrompt),
        {
          sessionId: meta.sessionId,
          history: messages,
          workingDirectory: this.config.workingDirectory,
          systemPrompt: sysPrompt,
        }
      );

      const reviewMsg = this.toMessage(
        "reviewer",
        currentReviewer.name,
        turn,
        "review",
        reviewResponse
      );
      messages.push(reviewMsg);
      this.session.appendMessage(meta.sessionId, reviewMsg);
      this.onTurnComplete?.(reviewMsg);

      // Check convergence
      if (detectConvergence(messages) || checkDiffStability(messages)) {
        const summary = formatConsensus(messages, turn);
        this.session.saveSummary(meta.sessionId, summary);
        this.session.updateStatus(meta.sessionId, "completed");
        return { type: "consensus", sessionId: meta.sessionId, rounds: turn, summary, messages };
      }

      // Swap roles for next cycle
      [currentReviewer, currentInitiator] = [currentInitiator, currentReviewer];
    }

    // Escalation: ask both for final summaries
    turn++;
    const escPrompt = escalationPrompt();

    this.onTurnStart?.(turn, this.agentA.name, "escalation");
    const escResponseA = await this.agentA.send(
      formatTurnPrompt(escPrompt, messages, userPrompt),
      {
        sessionId: meta.sessionId,
        history: messages,
        workingDirectory: this.config.workingDirectory,
        systemPrompt: escPrompt,
      }
    );
    const escMsgA = this.toMessage("initiator", this.agentA.name, turn, "deadlock", escResponseA);
    messages.push(escMsgA);
    this.session.appendMessage(meta.sessionId, escMsgA);
    this.onTurnComplete?.(escMsgA);

    this.onTurnStart?.(turn, this.agentB.name, "escalation");
    const escResponseB = await this.agentB.send(
      formatTurnPrompt(escPrompt, messages, userPrompt),
      {
        sessionId: meta.sessionId,
        history: messages,
        workingDirectory: this.config.workingDirectory,
        systemPrompt: escPrompt,
      }
    );
    const escMsgB = this.toMessage("reviewer", this.agentB.name, turn, "deadlock", escResponseB);
    messages.push(escMsgB);
    this.session.appendMessage(meta.sessionId, escMsgB);
    this.onTurnComplete?.(escMsgB);

    const summary = formatEscalation(messages.slice(-2), this.config.guardrailRounds);
    this.session.saveSummary(meta.sessionId, summary);
    this.session.updateStatus(meta.sessionId, "escalated");
    return { type: "escalation", sessionId: meta.sessionId, rounds: this.config.guardrailRounds, summary, messages };
  }

  async runWithHistory(
    userPrompt: string,
    existingMessages: Message[],
    sessionId: string,
    signal?: AbortSignal
  ): Promise<OrchestratorResult> {
    const messages: Message[] = [...existingMessages];
    let turn = Math.max(...existingMessages.map((m) => m.turn), 0);

    // Turn 1: Initiator
    turn++;
    this.onTurnStart?.(turn, this.agentA.name, "initiator");
    const initResponse = await this.agentA.send(
      formatTurnPrompt(initiatorPrompt(this.agentB.name), messages, userPrompt),
      {
        sessionId,
        history: messages,
        workingDirectory: this.config.workingDirectory,
        systemPrompt: initiatorPrompt(this.agentB.name),
      },
      signal
    );

    const initMsg = this.toMessage("initiator", this.agentA.name, turn, "code", initResponse);
    messages.push(initMsg);
    this.session.appendMessage(sessionId, initMsg);
    this.onTurnComplete?.(initMsg);

    // Review loop
    let currentReviewer = this.agentB;
    let currentInitiator = this.agentA;
    const maxTurn = turn + this.config.guardrailRounds - 1;

    while (turn < maxTurn) {
      turn++;

      const isFirstReview = messages.filter(m => m.type !== "user-prompt").length === 2 + existingMessages.filter(m => m.type !== "user-prompt").length;
      const sysPrompt = isFirstReview
        ? reviewerPrompt(currentInitiator.name)
        : rebuttalPrompt(currentInitiator.name);

      this.onTurnStart?.(turn, currentReviewer.name, isFirstReview ? "reviewer" : "rebuttal");
      const reviewResponse = await currentReviewer.send(
        formatTurnPrompt(sysPrompt, messages, userPrompt),
        {
          sessionId,
          history: messages,
          workingDirectory: this.config.workingDirectory,
          systemPrompt: sysPrompt,
        },
        signal
      );

      const reviewMsg = this.toMessage("reviewer", currentReviewer.name, turn, "review", reviewResponse);
      messages.push(reviewMsg);
      this.session.appendMessage(sessionId, reviewMsg);
      this.onTurnComplete?.(reviewMsg);

      if (detectConvergence(messages) || checkDiffStability(messages)) {
        const summary = formatConsensus(messages, turn);
        this.session.saveSummary(sessionId, summary);
        this.session.updateStatus(sessionId, "completed");
        return { type: "consensus", sessionId, rounds: turn, summary, messages };
      }

      [currentReviewer, currentInitiator] = [currentInitiator, currentReviewer];
    }

    // Escalation
    turn++;
    const escPrompt = escalationPrompt();

    this.onTurnStart?.(turn, this.agentA.name, "escalation");
    const escA = await this.agentA.send(
      formatTurnPrompt(escPrompt, messages, userPrompt),
      { sessionId, history: messages, workingDirectory: this.config.workingDirectory, systemPrompt: escPrompt },
      signal
    );
    const escMsgA = this.toMessage("initiator", this.agentA.name, turn, "deadlock", escA);
    messages.push(escMsgA);
    this.session.appendMessage(sessionId, escMsgA);
    this.onTurnComplete?.(escMsgA);

    this.onTurnStart?.(turn, this.agentB.name, "escalation");
    const escB = await this.agentB.send(
      formatTurnPrompt(escPrompt, messages, userPrompt),
      { sessionId, history: messages, workingDirectory: this.config.workingDirectory, systemPrompt: escPrompt },
      signal
    );
    const escMsgB = this.toMessage("reviewer", this.agentB.name, turn, "deadlock", escB);
    messages.push(escMsgB);
    this.session.appendMessage(sessionId, escMsgB);
    this.onTurnComplete?.(escMsgB);

    const summary = formatEscalation(messages.slice(-2), turn);
    this.session.saveSummary(sessionId, summary);
    this.session.updateStatus(sessionId, "escalated");
    return { type: "escalation", sessionId, rounds: turn, summary, messages };
  }

  async resume(sessionId: string, userGuidance?: string): Promise<OrchestratorResult> {
    const { meta, messages } = this.session.load(sessionId);
    const lastTurn = messages.length > 0 ? messages[messages.length - 1].turn : 0;

    // If user provided guidance, continue with it
    if (userGuidance) {
      const fakeResult: OrchestratorResult = {
        type: "escalation",
        sessionId,
        rounds: lastTurn,
        summary: "",
        messages,
      };
      return this.continueWithGuidance(fakeResult, userGuidance, sessionId);
    }

    // Otherwise, pick up where we left off — re-enter the review loop
    const userPrompt = meta.prompt;
    let turn = lastTurn;

    // Determine whose turn it is next based on message count
    let currentReviewer: AgentAdapter;
    let currentInitiator: AgentAdapter;
    if (messages.length % 2 === 1) {
      // Odd number of messages — agent B (reviewer) goes next
      currentReviewer = this.agentB;
      currentInitiator = this.agentA;
    } else {
      currentReviewer = this.agentA;
      currentInitiator = this.agentB;
    }

    this.session.updateStatus(sessionId, "active");

    while (turn < lastTurn + this.config.guardrailRounds) {
      turn++;

      this.onTurnStart?.(turn, currentReviewer.name, "rebuttal");
      const reviewResponse = await currentReviewer.send(
        formatTurnPrompt(rebuttalPrompt(currentInitiator.name), messages, userPrompt),
        {
          sessionId,
          history: messages,
          workingDirectory: this.config.workingDirectory,
          systemPrompt: rebuttalPrompt(currentInitiator.name),
        }
      );

      const reviewMsg = this.toMessage("reviewer", currentReviewer.name, turn, "review", reviewResponse);
      messages.push(reviewMsg);
      this.session.appendMessage(sessionId, reviewMsg);
      this.onTurnComplete?.(reviewMsg);

      if (detectConvergence(messages) || checkDiffStability(messages)) {
        const summary = formatConsensus(messages, turn);
        this.session.saveSummary(sessionId, summary);
        this.session.updateStatus(sessionId, "completed");
        return { type: "consensus", sessionId, rounds: turn, summary, messages };
      }

      [currentReviewer, currentInitiator] = [currentInitiator, currentReviewer];
    }

    // Escalation
    turn++;
    const escPrompt = escalationPrompt();

    this.onTurnStart?.(turn, this.agentA.name, "escalation");
    const escA = await this.agentA.send(
      formatTurnPrompt(escPrompt, messages, userPrompt),
      { sessionId, history: messages, workingDirectory: this.config.workingDirectory, systemPrompt: escPrompt }
    );
    const escMsgA = this.toMessage("initiator", this.agentA.name, turn, "deadlock", escA);
    messages.push(escMsgA);
    this.session.appendMessage(sessionId, escMsgA);
    this.onTurnComplete?.(escMsgA);

    this.onTurnStart?.(turn, this.agentB.name, "escalation");
    const escB = await this.agentB.send(
      formatTurnPrompt(escPrompt, messages, userPrompt),
      { sessionId, history: messages, workingDirectory: this.config.workingDirectory, systemPrompt: escPrompt }
    );
    const escMsgB = this.toMessage("reviewer", this.agentB.name, turn, "deadlock", escB);
    messages.push(escMsgB);
    this.session.appendMessage(sessionId, escMsgB);
    this.onTurnComplete?.(escMsgB);

    const summary = formatEscalation(messages.slice(-2), turn);
    this.session.saveSummary(sessionId, summary);
    this.session.updateStatus(sessionId, "escalated");
    return { type: "escalation", sessionId, rounds: turn, summary, messages };
  }

  async continueWithGuidance(
    previousResult: OrchestratorResult,
    userGuidance: string,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<OrchestratorResult> {
    const messages = [...previousResult.messages];
    const userPrompt = userGuidance;
    let turn = previousResult.rounds + 2; // after escalation turns

    // Inject user guidance as a special message
    const guidanceMsg: Message = {
      role: "initiator",
      agent: "claude", // attributed to user, but stored for history
      turn,
      type: "debate",
      content: `[USER GUIDANCE]: ${userGuidance}`,
      timestamp: new Date().toISOString(),
    };
    messages.push(guidanceMsg);
    this.session.appendMessage(sessionId, guidanceMsg);
    this.onTurnComplete?.(guidanceMsg);
    this.session.updateStatus(sessionId, "active");

    // Agent A responds to user guidance
    turn++;
    this.onTurnStart?.(turn, this.agentA.name, "guided");
    const responseA = await this.agentA.send(
      formatTurnPrompt(userGuidancePrompt(this.agentB.name), messages, userGuidance),
      {
        sessionId,
        history: messages,
        workingDirectory: this.config.workingDirectory,
        systemPrompt: userGuidancePrompt(this.agentB.name),
      },
      signal
    );
    const msgA = this.toMessage("initiator", this.agentA.name, turn, "review", responseA);
    messages.push(msgA);
    this.session.appendMessage(sessionId, msgA);
    this.onTurnComplete?.(msgA);

    // Review loop (same as main run)
    let currentReviewer = this.agentB;
    let currentInitiator = this.agentA;

    for (let round = 0; round < this.config.guardrailRounds; round++) {
      turn++;

      this.onTurnStart?.(turn, currentReviewer.name, "rebuttal");
      const reviewResponse = await currentReviewer.send(
        formatTurnPrompt(rebuttalPrompt(currentInitiator.name), messages, userGuidance),
        {
          sessionId,
          history: messages,
          workingDirectory: this.config.workingDirectory,
          systemPrompt: rebuttalPrompt(currentInitiator.name),
        },
        signal
      );

      const reviewMsg = this.toMessage("reviewer", currentReviewer.name, turn, "review", reviewResponse);
      messages.push(reviewMsg);
      this.session.appendMessage(sessionId, reviewMsg);
      this.onTurnComplete?.(reviewMsg);

      if (detectConvergence(messages) || checkDiffStability(messages)) {
        const summary = formatConsensus(messages, turn);
        this.session.saveSummary(sessionId, summary);
        this.session.updateStatus(sessionId, "completed");
        return { type: "consensus", sessionId, rounds: turn, summary, messages };
      }

      [currentReviewer, currentInitiator] = [currentInitiator, currentReviewer];
    }

    // Escalate again
    turn++;
    const escPrompt = escalationPrompt();

    this.onTurnStart?.(turn, this.agentA.name, "escalation");
    const escA = await this.agentA.send(
      formatTurnPrompt(escPrompt, messages, userGuidance),
      { sessionId, history: messages, workingDirectory: this.config.workingDirectory, systemPrompt: escPrompt },
      signal
    );
    const escMsgA = this.toMessage("initiator", this.agentA.name, turn, "deadlock", escA);
    messages.push(escMsgA);
    this.session.appendMessage(sessionId, escMsgA);
    this.onTurnComplete?.(escMsgA);

    this.onTurnStart?.(turn, this.agentB.name, "escalation");
    const escB = await this.agentB.send(
      formatTurnPrompt(escPrompt, messages, userGuidance),
      { sessionId, history: messages, workingDirectory: this.config.workingDirectory, systemPrompt: escPrompt },
      signal
    );
    const escMsgB = this.toMessage("reviewer", this.agentB.name, turn, "deadlock", escB);
    messages.push(escMsgB);
    this.session.appendMessage(sessionId, escMsgB);
    this.onTurnComplete?.(escMsgB);

    const summary = formatEscalation(messages.slice(-2), turn);
    this.session.saveSummary(sessionId, summary);
    this.session.updateStatus(sessionId, "escalated");
    return { type: "escalation", sessionId, rounds: turn, summary, messages };
  }

  private toMessage(
    role: "initiator" | "reviewer",
    agent: AgentName,
    turn: number,
    type: Message["type"],
    response: { content: string; artifacts?: any[]; convergenceSignal?: any }
  ): Message {
    return {
      role,
      agent,
      turn,
      type,
      content: response.content,
      artifacts: response.artifacts,
      convergenceSignal: response.convergenceSignal,
      timestamp: new Date().toISOString(),
    };
  }
}
