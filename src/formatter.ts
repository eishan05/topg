import type { Message, Artifact, ToolActivity } from "./types.js";
import { capitalize } from "./utils.js";

export function formatConsensus(messages: Message[], rounds: number): string {
  const lastMessages = getLastMessagePerAgent(messages);
  const allArtifacts = collectArtifacts(messages);

  let output = `[CONSENSUS after ${rounds} rounds]\n\n`;
  output += `## Agreed Approach\n\n`;

  const agentMessages = messages.filter((m) => m.type !== "user-prompt" && m.type !== "user-guidance");
  // Prefer the initiator's last substantive message over a reviewer's meta-review.
  // The initiator typically has the actual deliverable content while the reviewer
  // often just comments on it (e.g. "Your plan is solid...").
  const finalMsg = findBestConsensusMessage(agentMessages) ?? agentMessages[agentMessages.length - 1];
  output += finalMsg.content.replace(/\[CONVERGENCE:.*?\]/gi, "").trim();
  output += "\n\n";

  if (lastMessages.length > 1) {
    output += `## Key Decisions\n\n`;
    for (const msg of lastMessages) {
      output += `- **${capitalize(msg.agent)}**: ${firstSentence(msg.content)}\n`;
    }
    output += "\n";
  }

  if (allArtifacts.length > 0) {
    output += `## Artifacts\n\n`;
    for (const artifact of allArtifacts) {
      output += `- \`${artifact.path}\` (${artifact.type})\n`;
    }
    output += "\n";
  }

  const activities = collectToolActivities(messages);
  if (activities.length > 0) {
    output += formatToolActivities(activities);
  }

  return output;
}

export function formatEscalation(messages: Message[], rounds: number): string {
  const lastMessages = getLastMessagePerAgent(messages);

  let output = `[ESCALATION after ${rounds} rounds — no convergence]\n\n`;

  for (const msg of lastMessages) {
    output += `### ${capitalize(msg.agent)}'s Summary\n\n`;
    output += msg.content.replace(/\[CONVERGENCE:.*?\]/gi, "").trim();
    output += "\n\n";
  }

  const activities = collectToolActivities(messages);
  if (activities.length > 0) {
    output += formatToolActivities(activities);
  }

  return output;
}

/**
 * Find the best message to use as the consensus output.
 * Prefers the last initiator message over the last reviewer message,
 * since reviewers tend to produce meta-commentary ("Your plan is solid...")
 * rather than the actual deliverable.
 */
function findBestConsensusMessage(agentMessages: Message[]): Message | null {
  if (agentMessages.length === 0) return null;

  // If the last message is from the initiator, use it directly
  const last = agentMessages[agentMessages.length - 1];
  if (last.role === "initiator") return last;

  // Otherwise, find the last initiator message
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    if (agentMessages[i].role === "initiator") {
      return agentMessages[i];
    }
  }

  // Fallback to the last message if no initiator found
  return last;
}

function getLastMessagePerAgent(messages: Message[]): Message[] {
  const byAgent = new Map<string, Message>();
  for (const msg of messages) {
    if (msg.type === "user-prompt") continue;
    byAgent.set(msg.agent, msg);
  }
  return [...byAgent.values()];
}

function collectArtifacts(messages: Message[]): Artifact[] {
  const seen = new Set<string>();
  const artifacts: Artifact[] = [];
  for (const msg of messages) {
    for (const a of msg.artifacts ?? []) {
      if (!seen.has(a.path)) {
        seen.add(a.path);
        artifacts.push(a);
      }
    }
  }
  return artifacts;
}

function firstSentence(s: string): string {
  const clean = s.replace(/\[CONVERGENCE:.*?\]/gi, "").trim();
  const match = clean.match(/^(.+?[.!?])\s/);
  return match ? match[1] : clean.slice(0, 120);
}

function collectToolActivities(messages: Message[]): ToolActivity[] {
  const activities: ToolActivity[] = [];
  for (const msg of messages) {
    if (msg.toolActivities) {
      activities.push(...msg.toolActivities);
    }
  }
  return activities;
}

function formatToolActivities(activities: ToolActivity[]): string {
  let output = "## Tool Activity\n\n";

  const commands = activities.filter((a) => a.type === "command_execution");
  const fileChanges = activities.filter((a) => a.type === "file_change");
  const searches = activities.filter((a) => a.type === "web_search");
  const mcpCalls = activities.filter((a) => a.type === "mcp_tool_call");

  if (commands.length > 0) {
    output += "**Commands executed:**\n";
    for (const cmd of commands) {
      if (cmd.type === "command_execution") {
        const status = cmd.exitCode === 0 ? "ok" : `exit ${cmd.exitCode ?? "?"}`;
        output += `- \`${cmd.command}\` (${status})\n`;
      }
    }
    output += "\n";
  }

  if (fileChanges.length > 0) {
    output += "**Files changed:**\n";
    for (const fc of fileChanges) {
      if (fc.type === "file_change") {
        for (const c of fc.changes) {
          output += `- \`${c.path}\` (${c.kind})\n`;
        }
      }
    }
    output += "\n";
  }

  if (searches.length > 0) {
    output += "**Web searches:**\n";
    for (const s of searches) {
      if (s.type === "web_search") {
        output += `- ${s.query}\n`;
      }
    }
    output += "\n";
  }

  if (mcpCalls.length > 0) {
    output += "**MCP tool calls:**\n";
    for (const m of mcpCalls) {
      if (m.type === "mcp_tool_call") {
        const status = m.error ? `error: ${m.error}` : "ok";
        output += `- ${m.server}/${m.tool} (${status})\n`;
      }
    }
    output += "\n";
  }

  return output;
}
