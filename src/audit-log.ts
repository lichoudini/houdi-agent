import fs from "node:fs/promises";
import path from "node:path";

export type AuditEvent = {
  type: string;
  chatId?: number;
  userId?: number;
  details?: Record<string, unknown>;
};

export class AuditLogger {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(process.cwd(), filePath);
  }

  async log(event: AuditEvent): Promise<void> {
    const payload = {
      ts: new Date().toISOString(),
      ...event,
    };
    await fs.appendFile(this.filePath, `${JSON.stringify(payload)}\n`, "utf8");
  }
}

