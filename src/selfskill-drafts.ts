import fs from "node:fs/promises";
import path from "node:path";

export type SelfSkillDraft = {
  chatId: number;
  userId?: number;
  lines: string[];
  createdAt: string;
  updatedAt: string;
};

type SelfSkillDraftStorage = {
  drafts: SelfSkillDraft[];
};

type SelfSkillDraftServiceOptions = {
  filePath: string;
  maxLines?: number;
  maxLineChars?: number;
  maxTotalChars?: number;
};

type StartSelfSkillDraftInput = {
  chatId: number;
  userId?: number;
  seedLine?: string;
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeLine(raw: string, maxChars: number): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function compareByUpdatedAt(a: SelfSkillDraft, b: SelfSkillDraft): number {
  return a.updatedAt.localeCompare(b.updatedAt);
}

function normalizeDraft(raw: unknown, maxLineChars: number, maxLines: number, maxTotalChars: number): SelfSkillDraft | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const chatIdRaw = obj.chatId;
  const userIdRaw = obj.userId;
  const createdAtRaw = typeof obj.createdAt === "string" ? obj.createdAt.trim() : "";
  const updatedAtRaw = typeof obj.updatedAt === "string" ? obj.updatedAt.trim() : "";
  const linesRaw = Array.isArray(obj.lines) ? obj.lines : [];

  const chatId =
    typeof chatIdRaw === "number" && Number.isFinite(chatIdRaw)
      ? Math.floor(chatIdRaw)
      : Number.parseInt(String(chatIdRaw ?? ""), 10);
  if (!Number.isFinite(chatId)) {
    return null;
  }
  const createdAt = new Date(createdAtRaw);
  const updatedAt = new Date(updatedAtRaw);
  if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(updatedAt.getTime())) {
    return null;
  }

  const lines = linesRaw
    .map((line) => normalizeLine(String(line ?? ""), maxLineChars))
    .filter(Boolean)
    .slice(0, maxLines);

  while (lines.join(" ; ").length > maxTotalChars && lines.length > 1) {
    lines.shift();
  }

  const userId =
    typeof userIdRaw === "number" && Number.isFinite(userIdRaw) && userIdRaw > 0
      ? Math.floor(userIdRaw)
      : undefined;

  return {
    chatId,
    ...(typeof userId === "number" ? { userId } : {}),
    lines,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export class SelfSkillDraftService {
  private readonly filePath: string;
  private readonly maxLines: number;
  private readonly maxLineChars: number;
  private readonly maxTotalChars: number;
  private readonly draftsByChat = new Map<number, SelfSkillDraft>();
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: SelfSkillDraftServiceOptions) {
    this.filePath = path.resolve(options.filePath);
    this.maxLines = clampInt(options.maxLines ?? 60, 5, 300);
    this.maxLineChars = clampInt(options.maxLineChars ?? 400, 40, 4000);
    this.maxTotalChars = clampInt(options.maxTotalChars ?? 4000, 200, 20_000);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      const empty: SelfSkillDraftStorage = { drafts: [] };
      await fs.writeFile(this.filePath, `${JSON.stringify(empty, null, 2)}\n`, "utf8");
      this.loaded = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { drafts: [] };
    }
    const listRaw = Array.isArray((parsed as { drafts?: unknown })?.drafts)
      ? ((parsed as { drafts: unknown[] }).drafts ?? [])
      : [];
    for (const item of listRaw) {
      const draft = normalizeDraft(item, this.maxLineChars, this.maxLines, this.maxTotalChars);
      if (!draft) {
        continue;
      }
      this.draftsByChat.set(draft.chatId, draft);
    }
    this.loaded = true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("SelfSkillDraftService no esta cargado. Llama load() primero.");
    }
  }

  private async queuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      const drafts = [...this.draftsByChat.values()].sort(compareByUpdatedAt);
      const payload: SelfSkillDraftStorage = { drafts };
      await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    });
    await this.persistQueue;
  }

  private pruneLines(lines: string[]): string[] {
    const next = lines
      .map((line) => normalizeLine(line, this.maxLineChars))
      .filter(Boolean)
      .slice(-this.maxLines);
    while (next.join(" ; ").length > this.maxTotalChars && next.length > 1) {
      next.shift();
    }
    return next;
  }

  getDraft(chatId: number): SelfSkillDraft | null {
    this.ensureLoaded();
    const draft = this.draftsByChat.get(Math.floor(chatId));
    return draft ? { ...draft, lines: [...draft.lines] } : null;
  }

  async startDraft(input: StartSelfSkillDraftInput): Promise<SelfSkillDraft> {
    this.ensureLoaded();
    const chatId = Math.floor(input.chatId);
    const now = new Date().toISOString();
    const seed = normalizeLine(input.seedLine ?? "", this.maxLineChars);
    const lines = this.pruneLines(seed ? [seed] : []);
    const previous = this.draftsByChat.get(chatId);
    const draft: SelfSkillDraft = {
      chatId,
      ...(typeof input.userId === "number" && Number.isFinite(input.userId) && input.userId > 0
        ? { userId: Math.floor(input.userId) }
        : previous?.userId
          ? { userId: previous.userId }
          : {}),
      lines,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.draftsByChat.set(chatId, draft);
    await this.queuePersist();
    return { ...draft, lines: [...draft.lines] };
  }

  async appendLine(chatIdInput: number, lineInput: string): Promise<SelfSkillDraft> {
    this.ensureLoaded();
    const chatId = Math.floor(chatIdInput);
    const current = this.draftsByChat.get(chatId);
    if (!current) {
      throw new Error("No hay borrador activo para este chat");
    }
    const line = normalizeLine(lineInput, this.maxLineChars);
    if (!line) {
      throw new Error("Linea vacia");
    }

    const nextLines = this.pruneLines([...current.lines, line]);
    const next: SelfSkillDraft = {
      ...current,
      lines: nextLines,
      updatedAt: new Date().toISOString(),
    };
    this.draftsByChat.set(chatId, next);
    await this.queuePersist();
    return { ...next, lines: [...next.lines] };
  }

  buildInstruction(chatIdInput: number): string {
    this.ensureLoaded();
    const chatId = Math.floor(chatIdInput);
    const draft = this.draftsByChat.get(chatId);
    if (!draft || draft.lines.length === 0) {
      return "";
    }
    return draft.lines.join(" ; ").trim();
  }

  async clearDraft(chatIdInput: number): Promise<boolean> {
    this.ensureLoaded();
    const chatId = Math.floor(chatIdInput);
    const deleted = this.draftsByChat.delete(chatId);
    if (deleted) {
      await this.queuePersist();
    }
    return deleted;
  }
}
