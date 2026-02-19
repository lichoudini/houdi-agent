function nowIso(): string {
  return new Date().toISOString();
}

export function logInfo(message: string): void {
  console.log(`[${nowIso()}] INFO ${message}`);
}

export function logWarn(message: string): void {
  console.warn(`[${nowIso()}] WARN ${message}`);
}

export function logError(message: string): void {
  console.error(`[${nowIso()}] ERROR ${message}`);
}
