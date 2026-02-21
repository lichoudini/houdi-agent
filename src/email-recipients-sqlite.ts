import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SavedEmailRecipient = {
  chatId: number;
  name: string;
  nameKey: string;
  email: string;
  createdAt: string;
  updatedAt: string;
};

type EmailRecipientsStorage = {
  recipients: SavedEmailRecipient[];
};

type EmailRecipientsSqliteServiceOptions = {
  dbPath: string;
};

function mapRow(row: Record<string, unknown>): SavedEmailRecipient {
  return {
    chatId: Number(row.chat_id),
    name: String(row.name ?? ""),
    nameKey: String(row.name_key ?? ""),
    email: String(row.email ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export class EmailRecipientsSqliteService {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(options: EmailRecipientsSqliteServiceOptions) {
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
      CREATE TABLE IF NOT EXISTS email_recipients (
        chat_id INTEGER NOT NULL,
        name_key TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, name_key)
      );
      CREATE INDEX IF NOT EXISTS idx_email_recipients_chat_name ON email_recipients(chat_id, name);
    `);
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("EmailRecipientsSqliteService no cargado. Llama load() primero.");
    }
    return this.db;
  }

  countAll(): number {
    const db = this.ensureDb();
    const row = db.prepare("SELECT COUNT(*) AS count FROM email_recipients").get() as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  async migrateFromJson(filePath: string): Promise<number> {
    const db = this.ensureDb();
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
    const list = Array.isArray((parsed as EmailRecipientsStorage)?.recipients)
      ? ((parsed as EmailRecipientsStorage).recipients ?? [])
      : [];
    const insert = db.prepare(`
      INSERT OR IGNORE INTO email_recipients (chat_id, name_key, name, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const row of list) {
      if (!Number.isFinite(row.chatId) || row.chatId <= 0 || !row.nameKey || !row.name || !row.email) {
        continue;
      }
      const result = insert.run(row.chatId, row.nameKey, row.name, row.email, row.createdAt, row.updatedAt) as {
        changes?: number;
      };
      inserted += Number(result.changes ?? 0);
    }
    return inserted;
  }

  list(chatId: number): SavedEmailRecipient[] {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `SELECT chat_id, name_key, name, email, created_at, updated_at
         FROM email_recipients
         WHERE chat_id = ?
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all(chatId) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  getByNameKey(chatId: number, nameKey: string): SavedEmailRecipient | null {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `SELECT chat_id, name_key, name, email, created_at, updated_at
         FROM email_recipients
         WHERE chat_id = ? AND name_key = ?`,
      )
      .get(chatId, nameKey) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  listByNameKeyPrefix(chatId: number, nameKeyPrefix: string): SavedEmailRecipient[] {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `SELECT chat_id, name_key, name, email, created_at, updated_at
         FROM email_recipients
         WHERE chat_id = ? AND name_key LIKE ?
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all(chatId, `${nameKeyPrefix}%`) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  upsert(params: {
    chatId: number;
    name: string;
    nameKey: string;
    email: string;
  }): { created: boolean; row: SavedEmailRecipient } {
    const db = this.ensureDb();
    const existing = this.getByNameKey(params.chatId, params.nameKey);
    const now = new Date().toISOString();

    if (existing) {
      db.prepare(
        `UPDATE email_recipients
         SET name = ?, email = ?, updated_at = ?
         WHERE chat_id = ? AND name_key = ?`,
      ).run(params.name, params.email, now, params.chatId, params.nameKey);
      return {
        created: false,
        row: {
          ...existing,
          name: params.name,
          email: params.email,
          updatedAt: now,
        },
      };
    }

    db.prepare(
      `INSERT INTO email_recipients (chat_id, name_key, name, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(params.chatId, params.nameKey, params.name, params.email, now, now);

    return {
      created: true,
      row: {
        chatId: params.chatId,
        name: params.name,
        nameKey: params.nameKey,
        email: params.email,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  deleteByNameKey(chatId: number, nameKey: string): SavedEmailRecipient | null {
    const db = this.ensureDb();
    const existing = this.getByNameKey(chatId, nameKey);
    if (!existing) {
      return null;
    }
    db.prepare("DELETE FROM email_recipients WHERE chat_id = ? AND name_key = ?").run(chatId, nameKey);
    return existing;
  }

  updateByNameKey(params: {
    chatId: number;
    currentNameKey: string;
    nextName: string;
    nextNameKey: string;
    nextEmail: string;
  }): { previous: SavedEmailRecipient; row: SavedEmailRecipient } | null {
    const db = this.ensureDb();
    const previous = this.getByNameKey(params.chatId, params.currentNameKey);
    if (!previous) {
      return null;
    }

    const now = new Date().toISOString();
    if (params.currentNameKey !== params.nextNameKey) {
      const conflict = this.getByNameKey(params.chatId, params.nextNameKey);
      if (conflict) {
        throw new Error(`Ya existe un destinatario con nombre similar: ${conflict.name}`);
      }
    }

    db.prepare(
      `UPDATE email_recipients
       SET name_key = ?, name = ?, email = ?, updated_at = ?
       WHERE chat_id = ? AND name_key = ?`,
    ).run(params.nextNameKey, params.nextName, params.nextEmail, now, params.chatId, params.currentNameKey);

    return {
      previous,
      row: {
        ...previous,
        nameKey: params.nextNameKey,
        name: params.nextName,
        email: params.nextEmail,
        updatedAt: now,
      },
    };
  }

  clear(chatId: number): number {
    const db = this.ensureDb();
    const result = db.prepare("DELETE FROM email_recipients WHERE chat_id = ?").run(chatId) as { changes?: number };
    return Number(result.changes ?? 0);
  }
}
