import type { SavedEmailRecipient, EmailRecipientsSqliteService } from "../../email-recipients-sqlite.js";

export function normalizeRecipientName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "").trim();
}

export function normalizeRecipientEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmailAddress(raw: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(raw.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeTimestampMs(raw: string): number {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class GmailRecipientsManager {
  constructor(
    private readonly recipientsStore: EmailRecipientsSqliteService,
    private readonly normalizeIntentText: (text: string) => string,
  ) {}

  normalizeRecipientNameKey(raw: string): string {
    return this.normalizeIntentText(raw).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  }

  private sanitizeLegacyRecipientName(nameRaw: string, emailRaw: string): string {
    const name = normalizeRecipientName(nameRaw);
    const localPart = normalizeRecipientEmail(emailRaw).split("@")[0] ?? "";
    if (!name || !localPart) {
      return name;
    }
    const localEscaped = escapeRegExp(localPart);
    const cleaned = normalizeRecipientName(
      name
        .replace(new RegExp(`\\b(?:con|a|para)\\s+${localEscaped}\\s*$`, "i"), "")
        .replace(new RegExp(`\\b${localEscaped}\\s*$`, "i"), ""),
    );
    return cleaned || name;
  }

  private legacyNoiseScore(row: SavedEmailRecipient): number {
    const localPart = normalizeRecipientEmail(row.email).split("@")[0] ?? "";
    const normalizedName = this.normalizeIntentText(row.name);
    let score = 0;
    if (localPart && new RegExp(`\\b${escapeRegExp(localPart)}\\b`, "i").test(normalizedName)) {
      score += 2;
    }
    if (/\b(con|para)\b/.test(normalizedName)) {
      score += 2;
    }
    if (normalizedName.split(" ").filter(Boolean).length >= 3) {
      score += 1;
    }
    return score;
  }

  private cleanupLegacyRows(chatId: number): void {
    const rows = this.recipientsStore.list(chatId);
    if (rows.length < 2) {
      return;
    }
    for (const row of rows) {
      const sanitizedName = this.sanitizeLegacyRecipientName(row.name, row.email);
      if (!sanitizedName || sanitizedName === row.name) {
        continue;
      }
      const sanitizedKey = this.normalizeRecipientNameKey(sanitizedName);
      if (!sanitizedKey) {
        continue;
      }
      if (sanitizedKey === row.nameKey) {
        this.recipientsStore.updateByNameKey({
          chatId,
          currentNameKey: row.nameKey,
          nextName: sanitizedName,
          nextNameKey: row.nameKey,
          nextEmail: row.email,
        });
        continue;
      }

      const conflict = this.recipientsStore.getByNameKey(chatId, sanitizedKey);
      if (!conflict) {
        this.recipientsStore.updateByNameKey({
          chatId,
          currentNameKey: row.nameKey,
          nextName: sanitizedName,
          nextNameKey: sanitizedKey,
          nextEmail: row.email,
        });
        continue;
      }

      const rowScore = this.legacyNoiseScore(row);
      const conflictScore = this.legacyNoiseScore(conflict);
      const rowUpdatedAtMs = safeTimestampMs(row.updatedAt);
      const conflictUpdatedAtMs = safeTimestampMs(conflict.updatedAt);
      if (conflictScore <= rowScore && conflictUpdatedAtMs >= rowUpdatedAtMs) {
        this.recipientsStore.deleteByNameKey(chatId, row.nameKey);
      }
    }
  }

  list(chatId: number): SavedEmailRecipient[] {
    const chatIdSafe = Math.floor(chatId);
    this.cleanupLegacyRows(chatIdSafe);
    return this.recipientsStore.list(chatIdSafe);
  }

  async upsert(params: {
    chatId: number;
    name: string;
    email: string;
  }): Promise<{ created: boolean; row: SavedEmailRecipient }> {
    const chatId = Math.floor(params.chatId);
    const name = normalizeRecipientName(params.name);
    const email = normalizeRecipientEmail(params.email);
    if (!name) {
      throw new Error("Nombre de destinatario vacío.");
    }
    if (!isValidEmailAddress(email)) {
      throw new Error("Email inválido.");
    }
    const nameKey = this.normalizeRecipientNameKey(name);
    const result = this.recipientsStore.upsert({
      chatId,
      name,
      nameKey,
      email,
    });
    this.cleanupLegacyRows(chatId);
    return result;
  }

  async deleteByName(chatIdInput: number, nameInput: string): Promise<SavedEmailRecipient | null> {
    const chatId = Math.floor(chatIdInput);
    const nameKey = this.normalizeRecipientNameKey(nameInput);
    return this.recipientsStore.deleteByNameKey(chatId, nameKey);
  }

  resolveSelector(chatIdInput: number, selectorInput: string): SavedEmailRecipient | null {
    const chatId = Math.floor(chatIdInput);
    const selector = selectorInput.trim();
    if (!selector) {
      return null;
    }

    if (/^\d+$/.test(selector)) {
      const sorted = this.list(chatId);
      const position = Number.parseInt(selector, 10);
      if (!Number.isFinite(position) || position < 1 || position > sorted.length) {
        return null;
      }
      return sorted[position - 1] ?? null;
    }

    const nameKey = this.normalizeRecipientNameKey(selector);
    if (!nameKey) {
      return null;
    }
    const exact = this.recipientsStore.getByNameKey(chatId, nameKey);
    if (exact) {
      return exact;
    }
    const startsWith = this.recipientsStore.listByNameKeyPrefix(chatId, nameKey);
    if (startsWith.length === 1) {
      return startsWith[0] ?? null;
    }
    return null;
  }

  async deleteBySelector(chatIdInput: number, selectorInput: string): Promise<SavedEmailRecipient | null> {
    const chatId = Math.floor(chatIdInput);
    const resolved = this.resolveSelector(chatId, selectorInput);
    if (!resolved) {
      return null;
    }
    return this.recipientsStore.deleteByNameKey(chatId, resolved.nameKey);
  }

  async clear(chatIdInput: number): Promise<number> {
    const chatId = Math.floor(chatIdInput);
    return this.recipientsStore.clear(chatId);
  }

  async updateBySelector(params: {
    chatId: number;
    selector: string;
    nextName?: string;
    nextEmail?: string;
  }): Promise<{ previous: SavedEmailRecipient; row: SavedEmailRecipient } | null> {
    const chatId = Math.floor(params.chatId);
    const resolved = this.resolveSelector(chatId, params.selector);
    if (!resolved) {
      return null;
    }
    const previous = resolved;
    const nextName = params.nextName ? normalizeRecipientName(params.nextName) : previous.name;
    const nextEmail = params.nextEmail ? normalizeRecipientEmail(params.nextEmail) : previous.email;
    if (!nextName) {
      throw new Error("Nombre de destinatario vacío.");
    }
    if (!isValidEmailAddress(nextEmail)) {
      throw new Error("Email inválido.");
    }
    const nextNameKey = this.normalizeRecipientNameKey(nextName);
    return this.recipientsStore.updateByNameKey({
      chatId,
      currentNameKey: previous.nameKey,
      nextName,
      nextNameKey,
      nextEmail,
    });
  }
}
