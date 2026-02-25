export type PendingIntentClarificationState = {
  chatId: number;
  userId?: number;
  requestedAtMs: number;
  expiresAtMs: number;
  source: string;
  originalText: string;
  question: string;
  routeHints: string[];
  preferredRoute?: string;
  preferredAction?: string;
  missing?: string[];
};

export function createPendingIntentClarificationStore(params: {
  ttlMs: number;
  sanitizeOriginalText: (raw: string) => string;
  truncateInline: (text: string, maxChars: number) => string;
}) {
  const byChat = new Map<number, PendingIntentClarificationState>();

  const purgeExpired = (): void => {
    const now = Date.now();
    for (const [chatId, item] of byChat.entries()) {
      if (item.expiresAtMs <= now) {
        byChat.delete(chatId);
      }
    }
  };

  const register = (entry: {
    chatId: number;
    userId?: number;
    source: string;
    originalText: string;
    question: string;
    routeHints?: string[];
    preferredRoute?: string;
    preferredAction?: string;
    missing?: string[];
  }): void => {
    purgeExpired();
    const now = Date.now();
    byChat.set(entry.chatId, {
      chatId: entry.chatId,
      userId: entry.userId,
      requestedAtMs: now,
      expiresAtMs: now + params.ttlMs,
      source: entry.source,
      originalText: params.sanitizeOriginalText(entry.originalText),
      question: params.truncateInline(entry.question, 1000),
      routeHints: (entry.routeHints ?? []).slice(0, 6),
      ...(entry.preferredRoute ? { preferredRoute: entry.preferredRoute } : {}),
      ...(entry.preferredAction ? { preferredAction: entry.preferredAction } : {}),
      ...(entry.missing && entry.missing.length > 0 ? { missing: entry.missing.slice(0, 12) } : {}),
    });
  };

  const peek = (chatId: number, userId?: number): PendingIntentClarificationState | null => {
    purgeExpired();
    const item = byChat.get(chatId);
    if (!item) {
      return null;
    }
    if (typeof userId === "number" && typeof item.userId === "number" && item.userId !== userId) {
      return null;
    }
    return item;
  };

  const consume = (chatId: number, userId?: number): PendingIntentClarificationState | null => {
    const item = peek(chatId, userId);
    if (!item) {
      return null;
    }
    byChat.delete(chatId);
    return item;
  };

  const clear = (chatId: number, userId?: number): void => {
    const item = peek(chatId, userId);
    if (!item) {
      return;
    }
    byChat.delete(chatId);
  };

  return {
    purgeExpired,
    register,
    peek,
    consume,
    clear,
  };
}
