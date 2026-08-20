import { createHash } from "node:crypto";
import type { Part } from "@opencode-ai/sdk";

import type { SessionMessage } from "../services/capture.js";

export interface V2ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface V2Message {
  role: string;
  content?: V2ContentPart[];
  [key: string]: unknown;
}

export interface V2ContextEvent {
  sessionID: string;
  agent?: unknown;
  model?: unknown;
  system: unknown;
  messages: V2Message[];
  tools: Record<string, unknown>;
}

function messageFingerprint(role: string, text: string): string {
  return createHash("sha256").update(`${role}:${text}`).digest("hex").slice(0, 16);
}

function hasTextPart(message: V2Message): boolean {
  return (message.content ?? []).some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0,
  );
}

/**
 * Converts the V2 context-hook messages (AI SDK shape, no ids, no finish
 * markers) into the SessionMessage shape the shared capture helpers expect.
 *
 * V2 messages carry no stable id, so we fingerprint each message by content.
 * The ids must stay stable across snapshots of the same conversation so
 * capture dedupe works. The last assistant message that produced text is
 * marked as the final message of the turn.
 */
export function adaptMessages(messages: V2Message[]): SessionMessage[] {
  let lastAssistantTextIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "assistant" && hasTextPart(message)) {
      lastAssistantTextIndex = index;
    }
  });

  return messages.map((message, index) => {
    const textParts = (message.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => ({
        type: "text",
        text: part.text as string,
      }));

    const text = textParts.map((p) => p.text).join("\n");

    return {
      info: {
        id: messageFingerprint(message.role, text),
        role: message.role,
        sessionID: undefined,
        finish: index === lastAssistantTextIndex ? "end" : "",
        summary: undefined,
      },
      parts: textParts as unknown as Part[],
    };
  });
}

export function lastUserMessage(messages: V2Message[]): V2Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user") return message;
  }
  return undefined;
}

export function userMessageText(message: V2Message): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

export function userMessageFingerprint(message: V2Message): string {
  return messageFingerprint("user", userMessageText(message));
}
