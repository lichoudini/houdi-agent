import os from "node:os";
import { Bot, GrammyError, HttpError } from "grammy";
import type { AgentProfile } from "./agents.js";
import { AgentRegistry } from "./agents.js";
import { AdminSecurityController, type PendingApproval } from "./admin-security.js";
import { AuditLogger } from "./audit-log.js";
import { config } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { OpenAiService } from "./openai-client.js";
import { acquireSingleInstanceLock } from "./single-instance-lock.js";
import { TaskRunner } from "./task-runner.js";
import { splitForTelegram } from "./telegram-utils.js";

const agentRegistry = new AgentRegistry(config.agentsDir, config.defaultAgent);
await agentRegistry.load();
acquireSingleInstanceLock();

const taskRunner = new TaskRunner(config.execTimeoutMs, config.maxStdioChars);
const openAi = new OpenAiService();
const adminSecurity = new AdminSecurityController({
  approvalTtlMs: config.adminApprovalTtlSeconds * 1000,
});
const audit = new AuditLogger(config.auditLogPath);

const activeAgentByChat = new Map<number, string>();
const aiShellModeByChat = new Map<number, boolean>();

function getActiveAgent(chatId: number): string {
  return activeAgentByChat.get(chatId) ?? config.defaultAgent;
}

function setActiveAgent(chatId: number, agentName: string): void {
  activeAgentByChat.set(chatId, agentName);
}

function isAiShellModeEnabled(chatId: number): boolean {
  return aiShellModeByChat.get(chatId) ?? false;
}

function setAiShellMode(chatId: number, enabled: boolean): void {
  aiShellModeByChat.set(chatId, enabled);
}

function formatSeconds(startedAtMs: number): number {
  return Math.round((Date.now() - startedAtMs) / 1000);
}

function resolveRebootCommandLine(): string {
  const value = config.rebootCommand.trim();
  if (!value) {
    throw new Error("REBOOT_COMMAND está vacío en .env");
  }
  if (value.includes("\n")) {
    throw new Error("REBOOT_COMMAND debe ser una sola línea");
  }
  return value;
}

function resolveCommandName(commandLine: string): string {
  const first = commandLine.trim().split(/\s+/, 1)[0]?.trim().toLowerCase() ?? "";
  if (!first) {
    throw new Error("No se pudo resolver el comando");
  }
  if (!/^[a-z0-9._-]+$/.test(first)) {
    throw new Error(`Comando inválido: ${first}`);
  }
  return first;
}

type ChatReplyContext = {
  chat: { id: number };
  from?: { id?: number };
  reply: (text: string) => Promise<unknown>;
};

function getActor(ctx: ChatReplyContext): { chatId: number; userId: number } {
  return {
    chatId: ctx.chat.id,
    userId: ctx.from?.id ?? 0,
  };
}

function approvalRemainingSeconds(approval: PendingApproval): number {
  return Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000));
}

async function safeAudit(event: {
  type: string;
  chatId?: number;
  userId?: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await audit.log(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Audit log failed: ${message}`);
  }
}

async function replyLong(ctx: { reply: (text: string) => Promise<unknown> }, text: string) {
  const chunks = splitForTelegram(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

async function runCommandForProfile(params: {
  ctx: ChatReplyContext;
  profile: AgentProfile;
  commandLine: string;
  source: string;
  note?: string;
}): Promise<void> {
  const actor = getActor(params.ctx);

  let started;
  try {
    started = taskRunner.start(params.profile, params.commandLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude ejecutar: ${message}`);
    await safeAudit({
      type: "exec.start_failed",
      chatId: actor.chatId,
      userId: actor.userId,
      details: {
        source: params.source,
        agent: params.profile.name,
        commandLine: params.commandLine,
        error: message,
      },
    });
    return;
  }

  await params.ctx.reply(
    [
      `Tarea iniciada: ${started.task.id}`,
      `Agente: ${started.task.agent}`,
      `Comando: ${started.task.command} ${started.task.args.join(" ")}`,
      `PID: ${started.task.pid ?? "n/a"}`,
      `Origen: ${params.source}`,
    ].join("\n"),
  );

  await safeAudit({
    type: "exec.started",
    chatId: actor.chatId,
    userId: actor.userId,
    details: {
      source: params.source,
      agent: started.task.agent,
      taskId: started.task.id,
      command: started.task.command,
      args: started.task.args,
      cwd: started.task.cwd,
      note: params.note,
    },
  });

  const result = await started.done;
  const durationSeconds = Math.round((result.finishedAt - result.task.startedAt) / 1000);

  const header = [
    `Resultado ${result.task.id}`,
    `Estado: ${result.task.status}`,
    `Exit: ${result.exitCode ?? "null"} Signal: ${result.signal ?? "none"}`,
    `Duración: ${durationSeconds}s`,
  ].join("\n");

  const stdoutBlock = result.stdout ? `\n\nstdout:\n${result.stdout}` : "";
  const stderrBlock = result.stderr ? `\n\nstderr:\n${result.stderr}` : "";

  await replyLong(params.ctx, `${header}${stdoutBlock}${stderrBlock}`);

  await safeAudit({
    type: "exec.finished",
    chatId: actor.chatId,
    userId: actor.userId,
    details: {
      source: params.source,
      taskId: result.task.id,
      status: result.task.status,
      exitCode: result.exitCode,
      signal: result.signal,
      durationSeconds,
      timedOut: result.timedOut,
    },
  });
}

async function queueApproval(params: {
  ctx: ChatReplyContext;
  profile: AgentProfile;
  commandLine: string;
  kind: "exec" | "ai-shell" | "reboot";
  note?: string;
}): Promise<void> {
  const actor = getActor(params.ctx);
  const approval = adminSecurity.createApproval({
    kind: params.kind,
    chatId: actor.chatId,
    userId: actor.userId,
    agentName: params.profile.name,
    commandLine: params.commandLine,
    note: params.note,
  });

  await safeAudit({
    type: "approval.created",
    chatId: actor.chatId,
    userId: actor.userId,
    details: {
      approvalId: approval.id,
      kind: approval.kind,
      agent: approval.agentName,
      commandLine: approval.commandLine,
      note: approval.note,
    },
  });

  await params.ctx.reply(
    [
      `Aprobación requerida: ${approval.id}`,
      `Tipo: ${approval.kind}`,
      `Agente: ${approval.agentName}`,
      `Comando: ${approval.commandLine}`,
      `Expira en: ${approvalRemainingSeconds(approval)}s`,
      "Usa /approve <id> para ejecutar o /deny <id> para cancelar.",
    ].join("\n"),
  );
}

async function executeAiShellInstruction(ctx: ChatReplyContext, instruction: string): Promise<void> {
  if (!openAi.isConfigured()) {
    await ctx.reply(
      "OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.",
    );
    return;
  }

  const activeAgentName = getActiveAgent(ctx.chat.id);
  const profile = agentRegistry.require(activeAgentName);

  await ctx.reply(`Analizando instrucción para shell (${profile.name})...`);

  const plan = await openAi.planShellAction({
    instruction,
    allowedCommands: profile.allowCommands,
    cwd: profile.cwd,
  });

  if (plan.action === "reply") {
    await replyLong(ctx, plan.reply);
    return;
  }

  if (plan.reply) {
    await ctx.reply(plan.reply);
  }

  const commandLine = [plan.command, ...plan.args].join(" ");

  if (adminSecurity.isPanicModeEnabled()) {
    await ctx.reply("Panic mode está activo: ejecución bloqueada.");
    await safeAudit({
      type: "exec.blocked_panic",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        source: "ai-shell",
        commandLine,
      },
    });
    return;
  }

  if (adminSecurity.isAdminModeEnabled(ctx.chat.id)) {
    await queueApproval({
      ctx,
      profile,
      commandLine,
      kind: "ai-shell",
      note: `Instruction: ${instruction.slice(0, 300)}`,
    });
    return;
  }

  await runCommandForProfile({
    ctx,
    profile,
    commandLine,
    source: "ai-shell-direct",
    note: instruction.slice(0, 300),
  });
}

const bot = new Bot(config.telegramBotToken);

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) {
    return;
  }

  if (!config.allowedUserIds.has(userId)) {
    await ctx.reply("Acceso denegado. Este bot solo acepta usuarios autorizados.");
    logWarn(`Unauthorized access attempt from Telegram user ${userId}`);
    await safeAudit({
      type: "auth.denied",
      chatId: ctx.chat?.id,
      userId,
    });
    return;
  }

  await next();
});

bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  const active = getActiveAgent(chatId);
  const shellMode = isAiShellModeEnabled(chatId) ? "on" : "off";
  const adminMode = adminSecurity.isAdminModeEnabled(chatId) ? "on" : "off";
  const panicMode = adminSecurity.isPanicModeEnabled() ? "on" : "off";
  await ctx.reply(
    [
      "Houdi Agent activo.",
      `Agente actual: ${active}`,
      `Shell IA: ${shellMode}`,
      `Admin mode: ${adminMode}`,
      `Panic mode: ${panicMode}`,
      "Usa /help para ver comandos.",
    ].join("\n"),
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "Comandos:",
      "/status - Estado del host y tareas en ejecución",
      "/agent - Ver agente activo y lista",
      "/agent set <nombre> - Cambiar agente activo para este chat",
      "/ask <pregunta> - Consultar IA de OpenAI",
      "/shell <instrucción> - IA propone y ejecuta comando shell",
      "/shellmode on|off - Habilitar shell IA en chat libre",
      "/exec <cmd> [args] - Ejecutar comando permitido por el agente",
      "/reboot - Solicitar reinicio de PC (si está habilitado)",
      "/adminmode on|off - Requerir aprobación antes de ejecutar",
      "/approvals - Ver aprobaciones pendientes",
      "/approve <id> - Aprobar ejecución pendiente",
      "/deny <id> - Rechazar ejecución pendiente",
      "/panic on|off|status - Bloqueo global de ejecución",
      "/tasks - Ver tareas activas",
      "/kill <taskId> - Terminar tarea activa",
      "",
      "Chat libre: escribe un mensaje normal (sin /) y responde OpenAI.",
      "Si shellmode=on, el chat libre puede proponer comandos para ejecutar.",
      "Con adminmode=on, toda ejecución requiere /approve.",
    ].join("\n"),
  );
});

bot.command("status", async (ctx) => {
  const runningCount = taskRunner.listRunning().length;
  const usedMemMb = Math.round((os.totalmem() - os.freemem()) / (1024 * 1024));
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  const pendingCount = adminSecurity.listApprovals(ctx.chat.id).length;
  const activeProfile = agentRegistry.require(getActiveAgent(ctx.chat.id));
  let rebootAllowedInAgent = false;
  if (config.enableRebootCommand) {
    try {
      const rebootCommandName = resolveCommandName(resolveRebootCommandLine());
      rebootAllowedInAgent = activeProfile.allowCommands.includes(rebootCommandName);
    } catch {
      rebootAllowedInAgent = false;
    }
  }

  await ctx.reply(
    [
      `Host: ${os.hostname()}`,
      `OS: ${os.platform()} ${os.release()}`,
      `Uptime: ${Math.round(os.uptime() / 60)} min`,
      `CPU load (1/5/15): ${os.loadavg().map((n) => n.toFixed(2)).join(" / ")}`,
      `Memoria: ${usedMemMb}MB / ${totalMemMb}MB`,
      `Tareas activas: ${runningCount}`,
      `Agente actual: ${getActiveAgent(ctx.chat.id)}`,
      `Shell IA: ${isAiShellModeEnabled(ctx.chat.id) ? "on" : "off"}`,
      `Admin mode: ${adminSecurity.isAdminModeEnabled(ctx.chat.id) ? "on" : "off"}`,
      `Panic mode: ${adminSecurity.isPanicModeEnabled() ? "on" : "off"}`,
      `Reboot command: ${config.enableRebootCommand ? "habilitado" : "deshabilitado"} (${rebootAllowedInAgent ? "permitido en agente actual" : "no permitido en agente actual"})`,
      `Aprobaciones pendientes (chat): ${pendingCount}`,
      `OpenAI: ${openAi.isConfigured() ? `configurado (${openAi.getModel()})` : "no configurado"}`,
    ].join("\n"),
  );
});

bot.command("agent", async (ctx) => {
  const input = String(ctx.match ?? "").trim();

  if (!input) {
    const current = getActiveAgent(ctx.chat.id);
    const list = agentRegistry
      .list()
      .map((agent) => `- ${agent.name}: ${agent.description ?? "sin descripción"}`)
      .join("\n");

    await ctx.reply([`Agente actual: ${current}`, "Disponibles:", list].join("\n"));
    return;
  }

  const [subcommand, rawName] = input.split(/\s+/, 2);
  const targetName = (subcommand === "set" ? rawName : subcommand)?.trim() ?? "";

  if (!targetName) {
    await ctx.reply("Uso: /agent set <nombre>");
    return;
  }

  if (!agentRegistry.get(targetName)) {
    await ctx.reply(`Agente no encontrado: ${targetName}`);
    return;
  }

  setActiveAgent(ctx.chat.id, targetName);
  await ctx.reply(`Agente activo actualizado: ${targetName}`);
  await safeAudit({
    type: "agent.switch",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: { agent: targetName },
  });
});

bot.command("tasks", async (ctx) => {
  const tasks = taskRunner.listRunning();
  if (tasks.length === 0) {
    await ctx.reply("No hay tareas activas.");
    return;
  }

  const lines = tasks.map(
    (task) =>
      `- ${task.id} | ${task.command} ${task.args.join(" ")} | ${task.status} | ${formatSeconds(task.startedAt)}s`,
  );
  await replyLong(ctx, ["Tareas activas:", ...lines].join("\n"));
});

bot.command("kill", async (ctx) => {
  const taskId = String(ctx.match ?? "").trim();
  if (!taskId) {
    await ctx.reply("Uso: /kill <taskId>");
    return;
  }

  const ok = taskRunner.kill(taskId);
  if (!ok) {
    await ctx.reply(`No encontré una tarea activa con ID ${taskId}`);
    return;
  }

  await ctx.reply(`Señal de terminación enviada a ${taskId}`);
  await safeAudit({
    type: "task.kill",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: { taskId },
  });
});

bot.command("exec", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  if (!input) {
    await ctx.reply("Uso: /exec <comando> [args]");
    return;
  }

  if (adminSecurity.isPanicModeEnabled()) {
    await ctx.reply("Panic mode está activo: ejecución bloqueada.");
    return;
  }

  const profile = agentRegistry.require(getActiveAgent(ctx.chat.id));

  if (adminSecurity.isAdminModeEnabled(ctx.chat.id)) {
    await queueApproval({
      ctx,
      profile,
      commandLine: input,
      kind: "exec",
      note: "requested via /exec",
    });
    return;
  }

  await runCommandForProfile({
    ctx,
    profile,
    commandLine: input,
    source: "manual-exec",
  });
});

bot.command("reboot", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();

  if (raw === "status") {
    await ctx.reply(
      [
        `Reboot command: ${config.enableRebootCommand ? "habilitado" : "deshabilitado"}`,
        `Comando configurado: ${config.rebootCommand}`,
        `Admin mode (chat): ${adminSecurity.isAdminModeEnabled(ctx.chat.id) ? "on" : "off"}`,
        `Panic mode: ${adminSecurity.isPanicModeEnabled() ? "on" : "off"}`,
      ].join("\n"),
    );
    return;
  }

  if (!config.enableRebootCommand) {
    await ctx.reply(
      "La opción de reinicio está deshabilitada. Activa ENABLE_REBOOT_COMMAND=true en .env y reinicia el bot.",
    );
    return;
  }

  if (adminSecurity.isPanicModeEnabled()) {
    await ctx.reply("Panic mode está activo: ejecución bloqueada.");
    return;
  }

  const profile = agentRegistry.require(getActiveAgent(ctx.chat.id));
  let commandLine: string;
  let rebootCommandName: string;
  try {
    commandLine = resolveRebootCommandLine();
    rebootCommandName = resolveCommandName(commandLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Configuración inválida de reboot: ${message}`);
    return;
  }

  if (!profile.allowCommands.includes(rebootCommandName)) {
    await ctx.reply(
      [
        `El agente activo (${profile.name}) no permite ${rebootCommandName}.`,
        `Cambia a un agente con permisos adecuados (ej: /agent set admin).`,
      ].join("\n"),
    );
    return;
  }

  await queueApproval({
    ctx,
    profile,
    commandLine,
    kind: "reboot",
    note: "requested via /reboot",
  });
});

bot.command("ask", async (ctx) => {
  const question = String(ctx.match ?? "").trim();
  if (!question) {
    await ctx.reply("Uso: /ask <pregunta>");
    return;
  }

  if (!openAi.isConfigured()) {
    await ctx.reply(
      "OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.",
    );
    return;
  }

  await ctx.reply(`Consultando OpenAI (${openAi.getModel()})...`);

  try {
    const answer = await openAi.ask(question);
    await replyLong(ctx, answer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Error al consultar OpenAI: ${message}`);
  }
});

bot.command("shellmode", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();
  if (!raw) {
    await ctx.reply(`Shell IA está ${isAiShellModeEnabled(ctx.chat.id) ? "on" : "off"}.`);
    return;
  }

  if (raw !== "on" && raw !== "off") {
    await ctx.reply("Uso: /shellmode on|off");
    return;
  }

  const enabled = raw === "on";
  setAiShellMode(ctx.chat.id, enabled);
  await ctx.reply(
    [
      `Shell IA ahora está ${enabled ? "on" : "off"}.`,
      `Agente activo: ${getActiveAgent(ctx.chat.id)}`,
      "La IA solo puede ejecutar comandos permitidos en la allowlist del agente.",
    ].join("\n"),
  );

  await safeAudit({
    type: "shellmode.toggle",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: { enabled },
  });
});

bot.command("shell", async (ctx) => {
  const instruction = String(ctx.match ?? "").trim();
  if (!instruction) {
    await ctx.reply("Uso: /shell <instrucción>");
    return;
  }

  try {
    await executeAiShellInstruction(ctx, instruction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Error en shell IA: ${message}`);
  }
});

bot.command("adminmode", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();

  if (!raw || raw === "status") {
    await ctx.reply(`Admin mode está ${adminSecurity.isAdminModeEnabled(ctx.chat.id) ? "on" : "off"}.`);
    return;
  }

  if (raw !== "on" && raw !== "off") {
    await ctx.reply("Uso: /adminmode on|off");
    return;
  }

  const enabled = raw === "on";
  adminSecurity.setAdminMode(ctx.chat.id, enabled);
  await ctx.reply(
    [
      `Admin mode ahora está ${enabled ? "on" : "off"}.`,
      enabled
        ? "Cada ejecución de shell requerirá /approve antes de correr."
        : "Las ejecuciones vuelven a correr directo (si panic mode está off).",
    ].join("\n"),
  );

  await safeAudit({
    type: "adminmode.toggle",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: { enabled },
  });
});

bot.command("approvals", async (ctx) => {
  const approvals = adminSecurity.listApprovals(ctx.chat.id);
  if (approvals.length === 0) {
    await ctx.reply("No hay aprobaciones pendientes en este chat.");
    return;
  }

  const lines = approvals.map(
    (approval) =>
      `- ${approval.id} | ${approval.kind} | ${approval.commandLine} | expira ${approvalRemainingSeconds(approval)}s`,
  );
  await replyLong(ctx, ["Aprobaciones pendientes:", ...lines].join("\n"));
});

bot.command("approve", async (ctx) => {
  const id = String(ctx.match ?? "").trim();
  if (!id) {
    await ctx.reply("Uso: /approve <id>");
    return;
  }

  if (adminSecurity.isPanicModeEnabled()) {
    await ctx.reply("Panic mode está activo: desactívalo con /panic off para ejecutar.");
    return;
  }

  const approval = adminSecurity.consumeApproval(id, ctx.chat.id);
  if (!approval) {
    await ctx.reply(`No encontré aprobación pendiente con ID ${id} en este chat.`);
    return;
  }

  const profile = agentRegistry.get(approval.agentName);
  if (!profile) {
    await ctx.reply(`El agente ${approval.agentName} ya no existe. Aprobación descartada.`);
    return;
  }

  await ctx.reply(`Aprobación ${id} aceptada. Ejecutando...`);
  await safeAudit({
    type: "approval.approved",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      approvalId: id,
      kind: approval.kind,
      agent: approval.agentName,
      commandLine: approval.commandLine,
    },
  });

  await runCommandForProfile({
    ctx,
    profile,
    commandLine: approval.commandLine,
    source: `approval:${approval.kind}`,
    note: approval.note,
  });
});

bot.command("deny", async (ctx) => {
  const id = String(ctx.match ?? "").trim();
  if (!id) {
    await ctx.reply("Uso: /deny <id>");
    return;
  }

  const approval = adminSecurity.denyApproval(id, ctx.chat.id);
  if (!approval) {
    await ctx.reply(`No encontré aprobación pendiente con ID ${id} en este chat.`);
    return;
  }

  await ctx.reply(`Aprobación ${id} rechazada.`);
  await safeAudit({
    type: "approval.denied",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      approvalId: id,
      kind: approval.kind,
      commandLine: approval.commandLine,
    },
  });
});

bot.command("panic", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();

  if (!raw || raw === "status") {
    await ctx.reply(`Panic mode está ${adminSecurity.isPanicModeEnabled() ? "on" : "off"}.`);
    return;
  }

  if (raw !== "on" && raw !== "off") {
    await ctx.reply("Uso: /panic on|off|status");
    return;
  }

  const enable = raw === "on";
  adminSecurity.setPanicMode(enable);

  if (enable) {
    const killed = taskRunner.killAll();
    const cleared = adminSecurity.clearAllApprovals();
    await ctx.reply(
      [
        "Panic mode ACTIVADO.",
        `Tareas terminadas: ${killed}`,
        `Aprobaciones limpiadas: ${cleared}`,
        "No se permitirá nueva ejecución hasta /panic off.",
      ].join("\n"),
    );

    await safeAudit({
      type: "panic.on",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: { killedTasks: killed, clearedApprovals: cleared },
    });
    return;
  }

  await ctx.reply("Panic mode DESACTIVADO. La ejecución vuelve a estar disponible.");
  await safeAudit({
    type: "panic.off",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
  });
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) {
    return;
  }

  if (!openAi.isConfigured()) {
    await ctx.reply(
      "OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.",
    );
    return;
  }

  if (isAiShellModeEnabled(ctx.chat.id)) {
    try {
      await executeAiShellInstruction(ctx, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Error en shell IA: ${message}`);
    }
    return;
  }

  await ctx.reply(`Pensando con OpenAI (${openAi.getModel()})...`);

  try {
    const answer = await openAi.ask(text);
    await replyLong(ctx, answer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Error al consultar OpenAI: ${message}`);
  }
});

bot.catch((error) => {
  const ctx = error.ctx;
  logError(`Error while handling update ${ctx.update.update_id}: ${error.error}`);

  const err = error.error;
  if (err instanceof GrammyError) {
    logError(`GrammyError: ${err.description}`);
  } else if (err instanceof HttpError) {
    logError(`HttpError: ${err.message}`);
  } else {
    logError(`Unknown error: ${String(err)}`);
  }
});

logInfo("Starting Telegram bot...");
await bot.start();
