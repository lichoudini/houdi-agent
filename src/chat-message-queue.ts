type ChatTaskExecutor<T> = () => Promise<T>;

export type ChatMessageQueueEnqueueResult<T> = {
  waitMs: number;
  result: T;
};

export class ChatMessageQueue {
  private readonly tails = new Map<number, Promise<void>>();
  private readonly depths = new Map<number, number>();

  private normalizeChatId(chatIdInput: number): number {
    if (!Number.isFinite(chatIdInput)) {
      throw new Error("chatId inválido para cola");
    }
    return Math.floor(chatIdInput);
  }

  getDepth(chatIdInput: number): number {
    const chatId = this.normalizeChatId(chatIdInput);
    return this.depths.get(chatId) ?? 0;
  }

  snapshot(maxChats = 20): Array<{ chatId: number; depth: number }> {
    const capped = Math.max(1, Math.min(500, Math.floor(maxChats)));
    return [...this.depths.entries()]
      .map(([chatId, depth]) => ({ chatId, depth }))
      .filter((item) => item.depth > 0)
      .sort((a, b) => b.depth - a.depth || a.chatId - b.chatId)
      .slice(0, capped);
  }

  async enqueue<T>(chatIdInput: number, executor: ChatTaskExecutor<T>): Promise<ChatMessageQueueEnqueueResult<T>> {
    const chatId = this.normalizeChatId(chatIdInput);
    const enqueuedAt = Date.now();
    const previousTail = this.tails.get(chatId) ?? Promise.resolve();
    const nextDepth = (this.depths.get(chatId) ?? 0) + 1;
    this.depths.set(chatId, nextDepth);

    let resolveOuter: ((value: ChatMessageQueueEnqueueResult<T>) => void) | null = null;
    let rejectOuter: ((reason?: unknown) => void) | null = null;
    const outer = new Promise<ChatMessageQueueEnqueueResult<T>>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });

    const current = previousTail
      .catch(() => undefined)
      .then(async () => {
        const waitMs = Math.max(0, Date.now() - enqueuedAt);
        const result = await executor();
        resolveOuter?.({ waitMs, result });
      })
      .catch((error) => {
        rejectOuter?.(error);
      })
      .finally(() => {
        const remaining = (this.depths.get(chatId) ?? 1) - 1;
        if (remaining > 0) {
          this.depths.set(chatId, remaining);
        } else {
          this.depths.delete(chatId);
          this.tails.delete(chatId);
        }
      });

    this.tails.set(
      chatId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );

    return outer;
  }
}
