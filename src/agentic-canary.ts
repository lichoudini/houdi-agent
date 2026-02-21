function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export class AgenticCanary {
  private rolloutPercent: number;

  constructor(initialRolloutPercent: number) {
    this.rolloutPercent = this.normalizePercent(initialRolloutPercent);
  }

  private normalizePercent(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.floor(value)));
  }

  getRolloutPercent(): number {
    return this.rolloutPercent;
  }

  setRolloutPercent(value: number): number {
    this.rolloutPercent = this.normalizePercent(value);
    return this.rolloutPercent;
  }

  isEnabledForChat(chatId: number, feature: string): boolean {
    if (this.rolloutPercent <= 0) {
      return false;
    }
    if (this.rolloutPercent >= 100) {
      return true;
    }
    const bucket = stableHash(`${feature}:${chatId}`) % 100;
    return bucket < this.rolloutPercent;
  }
}
