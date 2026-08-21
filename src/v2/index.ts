import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Plugin } from "@opencode-ai/plugin-v2";

import { CONFIG, isConfigured, PLUGIN_VERSION } from "../config.js";
import { AGENT_ENTITY_CONTEXT } from "../services/entity-context.js";
import {
  buildCadenceBatches,
  buildCaptureTurns,
  buildSessionEndBatch,
  getCaptureId,
  type CaptureBatch,
  type CaptureTurn,
  type SessionMessage,
} from "../services/capture.js";
import { supermemoryClient } from "../services/local-store.js";
import { formatContextForPrompt } from "../services/context.js";
import { detectMemoryKeyword, matchesRecallHeuristic, MEMORY_NUDGE_MESSAGE } from "../services/injection.js";
import { log } from "../services/logger.js";
import { buildRecallDirective } from "../services/recall.js";
import { getTags, type ResolvedTags } from "../services/tags.js";
import { runSupermemoryTool } from "../services/tool.js";
import { checkNpmUpdate, formatUpdateNotice } from "../services/version-check.js";
import {
  adaptMessages,
  lastUserMessage,
  userMessageFingerprint,
  userMessageText,
  type V2ContextEvent,
  type V2ContentPart,
} from "./messages.js";

const DEBUG_LOG = "/tmp/sm-v2-debug.log";
const CAPTURE_STATE_FILE = `${process.env.HOME}/.supermemory-opencode/v2-capture-state.json`;
const UPDATE_COMMAND = "bunx opencode-supermemory@latest install";
const QUIET_MS = 15_000;

function debug(msg: string) {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // debug only
  }
}

// The beta server loads plugin entries twice, so two instances of this
// plugin run side by side. Capture ids are deterministic, so we persist
// completed captures to disk to keep the two instances from ingesting the
// same batch twice.
function captureCompleted(captureId: string): boolean {
  try {
    if (existsSync(CAPTURE_STATE_FILE)) {
      const state = JSON.parse(readFileSync(CAPTURE_STATE_FILE, "utf8"));
      return Array.isArray(state.ids) && state.ids.includes(captureId);
    }
  } catch {
    // fall through to "not completed"
  }
  return false;
}

function markCaptureCompleted(captureId: string) {
  try {
    let state: { ids: string[] } = { ids: [] };
    try {
      state = JSON.parse(readFileSync(CAPTURE_STATE_FILE, "utf8"));
    } catch {
      // first write
    }
    if (!Array.isArray(state.ids)) state.ids = [];
    if (!state.ids.includes(captureId)) state.ids.push(captureId);
    writeFileSync(CAPTURE_STATE_FILE, JSON.stringify(state));
  } catch {
    // best effort; a lost marker only risks a duplicate capture
  }
}

export default Plugin.define({
  id: "opencode.supermemory",
  setup: async (ctx) => {
    const anyCtx = ctx as unknown as Record<string, unknown>;
    debug(`setup: ctx keys: ${Object.keys(anyCtx).join(", ")}`);
    log("v2 plugin init", { configured: isConfigured() });

    // V2 plugin ctx has no per-project directory. The event stream carries
    // location.directory per event, so we remember each session's directory.
    const sessionDirs = new Map<string, string>();
    const injectedMessages = new Set<string>();
    const injectedSessions = new Set<string>();
    const messageCache = new Map<string, SessionMessage[]>();
    const activeSessions = new Set<string>();
    const lastActivity = new Map<string, number>();
    const inFlight = new Map<string, Promise<void>>();

    const hasTextMarker = (content: V2ContentPart[], marker: string): boolean =>
      content.some(
        (part) => typeof part.text === "string" && part.text.includes(marker),
      );

    const buildMemoryContext = async (
      sessionID: string,
      userMessage: string,
    ): Promise<string> => {
      const tags = getTags(sessionDirs.get(sessionID) ?? process.cwd());

      const [profileResult, userMemoriesResult, projectMemoriesListResult] =
        await Promise.all([
          supermemoryClient.getProfileScoped(
            tags.canonical,
            tags.personalReads,
            "personal",
            userMessage,
          ),
          supermemoryClient.searchMemoriesScoped(
            userMessage,
            tags.canonical,
            tags.personalReads,
            "personal",
          ),
          supermemoryClient.listMemoriesScoped(
            tags.canonical,
            tags.projectReads,
            "project",
            CONFIG.maxProjectMemories,
          ),
        ]);

      const profile = profileResult.success ? profileResult : null;
      const userMemories = userMemoriesResult.success
        ? userMemoriesResult
        : { results: [] };
      const projectMemoriesList = projectMemoriesListResult.success
        ? projectMemoriesListResult
        : { memories: [] };

      const projectMemories = {
        results: (projectMemoriesList.memories || []).map((m: any) => ({
          id: m.id,
          memory: m.summary || m.content || m.title || "",
          similarity: 1,
          title: m.title,
          metadata: m.metadata,
        })),
        total: projectMemoriesList.memories?.length || 0,
        timing: 0,
      };

      return formatContextForPrompt(profile, userMemories, projectMemories);
    };

    const buildFirstMessageContext = async (
      sessionID: string,
      userMessage: string,
    ): Promise<string> => {
      const updateCheck = checkNpmUpdate(
        "opencode-supermemory",
        PLUGIN_VERSION,
        UPDATE_COMMAND,
      ).then((info) => (info ? formatUpdateNotice(info) : null));

      let memoryContext = "";
      if (CONFIG.autoRecallEveryPrompt) {
        memoryContext = await buildMemoryContext(sessionID, userMessage);
      } else {
        const tags = getTags(sessionDirs.get(sessionID) ?? process.cwd());
        const profileResult = await supermemoryClient.getProfileScoped(
          tags.canonical,
          tags.personalReads,
          "personal",
        );
        const profile = profileResult.success ? profileResult : null;
        memoryContext = formatContextForPrompt(profile, { results: [] }, { results: [] });
      }

      const updateNotice = await updateCheck;
      return [memoryContext, updateNotice].filter(Boolean).join("\n\n");
    };

    // Replaces any system part carrying the marker with the fresh block, so
    // repeated injections across dispatches never accumulate duplicates.
    const refreshSystemBlock = (
      system: V2ContentPart[],
      marker: string,
      text: string,
    ) => {
      for (let index = system.length - 1; index >= 0; index -= 1) {
        const part = system[index];
        if (typeof part?.text === "string" && part.text.includes(marker)) {
          system.splice(index, 1);
        }
      }
      system.push({ type: "text", text });
    };

    const saveBatch = async (
      sessionID: string,
      tags: ResolvedTags,
      batch: CaptureBatch,
      reason: "cadence" | "session_end",
    ): Promise<void> => {
      const captureId = getCaptureId(sessionID, batch);
      if (captureCompleted(captureId)) return;

      const messages = batch.turns.flatMap((turn) => turn.messages);
      if (messages.length === 0) {
        markCaptureCompleted(captureId);
        return;
      }

      const result = await supermemoryClient.ingestConversation(
        `${sessionID}:${batch.startTurn}-${batch.endTurn}`,
        messages,
        [tags.canonical],
        {
          project: tags.projectName,
          sm_project_id: tags.projectId,
          sm_scope: "personal",
          sm_capture_mode: "automatic",
          captureReason: reason,
          sessionId: sessionID,
          turnStart: batch.startTurn,
          turnEnd: batch.endTurn,
        },
        {
          defaultEntityContext: AGENT_ENTITY_CONTEXT,
          customId: captureId,
        },
      );

      if (result.success) {
        markCaptureCompleted(captureId);
        log("[v2 capture] conversation batch saved", {
          sessionID,
          reason,
          startTurn: batch.startTurn,
          endTurn: batch.endTurn,
        });
        debug(`capture saved: ${sessionID} ${reason} turns ${batch.startTurn}-${batch.endTurn}`);
        return;
      }

      log("[v2 capture] failed to save conversation batch", {
        sessionID,
        reason,
        error: result.error,
      });
    };

    const runExclusive = async (
      sessionID: string,
      task: () => Promise<void>,
    ): Promise<void> => {
      const previous = inFlight.get(sessionID) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(task);
      inFlight.set(sessionID, next);
      try {
        await next;
      } finally {
        if (inFlight.get(sessionID) === next) {
          inFlight.delete(sessionID);
        }
      }
    };

    const captureCadence = async (sessionID: string): Promise<void> => {
      const snapshot = messageCache.get(sessionID);
      if (!snapshot || CONFIG.captureEveryNTurns <= 0) return;
      const tags = getTags(sessionDirs.get(sessionID) ?? process.cwd());
      const turns = buildCaptureTurns(snapshot);
      for (const batch of buildCadenceBatches(turns, CONFIG.captureEveryNTurns)) {
        await saveBatch(sessionID, tags, batch, "cadence");
      }
    };

    const captureSessionEnd = async (sessionID: string): Promise<void> => {
      const snapshot = messageCache.get(sessionID);
      if (!snapshot) return;
      const tags = getTags(sessionDirs.get(sessionID) ?? process.cwd());
      const turns = buildCaptureTurns(snapshot);
      const captureEveryNTurns = CONFIG.captureEveryNTurns;
      if (captureEveryNTurns > 0) {
        for (const batch of buildCadenceBatches(turns, captureEveryNTurns)) {
          await saveBatch(sessionID, tags, batch, "cadence");
        }
      }
      const finalBatch = buildSessionEndBatch(turns, captureEveryNTurns);
      if (finalBatch) {
        await saveBatch(sessionID, tags, finalBatch, "session_end");
      }
      messageCache.delete(sessionID);
      activeSessions.delete(sessionID);
    };

    await ctx.session.hook("context", async (rawEvent: unknown) => {
      const event = rawEvent as V2ContextEvent;
      const sessionID = event.sessionID;
      const messages = event.messages ?? [];

      lastActivity.set(sessionID, Date.now());
      activeSessions.add(sessionID);
      messageCache.set(sessionID, adaptMessages(messages));

      if (!isConfigured()) return;

      // V2 message parts have no hidden/synthetic flag, so anything pushed
      // into a message shows up in the conversation UI. Persistent guidance
      // therefore goes into the system prompt, which the model sees but the
      // UI never renders. Marker checks dedupe across dispatches and across
      // the two plugin instances the beta server loads.
      const system = event.system as unknown as V2ContentPart[];

      if (!hasTextMarker(system, "<supermemory-recall>")) {
        system.push({ type: "text", text: buildRecallDirective() });
      }

      const userMsg = lastUserMessage(messages);
      if (!userMsg) return;
      const content = (userMsg.content ??= []);
      const text = userMessageText(userMsg);
      if (!text.trim()) return;

      const fingerprint = userMessageFingerprint(userMsg);
      if (injectedMessages.has(fingerprint)) return;
      // The beta server double-loads plugin entries. The second instance sees
      // the marker text the first instance already pushed and skips.
      if (hasTextMarker(content, "[MEMORY TRIGGER DETECTED]")) return;
      injectedMessages.add(fingerprint);

      try {
        if (detectMemoryKeyword(text)) {
          content.push({ type: "text", text: MEMORY_NUDGE_MESSAGE });
        }

        if (!injectedSessions.has(sessionID)) {
          injectedSessions.add(sessionID);
          const contextText = await buildFirstMessageContext(sessionID, text);
          if (contextText) {
            refreshSystemBlock(system, "[SUPERMEMORY]", contextText);
            debug(`first-message context injected: ${contextText.length} chars`);
          }
        } else {
          // Conditioned recall: search memories for this message only when it
          // looks context-dependent, and refresh the injected block. Keeps
          // recall reliable without an API call on every trivial message.
          const shouldRecall =
            CONFIG.autoRecallEveryPrompt ||
            (CONFIG.conditionedRecall && matchesRecallHeuristic(text));
          if (shouldRecall) {
            const contextText = await buildMemoryContext(sessionID, text);
            if (contextText) {
              refreshSystemBlock(system, "[SUPERMEMORY]", contextText);
              debug(`conditioned recall injected: ${contextText.length} chars`);
            }
          }
        }
      } catch (error) {
        log("v2 context hook ERROR", { error: String(error) });
      }
    });

    await ctx.tool.transform((tools: any) => {
      tools.add({
        name: "supermemory",
        description:
          "Manage and query the Supermemory persistent memory system. Use 'search' to find relevant memories, 'add' to store new knowledge, 'profile' to view user profile, 'list' to see recent memories, 'forget' to remove a memory.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["add", "search", "profile", "list", "forget", "help"],
            },
            content: { type: "string" },
            query: { type: "string" },
            type: {
              type: "string",
              enum: [
                "project-config",
                "architecture",
                "error-solution",
                "preference",
                "learned-pattern",
                "conversation",
              ],
            },
            scope: { type: "string", enum: ["user", "project"] },
            memoryId: { type: "string" },
            limit: { type: "number" },
          },
        },
        execute: async (args: any, toolCtx: any) => {
          const sessionID = String(toolCtx?.sessionID ?? "");
          const directory = sessionID ? sessionDirs.get(sessionID) : undefined;
          debug(`tool execute: sessionID=${sessionID} directory=${directory ?? "fallback-cwd"}`);
          const tags = getTags(directory ?? process.cwd());
          const result = await runSupermemoryTool(args, tags, isConfigured());
          return { content: result };
        },
      });
    });

    const controller = new AbortController();
    let closed = false;

    const run = async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (closed) break;
          const anyEvent = event as unknown as {
            type: string;
            location?: { directory?: string };
            data?: { sessionID?: string; id?: string; info?: { id?: string } };
          };
          const sid = anyEvent.data?.sessionID;
          if (sid) lastActivity.set(sid, Date.now());
          const dir = anyEvent.location?.directory;
          if (dir && sid) sessionDirs.set(sid, dir);

          if (anyEvent.type === "session.deleted") {
            const data = anyEvent.data ?? {};
            const deletedID = data.sessionID ?? data.info?.id ?? data.id;
            if (deletedID) {
              debug(`session deleted: ${deletedID}`);
              await runExclusive(deletedID, () => captureSessionEnd(deletedID));
            }
            continue;
          }

          if (anyEvent.type === "global.disposed") {
            debug("global disposed: flushing captures");
            await Promise.all(
              [...activeSessions].map((sessionID) =>
                runExclusive(sessionID, () => captureSessionEnd(sessionID)),
              ),
            );
            continue;
          }
        }
      } catch (err) {
        // stream closed; nothing to do
      }
    };

    // Cadence capture after the session has been quiet for a while. V1
    // captured on session.idle, which the V2 public stream does not emit
    // reliably, so a quiet-period check is the V2 equivalent.
    const timer = setInterval(() => {
      const now = Date.now();
      for (const sessionID of activeSessions) {
        const last = lastActivity.get(sessionID) ?? 0;
        if (now - last >= QUIET_MS) {
          lastActivity.set(sessionID, now);
          void runExclusive(sessionID, () => captureCadence(sessionID));
        }
      }
    }, 10_000);

    void run();
    return () => {
      closed = true;
      clearInterval(timer);
      controller.abort();
    };
  },
});
