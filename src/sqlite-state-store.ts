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
  nextAttemptAtMs: number;
  lastError?: string;
};

export type StoredOutboxDeadLetter = {
  id: number;
  chatId: number;
  text: string;
  source: string;
  createdAtMs: number;
  attempts: number;
  failedAtMs: number;
  failureReason?: string;
  lastError?: string;
};

export type StoredPendingApproval = {
  id: string;
  kind: string;
  chatId: number;
  userId: number;
  agentName: string;
  commandLine: string;
  createdAt: number;
  expiresAt: number;
  note?: string;
};

export type StoredPlannedAction = {
  id: string;
  kind: string;
  chatId: number;
  userId?: number;
  requestedAtMs: number;
  expiresAtMs: number;
  summary: string;
  payloadJson: string;
};

export type StoredWorkspaceDeleteConfirmation = {
  chatId: number;
  pathsJson: string;
  requestedAtMs: number;
  expiresAtMs: number;
  source: string;
  userId?: number;
};

export type StoredWorkspaceDeletePathRequest = {
  chatId: number;
  requestedAtMs: number;
  expiresAtMs: number;
  source: string;
  userId?: number;
};

export type StoredChatRuntimeSettings = {
  chatId: number;
  activeAgent?: string;
  aiShellMode?: boolean;
  ecoMode?: boolean;
  safeMode?: boolean;
  openAiModel?: string;
  adminMode?: boolean;
  updatedAtMs: number;
};

export type StoredGlobalRuntimeSettings = {
  panicMode: boolean;
  updatedAtMs: number;
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
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_message_queue_chat ON outbound_message_queue(chat_id, created_at_ms ASC);
      CREATE INDEX IF NOT EXISTS idx_outbound_message_queue_due ON outbound_message_queue(next_attempt_at_ms, created_at_ms ASC);

      CREATE TABLE IF NOT EXISTS outbound_message_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        failed_at_ms INTEGER NOT NULL,
        failure_reason TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_message_dead_letter_chat ON outbound_message_dead_letter(chat_id, failed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        agent_name TEXT NOT NULL,
        command_line TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_chat ON pending_approvals(chat_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_expires ON pending_approvals(expires_at);

      CREATE TABLE IF NOT EXISTS pending_planned_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        user_id INTEGER,
        requested_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_planned_actions_chat ON pending_planned_actions(chat_id, requested_at_ms ASC);
      CREATE INDEX IF NOT EXISTS idx_pending_planned_actions_expires ON pending_planned_actions(expires_at_ms);

      CREATE TABLE IF NOT EXISTS pending_workspace_delete_confirmations (
        chat_id INTEGER PRIMARY KEY,
        paths_json TEXT NOT NULL,
        requested_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        user_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pending_workspace_delete_confirmations_expires ON pending_workspace_delete_confirmations(expires_at_ms);

      CREATE TABLE IF NOT EXISTS pending_workspace_delete_path_requests (
        chat_id INTEGER PRIMARY KEY,
        requested_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        user_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pending_workspace_delete_path_requests_expires ON pending_workspace_delete_path_requests(expires_at_ms);

      CREATE TABLE IF NOT EXISTS chat_runtime_settings (
        chat_id INTEGER PRIMARY KEY,
        active_agent TEXT,
        ai_shell_mode INTEGER,
        eco_mode INTEGER,
        safe_mode INTEGER,
        openai_model TEXT,
        admin_mode INTEGER,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_runtime_settings_updated ON chat_runtime_settings(updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS global_runtime_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        panic_mode INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    this.ensureOutboxSchema();
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SqliteStateStore no inicializado. Llama init() antes de usarlo.");
    }
    return this.db;
  }

  private runInTransaction(callback: (db: DatabaseSync) => void): void {
    const db = this.ensureDb();
    db.exec("BEGIN IMMEDIATE;");
    try {
      callback(db);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore rollback failures
      }
      throw error;
    }
  }

  private ensureOutboxSchema(): void {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(outbound_message_queue)").all() as Array<Record<string, unknown>>;
    const hasNextAttemptColumn = columns.some((column) => String(column.name ?? "") === "next_attempt_at_ms");
    if (!hasNextAttemptColumn) {
      db.exec("ALTER TABLE outbound_message_queue ADD COLUMN next_attempt_at_ms INTEGER NOT NULL DEFAULT 0;");
      db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_message_queue_due ON outbound_message_queue(next_attempt_at_ms, created_at_ms ASC);");
      db.exec("UPDATE outbound_message_queue SET next_attempt_at_ms = created_at_ms WHERE next_attempt_at_ms <= 0;");
    }
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
    nextAttemptAtMs?: number;
    lastError?: string;
  }): number {
    const db = this.ensureDb();
    const result = db
      .prepare(
        `
      INSERT INTO outbound_message_queue (chat_id, text, source, created_at_ms, attempts, next_attempt_at_ms, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        params.chatId,
        params.text,
        params.source,
        params.createdAtMs,
        params.attempts ?? 0,
        params.nextAttemptAtMs ?? params.createdAtMs,
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
          SELECT id, chat_id, text, source, created_at_ms, attempts, next_attempt_at_ms, last_error
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
          SELECT id, chat_id, text, source, created_at_ms, attempts, next_attempt_at_ms, last_error
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
      nextAttemptAtMs: Number(row.next_attempt_at_ms ?? row.created_at_ms ?? 0),
      lastError: typeof row.last_error === "string" ? row.last_error : undefined,
    }));
  }

  listDueOutboxMessages(params?: { chatId?: number; limit?: number; nowMs?: number }): StoredOutboxMessage[] {
    const db = this.ensureDb();
    const cappedLimit = Math.max(1, Math.min(500, Math.floor(params?.limit ?? 50)));
    const nowMs = Math.floor(params?.nowMs ?? Date.now());
    const rows =
      typeof params?.chatId === "number"
        ? (db
            .prepare(
              `
          SELECT id, chat_id, text, source, created_at_ms, attempts, next_attempt_at_ms, last_error
          FROM outbound_message_queue
          WHERE chat_id = ? AND next_attempt_at_ms <= ?
          ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, id ASC
          LIMIT ?
        `,
            )
            .all(params.chatId, nowMs, cappedLimit) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT id, chat_id, text, source, created_at_ms, attempts, next_attempt_at_ms, last_error
          FROM outbound_message_queue
          WHERE next_attempt_at_ms <= ?
          ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, id ASC
          LIMIT ?
        `,
            )
            .all(nowMs, cappedLimit) as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      id: Number(row.id),
      chatId: Number(row.chat_id),
      text: String(row.text ?? ""),
      source: String(row.source ?? ""),
      createdAtMs: Number(row.created_at_ms ?? 0),
      attempts: Number(row.attempts ?? 0),
      nextAttemptAtMs: Number(row.next_attempt_at_ms ?? row.created_at_ms ?? 0),
      lastError: typeof row.last_error === "string" ? row.last_error : undefined,
    }));
  }

  markOutboxAttempt(id: number, params?: { lastError?: string; nextAttemptAtMs?: number }): void {
    const db = this.ensureDb();
    db.prepare(
      `
      UPDATE outbound_message_queue
      SET attempts = attempts + 1, last_error = ?, next_attempt_at_ms = ?
      WHERE id = ?
    `,
    ).run(params?.lastError ?? null, Math.floor(params?.nextAttemptAtMs ?? Date.now()), id);
  }

  ackOutboxMessage(id: number): void {
    const db = this.ensureDb();
    db.prepare("DELETE FROM outbound_message_queue WHERE id = ?").run(id);
  }

  moveOutboxToDeadLetter(
    id: number,
    params?: {
      failureReason?: string;
      failedAtMs?: number;
    },
  ): boolean {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `
      SELECT id, chat_id, text, source, created_at_ms, attempts, last_error
      FROM outbound_message_queue
      WHERE id = ?
    `,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return false;
    }
    const failedAtMs = Math.floor(params?.failedAtMs ?? Date.now());
    const failureReason = params?.failureReason?.trim() || null;
    db.prepare(
      `
      INSERT INTO outbound_message_dead_letter (
        chat_id, text, source, created_at_ms, attempts, failed_at_ms, failure_reason, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      Number(row.chat_id ?? 0),
      String(row.text ?? ""),
      String(row.source ?? ""),
      Number(row.created_at_ms ?? 0),
      Number(row.attempts ?? 0),
      failedAtMs,
      failureReason,
      typeof row.last_error === "string" ? row.last_error : null,
    );
    db.prepare("DELETE FROM outbound_message_queue WHERE id = ?").run(id);
    return true;
  }

  listOutboxDeadLetter(chatId?: number, limit = 50): StoredOutboxDeadLetter[] {
    const db = this.ensureDb();
    const cappedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows =
      typeof chatId === "number"
        ? (db
            .prepare(
              `
          SELECT id, chat_id, text, source, created_at_ms, attempts, failed_at_ms, failure_reason, last_error
          FROM outbound_message_dead_letter
          WHERE chat_id = ?
          ORDER BY failed_at_ms DESC, id DESC
          LIMIT ?
        `,
            )
            .all(chatId, cappedLimit) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT id, chat_id, text, source, created_at_ms, attempts, failed_at_ms, failure_reason, last_error
          FROM outbound_message_dead_letter
          ORDER BY failed_at_ms DESC, id DESC
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
      failedAtMs: Number(row.failed_at_ms ?? 0),
      failureReason: typeof row.failure_reason === "string" ? row.failure_reason : undefined,
      lastError: typeof row.last_error === "string" ? row.last_error : undefined,
    }));
  }

  replacePendingApprovals(rows: StoredPendingApproval[]): void {
    this.runInTransaction((db) => {
      db.prepare("DELETE FROM pending_approvals").run();
      const insert = db.prepare(
        `
        INSERT INTO pending_approvals (
          id, kind, chat_id, user_id, agent_name, command_line, created_at, expires_at, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const item of rows) {
        insert.run(
          item.id,
          item.kind,
          item.chatId,
          item.userId,
          item.agentName,
          item.commandLine,
          item.createdAt,
          item.expiresAt,
          item.note ?? null,
        );
      }
    });
  }

  listPendingApprovals(chatId?: number): StoredPendingApproval[] {
    const db = this.ensureDb();
    const rows =
      typeof chatId === "number"
        ? (db
            .prepare(
              `
          SELECT id, kind, chat_id, user_id, agent_name, command_line, created_at, expires_at, note
          FROM pending_approvals
          WHERE chat_id = ?
          ORDER BY created_at ASC
        `,
            )
            .all(chatId) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT id, kind, chat_id, user_id, agent_name, command_line, created_at, expires_at, note
          FROM pending_approvals
          ORDER BY created_at ASC
        `,
            )
            .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      kind: String(row.kind ?? ""),
      chatId: Number(row.chat_id ?? 0),
      userId: Number(row.user_id ?? 0),
      agentName: String(row.agent_name ?? ""),
      commandLine: String(row.command_line ?? ""),
      createdAt: Number(row.created_at ?? 0),
      expiresAt: Number(row.expires_at ?? 0),
      note: typeof row.note === "string" ? row.note : undefined,
    }));
  }

  replacePendingPlannedActions(rows: StoredPlannedAction[]): void {
    this.runInTransaction((db) => {
      db.prepare("DELETE FROM pending_planned_actions").run();
      const insert = db.prepare(
        `
        INSERT INTO pending_planned_actions (
          id, kind, chat_id, user_id, requested_at_ms, expires_at_ms, summary, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const item of rows) {
        insert.run(
          item.id,
          item.kind,
          item.chatId,
          item.userId ?? null,
          item.requestedAtMs,
          item.expiresAtMs,
          item.summary,
          item.payloadJson,
        );
      }
    });
  }

  listPendingPlannedActions(chatId?: number): StoredPlannedAction[] {
    const db = this.ensureDb();
    const rows =
      typeof chatId === "number"
        ? (db
            .prepare(
              `
          SELECT id, kind, chat_id, user_id, requested_at_ms, expires_at_ms, summary, payload_json
          FROM pending_planned_actions
          WHERE chat_id = ?
          ORDER BY requested_at_ms ASC
        `,
            )
            .all(chatId) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT id, kind, chat_id, user_id, requested_at_ms, expires_at_ms, summary, payload_json
          FROM pending_planned_actions
          ORDER BY requested_at_ms ASC
        `,
            )
            .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      kind: String(row.kind ?? ""),
      chatId: Number(row.chat_id ?? 0),
      userId: typeof row.user_id === "number" ? row.user_id : undefined,
      requestedAtMs: Number(row.requested_at_ms ?? 0),
      expiresAtMs: Number(row.expires_at_ms ?? 0),
      summary: String(row.summary ?? ""),
      payloadJson: String(row.payload_json ?? "{}"),
    }));
  }

  replaceWorkspaceDeleteConfirmations(rows: StoredWorkspaceDeleteConfirmation[]): void {
    this.runInTransaction((db) => {
      db.prepare("DELETE FROM pending_workspace_delete_confirmations").run();
      const insert = db.prepare(
        `
        INSERT INTO pending_workspace_delete_confirmations (
          chat_id, paths_json, requested_at_ms, expires_at_ms, source, user_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      );
      for (const item of rows) {
        insert.run(
          item.chatId,
          item.pathsJson,
          item.requestedAtMs,
          item.expiresAtMs,
          item.source,
          item.userId ?? null,
        );
      }
    });
  }

  listWorkspaceDeleteConfirmations(chatId?: number): StoredWorkspaceDeleteConfirmation[] {
    const db = this.ensureDb();
    const rows =
      typeof chatId === "number"
        ? (db
            .prepare(
              `
          SELECT chat_id, paths_json, requested_at_ms, expires_at_ms, source, user_id
          FROM pending_workspace_delete_confirmations
          WHERE chat_id = ?
        `,
            )
            .all(chatId) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT chat_id, paths_json, requested_at_ms, expires_at_ms, source, user_id
          FROM pending_workspace_delete_confirmations
        `,
            )
            .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      chatId: Number(row.chat_id ?? 0),
      pathsJson: String(row.paths_json ?? "[]"),
      requestedAtMs: Number(row.requested_at_ms ?? 0),
      expiresAtMs: Number(row.expires_at_ms ?? 0),
      source: String(row.source ?? ""),
      userId: typeof row.user_id === "number" ? row.user_id : undefined,
    }));
  }

  replaceWorkspaceDeletePathRequests(rows: StoredWorkspaceDeletePathRequest[]): void {
    this.runInTransaction((db) => {
      db.prepare("DELETE FROM pending_workspace_delete_path_requests").run();
      const insert = db.prepare(
        `
        INSERT INTO pending_workspace_delete_path_requests (
          chat_id, requested_at_ms, expires_at_ms, source, user_id
        ) VALUES (?, ?, ?, ?, ?)
      `,
      );
      for (const item of rows) {
        insert.run(item.chatId, item.requestedAtMs, item.expiresAtMs, item.source, item.userId ?? null);
      }
    });
  }

  listWorkspaceDeletePathRequests(chatId?: number): StoredWorkspaceDeletePathRequest[] {
    const db = this.ensureDb();
    const rows =
      typeof chatId === "number"
        ? (db
            .prepare(
              `
          SELECT chat_id, requested_at_ms, expires_at_ms, source, user_id
          FROM pending_workspace_delete_path_requests
          WHERE chat_id = ?
        `,
            )
            .all(chatId) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT chat_id, requested_at_ms, expires_at_ms, source, user_id
          FROM pending_workspace_delete_path_requests
        `,
            )
            .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      chatId: Number(row.chat_id ?? 0),
      requestedAtMs: Number(row.requested_at_ms ?? 0),
      expiresAtMs: Number(row.expires_at_ms ?? 0),
      source: String(row.source ?? ""),
      userId: typeof row.user_id === "number" ? row.user_id : undefined,
    }));
  }

  replaceChatRuntimeSettings(rows: StoredChatRuntimeSettings[]): void {
    this.runInTransaction((db) => {
      db.prepare("DELETE FROM chat_runtime_settings").run();
      const insert = db.prepare(
        `
        INSERT INTO chat_runtime_settings (
          chat_id, active_agent, ai_shell_mode, eco_mode, safe_mode, openai_model, admin_mode, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const item of rows) {
        insert.run(
          item.chatId,
          item.activeAgent?.trim() || null,
          typeof item.aiShellMode === "boolean" ? (item.aiShellMode ? 1 : 0) : null,
          typeof item.ecoMode === "boolean" ? (item.ecoMode ? 1 : 0) : null,
          typeof item.safeMode === "boolean" ? (item.safeMode ? 1 : 0) : null,
          item.openAiModel?.trim() || null,
          typeof item.adminMode === "boolean" ? (item.adminMode ? 1 : 0) : null,
          item.updatedAtMs,
        );
      }
    });
  }

  listChatRuntimeSettings(chatId?: number): StoredChatRuntimeSettings[] {
    const db = this.ensureDb();
    const rows =
      typeof chatId === "number"
        ? (db
            .prepare(
              `
          SELECT chat_id, active_agent, ai_shell_mode, eco_mode, safe_mode, openai_model, admin_mode, updated_at_ms
          FROM chat_runtime_settings
          WHERE chat_id = ?
          ORDER BY updated_at_ms DESC
        `,
            )
            .all(chatId) as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `
          SELECT chat_id, active_agent, ai_shell_mode, eco_mode, safe_mode, openai_model, admin_mode, updated_at_ms
          FROM chat_runtime_settings
          ORDER BY updated_at_ms DESC
        `,
            )
            .all() as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      chatId: Number(row.chat_id ?? 0),
      activeAgent: typeof row.active_agent === "string" ? row.active_agent : undefined,
      aiShellMode: typeof row.ai_shell_mode === "number" ? row.ai_shell_mode === 1 : undefined,
      ecoMode: typeof row.eco_mode === "number" ? row.eco_mode === 1 : undefined,
      safeMode: typeof row.safe_mode === "number" ? row.safe_mode === 1 : undefined,
      openAiModel: typeof row.openai_model === "string" ? row.openai_model : undefined,
      adminMode: typeof row.admin_mode === "number" ? row.admin_mode === 1 : undefined,
      updatedAtMs: Number(row.updated_at_ms ?? 0),
    }));
  }

  upsertGlobalRuntimeSettings(settings: StoredGlobalRuntimeSettings): void {
    const db = this.ensureDb();
    db.prepare(
      `
      INSERT INTO global_runtime_settings (id, panic_mode, updated_at_ms)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        panic_mode = excluded.panic_mode,
        updated_at_ms = excluded.updated_at_ms
    `,
    ).run(settings.panicMode ? 1 : 0, settings.updatedAtMs);
  }

  getGlobalRuntimeSettings(): StoredGlobalRuntimeSettings | null {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT panic_mode, updated_at_ms FROM global_runtime_settings WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      panicMode: Number(row.panic_mode ?? 0) === 1,
      updatedAtMs: Number(row.updated_at_ms ?? 0),
    };
  }
}
