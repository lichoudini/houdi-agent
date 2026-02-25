export type IntentActionOutcomeRecord = {
  route: string;
  source: string;
  success: boolean;
  error?: string;
  atMs: number;
};

export function createIntentActionOutcomeStore(params: {
  truncateInline: (text: string, maxChars: number) => string;
}) {
  const byChat = new Map<number, IntentActionOutcomeRecord>();

  const set = (entry: {
    chatId: number;
    route: string;
    source: string;
    success: boolean;
    error?: string;
  }): void => {
    byChat.set(entry.chatId, {
      route: entry.route,
      source: entry.source,
      success: entry.success,
      ...(entry.error ? { error: params.truncateInline(entry.error, 500) } : {}),
      atMs: Date.now(),
    });
  };

  const consume = (entry: {
    chatId: number;
    route: string;
    delegatedSource: string;
  }): IntentActionOutcomeRecord | null => {
    const outcome = byChat.get(entry.chatId);
    if (!outcome) {
      return null;
    }
    if (outcome.route !== entry.route) {
      return null;
    }
    if (
      outcome.source !== entry.delegatedSource &&
      !outcome.source.startsWith(`${entry.delegatedSource}:`) &&
      !entry.delegatedSource.startsWith(`${outcome.source}:`)
    ) {
      return null;
    }
    byChat.delete(entry.chatId);
    return outcome;
  };

  return {
    set,
    consume,
  };
}
