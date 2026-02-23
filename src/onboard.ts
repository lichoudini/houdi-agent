#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";

type PromptOptions = {
  defaultValue?: string;
  required?: boolean;
  validate?: (value: string) => string | null;
  displayDefault?: boolean;
};

type OnboardRuntimeOptions = {
  nonInteractive: boolean;
  skipPreflight: boolean;
  assumeRiskAccepted: boolean;
  allowPreflightFailures: boolean;
  autoInstallDeps?: boolean;
  autoBuild?: boolean;
  serviceMode?: "none" | "user" | "system";
  forceSystemInstall: boolean;
};

type PreflightLevel = "ok" | "warn" | "fail";

type PreflightCheck = {
  id: string;
  level: PreflightLevel;
  message: string;
  hint?: string;
};

const PROJECT_DIR = process.cwd();
const ENV_PATH = path.join(PROJECT_DIR, ".env");
const ENV_EXAMPLE_PATH = path.join(PROJECT_DIR, ".env.example");
const ANSI_LIGHT_BLUE = "\x1b[94m";
const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_BOLD = "\x1b[1m";
const HOUDI_GRADIENT = [
  "\x1b[38;5;17m",
  "\x1b[38;5;18m",
  "\x1b[38;5;19m",
  "\x1b[38;5;20m",
  "\x1b[38;5;25m",
  "\x1b[38;5;27m",
  "\x1b[38;5;33m",
  "\x1b[38;5;39m",
];
const HOUDI_QUOTE =
  "Las corrientes frente a nosotros cambian constantemente. Debemos adaptarnos, avanzar, para llegar al destino.";

function buildHoudiAsciiLines(): string[] {
  // 8-line ASCII banner (height fixed at 8), thicker body.
  const h = [
    "HHHH      HHHH",
    "HHHH      HHHH",
    "HHHH      HHHH",
    "HHHHHHHHHHHHHH",
    "HHHHHHHHHHHHHH",
    "HHHH      HHHH",
    "HHHH      HHHH",
    "HHHH      HHHH",
  ];
  const o = [
    "  OOOOOOOOOO  ",
    " OOOO    OOOO ",
    "OOOO      OOOO",
    "OOOO      OOOO",
    "OOOO      OOOO",
    "OOOO      OOOO",
    " OOOO    OOOO ",
    "  OOOOOOOOOO  ",
  ];
  const u = [
    "UUUU      UUUU",
    "UUUU      UUUU",
    "UUUU      UUUU",
    "UUUU      UUUU",
    "UUUU      UUUU",
    "UUUU      UUUU",
    " UUUU    UUUU ",
    "  UUUUUUUUUU  ",
  ];
  const d = [
    "DDDDDDDDDDDD  ",
    "DDDDDDDDDDDDD ",
    "DDDD      DDDD",
    "DDDD       DDD",
    "DDDD       DDD",
    "DDDD      DDDD",
    "DDDDDDDDDDDDD ",
    "DDDDDDDDDDDD  ",
  ];
  const iLetter = [
    "IIIIIIIIIIII",
    "    IIII    ",
    "    IIII    ",
    "    IIII    ",
    "    IIII    ",
    "    IIII    ",
    "    IIII    ",
    "IIIIIIIIIIII",
  ];
  const lines: string[] = [];
  for (let idx = 0; idx < 8; idx += 1) {
    lines.push(`${h[idx]}  ${o[idx]}  ${u[idx]}  ${d[idx]}  ${iLetter[idx]}`);
  }
  return lines;
}

function printHoudiWelcomeBanner(): void {
  const lines = buildHoudiAsciiLines();
  const output = lines.map((line, index) => `${HOUDI_GRADIENT[index] ?? ANSI_LIGHT_BLUE}${line}${ANSI_RESET}`).join("\n");
  process.stdout.write(`${output}\n`);
  process.stdout.write(`${ANSI_LIGHT_BLUE}${HOUDI_QUOTE}${ANSI_RESET}\n\n`);
}

function printHeading(title: string): void {
  process.stdout.write(`${ANSI_BOLD}${title}${ANSI_RESET}\n`);
}

function colorizeLevel(level: PreflightLevel, text: string): string {
  if (level === "ok") {
    return `${ANSI_GREEN}${text}${ANSI_RESET}`;
  }
  if (level === "warn") {
    return `${ANSI_YELLOW}${text}${ANSI_RESET}`;
  }
  return `${ANSI_RED}${text}${ANSI_RESET}`;
}

function parseNodeVersionMajor(version: string): number {
  const normalized = version.replace(/^v/i, "");
  const majorRaw = normalized.split(".")[0] ?? "0";
  const parsed = Number.parseInt(majorRaw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function isExecutableAvailable(binary: string): Promise<boolean> {
  const candidatePaths = binary.includes(path.sep)
    ? [binary]
    : (process.env.PATH || "")
        .split(path.delimiter)
        .map((entry) => path.join(entry, binary))
        .filter(Boolean);
  for (const candidatePath of candidatePaths) {
    try {
      await fs.access(candidatePath, fsConstants.X_OK);
      return true;
    } catch {
      // noop
    }
  }
  return false;
}

function buildPreflightCheck(level: PreflightLevel, id: string, message: string, hint?: string): PreflightCheck {
  return { id, level, message, ...(hint ? { hint } : {}) };
}

async function runPreflightChecks(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const nodeMajor = parseNodeVersionMajor(process.version);
  if (nodeMajor >= 22) {
    checks.push(buildPreflightCheck("ok", "runtime.node", `Node.js ${process.version} compatible (>=22)`));
  } else {
    checks.push(
      buildPreflightCheck(
        "fail",
        "runtime.node",
        `Node.js ${process.version} no compatible`,
        "Instala Node.js 22+ antes de continuar.",
      ),
    );
  }

  if (await isExecutableAvailable("npm")) {
    checks.push(buildPreflightCheck("ok", "runtime.npm", "npm disponible en PATH"));
  } else {
    checks.push(
      buildPreflightCheck(
        "fail",
        "runtime.npm",
        "npm no está disponible en PATH",
        "Instala Node.js con npm incluido y reintenta.",
      ),
    );
  }

  if (await isExecutableAvailable("systemctl")) {
    checks.push(buildPreflightCheck("ok", "runtime.systemd", "systemctl detectado (servicios disponibles)"));
  } else {
    checks.push(
      buildPreflightCheck(
        "warn",
        "runtime.systemd",
        "systemctl no detectado",
        "Podrás correr Houdi manualmente, pero no instalar servicios persistentes systemd.",
      ),
    );
  }

  if (await isExecutableAvailable("sudo")) {
    checks.push(buildPreflightCheck("ok", "runtime.sudo", "sudo detectado"));
  } else {
    checks.push(
      buildPreflightCheck(
        "warn",
        "runtime.sudo",
        "sudo no detectado",
        "No podrás instalar servicio de sistema (system scope).",
      ),
    );
  }

  try {
    await fs.access(path.join(PROJECT_DIR, "package.json"), fsConstants.R_OK);
    checks.push(buildPreflightCheck("ok", "project.root", "Se detectó package.json del proyecto"));
  } catch {
    checks.push(
      buildPreflightCheck(
        "fail",
        "project.root",
        `No se encontró package.json en ${PROJECT_DIR}`,
        "Ejecuta el wizard desde la raíz del repo houdi-agent.",
      ),
    );
  }

  try {
    await fs.access(ENV_EXAMPLE_PATH, fsConstants.R_OK);
    checks.push(buildPreflightCheck("ok", "project.env-example", ".env.example disponible"));
  } catch {
    checks.push(
      buildPreflightCheck(
        "fail",
        "project.env-example",
        `No se puede leer ${ENV_EXAMPLE_PATH}`,
        "Recupera .env.example desde git antes de continuar.",
      ),
    );
  }

  return checks;
}

function printPreflightReport(checks: PreflightCheck[]): { ok: number; warn: number; fail: number } {
  const ok = checks.filter((entry) => entry.level === "ok").length;
  const warn = checks.filter((entry) => entry.level === "warn").length;
  const fail = checks.filter((entry) => entry.level === "fail").length;
  printHeading("Preflight del instalador");
  process.stdout.write(`Resumen: ok=${ok} warn=${warn} fail=${fail}\n\n`);
  for (const entry of checks) {
    const marker = entry.level === "ok" ? "[OK]" : entry.level === "warn" ? "[WARN]" : "[FAIL]";
    process.stdout.write(`${colorizeLevel(entry.level, marker)} ${entry.id}: ${entry.message}\n`);
    if (entry.hint) {
      process.stdout.write(`  hint: ${entry.hint}\n`);
    }
  }
  process.stdout.write("\n");
  return { ok, warn, fail };
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(vacío)";
  }
  if (trimmed.length <= 8) {
    return `${trimmed[0] ?? "*"}***`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function parseEnvContent(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function formatEnvValue(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@,+=-]+$/.test(value)) {
    return value;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} terminó con código ${code ?? "null"}`));
    });
  });
}

async function promptLine(
  rl: readline.Interface,
  question: string,
  options?: PromptOptions,
): Promise<string> {
  const defaultValue = options?.defaultValue ?? "";
  while (true) {
    const hasDefault = defaultValue.length > 0;
    const suffix =
      options?.displayDefault === false ? (hasDefault ? " [configurado]" : "") : hasDefault ? ` [${defaultValue}]` : "";
    const raw = (await rl.question(`${question}${suffix}: `)).trim();
    const value = raw || defaultValue;
    if (options?.required && !value) {
      process.stdout.write("Valor requerido.\n");
      continue;
    }
    if (options?.validate) {
      const error = options.validate(value);
      if (error) {
        process.stdout.write(`${error}\n`);
        continue;
      }
    }
    return value;
  }
}

async function promptYesNo(
  rl: readline.Interface,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const raw = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
    if (!raw) {
      return defaultValue;
    }
    if (["y", "yes", "si", "sí", "s"].includes(raw)) {
      return true;
    }
    if (["n", "no"].includes(raw)) {
      return false;
    }
    process.stdout.write("Respuesta inválida. Usa y/n.\n");
  }
}

async function promptChoice(
  rl: readline.Interface,
  question: string,
  choices: string[],
  defaultValue: string,
): Promise<string> {
  const normalizedChoices = new Set(choices.map((entry) => entry.toLowerCase()));
  while (true) {
    const raw = (await rl.question(`${question} [${choices.join("/")}] (${defaultValue}): `))
      .trim()
      .toLowerCase();
    const value = raw || defaultValue.toLowerCase();
    if (normalizedChoices.has(value)) {
      return value;
    }
    process.stdout.write(`Opción inválida. Usa: ${choices.join(", ")}.\n`);
  }
}

function readFlagValue(argv: string[], name: string): string | undefined {
  const exact = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index] ?? "";
    if (!current) {
      continue;
    }
    if (current === exact) {
      const next = argv[index + 1] ?? "";
      if (!next || next.startsWith("--")) {
        return undefined;
      }
      return next;
    }
    if (current.startsWith(`${exact}=`)) {
      return current.slice(exact.length + 1);
    }
  }
  return undefined;
}

function readBooleanFlag(argv: string[], positiveName: string, negativeName: string): boolean | undefined {
  if (argv.includes(`--${positiveName}`)) {
    return true;
  }
  if (argv.includes(`--${negativeName}`)) {
    return false;
  }
  return undefined;
}

function parseOnboardRuntimeOptions(argv: string[]): OnboardRuntimeOptions {
  const nonInteractive = argv.includes("--yes") || argv.includes("--non-interactive");
  const skipPreflight = argv.includes("--skip-preflight");
  const assumeRiskAccepted = argv.includes("--accept-risk");
  const allowPreflightFailures = argv.includes("--allow-preflight-failures");
  const autoInstallDeps = readBooleanFlag(argv, "install-deps", "skip-install-deps");
  const autoBuild = readBooleanFlag(argv, "build", "skip-build");
  const forceSystemInstall = argv.includes("--force-system-install");

  const serviceModeRaw = readFlagValue(argv, "service-mode");
  let serviceMode: "none" | "user" | "system" | undefined;
  if (serviceModeRaw) {
    const normalized = serviceModeRaw.trim().toLowerCase();
    if (normalized === "none" || normalized === "user" || normalized === "system") {
      serviceMode = normalized;
    } else {
      throw new Error("Valor inválido para --service-mode. Usa none|user|system.");
    }
  }

  return {
    nonInteractive,
    skipPreflight,
    assumeRiskAccepted,
    allowPreflightFailures,
    ...(autoInstallDeps === undefined ? {} : { autoInstallDeps }),
    ...(autoBuild === undefined ? {} : { autoBuild }),
    ...(serviceMode ? { serviceMode } : {}),
    forceSystemInstall,
  };
}

function applyEnvironmentOverrides(envMap: Map<string, string>, allowedKeys: string[]): void {
  for (const key of allowedKeys) {
    const raw = process.env[key];
    if (typeof raw === "string") {
      envMap.set(key, raw);
    }
  }
}

function ensureNumericCsv(raw: string): string | null {
  if (!raw.trim()) {
    return "Debe contener al menos un user id.";
  }
  const chunks = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chunks.length === 0) {
    return "Debe contener al menos un user id.";
  }
  for (const chunk of chunks) {
    if (!/^\d+$/.test(chunk)) {
      return `ID inválido: ${chunk}`;
    }
  }
  return null;
}

function normalizeBoolean(value: boolean): string {
  return value ? "true" : "false";
}

function normalizeDirValue(raw: string, fallback: string): string {
  const value = raw.trim();
  if (!value) {
    return fallback;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return value.startsWith("./") || value.startsWith("../") ? value : `./${value}`;
}

function isValidIPv4(host: string): boolean {
  const chunks = host.split(".");
  if (chunks.length !== 4) {
    return false;
  }
  for (const chunk of chunks) {
    if (!/^\d{1,3}$/.test(chunk)) {
      return false;
    }
    const value = Number.parseInt(chunk, 10);
    if (value < 0 || value > 255) {
      return false;
    }
  }
  return true;
}

function isValidHostname(host: string): boolean {
  if (host.length > 253 || host.startsWith("-") || host.endsWith("-")) {
    return false;
  }
  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) {
    return false;
  }
  return labels.every((label) => /^[A-Za-z0-9-]+$/.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}

function normalizeLocalApiHostCandidate(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) {
    return "127.0.0.1";
  }
  if (validateLocalApiHost(value) !== null) {
    return "127.0.0.1";
  }
  return value;
}

function validateLocalApiHost(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return "Host requerido.";
  }
  if (/\s/.test(value)) {
    return "Host inválido: no puede contener espacios.";
  }

  const lowered = value.toLowerCase();
  if (["y", "yes", "s", "si", "sí", "n", "no", "true", "false"].includes(lowered)) {
    return "Host inválido: parece una respuesta y/n. Usa 127.0.0.1, localhost, ::1 o un host válido.";
  }

  if (lowered === "localhost" || value === "::1" || isValidIPv4(value) || isValidHostname(value)) {
    return null;
  }

  return "Host inválido. Usa 127.0.0.1, localhost, ::1 o un host/IP válido.";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runtimeOptions = parseOnboardRuntimeOptions(argv);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(
      [
        "Houdi Onboarding Wizard",
        "",
        "Uso:",
        "  npm run onboard",
        "  npm run setup",
        "  ./scripts/houdi-onboard.sh",
        "  npm run onboard -- --accept-risk",
        "  npm run onboard -- --skip-preflight",
        "  npm run onboard -- --yes --accept-risk --service-mode user --install-deps --build",
        "",
        "Qué hace:",
        "- Configura .env paso a paso (Telegram, OpenAI, Gmail, workspace, bridge local y WhatsApp bridge).",
        "- Configura integración externa opcional (LIM).",
        "- Opcionalmente ejecuta npm install, npm run build e instala servicio systemd.",
        "",
        "Flags:",
        "- --accept-risk: omite confirmación inicial de riesgo.",
        "- --skip-preflight: omite chequeos previos del instalador.",
        "- --yes|--non-interactive: no pregunta (usa .env/.env.example/env del proceso).",
        "- --allow-preflight-failures: continúa incluso con FAIL en preflight (solo con --yes).",
        "- --install-deps|--skip-install-deps: fuerza instalación u omisión de npm install.",
        "- --build|--skip-build: fuerza ejecución u omisión de npm run build.",
        "- --service-mode <none|user|system>: modo de instalación de servicio.",
        "- --force-system-install: evita confirmación extra al instalar servicio system.",
        "",
        "Modo no interactivo (variables mínimas recomendadas):",
        "- TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS",
        "- OPENAI_API_KEY (opcional), OPENAI_MODEL (opcional)",
        "- ENABLE_GMAIL_ACCOUNT + credenciales Gmail (si aplica)",
      ].join("\n"),
    );
    process.stdout.write("\n");
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

  printHoudiWelcomeBanner();
  printHeading("Houdi Onboarding Wizard");
  process.stdout.write("Instalador guiado para dejar tu instancia lista y operativa.\n");
  process.stdout.write("Este agente puede operar con permisos altos según agente/entorno.\n\n");
  if (runtimeOptions.nonInteractive) {
    process.stdout.write(`${ANSI_YELLOW}Modo no interactivo activo (--yes).${ANSI_RESET}\n`);
    process.stdout.write("No se harán preguntas: se usarán defaults/.env/env del proceso.\n\n");
  }
  process.stdout.write("Antes de arrancar, tené a mano:\n");
  process.stdout.write("- TELEGRAM_BOT_TOKEN (de BotFather)\n");
  process.stdout.write("- TELEGRAM_ALLOWED_USER_IDS (tu user id o lista CSV)\n");
  process.stdout.write("- OPENAI_API_KEY (opcional)\n");
  process.stdout.write("- Credenciales Gmail OAuth (solo si lo vas a usar)\n\n");
  process.stdout.write("- Credenciales Meta WhatsApp Cloud API (opcional)\n\n");

  let rlClosed = false;
  const closeReadline = (): void => {
    if (rlClosed) {
      return;
    }
    rl.close();
    rlClosed = true;
  };

  try {
    const resolveLine = async (
      question: string,
      options: PromptOptions | undefined,
      keyHint?: string,
    ): Promise<string> => {
      if (!runtimeOptions.nonInteractive) {
        return promptLine(rl, question, options);
      }
      const value = (options?.defaultValue ?? "").trim();
      if (options?.required && !value) {
        const variableHint = keyHint ? `Define ${keyHint} en .env o como variable de entorno.` : "Define un valor.";
        throw new Error(`Modo --yes: falta valor requerido para "${question}". ${variableHint}`);
      }
      if (options?.validate) {
        const validationError = options.validate(value);
        if (validationError) {
          throw new Error(`Modo --yes: valor inválido para "${question}". ${validationError}`);
        }
      }
      const visibleValue = options?.displayDefault === false ? (value ? "[configurado]" : "[vacío]") : value || "(vacío)";
      process.stdout.write(`- ${question}: ${visibleValue} [auto]\n`);
      return value;
    };

    const resolveYesNo = async (question: string, defaultValue: boolean): Promise<boolean> => {
      if (!runtimeOptions.nonInteractive) {
        return promptYesNo(rl, question, defaultValue);
      }
      process.stdout.write(`- ${question}: ${defaultValue ? "yes" : "no"} [auto]\n`);
      return defaultValue;
    };

    const resolveChoice = async (question: string, choices: string[], defaultValue: string): Promise<string> => {
      if (!runtimeOptions.nonInteractive) {
        return promptChoice(rl, question, choices, defaultValue);
      }
      if (!choices.map((entry) => entry.toLowerCase()).includes(defaultValue.toLowerCase())) {
        throw new Error(`Modo --yes: opción inválida para "${question}": ${defaultValue}`);
      }
      process.stdout.write(`- ${question}: ${defaultValue} [auto]\n`);
      return defaultValue;
    };

    if (!runtimeOptions.skipPreflight) {
      const preflightChecks = await runPreflightChecks();
      const preflightSummary = printPreflightReport(preflightChecks);
      if (preflightSummary.fail > 0) {
        if (runtimeOptions.nonInteractive && !runtimeOptions.allowPreflightFailures) {
          throw new Error(
            "Preflight con fallas bloqueantes. Corrige el entorno o usa --allow-preflight-failures para continuar bajo tu responsabilidad.",
          );
        }
        const continueWithFailures = await resolveYesNo("Hay fallas bloqueantes en preflight. ¿Continuar de todos modos?", false);
        if (!continueWithFailures) {
          process.stdout.write("Onboarding cancelado para corregir preflight.\n");
          return;
        }
      }
    }

    if (!runtimeOptions.assumeRiskAccepted) {
      if (runtimeOptions.nonInteractive) {
        throw new Error("Modo --yes requiere --accept-risk para confirmar explícitamente la advertencia de seguridad.");
      }
      process.stdout.write(
        [
          "Advertencia de riesgo:",
          "- Esta instalación puede ejecutar comandos sensibles del host.",
          "- Si habilitas servicio de sistema o reboot remoto, puede requerir sudo.",
          "- Úsalo solo en equipos/cuentas que controles.",
          "",
        ].join("\n"),
      );
      const accepted = await resolveYesNo("¿Aceptas estos riesgos y quieres continuar?", false);
      if (!accepted) {
        process.stdout.write("Onboarding cancelado por el usuario.\n");
        return;
      }
    }

    let envExampleContent = "";
    try {
      envExampleContent = await fs.readFile(ENV_EXAMPLE_PATH, "utf8");
    } catch {
      throw new Error(`No existe ${ENV_EXAMPLE_PATH}.`);
    }

    const envExampleMap = parseEnvContent(envExampleContent);
    let envCurrentContent = "";
    try {
      envCurrentContent = await fs.readFile(ENV_PATH, "utf8");
    } catch {
      envCurrentContent = envExampleContent;
    }
    const envCurrentMap = parseEnvContent(envCurrentContent);
    const envMap = new Map<string, string>(envCurrentMap);
    applyEnvironmentOverrides(envMap, [
      "HOUDI_WORKSPACE_DIR",
      "DEFAULT_AGENT",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "ENABLE_WEB_BROWSE",
      "ENABLE_GMAIL_ACCOUNT",
      "GMAIL_ACCOUNT_EMAIL",
      "GMAIL_CLIENT_ID",
      "GMAIL_CLIENT_SECRET",
      "GMAIL_REFRESH_TOKEN",
      "HOUDI_LOCAL_API_ENABLED",
      "HOUDI_LOCAL_API_HOST",
      "HOUDI_LOCAL_API_PORT",
      "HOUDI_LOCAL_API_TOKEN",
      "WHATSAPP_BRIDGE_HOST",
      "WHATSAPP_BRIDGE_PORT",
      "WHATSAPP_WEBHOOK_PATH",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_GRAPH_API_VERSION",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_BRIDGE_USER_ID",
      "WHATSAPP_ALLOWED_FROM",
      "WHATSAPP_WEBHOOK_MAX_BYTES",
      "WHATSAPP_BRIDGE_TIMEOUT_MS",
      "WHATSAPP_BRIDGE_RETRY_COUNT",
      "WHATSAPP_BRIDGE_RETRY_DELAY_MS",
      "WHATSAPP_REPLY_CHUNK_MAX_CHARS",
      "WHATSAPP_EVENT_DEDUPE_TTL_MS",
      "WHATSAPP_SEND_BRIDGE_ERRORS_TO_USER",
      "ENABLE_LIM_CONTROL",
      "LIM_APP_DIR",
      "LIM_APP_SERVICE",
      "LIM_TUNNEL_SERVICE",
      "LIM_LOCAL_HEALTH_URL",
      "LIM_PUBLIC_HEALTH_URL",
    ]);

    printHeading("Paso 1/7 - Configuración base");
    process.stdout.write(
      [
        "La carpeta workspace es el directorio de trabajo del agente.",
        "Ahí guarda archivos recibidos, imágenes, documentos y operaciones de workspace.",
        "Puedes usar una ruta relativa (ej: ./workspace) o absoluta (ej: /home/usuario/houdi-workspace).",
        "",
      ].join("\n"),
    );
    const workspaceDir = normalizeDirValue(
      await resolveLine("Directorio workspace (carpeta de trabajo)", {
        defaultValue: envMap.get("HOUDI_WORKSPACE_DIR") || envExampleMap.get("HOUDI_WORKSPACE_DIR") || "./workspace",
        required: true,
      }, "HOUDI_WORKSPACE_DIR"),
      "./workspace",
    );
    envMap.set("HOUDI_WORKSPACE_DIR", workspaceDir);

    const defaultAgent = await resolveLine("Agente por defecto", {
      defaultValue: envMap.get("DEFAULT_AGENT") || envExampleMap.get("DEFAULT_AGENT") || "operator",
      required: true,
    }, "DEFAULT_AGENT");
    envMap.set("DEFAULT_AGENT", defaultAgent);

    printHeading("\nPaso 2/7 - Telegram");
    process.stdout.write(
      [
        "Esta sección define quién puede operar el agente.",
        "Solo los IDs incluidos en TELEGRAM_ALLOWED_USER_IDS tendrán acceso.",
        "",
      ].join("\n"),
    );
    const telegramToken = await resolveLine("TELEGRAM_BOT_TOKEN", {
      defaultValue: envMap.get("TELEGRAM_BOT_TOKEN") || "",
      required: true,
      validate: (value) => (value.length < 20 ? "Token Telegram inválido o incompleto." : null),
      displayDefault: false,
    }, "TELEGRAM_BOT_TOKEN");
    envMap.set("TELEGRAM_BOT_TOKEN", telegramToken);

    const allowedUserIds = await resolveLine("TELEGRAM_ALLOWED_USER_IDS (csv)", {
      defaultValue: envMap.get("TELEGRAM_ALLOWED_USER_IDS") || "",
      required: true,
      validate: ensureNumericCsv,
    }, "TELEGRAM_ALLOWED_USER_IDS");
    envMap.set("TELEGRAM_ALLOWED_USER_IDS", allowedUserIds);

    printHeading("\nPaso 3/7 - OpenAI");
    process.stdout.write("Si no defines OPENAI_API_KEY, Houdi funcionará pero sin capacidades IA avanzadas.\n\n");
    const openAiApiKey = await resolveLine("OPENAI_API_KEY (opcional)", {
      defaultValue: envMap.get("OPENAI_API_KEY") || "",
      displayDefault: false,
    }, "OPENAI_API_KEY");
    envMap.set("OPENAI_API_KEY", openAiApiKey);

    const openAiModel = await resolveLine("OPENAI_MODEL", {
      defaultValue: envMap.get("OPENAI_MODEL") || envExampleMap.get("OPENAI_MODEL") || "gpt-4o-mini",
      required: true,
    }, "OPENAI_MODEL");
    envMap.set("OPENAI_MODEL", openAiModel);

    const enableWebBrowse = await resolveYesNo(
      "Habilitar navegación web",
      (envMap.get("ENABLE_WEB_BROWSE") || "true").toLowerCase() === "true",
    );
    envMap.set("ENABLE_WEB_BROWSE", normalizeBoolean(enableWebBrowse));

    printHeading("\nPaso 4/7 - Gmail");
    process.stdout.write("Actívalo solo si realmente necesitas lectura/envío de correos desde el agente.\n\n");
    const enableGmail = await resolveYesNo(
      "Habilitar integración Gmail",
      (envMap.get("ENABLE_GMAIL_ACCOUNT") || "false").toLowerCase() === "true",
    );
    envMap.set("ENABLE_GMAIL_ACCOUNT", normalizeBoolean(enableGmail));
    if (enableGmail) {
      const gmailAccountEmail = await resolveLine("GMAIL_ACCOUNT_EMAIL", {
        defaultValue: envMap.get("GMAIL_ACCOUNT_EMAIL") || "",
      }, "GMAIL_ACCOUNT_EMAIL");
      const gmailClientId = await resolveLine("GMAIL_CLIENT_ID", {
        defaultValue: envMap.get("GMAIL_CLIENT_ID") || "",
        required: true,
      }, "GMAIL_CLIENT_ID");
      const gmailClientSecret = await resolveLine("GMAIL_CLIENT_SECRET", {
        defaultValue: envMap.get("GMAIL_CLIENT_SECRET") || "",
        required: true,
        displayDefault: false,
      }, "GMAIL_CLIENT_SECRET");
      const gmailRefreshToken = await resolveLine("GMAIL_REFRESH_TOKEN", {
        defaultValue: envMap.get("GMAIL_REFRESH_TOKEN") || "",
        required: true,
        displayDefault: false,
      }, "GMAIL_REFRESH_TOKEN");
      envMap.set("GMAIL_ACCOUNT_EMAIL", gmailAccountEmail);
      envMap.set("GMAIL_CLIENT_ID", gmailClientId);
      envMap.set("GMAIL_CLIENT_SECRET", gmailClientSecret);
      envMap.set("GMAIL_REFRESH_TOKEN", gmailRefreshToken);
    } else {
      envMap.set("GMAIL_ACCOUNT_EMAIL", "");
      envMap.set("GMAIL_CLIENT_ID", "");
      envMap.set("GMAIL_CLIENT_SECRET", "");
      envMap.set("GMAIL_REFRESH_TOKEN", "");
    }

    printHeading("\nPaso 5/7 - Bridge local CLI");
    process.stdout.write("Permite que CLI local y Telegram compartan el mismo runtime/estado.\n\n");
    const enableLocalApi = await resolveYesNo(
      "Habilitar API local para paridad CLI/Telegram",
      (envMap.get("HOUDI_LOCAL_API_ENABLED") || "true").toLowerCase() === "true",
    );
    envMap.set("HOUDI_LOCAL_API_ENABLED", normalizeBoolean(enableLocalApi));
    if (enableLocalApi) {
      const localApiHostDefault = normalizeLocalApiHostCandidate(envMap.get("HOUDI_LOCAL_API_HOST"));
      const localApiHost = await resolveLine("HOUDI_LOCAL_API_HOST", {
        defaultValue: localApiHostDefault,
        required: true,
        validate: validateLocalApiHost,
      }, "HOUDI_LOCAL_API_HOST");
      const localApiPort = await resolveLine("HOUDI_LOCAL_API_PORT", {
        defaultValue: envMap.get("HOUDI_LOCAL_API_PORT") || "3210",
        required: true,
        validate: (value) => {
          if (!/^\d+$/.test(value)) {
            return "Debe ser número entero.";
          }
          const parsed = Number.parseInt(value, 10);
          if (parsed < 1 || parsed > 65535) {
            return "Puerto fuera de rango (1-65535).";
          }
          return null;
        },
      }, "HOUDI_LOCAL_API_PORT");
      let localApiToken = await resolveLine("HOUDI_LOCAL_API_TOKEN (vacío = sin token)", {
        defaultValue: envMap.get("HOUDI_LOCAL_API_TOKEN") || "",
        displayDefault: false,
      }, "HOUDI_LOCAL_API_TOKEN");
      if (!localApiToken) {
        const generateToken = await resolveYesNo("¿Generar token aleatorio para mayor seguridad?", true);
        if (generateToken) {
          localApiToken = randomBytes(24).toString("hex");
        }
      }
      envMap.set("HOUDI_LOCAL_API_HOST", localApiHost);
      envMap.set("HOUDI_LOCAL_API_PORT", localApiPort);
      envMap.set("HOUDI_LOCAL_API_TOKEN", localApiToken);
    }

    printHeading("\nPaso 6/8 - Bridge WhatsApp (opcional)");
    process.stdout.write("Permite recibir mensajes por webhook de WhatsApp Cloud API y responder vía bridge local.\n\n");
    const hasWhatsAppConfigured = Boolean((envMap.get("WHATSAPP_VERIFY_TOKEN") || "").trim() && (envMap.get("WHATSAPP_ACCESS_TOKEN") || "").trim());
    const configureWhatsApp = await resolveYesNo("Configurar bridge WhatsApp", hasWhatsAppConfigured);
    if (configureWhatsApp) {
      const whatsappVerifyToken = await resolveLine("WHATSAPP_VERIFY_TOKEN", {
        defaultValue: envMap.get("WHATSAPP_VERIFY_TOKEN") || "",
        required: true,
        displayDefault: false,
      }, "WHATSAPP_VERIFY_TOKEN");
      const whatsappAccessToken = await resolveLine("WHATSAPP_ACCESS_TOKEN", {
        defaultValue: envMap.get("WHATSAPP_ACCESS_TOKEN") || "",
        required: true,
        displayDefault: false,
      }, "WHATSAPP_ACCESS_TOKEN");
      const whatsappAppSecret = await resolveLine("WHATSAPP_APP_SECRET (opcional, recomendado para firma)", {
        defaultValue: envMap.get("WHATSAPP_APP_SECRET") || "",
        displayDefault: false,
      }, "WHATSAPP_APP_SECRET");
      const whatsappBridgeHost = await resolveLine("WHATSAPP_BRIDGE_HOST", {
        defaultValue: envMap.get("WHATSAPP_BRIDGE_HOST") || "0.0.0.0",
        required: true,
      }, "WHATSAPP_BRIDGE_HOST");
      const whatsappBridgePort = await resolveLine("WHATSAPP_BRIDGE_PORT", {
        defaultValue: envMap.get("WHATSAPP_BRIDGE_PORT") || "3390",
        required: true,
        validate: (value) => {
          if (!/^\d+$/.test(value)) {
            return "Debe ser número entero.";
          }
          const parsed = Number.parseInt(value, 10);
          if (parsed < 1 || parsed > 65535) {
            return "Puerto fuera de rango (1-65535).";
          }
          return null;
        },
      }, "WHATSAPP_BRIDGE_PORT");
      const whatsappWebhookPath = await resolveLine("WHATSAPP_WEBHOOK_PATH", {
        defaultValue: envMap.get("WHATSAPP_WEBHOOK_PATH") || "/webhook/whatsapp",
        required: true,
      }, "WHATSAPP_WEBHOOK_PATH");
      const whatsappAllowedFrom = await resolveLine("WHATSAPP_ALLOWED_FROM (csv opcional, * para todos)", {
        defaultValue: envMap.get("WHATSAPP_ALLOWED_FROM") || "",
      }, "WHATSAPP_ALLOWED_FROM");
      const whatsappBridgeUserId = await resolveLine("WHATSAPP_BRIDGE_USER_ID (opcional)", {
        defaultValue: envMap.get("WHATSAPP_BRIDGE_USER_ID") || "",
      }, "WHATSAPP_BRIDGE_USER_ID");
      const whatsappApiVersion = await resolveLine("WHATSAPP_GRAPH_API_VERSION", {
        defaultValue: envMap.get("WHATSAPP_GRAPH_API_VERSION") || "v22.0",
        required: true,
      }, "WHATSAPP_GRAPH_API_VERSION");

      envMap.set("WHATSAPP_VERIFY_TOKEN", whatsappVerifyToken);
      envMap.set("WHATSAPP_ACCESS_TOKEN", whatsappAccessToken);
      envMap.set("WHATSAPP_APP_SECRET", whatsappAppSecret);
      envMap.set("WHATSAPP_BRIDGE_HOST", whatsappBridgeHost);
      envMap.set("WHATSAPP_BRIDGE_PORT", whatsappBridgePort);
      envMap.set("WHATSAPP_WEBHOOK_PATH", whatsappWebhookPath);
      envMap.set("WHATSAPP_ALLOWED_FROM", whatsappAllowedFrom);
      envMap.set("WHATSAPP_BRIDGE_USER_ID", whatsappBridgeUserId);
      envMap.set("WHATSAPP_GRAPH_API_VERSION", whatsappApiVersion);
    }

    printHeading("\nPaso 7/8 - Integración externa opcional");
    const enableLim = await resolveYesNo(
      "Habilitar control de LIM externo",
      (envMap.get("ENABLE_LIM_CONTROL") || "false").toLowerCase() === "true",
    );
    envMap.set("ENABLE_LIM_CONTROL", normalizeBoolean(enableLim));
    if (enableLim) {
      const limAppDir = normalizeDirValue(
        await resolveLine("LIM_APP_DIR", {
          defaultValue: envMap.get("LIM_APP_DIR") || "./lim-app",
          required: true,
        }, "LIM_APP_DIR"),
        "./lim-app",
      );
      const limAppService = await resolveLine("LIM_APP_SERVICE", {
        defaultValue: envMap.get("LIM_APP_SERVICE") || "houdi-lim-app.service",
        required: true,
      }, "LIM_APP_SERVICE");
      const limTunnelService = await resolveLine("LIM_TUNNEL_SERVICE", {
        defaultValue: envMap.get("LIM_TUNNEL_SERVICE") || "houdi-lim-tunnel.service",
        required: true,
      }, "LIM_TUNNEL_SERVICE");
      const limLocalHealth = await resolveLine("LIM_LOCAL_HEALTH_URL", {
        defaultValue: envMap.get("LIM_LOCAL_HEALTH_URL") || "http://127.0.0.1:3333/health",
        required: true,
      }, "LIM_LOCAL_HEALTH_URL");
      const limPublicHealth = await resolveLine("LIM_PUBLIC_HEALTH_URL", {
        defaultValue: envMap.get("LIM_PUBLIC_HEALTH_URL") || limLocalHealth,
        required: true,
      }, "LIM_PUBLIC_HEALTH_URL");
      envMap.set("LIM_APP_DIR", limAppDir);
      envMap.set("LIM_APP_SERVICE", limAppService);
      envMap.set("LIM_TUNNEL_SERVICE", limTunnelService);
      envMap.set("LIM_LOCAL_HEALTH_URL", limLocalHealth);
      envMap.set("LIM_PUBLIC_HEALTH_URL", limPublicHealth);
    }

    printHeading("\nPaso 8/8 - Confirmación");
    process.stdout.write(
      [
        `- Workspace: ${envMap.get("HOUDI_WORKSPACE_DIR")}`,
        `- Telegram IDs: ${envMap.get("TELEGRAM_ALLOWED_USER_IDS")}`,
        `- Telegram token: ${maskSecret(envMap.get("TELEGRAM_BOT_TOKEN") || "")}`,
        `- OpenAI key: ${maskSecret(envMap.get("OPENAI_API_KEY") || "")}`,
        `- Gmail: ${envMap.get("ENABLE_GMAIL_ACCOUNT") === "true" ? "on" : "off"}`,
        `- Bridge local: ${envMap.get("HOUDI_LOCAL_API_ENABLED") === "true" ? "on" : "off"}`,
        `- Bridge WhatsApp: ${((envMap.get("WHATSAPP_VERIFY_TOKEN") || "").trim() && (envMap.get("WHATSAPP_ACCESS_TOKEN") || "").trim()) ? "configurado" : "off"}`,
        `- LIM externo: ${envMap.get("ENABLE_LIM_CONTROL") === "true" ? "on" : "off"}`,
        "",
      ].join("\n"),
    );

    const confirmWrite = await resolveYesNo("¿Guardar configuración en .env?", true);
    if (!confirmWrite) {
      process.stdout.write("Onboarding cancelado. No se escribieron cambios.\n");
      return;
    }

    const outputLines: string[] = [];
    const seen = new Set<string>();
    const exampleLines = envExampleContent.split(/\r?\n/);
    for (const line of exampleLines) {
      const equalsIndex = line.indexOf("=");
      if (equalsIndex > 0 && /^[A-Z0-9_]+$/.test(line.slice(0, equalsIndex).trim())) {
        const key = line.slice(0, equalsIndex).trim();
        const value = envMap.get(key) ?? envExampleMap.get(key) ?? "";
        outputLines.push(`${key}=${formatEnvValue(value)}`);
        seen.add(key);
      } else {
        outputLines.push(line);
      }
    }

    const extraKeys = [...envMap.keys()].filter((key) => !seen.has(key)).sort();
    if (extraKeys.length > 0) {
      outputLines.push("");
      outputLines.push("# Extra keys");
      for (const key of extraKeys) {
        outputLines.push(`${key}=${formatEnvValue(envMap.get(key) || "")}`);
      }
    }

    await fs.writeFile(ENV_PATH, `${outputLines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`, "utf8");
    process.stdout.write(`${ANSI_GREEN}.env actualizado en ${ENV_PATH}${ANSI_RESET}\n`);

    const runInstallDefault = runtimeOptions.autoInstallDeps ?? true;
    const runInstall = await resolveYesNo("¿Ejecutar npm install ahora?", runInstallDefault);
    if (runInstall) {
      await runCommand("npm", ["install"], PROJECT_DIR);
    }

    const runBuildDefault = runtimeOptions.autoBuild ?? true;
    const runBuild = await resolveYesNo("¿Ejecutar npm run build ahora?", runBuildDefault);
    if (runBuild) {
      await runCommand("npm", ["run", "build"], PROJECT_DIR);
    }

    printHeading("\nModo de instalación de servicio");
    process.stdout.write(
      [
        "- none: no instala servicio. Ejecutas el bot manualmente con npm start.",
        "- user: instala systemd --user (sin sudo). Funciona para tu usuario.",
        "- system: instala servicio global systemd (requiere sudo). Recomendado para producción.",
        "",
      ].join("\n"),
    );
    const serviceModeDefault = runtimeOptions.serviceMode ?? "none";
    const serviceMode = await resolveChoice("Instalación de servicio", ["none", "user", "system"], serviceModeDefault);
    let installedSlackBridgeService = false;
    let installedWhatsAppBridgeService = false;
    if (serviceMode === "user") {
      await runCommand("bash", ["./scripts/install-systemd-user-service.sh"], PROJECT_DIR);
      const hasSlackTokens = Boolean((envMap.get("SLACK_BOT_TOKEN") || "").trim() && (envMap.get("SLACK_APP_TOKEN") || "").trim());
      const installSlackBridge = await resolveYesNo(
        "¿Instalar servicio Slack bridge (systemd --user)?",
        hasSlackTokens,
      );
      if (installSlackBridge) {
        await runCommand("bash", ["./scripts/install-systemd-user-slack-bridge.sh"], PROJECT_DIR);
        installedSlackBridgeService = true;
      }
      const hasWhatsAppTokens = Boolean((envMap.get("WHATSAPP_VERIFY_TOKEN") || "").trim() && (envMap.get("WHATSAPP_ACCESS_TOKEN") || "").trim());
      const installWhatsAppBridge = await resolveYesNo(
        "¿Instalar servicio WhatsApp bridge (systemd --user)?",
        hasWhatsAppTokens,
      );
      if (installWhatsAppBridge) {
        await runCommand("bash", ["./scripts/install-systemd-user-whatsapp-bridge.sh"], PROJECT_DIR);
        installedWhatsAppBridgeService = true;
      }
    } else if (serviceMode === "system") {
      const confirmSystem = runtimeOptions.forceSystemInstall
        ? true
        : await resolveYesNo("Instalar servicio de sistema requiere permisos sudo. ¿Continuar?", false);
      if (!confirmSystem) {
        process.stdout.write("Instalación de servicio system omitida.\n");
      } else {
        process.stdout.write(
          [
            "Se ejecutará instalador de servicio de sistema (puede pedir contraseña sudo).",
            "Cierro el prompt interactivo para evitar bloqueo de teclado durante sudo.",
            "",
          ].join("\n"),
        );
        closeReadline();
        await runCommand("sudo", ["./scripts/install-systemd-system-service.sh"], PROJECT_DIR);
      }
    }

    printHeading("\nOnboarding completado");
    const nextSteps: string[] = [];
    if (serviceMode === "none") {
      nextSteps.push("1) Inicia el bot manualmente: npm start");
    } else if (serviceMode === "user") {
      nextSteps.push("1) Verifica servicio user: systemctl --user status houdi-agent.service --no-pager");
      if (installedSlackBridgeService) {
        nextSteps.push("2) Verifica Slack bridge: systemctl --user status houdi-slack-bridge.service --no-pager");
      }
      if (installedWhatsAppBridgeService) {
        nextSteps.push("3) Verifica WhatsApp bridge: systemctl --user status houdi-whatsapp-bridge.service --no-pager");
      }
    } else {
      nextSteps.push("1) Verifica servicio system: systemctl status houdi-agent.service --no-pager");
      nextSteps.push("2) Logs del servicio: sudo journalctl -u houdi-agent.service -f");
    }
    if (serviceMode !== "system") {
      nextSteps.push("2) Logs runtime: tail -f houdi-agent.log");
    }
    nextSteps.push("3) Entra al CLI interactivo: npm run cli -- chat");
    nextSteps.push('4) Envío único por CLI: npm run cli -- agent -m "hola"');
    nextSteps.push("5) Diagnóstico rápido: /doctor en Telegram (y /status).");
    nextSteps.push("6) Prueba Telegram con /status y un mensaje natural.");
    process.stdout.write(`${nextSteps.join("\n")}\n`);
  } finally {
    closeReadline();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error onboarding: ${message}\n`);
  process.exit(1);
});
