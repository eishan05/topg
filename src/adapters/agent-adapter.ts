import type { AgentName, AgentResponse, ConversationContext, StreamChunkCallback } from "../types.js";

export interface AgentAdapter {
  name: AgentName;
  send(prompt: string, context: ConversationContext, signal?: AbortSignal, onChunk?: StreamChunkCallback): Promise<AgentResponse>;
}
