import type { AgentName, Message } from "../core/types.js";

export function collaboratorSystemPrompt(callerAgent: AgentName): string {
  return `You are collaborating with ${callerAgent}. You are being consulted as a peer — not a subordinate.

Instructions:
- Provide your honest assessment. If you disagree with the caller's approach, say so clearly.
- Be specific: reference file paths, line numbers, code snippets when relevant.
- If asked to review code, evaluate correctness, completeness, and quality.
- If asked for design input, consider trade-offs and alternatives.
- If asked to validate, check assumptions and edge cases.
- Do not be deferential — you were consulted because a second perspective has value.
- Keep responses focused and actionable.`;
}

export function formatCollaboratePrompt(
  systemPrompt: string,
  messages: Message[],
  newMessage: string
): string {
  let prompt = systemPrompt + "\n\n";

  if (messages.length > 0) {
    prompt += "## Conversation So Far\n\n";
    for (const msg of messages) {
      const label = msg.role === "caller" ? "Caller" : "You";
      prompt += `### ${label} (turn ${msg.turn})\n\n${msg.content}\n\n`;
    }
  }

  prompt += `## New Message from Caller\n\n${newMessage}\n\n`;
  prompt += "## Your Response\n\n";
  return prompt;
}
