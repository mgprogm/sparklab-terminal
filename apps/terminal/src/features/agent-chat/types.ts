/**
 * Transcript entry model for the agent chat panel.
 *
 * The stream from the agent service (AgentWsServerMessage) is folded into an
 * ordered list of these entries, which the panel renders top-to-bottom.
 */
import type { AgentApprovalBehavior } from "@sparklab/shared-types";

export type ToolEventState = "running" | "ok" | "error";

export interface UserEntry {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantEntry {
  kind: "assistant";
  id: string;
  text: string;
  streaming: boolean;
}

export interface ToolEventEntry {
  kind: "tool";
  id: string; // callId
  tool: string;
  sessionId?: string;
  summary: string;
  input: unknown;
  state: ToolEventState;
  resultSummary?: string;
}

export type ApprovalState = "pending" | AgentApprovalBehavior | "expired";

export interface ApprovalEntry {
  kind: "approval";
  id: string; // requestId
  tool: string;
  sessionId?: string;
  summary: string;
  input: unknown;
  state: ApprovalState;
}

export interface NoticeEntry {
  kind: "notice";
  id: string;
  text: string;
  tone: "error" | "info";
}

export type TranscriptEntry =
  UserEntry | AssistantEntry | ToolEventEntry | ApprovalEntry | NoticeEntry;
