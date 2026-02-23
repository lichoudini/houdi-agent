export type BridgeSessionPayload = {
  source?: string;
  sessionKey?: string;
  channel?: string;
  threadTs?: string;
  chatId?: number;
};

function fnv1aHash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}

export function normalizeSessionKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  if (!/^[a-z0-9][a-z0-9:._/-]{2,220}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function chatIdFromSessionKey(sessionKey: string): number {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    throw new Error("sessionKey inválido");
  }
  return (fnv1aHash32(normalized) % 2_000_000_000) + 1;
}

export function buildSlackSessionKey(channelInput?: string, threadTsInput?: string): string | null {
  const channel = normalizeSegment(channelInput || "");
  if (!channel) {
    return null;
  }
  const threadRaw = (threadTsInput || "").trim();
  const thread = threadRaw ? normalizeSegment(threadRaw) : "main";
  const candidate = `slack:${channel}:thread:${thread}`;
  return normalizeSessionKey(candidate);
}

export function deriveSessionKeyFromBridgePayload(payload: BridgeSessionPayload): string | null {
  const explicit = normalizeSessionKey(payload.sessionKey);
  if (explicit) {
    return explicit;
  }

  const source = (payload.source || "").trim().toLowerCase();
  if (source.startsWith("slack")) {
    return buildSlackSessionKey(payload.channel, payload.threadTs);
  }
  if (source.startsWith("telegram")) {
    const chatId = Number.isFinite(payload.chatId) ? Math.floor(payload.chatId ?? 0) : 0;
    if (chatId > 0) {
      return normalizeSessionKey(`telegram:chat:${chatId}`);
    }
  }
  if (source.startsWith("cli")) {
    const chatId = Number.isFinite(payload.chatId) ? Math.floor(payload.chatId ?? 0) : 0;
    if (chatId > 0) {
      return normalizeSessionKey(`cli:chat:${chatId}`);
    }
  }
  return null;
}
