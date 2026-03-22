import type { AgentName } from "./types.js";

export function initiatorPrompt(otherAgent: AgentName): string {
  return `You are collaborating with another AI agent (${otherAgent}). Your counterpart will review your response.

Instructions:
- Before responding, briefly state:
  1. Your understanding of the request
  2. Key constraints or assumptions
  3. Your chosen approach and why
- Then provide your implementation
- Be specific and cite trade-offs for any decisions you make
- Be open to revision — this is a collaborative process
- If you produce code, include complete implementations, not pseudocode
- IMPORTANT: For simple requests (greetings, factual questions, straightforward tasks), give a direct response and signal [CONVERGENCE: agree]. Do not over-complicate trivial prompts.`;
}

export function reviewerPrompt(otherAgent: AgentName): string {
  return `Another AI agent (${otherAgent}) produced the following response. You are the reviewer.

Instructions:
- Verify the response against these criteria:
  1. **Correctness**: Does it handle edge cases and produce correct results?
  2. **Completeness**: Does it fully address the user's request?
  3. **Quality**: Are there clear improvements that would meaningfully benefit the user?
- If all three pass, approve with [CONVERGENCE: agree]
- If any fail, explain specifically what fails and why
- If you suggest changes, be surgical: quote the specific part you'd change and provide the replacement. Do not rewrite the entire response if only part needs changing.
- Do not be contrarian for its own sake — if the work is solid, approve it
- IMPORTANT: For simple requests, if the response is reasonable, approve it immediately with [CONVERGENCE: agree]. Do not nitpick trivial responses.`;
}

export function rebuttalPrompt(reviewerAgent: AgentName): string {
  return `Your reviewer (${reviewerAgent}) has provided feedback on your previous response.

Instructions:
For each piece of feedback:
- If valid: incorporate it and explain the change
- If partially valid: explain what you accept and what you don't, with reasoning
- If invalid: defend your original approach with specific evidence

Do not accept changes that make the solution worse just to converge. Be specific about which suggestions you accept and which you reject.

If you suggest changes, be surgical: quote the specific part you'd change and provide the replacement. Do not rewrite the entire response if only part needs changing.`;
}

export function escalationPrompt(): string {
  return `You have been in a multi-round collaboration and have not yet reached full agreement. This is the final round before escalating to the user.

Instructions:
- Produce a structured summary with these sections:
  1. **What we agree on** — list points of consensus
  2. **Where we disagree** — list remaining disagreements with your position and reasoning
  3. **My recommendation** — your final recommendation to the user
- Be concise and specific
- End with [CONVERGENCE: disagree]`;
}

export function userGuidancePrompt(otherAgent: AgentName): string {
  return `The user has reviewed the escalation report and provided guidance. You are resuming collaboration with ${otherAgent}.

Instructions:
- Incorporate the user's guidance into your response
- The user's direction takes priority over your previous position
- Work with the other agent to converge on a solution that follows the user's guidance
- End your response with a convergence signal: [CONVERGENCE: agree|disagree|partial]`;
}

import type { Message } from "./types.js";

export function formatConversationHistory(messages: Message[]): string {
  if (messages.length === 0) return "";
  let history = "## Conversation So Far\n\n";
  for (const msg of messages) {
    history += `<turn number="${msg.turn}" agent="${msg.agent}" role="${msg.role}">\n`;
    history += `${msg.content}\n`;
    history += `</turn>\n\n`;
  }
  return history;
}

export function summarizeHistory(messages: Message[], keepRecent: number = 4): { summary: string; recent: Message[] } {
  if (messages.length <= keepRecent) {
    return { summary: "", recent: messages };
  }
  const older = messages.slice(0, messages.length - keepRecent);
  const recent = messages.slice(messages.length - keepRecent);

  const agreements: string[] = [];
  const positions = new Map<string, string>();

  const userGuidanceEntries: string[] = [];

  for (const msg of older) {
    // Separate user-prompt and guidance messages from agent positions
    if (msg.type === "user-prompt" || msg.content.startsWith("[USER GUIDANCE]:")) {
      const guidance = msg.content.replace(/^\[USER (?:GUIDANCE|PROMPT[^\]]*)\]:\s*/i, "").trim();
      userGuidanceEntries.push(`Turn ${msg.turn}: User said: ${guidance.split("\n")[0]}`);
      continue;
    }

    const label = msg.agent.charAt(0).toUpperCase() + msg.agent.slice(1);
    const firstLine = msg.content.replace(/\[CONVERGENCE:.*?\]/gi, "").trim().split("\n")[0];
    positions.set(msg.agent, firstLine);
    if (msg.convergenceSignal === "agree" || msg.convergenceSignal === "partial") {
      agreements.push(`Turn ${msg.turn}: ${label} signaled ${msg.convergenceSignal}`);
    }
  }

  let summary = "## Earlier Discussion (summarized)\n\n";
  summary += `${older.length} earlier turns between agents.\n\n`;
  if (agreements.length > 0) {
    summary += `Key signals: ${agreements.join("; ")}\n\n`;
  }
  for (const [agent, position] of positions) {
    const label = agent.charAt(0).toUpperCase() + agent.slice(1);
    summary += `Last position from ${label} (in summarized turns): ${position}\n`;
  }
  if (userGuidanceEntries.length > 0) {
    summary += `\nUser guidance: ${userGuidanceEntries.join("; ")}\n`;
  }
  summary += "\n";

  return { summary, recent };
}

const HISTORY_SUMMARIZE_THRESHOLD = 8;

export function formatTurnPrompt(systemPrompt: string, messages: Message[], userPrompt?: string): string {
  let prompt = systemPrompt + "\n\n";
  if (userPrompt) {
    prompt += `## User's Original Request\n\n${userPrompt}\n\n`;
  }

  if (messages.length > HISTORY_SUMMARIZE_THRESHOLD) {
    const { summary, recent } = summarizeHistory(messages);
    if (summary) {
      prompt += summary;
    }
    const recentHistory = formatConversationHistory(recent);
    if (recentHistory) {
      prompt += recentHistory.replace("## Conversation So Far\n\n", "## Recent Turns\n\n");
    }
  } else {
    const history = formatConversationHistory(messages);
    if (history) {
      prompt += history;
    }
  }

  prompt += "## Your Response\n\n";
  prompt += "(Write your response, then end with exactly one convergence signal on its own line)\n";
  prompt += "[CONVERGENCE: agree|disagree|partial]\n";
  return prompt;
}
