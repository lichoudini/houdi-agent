#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
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

const PROJECT_DIR = process.cwd();
const ENV_PATH = path.join(PROJECT_DIR, ".env");
const ENV_EXAMPLE_PATH = path.join(PROJECT_DIR, ".env.example");
const ANSI_LIGHT_BLUE = "\x1b[94m";
const ANSI_RESET = "\x1b[0m";
const VRAND_QUOTE =
  "The currents before us are ever changing. We must adapt and press forward if we are to see our journey's end.";

function buildVrandAsciiLines(): string[] {
  // 8-line ASCII banner (height fixed at 8)
  const v = [
    "V     V",
    "V     V",
    "V     V",
    "V     V",
    " V   V ",
    " V   V ",
    "  V V  ",
    "   V   ",
  ];
  const r = [
    "RRRRR  ",
    "R    R ",
    "R    R ",
    "RRRRR  ",
    "R  R   ",
    "R   R  ",
    "R    R ",
    "R     R",
  ];
  const a = [
    "  AAA  ",
    " A   A ",
    "A     A",
    "A     A",
    "AAAAAAA",
    "A     A",
    "A     A",
    "A     A",
  ];
  const n = [
    "N     N",
    "NN    N",
    "N N   N",
    "N  N  N",
    "N   N N",
    "N    NN",
    "N     N",
    "N     N",
  ];
  const d = [
    "DDDDD  ",
    "D    D ",
    "D     D",
    "D     D",
    "D     D",
    "D     D",
    "D    D ",
    "DDDDD  ",
  ];
  const lines: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    lines.push(`${v[i]}  ${r[i]}  ${a[i]}  ${n[i]}  ${d[i]}`);
  }
  return lines;
}

function printVrandWelcomeBanner(): void {
  const lines = buildVrandAsciiLines();
  const output = lines.map((line) => `${ANSI_LIGHT_BLUE}${line}${ANSI_RESET}`).join("\n");
  process.stdout.write(`${output}\n`);
  process.stdout.write(`${ANSI_LIGHT_BLUE}${VRAND_QUOTE}${ANSI_RESET}\n\n`);
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
  const assumeRiskAccepted = argv.includes("--accept-risk");
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
        "",
        "Qué hace:",
        "- Configura .env paso a paso (Telegram, OpenAI, Gmail, workspace, bridge local).",
        "- Configura integración externa opcional (LIM).",
        "- Opcionalmente ejecuta npm install, npm run build e instala servicio systemd.",
        "",
        "Flags:",
        "- --accept-risk: omite confirmación inicial de riesgo.",
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

  printVrandWelcomeBanner();
  process.stdout.write(
    [
      "Houdi Onboarding Wizard",
      "Configura tu instancia paso a paso y genera .env listo para usar.",
      "Este agente puede operar con permisos altos según agente/entorno.",
      "",
    ].join("\n"),
  );

  let rlClosed = false;
  const closeReadline = (): void => {
    if (rlClosed) {
      return;
    }
    rl.close();
    rlClosed = true;
  };

  try {
    if (!assumeRiskAccepted) {
      process.stdout.write(
        [
          "Advertencia de riesgo:",
          "- Esta instalación puede ejecutar comandos sensibles del host.",
          "- Si habilitas servicio de sistema o reboot remoto, puede requerir sudo.",
          "- Úsalo solo en equipos/cuentas que controles.",
          "",
        ].join("\n"),
      );
      const accepted = await promptYesNo(rl, "¿Aceptas estos riesgos y quieres continuar?", false);
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

    process.stdout.write("Paso 1/7 - Configuración base\n");
    process.stdout.write(
      [
        "La carpeta workspace es el directorio de trabajo del agente.",
        "Ahí guarda archivos recibidos, imágenes, documentos y operaciones de workspace.",
        "Puedes usar una ruta relativa (ej: ./workspace) o absoluta (ej: /home/usuario/houdi-workspace).",
        "",
      ].join("\n"),
    );
    const workspaceDir = normalizeDirValue(
      await promptLine(rl, "Directorio workspace (carpeta de trabajo)", {
        defaultValue: envMap.get("HOUDI_WORKSPACE_DIR") || envExampleMap.get("HOUDI_WORKSPACE_DIR") || "./workspace",
        required: true,
      }),
      "./workspace",
    );
    envMap.set("HOUDI_WORKSPACE_DIR", workspaceDir);

    const defaultAgent = await promptLine(rl, "Agente por defecto", {
      defaultValue: envMap.get("DEFAULT_AGENT") || envExampleMap.get("DEFAULT_AGENT") || "operator",
      required: true,
    });
    envMap.set("DEFAULT_AGENT", defaultAgent);

    process.stdout.write("\nPaso 2/7 - Telegram\n");
    const telegramToken = await promptLine(rl, "TELEGRAM_BOT_TOKEN", {
      defaultValue: envMap.get("TELEGRAM_BOT_TOKEN") || "",
      required: true,
      validate: (value) => (value.length < 20 ? "Token Telegram inválido o incompleto." : null),
      displayDefault: false,
    });
    envMap.set("TELEGRAM_BOT_TOKEN", telegramToken);

    const allowedUserIds = await promptLine(rl, "TELEGRAM_ALLOWED_USER_IDS (csv)", {
      defaultValue: envMap.get("TELEGRAM_ALLOWED_USER_IDS") || "",
      required: true,
      validate: ensureNumericCsv,
    });
    envMap.set("TELEGRAM_ALLOWED_USER_IDS", allowedUserIds);

    process.stdout.write("\nPaso 3/7 - OpenAI\n");
    const openAiApiKey = await promptLine(rl, "OPENAI_API_KEY (opcional)", {
      defaultValue: envMap.get("OPENAI_API_KEY") || "",
      displayDefault: false,
    });
    envMap.set("OPENAI_API_KEY", openAiApiKey);

    const openAiModel = await promptLine(rl, "OPENAI_MODEL", {
      defaultValue: envMap.get("OPENAI_MODEL") || envExampleMap.get("OPENAI_MODEL") || "gpt-4o-mini",
      required: true,
    });
    envMap.set("OPENAI_MODEL", openAiModel);

    const enableWebBrowse = await promptYesNo(
      rl,
      "Habilitar navegación web",
      (envMap.get("ENABLE_WEB_BROWSE") || "true").toLowerCase() === "true",
    );
    envMap.set("ENABLE_WEB_BROWSE", normalizeBoolean(enableWebBrowse));

    process.stdout.write("\nPaso 4/7 - Gmail\n");
    const enableGmail = await promptYesNo(
      rl,
      "Habilitar integración Gmail",
      (envMap.get("ENABLE_GMAIL_ACCOUNT") || "false").toLowerCase() === "true",
    );
    envMap.set("ENABLE_GMAIL_ACCOUNT", normalizeBoolean(enableGmail));
    if (enableGmail) {
      const gmailAccountEmail = await promptLine(rl, "GMAIL_ACCOUNT_EMAIL", {
        defaultValue: envMap.get("GMAIL_ACCOUNT_EMAIL") || "",
      });
      const gmailClientId = await promptLine(rl, "GMAIL_CLIENT_ID", {
        defaultValue: envMap.get("GMAIL_CLIENT_ID") || "",
        required: true,
      });
      const gmailClientSecret = await promptLine(rl, "GMAIL_CLIENT_SECRET", {
        defaultValue: envMap.get("GMAIL_CLIENT_SECRET") || "",
        required: true,
        displayDefault: false,
      });
      const gmailRefreshToken = await promptLine(rl, "GMAIL_REFRESH_TOKEN", {
        defaultValue: envMap.get("GMAIL_REFRESH_TOKEN") || "",
        required: true,
        displayDefault: false,
      });
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

    process.stdout.write("\nPaso 5/7 - Bridge local CLI\n");
    const enableLocalApi = await promptYesNo(
      rl,
      "Habilitar API local para paridad CLI/Telegram",
      (envMap.get("HOUDI_LOCAL_API_ENABLED") || "true").toLowerCase() === "true",
    );
    envMap.set("HOUDI_LOCAL_API_ENABLED", normalizeBoolean(enableLocalApi));
    if (enableLocalApi) {
      const localApiHostDefault = normalizeLocalApiHostCandidate(envMap.get("HOUDI_LOCAL_API_HOST"));
      const localApiHost = await promptLine(rl, "HOUDI_LOCAL_API_HOST", {
        defaultValue: localApiHostDefault,
        required: true,
        validate: validateLocalApiHost,
      });
      const localApiPort = await promptLine(rl, "HOUDI_LOCAL_API_PORT", {
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
      });
      let localApiToken = await promptLine(rl, "HOUDI_LOCAL_API_TOKEN (vacío = sin token)", {
        defaultValue: envMap.get("HOUDI_LOCAL_API_TOKEN") || "",
        displayDefault: false,
      });
      if (!localApiToken) {
        const generateToken = await promptYesNo(rl, "¿Generar token aleatorio para mayor seguridad?", true);
        if (generateToken) {
          localApiToken = randomBytes(24).toString("hex");
        }
      }
      envMap.set("HOUDI_LOCAL_API_HOST", localApiHost);
      envMap.set("HOUDI_LOCAL_API_PORT", localApiPort);
      envMap.set("HOUDI_LOCAL_API_TOKEN", localApiToken);
    }

    process.stdout.write("\nPaso 6/7 - Integración externa opcional\n");
    const enableLim = await promptYesNo(
      rl,
      "Habilitar control de LIM externo",
      (envMap.get("ENABLE_LIM_CONTROL") || envMap.get("ENABLE_CONNECTOR_CONTROL") || "false").toLowerCase() ===
        "true",
    );
    envMap.set("ENABLE_LIM_CONTROL", normalizeBoolean(enableLim));
    if (enableLim) {
      const limAppDir = normalizeDirValue(
        await promptLine(rl, "LIM_APP_DIR", {
          defaultValue: envMap.get("LIM_APP_DIR") || envMap.get("CONNECTOR_APP_DIR") || "./lim-app",
          required: true,
        }),
        "./lim-app",
      );
      const limAppService = await promptLine(rl, "LIM_APP_SERVICE", {
        defaultValue: envMap.get("LIM_APP_SERVICE") || envMap.get("CONNECTOR_RETRIEVER_SERVICE") || "houdi-lim-app.service",
        required: true,
      });
      const limTunnelService = await promptLine(rl, "LIM_TUNNEL_SERVICE", {
        defaultValue:
          envMap.get("LIM_TUNNEL_SERVICE") || envMap.get("CONNECTOR_CLOUDFLARED_SERVICE") || "houdi-lim-tunnel.service",
        required: true,
      });
      const limLocalHealth = await promptLine(rl, "LIM_LOCAL_HEALTH_URL", {
        defaultValue: envMap.get("LIM_LOCAL_HEALTH_URL") || envMap.get("CONNECTOR_LOCAL_HEALTH_URL") || "http://127.0.0.1:3333/health",
        required: true,
      });
      const limPublicHealth = await promptLine(rl, "LIM_PUBLIC_HEALTH_URL", {
        defaultValue: envMap.get("LIM_PUBLIC_HEALTH_URL") || envMap.get("CONNECTOR_PUBLIC_HEALTH_URL") || limLocalHealth,
        required: true,
      });
      envMap.set("LIM_APP_DIR", limAppDir);
      envMap.set("LIM_APP_SERVICE", limAppService);
      envMap.set("LIM_TUNNEL_SERVICE", limTunnelService);
      envMap.set("LIM_LOCAL_HEALTH_URL", limLocalHealth);
      envMap.set("LIM_PUBLIC_HEALTH_URL", limPublicHealth);
    }
    envMap.delete("ENABLE_CONNECTOR_CONTROL");
    envMap.delete("CONNECTOR_APP_DIR");
    envMap.delete("CONNECTOR_RETRIEVER_SERVICE");
    envMap.delete("CONNECTOR_CLOUDFLARED_SERVICE");
    envMap.delete("CONNECTOR_LOCAL_HEALTH_URL");
    envMap.delete("CONNECTOR_PUBLIC_HEALTH_URL");
    envMap.delete("CONNECTOR_HEALTH_TIMEOUT_MS");

    process.stdout.write("\nPaso 7/7 - Confirmación\n");
    process.stdout.write(
      [
        `- Workspace: ${envMap.get("HOUDI_WORKSPACE_DIR")}`,
        `- Telegram IDs: ${envMap.get("TELEGRAM_ALLOWED_USER_IDS")}`,
        `- Telegram token: ${maskSecret(envMap.get("TELEGRAM_BOT_TOKEN") || "")}`,
        `- OpenAI key: ${maskSecret(envMap.get("OPENAI_API_KEY") || "")}`,
        `- Gmail: ${envMap.get("ENABLE_GMAIL_ACCOUNT") === "true" ? "on" : "off"}`,
        `- Bridge local: ${envMap.get("HOUDI_LOCAL_API_ENABLED") === "true" ? "on" : "off"}`,
        `- LIM externo: ${envMap.get("ENABLE_LIM_CONTROL") === "true" ? "on" : "off"}`,
        "",
      ].join("\n"),
    );

    const confirmWrite = await promptYesNo(rl, "¿Guardar configuración en .env?", true);
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
    process.stdout.write(`.env actualizado en ${ENV_PATH}\n`);

    const runInstall = await promptYesNo(rl, "¿Ejecutar npm install ahora?", true);
    if (runInstall) {
      await runCommand("npm", ["install"], PROJECT_DIR);
    }

    const runBuild = await promptYesNo(rl, "¿Ejecutar npm run build ahora?", true);
    if (runBuild) {
      await runCommand("npm", ["run", "build"], PROJECT_DIR);
    }

    process.stdout.write(
      [
        "",
        "Modo de instalación de servicio:",
        "- none: no instala servicio. Ejecutas el bot manualmente con npm start.",
        "- user: instala systemd --user (sin sudo). Funciona para tu usuario.",
        "- system: instala servicio global systemd (requiere sudo). Recomendado para producción.",
        "",
      ].join("\n"),
    );
    const serviceMode = await promptChoice(
      rl,
      "Instalación de servicio",
      ["none", "user", "system"],
      "none",
    );
    if (serviceMode === "user") {
      await runCommand("bash", ["./scripts/install-systemd-user-service.sh"], PROJECT_DIR);
    } else if (serviceMode === "system") {
      const confirmSystem = await promptYesNo(
        rl,
        "Instalar servicio de sistema requiere permisos sudo. ¿Continuar?",
        false,
      );
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

    process.stdout.write(
      [
        "",
        "Onboarding completado.",
        "Siguientes pasos sugeridos:",
        "1) Inicia el bot (si no instalaste servicio): npm start",
        "2) Entra al CLI interactivo: npm run cli -- chat",
        '3) Envío único por CLI: npm run cli -- agent -m "hola"',
        "4) Diagnóstico rápido: npm run cli -- memory status",
        "5) Prueba Telegram con /status y un mensaje natural.",
      ].join("\n"),
    );
  } finally {
    closeReadline();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error onboarding: ${message}\n`);
  process.exit(1);
});
