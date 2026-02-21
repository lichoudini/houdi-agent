type RunTraceStatus = "ok" | "error" | "blocked";

function randomRunId(): string {
  const now = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString(36)
    .padStart(4, "0");
  return `run_${now}_${rand}`;
}

export type RunTrace = {
  id: string;
  chatId: number;
  userId?: number;
  action: string;
  source: string;
  startedAtMs: number;
};

export function startRunTrace(params: {
  chatId: number;
  userId?: number;
  action: string;
  source: string;
}): RunTrace {
  return {
    id: randomRunId(),
    chatId: params.chatId,
    userId: params.userId,
    action: params.action,
    source: params.source,
    startedAtMs: Date.now(),
  };
}

export function finishRunTrace(params: {
  trace: RunTrace;
  status: RunTraceStatus;
  error?: string;
}): {
  runId: string;
  action: string;
  source: string;
  status: RunTraceStatus;
  durationMs: number;
  error?: string;
} {
  const durationMs = Math.max(0, Date.now() - params.trace.startedAtMs);
  return {
    runId: params.trace.id,
    action: params.trace.action,
    source: params.trace.source,
    status: params.status,
    durationMs,
    ...(params.error ? { error: params.error } : {}),
  };
}
