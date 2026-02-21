import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

export type DoctorCheckLevel = "ok" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  level: DoctorCheckLevel;
  message: string;
  hint?: string;
};

export type DoctorReport = {
  checks: DoctorCheck[];
  ok: number;
  warn: number;
  fail: number;
};

export type GmailDoctorStatus = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  accountEmail?: string;
};

export type DoctorRuntimeInput = {
  openAiConfigured: boolean;
  gmail: GmailDoctorStatus;
  botToken: string;
};

function parseNodeVersionMajor(version: string): number {
  const normalized = version.replace(/^v/i, "");
  const majorRaw = normalized.split(".")[0] ?? "0";
  const parsed = Number.parseInt(majorRaw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function isPathWritable(filePath: string): Promise<boolean> {
  try {
    const parentDir = path.dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.access(parentDir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function canWriteWorkspaceDir(dirPath: string): Promise<boolean> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.access(dirPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function tokenLooksValid(token: string): boolean {
  return /^\d{7,12}:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

function hostLooksLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function buildCheck(level: DoctorCheckLevel, id: string, message: string, hint?: string): DoctorCheck {
  return { level, id, message, ...(hint ? { hint } : {}) };
}

export async function runDoctor(input: DoctorRuntimeInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const nodeMajor = parseNodeVersionMajor(process.version);
  if (nodeMajor >= 22) {
    checks.push(buildCheck("ok", "runtime.node", `Node.js ${process.version} (compatible)`));
  } else {
    checks.push(
      buildCheck(
        "fail",
        "runtime.node",
        `Node.js ${process.version} no compatible (se recomienda >= 22)`,
        "Actualiza Node.js y reinicia el agente.",
      ),
    );
  }

  if (tokenLooksValid(input.botToken)) {
    checks.push(buildCheck("ok", "telegram.token", "TELEGRAM_BOT_TOKEN con formato válido"));
  } else {
    checks.push(
      buildCheck(
        "fail",
        "telegram.token",
        "TELEGRAM_BOT_TOKEN parece inválido",
        "Regenera el token en BotFather y actualiza .env.",
      ),
    );
  }

  if (input.openAiConfigured) {
    checks.push(buildCheck("ok", "openai.key", "OPENAI_API_KEY configurada"));
  } else {
    checks.push(
      buildCheck(
        "warn",
        "openai.key",
        "OPENAI_API_KEY no configurada",
        "Funciones IA (/ask, visión, transcripción) quedarán deshabilitadas.",
      ),
    );
  }

  const workspaceWritable = await canWriteWorkspaceDir(config.workspaceDir);
  if (workspaceWritable) {
    checks.push(buildCheck("ok", "workspace.dir", `Workspace accesible: ${config.workspaceDir}`));
  } else {
    checks.push(
      buildCheck(
        "fail",
        "workspace.dir",
        `Sin permisos de escritura en workspace: ${config.workspaceDir}`,
        "Corrige permisos/owner del directorio.",
      ),
    );
  }

  const dbWritable = await isPathWritable(config.stateDbFile);
  if (dbWritable) {
    checks.push(buildCheck("ok", "state.db", `State DB escribible: ${config.stateDbFile}`));
  } else {
    checks.push(
      buildCheck(
        "fail",
        "state.db",
        `State DB no escribible: ${config.stateDbFile}`,
        "Verifica permisos del directorio state.",
      ),
    );
  }

  const auditWritable = await isPathWritable(config.auditLogPath);
  if (auditWritable) {
    checks.push(buildCheck("ok", "audit.log", `Audit log escribible: ${config.auditLogPath}`));
  } else {
    checks.push(
      buildCheck(
        "warn",
        "audit.log",
        `No se puede escribir audit log: ${config.auditLogPath}`,
        "Revisa permisos para no perder trazabilidad.",
      ),
    );
  }

  if (!input.gmail.enabled) {
    checks.push(buildCheck("ok", "gmail.mode", "Gmail deshabilitado por config"));
  } else if (input.gmail.configured) {
    checks.push(
      buildCheck(
        "ok",
        "gmail.config",
        `Gmail habilitado y configurado (${input.gmail.accountEmail || "cuenta no indicada"})`,
      ),
    );
  } else {
    checks.push(
      buildCheck(
        "warn",
        "gmail.config",
        `Gmail habilitado con config incompleta: ${input.gmail.missing.join(", ")}`,
        "Completa credenciales OAuth en .env.",
      ),
    );
  }

  if (hostLooksLoopback(config.localApiHost)) {
    checks.push(buildCheck("ok", "bridge.bind", `Bridge local bind seguro (${config.localApiHost})`));
  } else {
    checks.push(
      buildCheck(
        "warn",
        "bridge.bind",
        `Bridge local expuesto en host no-loopback (${config.localApiHost})`,
        "Usa 127.0.0.1 salvo necesidad explícita de red.",
      ),
    );
  }

  const freeMemMb = Math.round((os.freemem() / (1024 * 1024)) * 10) / 10;
  if (freeMemMb < 100) {
    checks.push(
      buildCheck(
        "warn",
        "runtime.memory",
        `Memoria libre baja (${freeMemMb} MB)`,
        "Podrías tener latencia o reinicios por presión de memoria.",
      ),
    );
  } else {
    checks.push(buildCheck("ok", "runtime.memory", `Memoria libre aceptable (${freeMemMb} MB)`));
  }

  const fail = checks.filter((item) => item.level === "fail").length;
  const warn = checks.filter((item) => item.level === "warn").length;
  const ok = checks.filter((item) => item.level === "ok").length;
  return { checks, ok, warn, fail };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Doctor: ok=${report.ok} warn=${report.warn} fail=${report.fail}`,
    "",
  ];
  for (const check of report.checks) {
    const marker = check.level === "ok" ? "[OK]" : check.level === "warn" ? "[WARN]" : "[FAIL]";
    lines.push(`${marker} ${check.id}: ${check.message}`);
    if (check.hint) {
      lines.push(`  hint: ${check.hint}`);
    }
  }
  return lines.join("\n");
}
