import { SqliteStateStore } from "./sqlite-state-store.js";

export type IdempotentPayload = {
  statusCode: number;
  body: Record<string, unknown>;
};

export class RequestIdempotencyService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: SqliteStateStore,
    private readonly ttlMs: number,
  ) {}

  private buildKey(chatId: number, requestId: string): string {
    return `${chatId}:${requestId}`;
  }

  normalizeRequestId(raw: unknown): string | null {
    if (typeof raw !== "string") {
      return null;
    }
    const value = raw.trim();
    if (!value) {
      return null;
    }
    if (!/^[a-zA-Z0-9_.:-]{6,180}$/.test(value)) {
      return null;
    }
    return value;
  }

  read(chatId: number, requestId: string): IdempotentPayload | null {
    const hit = this.store.getIdempotencyHit(chatId, requestId);
    if (!hit) {
      return null;
    }
    if (Date.now() - hit.createdAtMs > this.ttlMs) {
      return null;
    }
    try {
      const parsed = JSON.parse(hit.payloadJson) as IdempotentPayload;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      if (typeof parsed.statusCode !== "number" || !parsed.body || typeof parsed.body !== "object") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  save(chatId: number, requestId: string, payload: IdempotentPayload): void {
    this.store.saveIdempotencyHit({
      chatId,
      requestId,
      payloadJson: JSON.stringify(payload),
      createdAtMs: Date.now(),
    });
  }

  tryAcquire(chatId: number, requestId: string): boolean {
    const key = this.buildKey(chatId, requestId);
    if (this.inFlight.has(key)) {
      return false;
    }
    this.inFlight.add(key);
    return true;
  }

  release(chatId: number, requestId: string): void {
    this.inFlight.delete(this.buildKey(chatId, requestId));
  }

  pruneExpired(): number {
    return this.store.pruneIdempotency(Date.now() - this.ttlMs);
  }
}
