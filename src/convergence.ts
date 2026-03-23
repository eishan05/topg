import type { Message, ConvergenceSignal } from "./types.js";

const CONVERGENCE_TAG_RE = /\[CONVERGENCE:\s*(agree|disagree|partial|defer)\]/i;

const AGREEMENT_PHRASES = [
  "i agree",
  "looks good",
  "no further changes",
  "no modifications needed",
  "this is correct",
  "no objections",
  "lgtm",
  "ship it",
  "well done",
  "this looks right",
  "i'm satisfied",
  "no issues found",
  "approved",
  "nothing to add",
  "no concerns",
  "this is fine",
  "perfectly fine",
  "solid response",
  "approve the response",
  "approve this",
  "good as-is",
  "good as is",
  "no changes needed",
  "response is complete",
  "nothing to change",
  "well stated",
];

const DISAGREEMENT_PHRASES = [
  "i disagree",
  "should instead",
  "better approach",
  "fundamentally different",
  "major concern",
  "significant issue",
  "needs rework",
  "counter-proposal",
];

export function parseConvergenceTag(content: string): ConvergenceSignal | null {
  const match = content.match(CONVERGENCE_TAG_RE);
  return match ? (match[1].toLowerCase() as ConvergenceSignal) : null;
}

function getSignalForMessage(msg: Message): ConvergenceSignal | null {
  if (msg.convergenceSignal) return msg.convergenceSignal;
  const tagSignal = parseConvergenceTag(msg.content);
  if (tagSignal) return tagSignal;
  const lower = msg.content.toLowerCase();
  const hasAgreement = AGREEMENT_PHRASES.some((phrase) => lower.includes(phrase));
  if (hasAgreement) return "agree";
  const hasDisagreement = DISAGREEMENT_PHRASES.some((phrase) => lower.includes(phrase));
  if (hasDisagreement) return "disagree";
  return null;
}

export function detectConvergence(messages: Message[]): boolean {
  const agentMessages = messages.filter((m) => m.type !== "user-prompt" && m.type !== "user-guidance");
  if (agentMessages.length < 2) return false;
  const lastByAgent = new Map<string, Message>();
  for (const msg of agentMessages) {
    lastByAgent.set(msg.agent, msg);
  }
  if (lastByAgent.size < 2) return false;
  const signals = [...lastByAgent.values()].map(getSignalForMessage);

  // Strong consensus: both agree
  if (signals.every((s) => s === "agree")) return true;

  // Soft consensus: one agrees and the other is partial (not disagree)
  // This prevents endless rounds when agents mostly agree but one hedges
  if (
    signals.includes("agree") &&
    signals.every((s) => s === "agree" || s === "partial")
  ) {
    return true;
  }

  return false;
}

export function checkDiffStability(messages: Message[]): boolean {
  const agentMessages = messages.filter((m) => m.type !== "user-prompt" && m.type !== "user-guidance");
  if (agentMessages.length < 4) return false;
  const recent = agentMessages.slice(-4);
  const contents = recent.map((m) =>
    m.content
      .replace(CONVERGENCE_TAG_RE, "")
      .replace(/^(i agree|confirmed|yes|looks good)[.,!]?\s*/i, "")
      .trim()
      .toLowerCase()
  );
  const similarity = (a: string, b: string): number => {
    if (a === b) return 1;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    const words = shorter.split(/\s+/);
    const matchedWords = words.filter((w) => longer.includes(w));
    return matchedWords.length / words.length;
  };
  return similarity(contents[0], contents[2]) > 0.8 && similarity(contents[1], contents[3]) > 0.8;
}
