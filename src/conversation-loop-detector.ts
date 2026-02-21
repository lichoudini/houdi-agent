import { createHash } from "node:crypto";

export type ConversationLoopDetectorKind = "repeat" | "ping-pong";

export type ConversationLoopDetection =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: ConversationLoopDetectorKind;
      count: number;
      message: string;
    };

type ConversationLoopDetectorOptions = {
  historySize?: number;
  windowMs?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
};

type HistoryItem = {
  atMs: number;
  textHash: string;
};

const DEFAULT_HISTORY_SIZE = 40;
const DEFAULT_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_WARNING_THRESHOLD = 5;
const DEFAULT_CRITICAL_THRESHOLD = 8;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hashNormalizedText(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

function consecutiveEqualTail(items: HistoryItem[], hash: string): number {
  let count = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if ((items[i]?.textHash ?? "") !== hash) {
      break;
    }
    count += 1;
  }
  return count;
}

function alternatingTailCount(items: HistoryItem[]): number {
  if (items.length < 4) {
    return 0;
  }
  const a = items[items.length - 1]?.textHash ?? "";
  const b = items[items.length - 2]?.textHash ?? "";
  if (!a || !b || a === b) {
    return 0;
  }
  let expected = a;
  let count = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const hash = items[i]?.textHash ?? "";
    if (hash !== expected) {
      break;
    }
    count += 1;
    expected = expected === a ? b : a;
  }
  return count;
}

export class ConversationLoopDetector {
  private readonly historyByChat = new Map<number, HistoryItem[]>();
  private readonly historySize: number;
  private readonly windowMs: number;
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;

  constructor(options?: ConversationLoopDetectorOptions) {
    this.historySize = clampInt(options?.historySize ?? DEFAULT_HISTORY_SIZE, 10, 200);
    this.windowMs = clampInt(options?.windowMs ?? DEFAULT_WINDOW_MS, 5_000, 15 * 60_000);
    this.warningThreshold = clampInt(options?.warningThreshold ?? DEFAULT_WARNING_THRESHOLD, 3, 50);
    this.criticalThreshold = clampInt(
      Math.max(options?.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD, this.warningThreshold + 1),
      this.warningThreshold + 1,
      100,
    );
  }

  record(chatIdInput: number, textInput: string): ConversationLoopDetection {
    if (!Number.isFinite(chatIdInput)) {
      return { stuck: false };
    }
    const chatId = Math.floor(chatIdInput);
    const normalized = normalizeText(textInput);
    if (!normalized) {
      return { stuck: false };
    }
    const hash = hashNormalizedText(normalized);
    const now = Date.now();
    const existing = this.historyByChat.get(chatId) ?? [];
    const fresh = existing.filter((item) => now - item.atMs <= this.windowMs);
    fresh.push({ atMs: now, textHash: hash });
    if (fresh.length > this.historySize) {
      fresh.splice(0, fresh.length - this.historySize);
    }
    this.historyByChat.set(chatId, fresh);

    const repeatCount = consecutiveEqualTail(fresh, hash);
    if (repeatCount >= this.criticalThreshold) {
      return {
        stuck: true,
        level: "critical",
        detector: "repeat",
        count: repeatCount,
        message: "Detecté repetición de pedido. Frené la ejecución para evitar un loop.",
      };
    }
    if (repeatCount >= this.warningThreshold) {
      return {
        stuck: true,
        level: "warning",
        detector: "repeat",
        count: repeatCount,
        message: "Detecté repetición del mismo pedido. Sigo, pero vigilo posible loop.",
      };
    }

    const pingPong = alternatingTailCount(fresh);
    if (pingPong >= this.criticalThreshold) {
      return {
        stuck: true,
        level: "critical",
        detector: "ping-pong",
        count: pingPong,
        message: "Detecté ida y vuelta repetitiva entre dos mensajes. Pauso para evitar loop.",
      };
    }
    if (pingPong >= this.warningThreshold) {
      return {
        stuck: true,
        level: "warning",
        detector: "ping-pong",
        count: pingPong,
        message: "Detecté ida y vuelta repetitiva entre mensajes. Sigo con precaución.",
      };
    }

    return { stuck: false };
  }
}
