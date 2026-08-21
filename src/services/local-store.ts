import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type {
  ConversationIngestResponse,
  ConversationMessage,
  MemoryType,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Local memory store: SQLite + FTS5, no vendor, no cloud.
//
// Implements the same public surface as SupermemoryClient (search, profile,
// list, add, delete, ingest) so the plugin and tool layer can swap backends
// with a one-line import change. Return shapes mirror client.ts exactly.
// ---------------------------------------------------------------------------

export type MemoryScope = "personal" | "project";

export interface SearchResultItem {
  id?: string;
  memory?: string;
  content?: string;
  chunk?: string;
  context?: unknown;
  score?: number;
  similarity?: number;
  title?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown> | null;
  containerTag?: string;
}

export interface SearchResponse {
  success: boolean;
  results?: SearchResultItem[];
  total?: number;
  timing?: number;
  error?: string;
}

export interface ProfileResponse {
  success: boolean;
  profile: { static: string[]; dynamic: string[] } | null;
  searchResults?: {
    results: SearchResultItem[];
    total: number;
    timing?: number;
  };
  error?: string;
}

export interface ListMemoryItem {
  id: string;
  summary?: string | null;
  content?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ListResponse {
  success: boolean;
  memories: ListMemoryItem[];
  pagination: {
    currentPage: number;
    totalItems: number;
    totalPages: number;
  };
  error?: string;
}

const MAX_CONVERSATION_CHARS = 100_000;

function dbPath(): string {
  if (process.env.OPENCODE_MEMORY_DB_PATH) {
    return process.env.OPENCODE_MEMORY_DB_PATH;
  }
  return path.join(
    homedir(),
    ".config",
    "opencode",
    "supermemory-local",
    "memory.sqlite",
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampSimilarity(raw: number): number {
  // FTS5 bm25 returns negative scores where closer to 0 is better.
  // Convert to 0..1 similarity for the same shape the cloud API returned.
  const s = Math.max(0, Math.min(1, 1 - Math.abs(raw) / 200));
  return Math.round(s * 1000) / 1000;
}

export class LocalMemoryStore {
  private db: Database;

  constructor() {
    const p = dbPath();
    mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        container_tag TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'personal',
        memory_type TEXT NOT NULL DEFAULT 'conversation',
        title TEXT,
        metadata TEXT,
        custom_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_container ON memories (container_tag);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope);
      CREATE INDEX IF NOT EXISTS idx_memories_custom ON memories (custom_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        title,
        container_tag UNINDEXED,
        memory_type UNINDEXED,
        scope UNINDEXED,
        id UNINDEXED
      );
    `);
  }

  private rowToResult(row: any): SearchResultItem {
    let metadata: Record<string, unknown> | null = null;
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : null;
    } catch {
      metadata = null;
    }
    return {
      id: row.id,
      memory: row.content,
      content: row.content,
      similarity: row.similarity ?? undefined,
      title: row.title ?? undefined,
      updatedAt: row.updated_at ?? undefined,
      metadata,
      containerTag: row.container_tag,
    };
  }

  private rowToListItem(row: any): ListMemoryItem {
    let metadata: Record<string, unknown> | null = null;
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : null;
    } catch {
      metadata = null;
    }
    return {
      id: row.id,
      summary: row.title ?? null,
      content: row.content,
      title: row.title ?? null,
      metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private searchRows(query: string, containerTags: string[], limit: number, scope?: MemoryScope): { results: SearchResultItem[]; total: number } {
    const tags = [...new Set(containerTags.filter(Boolean))];
    if (tags.length === 0) {
      return { results: [], total: 0 };
    }
    const placeholders = tags.map(() => "?").join(",");
    const params: (string | number)[] = [query, ...tags, limit];
    let scopeClause = "";
    if (scope === "project") {
      scopeClause = " AND m.scope = 'project'";
    } else if (scope === "personal") {
      scopeClause = " AND m.scope = 'personal'";
    }
    const sql = `
      SELECT m.*, bm25(memories_fts) AS score
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.id
      WHERE memories_fts MATCH ?
        AND m.container_tag IN (${placeholders})
        ${scopeClause}
      ORDER BY score
      LIMIT ?
    `;
    let rows: any[] = [];
    try {
      rows = this.db.query(sql).all(...params) as any[];
    } catch (err) {
      // FTS syntax errors (e.g. odd characters in query) — fall back to LIKE.
      const like = `%${query}%`;
      const likeParams: (string | number)[] = [like, ...tags, limit];
      rows = this.db
        .query(
          `SELECT m.*, 0.5 AS score FROM memories m
           WHERE m.container_tag IN (${placeholders}) AND m.content LIKE ?
           ${scopeClause}
           ORDER BY m.updated_at DESC LIMIT ?`,
        )
        .all(...likeParams) as any[];
    }
    const results = rows.map((r) => ({
      ...this.rowToResult(r),
      similarity: clampSimilarity(Number(r.score ?? 0.5)),
    }));
    return { results, total: results.length };
  }

  // --- search -------------------------------------------------------------

  async searchMemories(query: string, containerTag: string, scope?: MemoryScope): Promise<SearchResponse> {
    try {
      const { results, total } = this.searchRows(query, [containerTag], CONFIG.maxMemories, scope);
      log("local searchMemories: success", { count: results.length });
      return { success: true, results, total, timing: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("local searchMemories: error", { error: errorMessage });
      return { success: false, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async searchMemoriesMany(query: string, containerTags: string[]): Promise<SearchResponse> {
    const { results, total } = this.searchRows(query, containerTags, CONFIG.maxMemories);
    return { success: true, results, total, timing: 0 };
  }

  async searchMemoriesScoped(query: string, canonicalTag: string, containerTags: string[], scope: MemoryScope): Promise<SearchResponse> {
    const tags = [...new Set([canonicalTag, ...containerTags.filter((t) => t && t !== canonicalTag)])];
    const { results, total } = this.searchRows(query, tags, CONFIG.maxMemories, scope);
    return { success: true, results, total, timing: 0 };
  }

  // --- profile ------------------------------------------------------------

  async getProfile(containerTag: string, query?: string, scope?: MemoryScope): Promise<ProfileResponse> {
    try {
      const tags = [containerTag];
      const staticRows = this.db
        .query(
          `SELECT content FROM memories WHERE container_tag = ? AND scope = 'personal'
             AND memory_type IN ('preference', 'project-config', 'learned-pattern')
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(containerTag, CONFIG.maxProfileItems) as Array<{ content: string }>;
      const dynamicRows = this.db
        .query(
          `SELECT content FROM memories WHERE container_tag = ? AND scope = 'personal'
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(containerTag, CONFIG.maxProfileItems) as Array<{ content: string }>;

      let searchResults;
      if (query) {
        const { results, total } = this.searchRows(query, tags, CONFIG.maxMemories, scope);
        searchResults = { results, total, timing: 0 };
      }
      return {
        success: true,
        profile: {
          static: staticRows.map((r) => r.content),
          dynamic: dynamicRows.map((r) => r.content),
        },
        searchResults,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("local getProfile: error", { error: errorMessage });
      return { success: false, error: errorMessage, profile: null };
    }
  }

  async getProfileMany(containerTags: string[], query?: string): Promise<ProfileResponse> {
    const merged: string[] = [];
    for (const tag of containerTags) {
      const res = await this.getProfile(tag, query);
      if (res.success && res.profile) {
        merged.push(...res.profile.static, ...res.profile.dynamic);
      }
    }
    return {
      success: true,
      profile: { static: merged, dynamic: [] },
    };
  }

  async getProfileScoped(canonicalTag: string, containerTags: string[], scope: MemoryScope, query?: string): Promise<ProfileResponse> {
    const tags = [...new Set([canonicalTag, ...containerTags.filter((t) => t && t !== canonicalTag)])];
    const mergedStatic: string[] = [];
    const mergedDynamic: string[] = [];
    let searchResults;
    for (const tag of tags) {
      const res = await this.getProfile(tag, query, scope);
      if (res.success && res.profile) {
        mergedStatic.push(...res.profile.static);
        mergedDynamic.push(...res.profile.dynamic);
      }
      if (!searchResults && res.searchResults) {
        searchResults = res.searchResults;
      }
    }
    return {
      success: true,
      profile: { static: mergedStatic, dynamic: mergedDynamic },
      searchResults,
    };
  }

  // --- write ----------------------------------------------------------------

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: {
      type?: MemoryType;
      tool?: string;
      [key: string]: unknown;
    },
    options?: { customId?: string; entityContext?: string },
  ) {
    try {
      const id = randomUUID();
      const now = nowIso();
      const memoryType = metadata?.type ?? "conversation";
      const scope = (metadata?.sm_scope as MemoryScope) ?? "personal";
      const title =
        typeof metadata?.title === "string" ? metadata.title : null;
      const metaJson = JSON.stringify(metadata ?? {});

      if (options?.customId) {
        const existing = this.db
          .query("SELECT id FROM memories WHERE custom_id = ?")
          .get(options.customId) as { id: string } | null;
        if (existing) {
          // Idempotent upsert: refresh content + metadata, keep the id.
          this.db
            .query(
              `UPDATE memories SET content = ?, metadata = ?, memory_type = ?,
                 scope = ?, updated_at = ? WHERE custom_id = ?`,
            )
            .run(content, metaJson, memoryType, scope, now, options.customId);
          this.db
            .query(
              `UPDATE memories_fts SET content = ?, title = ?,
                 container_tag = ?, memory_type = ?, scope = ?
               WHERE id = ?`,
            )
            .run(content, title ?? "", containerTag, memoryType, scope, existing.id);
          log("local addMemory: upserted", { id: existing.id });
          return { success: true as const, id: existing.id };
        }
      }

      this.db
        .query(
          `INSERT INTO memories
             (id, content, container_tag, scope, memory_type, title, metadata, custom_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, content, containerTag, scope, memoryType, title, metaJson, options?.customId ?? null, now, now);
      this.db
        .query(
          `INSERT INTO memories_fts (id, content, title, container_tag, memory_type, scope)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, content, title ?? "", containerTag, memoryType, scope);
      log("local addMemory: success", { id });
      return { success: true as const, id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("local addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string, _containerTags: string[] = []) {
    try {
      this.db.query("DELETE FROM memories_fts WHERE id = ?").run(memoryId);
      this.db.query("DELETE FROM memories WHERE id = ?").run(memoryId);
      log("local deleteMemory: deleted", { memoryId });
      return { success: true as const };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("local deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  // --- list -----------------------------------------------------------------

  async listMemories(containerTag: string, limit = 20, scope?: MemoryScope): Promise<ListResponse> {
    try {
      const scopeClause =
        scope === "project"
          ? " AND scope = 'project'"
          : scope === "personal"
            ? " AND scope = 'personal'"
            : "";
      const rows = this.db
        .query(
          `SELECT * FROM memories WHERE container_tag = ? ${scopeClause}
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(containerTag, limit) as any[];
      const total = rows.length;
      return {
        success: true,
        memories: rows.map((r) => this.rowToListItem(r)),
        pagination: { currentPage: 1, totalItems: total, totalPages: 1 },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
      };
    }
  }

  async listMemoriesMany(containerTags: string[], limit = 20): Promise<ListResponse> {
    const all: ListMemoryItem[] = [];
    for (const tag of containerTags) {
      const res = await this.listMemories(tag, limit);
      all.push(...res.memories);
    }
    return {
      success: true,
      memories: all.slice(0, limit),
      pagination: { currentPage: 1, totalItems: all.length, totalPages: 1 },
    };
  }

  async listMemoriesScoped(canonicalTag: string, containerTags: string[], scope: MemoryScope, limit = 20): Promise<ListResponse> {
    const tags = [...new Set([canonicalTag, ...containerTags.filter((t) => t && t !== canonicalTag)])];
    const all: ListMemoryItem[] = [];
    for (const tag of tags) {
      const res = await this.listMemories(tag, limit, scope);
      all.push(...res.memories);
    }
    return {
      success: true,
      memories: all.slice(0, limit),
      pagination: { currentPage: 1, totalItems: all.length, totalPages: 1 },
    };
  }

  // --- ingest ----------------------------------------------------------------

  private formatConversationMessage(message: ConversationMessage): string {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) =>
              part.type === "text"
                ? part.text
                : `[image] ${part.imageUrl.url}`,
            )
            .join("\n");
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return `[${message.role}]`;
    }
    return `[${message.role}] ${trimmed}`;
  }

  private formatConversationTranscript(messages: ConversationMessage[]): string {
    return messages
      .map(
        (message, idx) =>
          `${idx + 1}. ${this.formatConversationMessage(message)}`,
      )
      .join("\n");
  }

  async ingestConversation(
    conversationId: string,
    messages: ConversationMessage[],
    containerTags: string[],
    metadata?: Record<string, string | number | boolean>,
    options?: {
      defaultEntityContext?: string;
      entityContextByContainerTag?: Record<string, string>;
      customId?: string;
    },
  ): Promise<
    | { success: true; id: string; conversationId: string; status: "stored" | "partial"; storedMemoryIds: string[] }
    | { success: false; error: string }
  > {
    if (messages.length === 0) {
      return { success: false, error: "No messages to ingest" };
    }
    const uniqueTags = [...new Set(containerTags)].filter((tag) => tag.length > 0);
    if (uniqueTags.length === 0) {
      return { success: false, error: "At least one containerTag is required" };
    }

    const transcript = this.formatConversationTranscript(messages);
    const rawContent = `[Conversation ${conversationId}]\n${transcript}`;
    const content =
      rawContent.length > MAX_CONVERSATION_CHARS
        ? `${rawContent.slice(0, MAX_CONVERSATION_CHARS)}\n...[truncated]`
        : rawContent;

    const ingestMetadata = {
      type: "conversation" as const,
      conversationId,
      messageCount: messages.length,
      originalContainerTags: uniqueTags,
      ...metadata,
    };

    const savedIds: string[] = [];
    let firstError: string | null = null;

    for (const tag of uniqueTags) {
      const customId =
        options?.customId && uniqueTags.length > 1
          ? `${options.customId}:${tag}`
          : options?.customId;
      const result = await this.addMemory(content, tag, ingestMetadata, {
        ...(customId ? { customId } : {}),
      });
      if (result.success) {
        savedIds.push(result.id);
      } else if (!firstError) {
        firstError = result.error || "Failed to store conversation";
      }
    }

    if (savedIds.length === 0) {
      return {
        success: false,
        error: firstError || "Failed to ingest conversation",
      };
    }

    const status = savedIds.length === uniqueTags.length ? "stored" : "partial";
    return {
      success: true,
      id: savedIds[0]!,
      conversationId,
      status,
      storedMemoryIds: savedIds,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // best effort
    }
  }
}

export const localMemoryStore = new LocalMemoryStore();

// Drop-in alias: plugin and tool code reference `supermemoryClient` by name.
// Pointing it at the local store keeps the rest of the codebase unchanged.
export const supermemoryClient = localMemoryStore;
