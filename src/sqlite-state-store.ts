import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StoredConversationTurn = {
  chatId: number;
  role: "user" | "assistant";
  text: string;
  source: string;
  atMs: number;
  userId?: number;
};

export type StoredIndexedListContext = {
  chatId: number;
  kind: string;
  title: string;
  source: string;
  itemsJson: string;
  createdAtMs: number;
};

export type StoredIdempotencyHit = {
  chatId: number;
  requestId: string;
  payloadJson: string;
  createdAtMs: number;
};

export type StoredOutboxMessage = {
  id: number;
  chatId: number;
  text: string;
  source: string;
  createdAtMs: number;
  attempts: number;
  lastError?: string;
};

export class SqliteStateStore {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(dbPathInput: string) {
    this.dbPath = path.resolve(dbPathInput);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        user_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_chat_id ON conversation_turns(chat_id, at_ms DESC);

      CREATE TABLE IF NOT EXISTS indexed_list_contexts (
        chat_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        items_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_requests (
        chat_id INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_requests(created_at_ms);

      CREATE TABLE IF NOT EXISTS outbound_message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_message_queue_chat ON outbound_message_queue(chat_id, created_at_ms ASC);
    `);
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SqliteStateStore no inicializado. Llama init() antes de usarlo.");
    }
    return this.db;
  }

  appendConversationTurn(turn: StoredConversationTurn): void {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT INTO conversation_turns (chat_id, role, text, source, at_ms, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(turn.chatId, turn.role, turn.text, turn.source, turn.atMs, turn.userId ?? null);
  }

  listRecentConversationTurns(chatId: number, limit: number): StoredConversationTurn[] {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      SELECT chat_id, role, text, source, at_ms, user_id
      FROM conversation_turns
      WHERE chat_id = ?
      ORDER BY at_ms DESC
      LIMIT ?
    `);
    const rows = stmt.all(chatId, Math.max(1, Math.min(500, Math.floor(limit)))) as Array<Record<string, unknown>>;
    return rows
      .map((row) => {
        const role: "user" | "assistant" = row.role === "assistant" ? "assistant" : "user";
        return {
          chatId: Number(row.chat_id),
          role,
          text: String(row.text ?? ""),
          source: String(row.source ?? ""),
          atMs: Number(row.at_ms),
          userId: typeof row.user_id === "number" ? row.user_id : undefined,
        };
      })
      .filter((row) => Number.isFinite(row.chatId) && row.text.length > 0)
      .sort((a, b) => a.atMs - b.atMs);
  }

  upsertIndexedListContext(context: StoredIndexedListContext): void {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT INTO indexed_list_contexts (chat_id, kind, title, source, items_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        source = excluded.source,
        items_json = excluded.items_json,
        created_at_ms = excluded.created_at_ms
    `);
    stmt.run(context.chatId, context.kind, context.title, context.source, context.itemsJson, context.createdAtMs);
  }

  deleteIndexedListContext(chatId: number): void {
    const db = this.ensureDb();
    db.prepare("DELETE FROM indexed_list_contexts WHERE chat_id = ?").run(chatId);
  }

  getIndexedListContext(chatId: number): StoredIndexedListContext | null {
    const db = this.ensureDb();
    const row = db
      .prepare(
        "SELECT chat_id, kind, title, source, items_json, created_at_ms FROM indexed_list_contexts WHERE chat_id = ?",
      )
      .get(chatId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      chatId: Number(row.chat_id),
      kind: String(row.kind ?? ""),
      title: String(row.title ?? ""),
      source: String(row.source ?? ""),
      itemsJson: String(row.items_json ?? "[]"),
      createdAtMs: Number(row.created_at_ms ?? 0),
    };
  }

  saveIdempotencyHit(hit: StoredIdempotencyHit): void {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT INTO idempotency_requests (chat_id, request_id, payload_json, created_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, request_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        created_at_ms = excluded.created_at_ms
    `);
    stmt.run(hit.chatId, hit.requestId, hit.payloadJson, hit.createdAtMs);
  }

  getIdempotencyHit(chatId: number, requestId: string): StoredIdempotencyHit | null {
    const db = this.ensureDb();
    const row = db
      .prepare(
        "SELECT chat_id, request_id, payload_json, created_at_ms FROM idempotency_requests WHERE chat_id = ? AND request_id = ?",
      )
      .get(chatId, requestId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      chatId: Number(row.chat_id),
      requestId: String(row.request_id ?? ""),
      payloadJson: String(row.payload_json ?? "{}"),
      createdAtMs: Number(row.created_at_ms ?? 0),
    };
  }

  pruneIdempotency(beforeEpochMs: number): number {
    const db = this.ensureDb();
    const result = db.prepare("DELETE FROM idempotency_requests WHERE created_at_ms < ?").run(beforeEpochMs) as {
      changes?: number;
    };
    return Number(result.changes ?? 0);
  }

  enqueueOutboxMessage(params: {
    chatId: number;
    text: string;
    source: string;
    createdAtMs: number;
    attempts?: number;
    lastError?: string;
  }): number {
    const db = this.ensureDb();
    const result = db
      .prepare(
        `
      INSERT INTO outbound_message_queue (chat_id, text, source, created_at_ms, attempts, last_error)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        params.chatId,
        params.text,
        params.source,
        params.createdAtMs,
        params.attempts ?? 0,
        params.lastError ?? null,
      ) as { lastInsertRowid?: number | bigint };
    return Number(result.lastInsertRowid ?? 0);
  }

  listOutboxMessages(chatId?: number, limit = 50): StoredOutboxMessage[] {
    const db = this.ensureDb();
    const cappedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows =
      typeof chatId === "number"
        ? (db
            .prepare(
              `
          SELECT id, chat_id, text, source, created_at_ms, attempts, last_error
          FROM outbound_message_queue
          WHERE chat_id = ?
          ORDER BY created_at_ms ASC, id ASC
          LIMIT ?
        `,
            )
            .all(chatId, cappedLimit) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT id, chat_id, text, source, created_at_ms, attempts, last_error
          FROM outbound_message_queue
          ORDER BY created_at_ms ASC, id ASC
          LIMIT ?
        `,
            )
            .all(cappedLimit) as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      id: Number(row.id),
      chatId: Number(row.chat_id),
      text: String(row.text ?? ""),
      source: String(row.source ?? ""),
      createdAtMs: Number(row.created_at_ms ?? 0),
      attempts: Number(row.attempts ?? 0),
      lastError: typeof row.last_error === "string" ? row.last_error : undefined,
    }));
  }

  markOutboxAttempt(id: number, lastError?: string): void {
    const db = this.ensureDb();
    db.prepare(
      `
      UPDATE outbound_message_queue
      SET attempts = attempts + 1, last_error = ?
      WHERE id = ?
    `,
    ).run(lastError ?? null, id);
  }

  ackOutboxMessage(id: number): void {
    const db = this.ensureDb();
    db.prepare("DELETE FROM outbound_message_queue WHERE id = ?").run(id);
  }
}
