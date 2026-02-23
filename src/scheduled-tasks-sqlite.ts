import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskStatus,
  UpdateScheduledTaskInput,
} from "./scheduled-task-types.js";

type ScheduledTaskStorage = {
  tasks: ScheduledTask[];
};

type ScheduledTaskSqliteServiceOptions = {
  dbPath: string;
};

function generateTaskId(): string {
  return `tsk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function toIso(input: Date): string {
  return new Date(input.getTime()).toISOString();
}

function normalizeTaskRefToken(raw: string): string {
  return raw.trim().replace(/[,:;!?]+$/g, "").toLowerCase();
}

function canonicalizeTaskRef(raw: string): string {
  const normalized = normalizeTaskRefToken(raw);
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("tsk")) {
    return normalized;
  }
  if (normalized === "tsk") {
    return normalized;
  }
  const withPrefix = normalized.replace(/^tsk_/, "tsk-");
  return withPrefix.replace(/_/g, "-");
}

function mapTaskRow(row: Record<string, unknown>): ScheduledTask {
  return {
    id: String(row.id ?? ""),
    chatId: Number(row.chat_id ?? 0),
    ...(typeof row.user_id === "number" ? { userId: row.user_id } : {}),
    title: String(row.title ?? ""),
    dueAt: String(row.due_at ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    status: String(row.status ?? "pending") as ScheduledTaskStatus,
    ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
    ...(typeof row.canceled_at === "string" ? { canceledAt: row.canceled_at } : {}),
    failureCount: Number(row.failure_count ?? 0),
    ...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
    ...(typeof row.retry_after === "string" ? { retryAfter: row.retry_after } : {}),
    ...(typeof row.delivery_kind === "string"
      ? { deliveryKind: row.delivery_kind as "reminder" | "gmail-send" | "natural-intent" }
      : {}),
    ...(typeof row.delivery_payload === "string" ? { deliveryPayload: row.delivery_payload } : {}),
  };
}

export class ScheduledTaskSqliteService {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(options: ScheduledTaskSqliteServiceOptions) {
    this.dbPath = path.resolve(options.dbPath);
  }

  async load(): Promise<void> {
    if (this.db) {
      return;
    }
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        user_id INTEGER,
        title TEXT NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        canceled_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        retry_after TEXT,
        delivery_kind TEXT,
        delivery_payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_chat_status_due ON scheduled_tasks(chat_id, status, due_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due_status ON scheduled_tasks(status, due_at);
    `);
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("ScheduledTaskSqliteService no cargado. Llama load() primero.");
    }
    return this.db;
  }

  countAll(): number {
    const db = this.ensureDb();
    const row = db.prepare("SELECT COUNT(*) AS count FROM scheduled_tasks").get() as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  async migrateFromJson(filePath: string): Promise<number> {
    if (this.countAll() > 0) {
      return 0;
    }
    const absolutePath = path.resolve(filePath);
    let raw = "";
    try {
      raw = await fs.readFile(absolutePath, "utf8");
    } catch {
      return 0;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 0;
    }
    const list = Array.isArray((parsed as ScheduledTaskStorage)?.tasks) ? ((parsed as ScheduledTaskStorage).tasks ?? []) : [];
    if (list.length === 0) {
      return 0;
    }
    const db = this.ensureDb();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO scheduled_tasks (
        id, chat_id, user_id, title, due_at, created_at, updated_at, status,
        completed_at, canceled_at, failure_count, last_error, retry_after,
        delivery_kind, delivery_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const task of list) {
      if (!task.id || !task.title || !task.dueAt || !task.createdAt || !task.updatedAt) {
        continue;
      }
      const result = insert.run(
        task.id,
        task.chatId,
        task.userId ?? null,
        task.title,
        task.dueAt,
        task.createdAt,
        task.updatedAt,
        task.status,
        task.completedAt ?? null,
        task.canceledAt ?? null,
        task.failureCount ?? 0,
        task.lastError ?? null,
        task.retryAfter ?? null,
        task.deliveryKind ?? null,
        task.deliveryPayload ?? null,
      ) as { changes?: number };
      inserted += Number(result.changes ?? 0);
    }
    return inserted;
  }

  private listBySql(sql: string, ...params: SQLInputValue[]): ScheduledTask[] {
    const db = this.ensureDb();
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapTaskRow);
  }

  listPending(chatId: number): ScheduledTask[] {
    return this.listBySql(
      `SELECT * FROM scheduled_tasks WHERE chat_id = ? AND status = 'pending' ORDER BY due_at ASC, created_at ASC`,
      chatId,
    );
  }

  listAll(chatId: number): ScheduledTask[] {
    return this.listBySql(`SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY due_at ASC, created_at ASC`, chatId);
  }

  resolveTaskByRef(chatId: number, refInput: string): ScheduledTask | null {
    const ref = normalizeTaskRefToken(refInput);
    if (!ref) {
      return null;
    }
    const pending = this.listPending(chatId);
    if (pending.length === 0) {
      return null;
    }
    if (ref === "last" || ref === "ultimo" || ref === "último" || ref === "ultima" || ref === "última") {
      return pending[pending.length - 1] ?? null;
    }
    if (/^\d+$/.test(ref)) {
      const index = Number.parseInt(ref, 10);
      if (!Number.isFinite(index) || index < 1 || index > pending.length) {
        return null;
      }
      return pending[index - 1] ?? null;
    }

    const canonicalRef = canonicalizeTaskRef(ref);
    const exact = pending.find((task) => canonicalizeTaskRef(task.id) === canonicalRef);
    if (exact) {
      return exact;
    }

    if (/\.{2,}$/.test(ref)) {
      const prefixRef = canonicalizeTaskRef(ref.replace(/\.{2,}$/, ""));
      if (!prefixRef) {
        return null;
      }
      const matches = pending.filter((task) => canonicalizeTaskRef(task.id).startsWith(prefixRef));
      if (matches.length === 1) {
        return matches[0] ?? null;
      }
      return null;
    }

    return null;
  }

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const title = normalizeTitle(input.title);
    if (!title) {
      throw new Error("Descripción vacía");
    }
    const dueAt = new Date(input.dueAt.getTime());
    if (!Number.isFinite(dueAt.getTime())) {
      throw new Error("Fecha/hora inválida");
    }
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: generateTaskId(),
      chatId: Math.floor(input.chatId),
      ...(typeof input.userId === "number" && Number.isFinite(input.userId) && input.userId > 0
        ? { userId: Math.floor(input.userId) }
        : {}),
      title,
      dueAt: dueAt.toISOString(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      failureCount: 0,
      ...(input.deliveryKind ? { deliveryKind: input.deliveryKind } : {}),
      ...(typeof input.deliveryPayload === "string" && input.deliveryPayload.trim().length > 0
        ? { deliveryPayload: input.deliveryPayload.slice(0, 30_000) }
        : {}),
    };

    const db = this.ensureDb();
    db.prepare(
      `INSERT INTO scheduled_tasks (
        id, chat_id, user_id, title, due_at, created_at, updated_at, status,
        completed_at, canceled_at, failure_count, last_error, retry_after, delivery_kind, delivery_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)`,
    ).run(
      task.id,
      task.chatId,
      task.userId ?? null,
      task.title,
      task.dueAt,
      task.createdAt,
      task.updatedAt,
      task.status,
      task.failureCount,
      task.deliveryKind ?? null,
      task.deliveryPayload ?? null,
    );
    return task;
  }

  async updateTask(taskId: string, changes: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    const id = taskId.trim();
    const current = this.getPendingById(id);
    if (!current) {
      throw new Error("Tarea no encontrada o no editable");
    }

    const nextTitle = typeof changes.title === "string" ? normalizeTitle(changes.title) : current.title;
    if (!nextTitle) {
      throw new Error("Descripción vacía");
    }
    const nextDueAt = changes.dueAt ? toIso(changes.dueAt) : current.dueAt;
    if (changes.dueAt && !Number.isFinite(new Date(nextDueAt).getTime())) {
      throw new Error("Fecha/hora inválida");
    }
    const updatedAt = new Date().toISOString();

    const db = this.ensureDb();
    db.prepare(
      `UPDATE scheduled_tasks
       SET title = ?, due_at = ?, updated_at = ?, retry_after = NULL, last_error = NULL
       WHERE id = ? AND status = 'pending'`,
    ).run(nextTitle, nextDueAt, updatedAt, id);

    return {
      ...current,
      title: nextTitle,
      dueAt: nextDueAt,
      updatedAt,
      retryAfter: undefined,
      lastError: undefined,
    };
  }

  async cancelTask(taskId: string): Promise<ScheduledTask> {
    const id = taskId.trim();
    const current = this.getPendingById(id);
    if (!current) {
      throw new Error("Tarea no encontrada o ya finalizada");
    }
    const now = new Date().toISOString();

    const db = this.ensureDb();
    db.prepare(
      `UPDATE scheduled_tasks
       SET status = 'canceled', canceled_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(now, now, id);

    return {
      ...current,
      status: "canceled",
      canceledAt: now,
      updatedAt: now,
    };
  }

  dueTasks(nowInput?: Date): ScheduledTask[] {
    const nowIso = (nowInput ?? new Date()).toISOString();
    return this.listBySql(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'pending'
         AND due_at <= ?
         AND (retry_after IS NULL OR retry_after <= ?)
       ORDER BY due_at ASC, created_at ASC`,
      nowIso,
      nowIso,
    );
  }

  async markDelivered(taskId: string, deliveredAtInput?: Date): Promise<ScheduledTask> {
    const id = taskId.trim();
    const current = this.getPendingById(id);
    if (!current) {
      throw new Error("Tarea no encontrada o no pendiente");
    }
    const deliveredAt = deliveredAtInput ?? new Date();
    const deliveredIso = deliveredAt.toISOString();

    const db = this.ensureDb();
    db.prepare(
      `UPDATE scheduled_tasks
       SET status = 'done', completed_at = ?, updated_at = ?, retry_after = NULL, last_error = NULL
       WHERE id = ? AND status = 'pending'`,
    ).run(deliveredIso, deliveredIso, id);

    return {
      ...current,
      status: "done",
      completedAt: deliveredIso,
      updatedAt: deliveredIso,
      retryAfter: undefined,
      lastError: undefined,
    };
  }

  async markDeliveryFailure(taskId: string, errorMessage: string, nowInput?: Date): Promise<ScheduledTask> {
    const id = taskId.trim();
    const current = this.getPendingById(id);
    if (!current) {
      throw new Error("Tarea no encontrada o no pendiente");
    }

    const now = nowInput ?? new Date();
    const nextFailureCount = clampInt(current.failureCount + 1, 1, 10_000);
    const retryMinutes = Math.min(30, Math.max(1, 2 ** Math.min(5, nextFailureCount)));
    const retryAfter = new Date(now.getTime() + retryMinutes * 60 * 1000).toISOString();
    const updatedAt = now.toISOString();

    const db = this.ensureDb();
    db.prepare(
      `UPDATE scheduled_tasks
       SET failure_count = ?, last_error = ?, retry_after = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(nextFailureCount, errorMessage.slice(0, 1000), retryAfter, updatedAt, id);

    return {
      ...current,
      failureCount: nextFailureCount,
      lastError: errorMessage.slice(0, 1000),
      retryAfter,
      updatedAt,
    };
  }

  private getPendingById(id: string): ScheduledTask | null {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND status = 'pending'")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapTaskRow(row) : null;
  }
}
