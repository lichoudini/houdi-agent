import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import { AgentContextMemory, type PromptContextSnapshot, type PromptMemoryHit } from "./agent-context-memory.js";
import type { AgentProfile } from "./agents.js";
import { AgentRegistry } from "./agents.js";
import { AdminSecurityController, type PendingApproval } from "./admin-security.js";
import { AuditLogger } from "./audit-log.js";
import { config } from "./config.js";
import { DocumentReader } from "./document-reader.js";
import type { GmailMessageSummary } from "./gmail-account.js";
import { GmailAccountService } from "./gmail-account.js";
import { InterestLearningService } from "./interest-learning.js";
import {
  type FitResult,
  IntentSemanticRouter,
  type IntentRouteName,
  type SemanticRouteDecision,
} from "./intent-semantic-router.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { formatMemoryHitsNaturalText } from "./memory-presenter.js";
import { OpenAiService } from "./openai-client.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { OpenMeteoApiTool } from "./open-meteo-api.js";
import { formatUsd as formatUsageUsd } from "./openai-usage.js";
import { AgenticCanary } from "./agentic-canary.js";
import { AgentPolicyEngine, type AgentCapability } from "./agent-policy.js";
import { RedditApiTool, type RedditPostResult } from "./reddit-api.js";
import { finishRunTrace, startRunTrace } from "./run-trace.js";
import { type SavedEmailRecipient, EmailRecipientsSqliteService } from "./email-recipients-sqlite.js";
import { ScheduledTaskSqliteService } from "./scheduled-tasks-sqlite.js";
import { GmailRecipientsManager, isValidEmailAddress, normalizeRecipientEmail, normalizeRecipientName } from "./domains/gmail/recipients-manager.js";
import { DomainRegistry } from "./domains/domain-registry.js";
import {
  detectGmailNaturalIntent as detectGmailNaturalIntentDomain,
  detectGmailRecipientNaturalIntent as detectGmailRecipientNaturalIntentDomain,
} from "./domains/gmail/intents.js";
import { createGmailTextParsers } from "./domains/gmail/text-parsers.js";
import { buildIntentRouterContextFilter as buildIntentRouterContextFilterDomain } from "./domains/router/context-filter.js";
import {
  type IndexedListReferenceIntent,
  parseIndexedListReferenceIntent as parseIndexedListReferenceIntentDomain,
} from "./domains/router/indexed-list-intent.js";
import {
  IntentRouterStatsRepository,
  buildIntentRouterStatsReport as buildIntentRouterStatsReportDomain,
} from "./domains/router/intent-router-stats.js";
import { IntentConfidenceCalibrator } from "./domains/router/confidence-calibration.js";
import { buildCurationSuggestions } from "./domains/router/curation.js";
import { DynamicIntentRoutesStore } from "./domains/router/dynamic-routes.js";
import { rankIntentCandidatesWithEnsemble } from "./domains/router/ensemble.js";
import { applyIntentRouteLayers, type RouteLayerDecision } from "./domains/router/route-layers.js";
import { resolveIntentRouterAbVariant } from "./domains/router/ab-routing.js";
import { RouterVersionStore } from "./domains/router/router-versioning.js";
import { detectWorkspaceNaturalIntent as detectWorkspaceNaturalIntentDomain } from "./domains/workspace/intents.js";
import {
  detectSimpleTextExtensionHint as detectSimpleTextExtensionHintDomain,
  looksLikeWorkspacePathCandidate as looksLikeWorkspacePathCandidateDomain,
  parseWorkspaceFileIndexReference as parseWorkspaceFileIndexReferenceDomain,
  pickFirstNonEmpty,
} from "./domains/workspace/intent-helpers.js";
import { createWorkspaceTextParsers } from "./domains/workspace/text-parsers.js";
import { WorkspaceFilesService } from "./domains/workspace/workspace-files-service.js";
import { SelfSkillDraftService } from "./selfskill-drafts.js";
import { acquireSingleInstanceLock } from "./single-instance-lock.js";
import { TaskRunner } from "./task-runner.js";
import { splitForTelegram } from "./telegram-utils.js";
import { CoinGeckoApiTool } from "./coingecko-api.js";
import type { WebSearchResult } from "./web-browser.js";
import { WebBrowser } from "./web-browser.js";
import { ObservabilityService } from "./observability.js";
import { ChatMessageQueue } from "./chat-message-queue.js";
import { ConversationLoopDetector } from "./conversation-loop-detector.js";
import { ProgressNoticeService } from "./progress-notices.js";
import { RequestIdempotencyService } from "./request-idempotency.js";
import {
  SqliteStateStore,
  type StoredChatRuntimeSettings,
  type StoredOutboxMessage,
  type StoredPendingApproval,
  type StoredPlannedAction,
  type StoredWorkspaceDeleteConfirmation,
  type StoredWorkspaceDeletePathRequest,
} from "./sqlite-state-store.js";
import {
  isLocalBridgeAuthorized,
  parsePositiveInteger,
  readHttpRequestBody,
  writeJsonResponse,
} from "./local-bridge-http.js";

const agentRegistry = new AgentRegistry(config.agentsDir, config.defaultAgent);
await agentRegistry.load();

const contextMemory = new AgentContextMemory({
  workspaceDir: config.workspaceDir,
  contextFileMaxChars: config.contextFileMaxChars,
  contextTotalMaxChars: config.contextTotalMaxChars,
  memoryMaxResults: config.memoryMaxResults,
  memorySnippetMaxChars: config.memorySnippetMaxChars,
  memoryMaxInjectedChars: config.memoryMaxInjectedChars,
  memoryBackend: config.memoryBackend,
});
await contextMemory.ensureWorkspace();

const documentReader = new DocumentReader({
  baseDir: process.cwd(),
  maxFileBytes: config.docMaxFileBytes,
  maxTextChars: config.docMaxTextChars,
});
const webBrowser = new WebBrowser({
  timeoutMs: config.webFetchTimeoutMs,
  maxFetchBytes: config.webFetchMaxBytes,
  maxTextChars: config.webContentMaxChars,
  defaultSearchResults: config.webSearchMaxResults,
});
const redditApi = new RedditApiTool({
  timeoutMs: config.webFetchTimeoutMs,
});
const coinGeckoApi = new CoinGeckoApiTool({
  timeoutMs: config.webFetchTimeoutMs,
});
const openMeteoApi = new OpenMeteoApiTool({
  timeoutMs: config.webFetchTimeoutMs,
});
const gmailAccount = new GmailAccountService({
  enabled: config.enableGmailAccount,
  clientId: config.gmailClientId,
  clientSecret: config.gmailClientSecret,
  refreshToken: config.gmailRefreshToken,
  accountEmail: config.gmailAccountEmail,
  maxResults: config.gmailMaxResults,
});

acquireSingleInstanceLock();

const taskRunner = new TaskRunner(config.execTimeoutMs, config.maxStdioChars);
const openAi = new OpenAiService();
const semanticIntentRouter = new IntentSemanticRouter({
  hybridAlpha: config.intentRouterHybridAlpha,
  minScoreGap: config.intentRouterMinScoreGap,
});
const dynamicIntentRoutes = new DynamicIntentRoutesStore();
const intentConfidenceCalibrator = new IntentConfidenceCalibrator(10);
const routerVersionStore = new RouterVersionStore();
try {
  await semanticIntentRouter.loadFromFile(config.intentRouterRoutesFile, {
    createIfMissing: true,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logWarn(`No pude cargar intent routes desde archivo, uso defaults: ${message}`);
}
try {
  await dynamicIntentRoutes.loadFromFile(config.intentRouterChatRoutesFile);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/enoent/i.test(message)) {
    logWarn(`No pude cargar intent routes por chat: ${message}`);
  }
}
try {
  await intentConfidenceCalibrator.loadFromFile(config.intentRouterCalibrationFile);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/enoent/i.test(message)) {
    logWarn(`No pude cargar calibración de intent router: ${message}`);
  }
}
try {
  await routerVersionStore.load(config.intentRouterVersionsFile);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/enoent/i.test(message)) {
    logWarn(`No pude cargar versiones de intent router: ${message}`);
  }
}
if (!routerVersionStore.getActiveSnapshot()) {
  routerVersionStore.createSnapshot({
    label: "bootstrap",
    routes: semanticIntentRouter.listRoutes(),
    hybridAlpha: semanticIntentRouter.getHybridAlpha(),
    minScoreGap: semanticIntentRouter.getMinScoreGap(),
  });
  await routerVersionStore.save(config.intentRouterVersionsFile);
}
const adminSecurity = new AdminSecurityController({
  approvalTtlMs: config.adminApprovalTtlSeconds * 1000,
});
const audit = new AuditLogger(config.auditLogPath);
const scheduledTasks = new ScheduledTaskSqliteService({
  dbPath: config.stateDbFile,
});
await scheduledTasks.load();
await scheduledTasks.migrateFromJson(config.scheduleFile);
const emailRecipients = new EmailRecipientsSqliteService({
  dbPath: config.stateDbFile,
});
await emailRecipients.load();
await emailRecipients.migrateFromJson(config.recipientsFile);
const gmailRecipients = new GmailRecipientsManager(emailRecipients, normalizeIntentText);
const selfSkillDrafts = new SelfSkillDraftService({
  filePath: config.selfSkillDraftsFile,
});
await selfSkillDrafts.load();
const interestLearning = new InterestLearningService({
  filePath: config.interestsFile,
});
await interestLearning.load();
const observability = new ObservabilityService();
const sqliteState = new SqliteStateStore(config.stateDbFile);
await sqliteState.init();
const idempotency = new RequestIdempotencyService(sqliteState, config.idempotencyTtlMs);
const policyEngine = new AgentPolicyEngine(config.agentPolicyFile);
await policyEngine.load();
const agenticCanary = new AgenticCanary(config.agenticCanaryPercent);
const domainRegistry = new DomainRegistry();
domainRegistry.register({
  id: "router",
  summary: "Orquestación natural + semántica + calibración",
  capabilities: ["intent-routing", "a-b", "canary", "calibration", "curation"],
  ownerFile: "src/domains/router/*",
});
domainRegistry.register({
  id: "workspace",
  summary: "Operaciones de archivos y carpetas en workspace",
  capabilities: ["list", "read", "write", "move", "rename", "delete", "send"],
  ownerFile: "src/domains/workspace/*",
});
domainRegistry.register({
  id: "gmail",
  summary: "Lectura/envío y gestión de mensajes/recipients",
  capabilities: ["list", "read", "send", "labels", "archive", "trash", "recipients"],
  ownerFile: "src/domains/gmail/*",
});

const activeAgentByChat = new Map<number, string>();
const aiShellModeByChat = new Map<number, boolean>();
const ecoModeByChat = new Map<number, boolean>();
const safeModeByChat = new Map<number, boolean>();
const openAiModelByChat = new Map<number, string>();
const OPENAI_MODELS_BY_COST: Array<{ model: string; tier: "bajo" | "medio" | "alto"; notes: string }> = [
  { model: "gpt-5-nano", tier: "bajo", notes: "ultra económico para tareas simples y alto volumen" },
  { model: "gpt-4.1-nano", tier: "bajo", notes: "muy económico para clasificación/automatizaciones ligeras" },
  { model: "gpt-4o-mini", tier: "bajo", notes: "rápido y económico, recomendado para uso general" },
  { model: "gpt-4.1-mini", tier: "bajo", notes: "económico con buen razonamiento general" },
  { model: "gpt-4.1", tier: "medio", notes: "mejor calidad para tareas exigentes" },
  { model: "gpt-4o", tier: "medio", notes: "muy buen balance multimodal" },
  { model: "o3-mini", tier: "medio", notes: "razonamiento fuerte en costo intermedio" },
  { model: "o3", tier: "alto", notes: "máximo razonamiento, mayor costo" },
  { model: "o1", tier: "alto", notes: "razonamiento profundo, alto costo" },
];
const lastWebResultsByChat = new Map<number, WebSearchResult[]>();
type LastDocumentSnapshot = {
  path: string;
  text: string;
  updatedAt: string;
};
const lastDocumentByChat = new Map<number, LastDocumentSnapshot>();
type LastEmailSnapshot = {
  to: string;
  subject: string;
  body: string;
  sentAt: string;
};
const lastSentEmailByChat = new Map<number, LastEmailSnapshot>();
type AssistantReplySnapshot = {
  text: string;
  source: string;
  atMs: number;
};
type RecentConversationTurn = {
  role: "user" | "assistant";
  text: string;
  source: string;
  atMs: number;
};
const lastAssistantReplyByChat = new Map<number, AssistantReplySnapshot>();
const assistantReplyHistoryByChat = new Map<number, AssistantReplySnapshot[]>();
const recentConversationByChat = new Map<number, RecentConversationTurn[]>();
const intentRouterDatasetFilePath = path.resolve(process.cwd(), config.intentRouterDatasetFile);
const intentRouterStatsRepository = new IntentRouterStatsRepository(intentRouterDatasetFilePath, (message) => logWarn(message));
const lastGmailResultsByChat = new Map<number, GmailMessageSummary[]>();
const lastGmailMessageIdByChat = new Map<number, string>();
const lastListedFilesByChat = new Map<number, Array<{ relPath: string; size: number; modifiedAt: string }>>();
type IndexedListKind = "workspace-list" | "stored-files" | "web-results" | "gmail-list";
type IndexedListItem = {
  index: number;
  label: string;
  reference: string;
  itemType?: "dir" | "file" | "link" | "other";
};
type IndexedListContext = {
  kind: IndexedListKind;
  title: string;
  source: string;
  items: IndexedListItem[];
  createdAtMs: number;
};
const indexedListByChat = new Map<number, IndexedListContext>();
const lastConnectorContextByChat = new Map<number, number>();
let selfUpdateInProgress = false;
let localBridgeServer: Server | null = null;
let outboxRecoveryTimer: NodeJS.Timeout | null = null;
let outboxRecoveryInFlight = false;
let runtimeStatePersistenceTimer: NodeJS.Timeout | null = null;
type PendingWorkspaceDeleteConfirmation = {
  paths: string[];
  requestedAtMs: number;
  expiresAtMs: number;
  source: string;
  userId?: number;
};
type PendingWorkspaceDeletePathRequest = {
  requestedAtMs: number;
  expiresAtMs: number;
  source: string;
  userId?: number;
};
type WorkspaceClipboardState = {
  paths: string[];
  copiedAtMs: number;
  source: string;
  selector?: WorkspaceNameSelector;
};
type PlannedActionKind = "exec" | "gmail-send" | "workspace-delete";
type PendingPlannedAction = {
  id: string;
  kind: PlannedActionKind;
  chatId: number;
  userId?: number;
  requestedAtMs: number;
  expiresAtMs: number;
  summary: string;
  payload: Record<string, unknown>;
};
const pendingWorkspaceDeleteByChat = new Map<number, PendingWorkspaceDeleteConfirmation>();
const pendingWorkspaceDeletePathByChat = new Map<number, PendingWorkspaceDeletePathRequest>();
const workspaceClipboardByChat = new Map<number, WorkspaceClipboardState>();
const pendingPlannedActionsById = new Map<string, PendingPlannedAction>();
const incomingMessageQueue = new ChatMessageQueue();
const conversationLoopDetector = new ConversationLoopDetector();
const progressNoticeService = new ProgressNoticeService();
const lastTaskActivityByChat = new Map<number, { text: string; atMs: number }>();
type StoicSmalltalkSession = {
  expiresAtMs: number;
  turnsRemaining: number;
  lastUserText: string;
  lastReplyText: string;
};
const stoicSmalltalkByChat = new Map<number, StoicSmalltalkSession>();
const DOCUMENT_SEARCH_MAX_DEPTH = 6;
const DOCUMENT_SEARCH_MAX_DIRS = 2000;
const SELF_SKILLS_SECTION_TITLE = "## Dynamic Skills";
const SELF_RESTART_SERVICE_COMMAND = "systemctl restart houdi-agent.service";
const SELF_UPDATE_APPROVAL_COMMAND = "__selfupdate__";
const NEWS_MAX_REDDIT_RESULTS = 2;
const NEWS_MAX_AGE_DAYS = 7;
const NEWS_MAX_SPECIALIZED_DOMAIN_QUERIES = 8;
const CONNECTOR_CONTEXT_TTL_MS = 30 * 60 * 1000;
const RECENT_EMAIL_ROUTER_CONTEXT_TURNS = 3;
const RECENT_INTENT_ROUTER_CONTEXT_TURNS = 3;
const RECENT_CONVERSATION_TURN_LIMIT = 40;
const NATURAL_INTENT_ROUTER_MIN_TEXT_CHARS = 12;
const AI_SEQUENCE_ROUTER_MAX_STEPS = 6;
const WORKSPACE_DELETE_CONFIRM_TTL_MS = 5 * 60 * 1000;
const PLANNED_ACTION_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_DELETE_PATH_PROMPT_TTL_MS = 5 * 60 * 1000;
const INDEXED_LIST_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;
const INDEXED_LIST_ACTION_MAX_ITEMS = 5;
const TASK_ACTIVITY_TTL_MS = 2 * 60 * 1000;
const STOIC_SMALLTALK_TTL_MS = 20 * 60 * 1000;
const STOIC_SMALLTALK_MAX_TURNS = 12;
const ASSISTANT_REPLY_HISTORY_LIMIT = 30;
const SELF_UPDATE_GIT_REMOTE = "origin";
const SELF_UPDATE_STDIO_MAX_CHARS = 12_000;
const SELF_UPDATE_SHORT_TIMEOUT_MS = 45_000;
const SELF_UPDATE_FETCH_TIMEOUT_MS = 120_000;
const SELF_UPDATE_INSTALL_TIMEOUT_MS = 900_000;
const SELF_UPDATE_BUILD_TIMEOUT_MS = 900_000;
const LOCAL_BRIDGE_MESSAGE_PATH = "/internal/cli/message";
const LOCAL_BRIDGE_HEALTH_PATH = "/internal/cli/health";
const LOCAL_BRIDGE_MAX_BODY_BYTES = 512_000;
const OUTBOX_MAX_RETRIES = 5;
const OUTBOX_BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000, 1_800_000];
const OUTBOX_RECOVERY_INTERVAL_MS = 15_000;
const OUTBOX_RECOVERY_BATCH_SIZE = 30;
const RUNTIME_STATE_PERSIST_INTERVAL_MS = 5_000;
const WORKSPACE_SELECTOR_MAX_DEPTH = 10;
const WORKSPACE_SELECTOR_MAX_DIRS = 4000;
const WORKSPACE_SELECTOR_MAX_MATCHES = 200;
const SIMPLE_TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".md",
  ".yml",
  ".yaml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".ini",
  ".log",
]);
const KNOWN_TELEGRAM_COMMANDS = new Set([
  "start",
  "help",
  "version",
  "model",
  "status",
  "doctor",
  "usage",
  "domains",
  "policy",
  "agenticcanary",
  "agent",
  "tasks",
  "kill",
  "agenda",
  "exec",
  "reboot",
  "ask",
  "readfile",
  "askfile",
  "workspace",
  "mkfile",
  "files",
  "images",
  "getfile",
  "web",
  "lim",
  "crypto",
  "weather",
  "reddit",
  "webopen",
  "webask",
  "gmail",
  "remember",
  "memory",
  "interests",
  "suggest",
  "selfskill",
  "selfrestart",
  "selfupdate",
  "eco",
  "safe",
  "shellmode",
  "shell",
  "adminmode",
  "approvals",
  "approve",
  "deny",
  "confirm",
  "cancelplan",
  "outbox",
  "metrics",
  "panic",
  "intentstats",
  "intentfit",
  "intentreload",
  "intentroutes",
  "intentcalibrate",
  "intentcurate",
  "intentab",
  "intentversion",
  "intentcanary",
]);

function buildStoredPendingApprovalRows(): StoredPendingApproval[] {
  return adminSecurity.snapshotApprovals().map((approval) => ({
    id: approval.id,
    kind: approval.kind,
    chatId: approval.chatId,
    userId: approval.userId,
    agentName: approval.agentName,
    commandLine: approval.commandLine,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    ...(approval.note ? { note: approval.note } : {}),
  }));
}

function buildStoredPlannedActionRows(): StoredPlannedAction[] {
  return [...pendingPlannedActionsById.values()].map((planned) => ({
    id: planned.id,
    kind: planned.kind,
    chatId: planned.chatId,
    ...(typeof planned.userId === "number" ? { userId: planned.userId } : {}),
    requestedAtMs: planned.requestedAtMs,
    expiresAtMs: planned.expiresAtMs,
    summary: planned.summary,
    payloadJson: JSON.stringify(planned.payload ?? {}),
  }));
}

function buildStoredWorkspaceDeleteConfirmationRows(): StoredWorkspaceDeleteConfirmation[] {
  return [...pendingWorkspaceDeleteByChat.entries()].map(([chatId, pending]) => ({
    chatId,
    pathsJson: JSON.stringify(pending.paths ?? []),
    requestedAtMs: pending.requestedAtMs,
    expiresAtMs: pending.expiresAtMs,
    source: pending.source,
    ...(typeof pending.userId === "number" ? { userId: pending.userId } : {}),
  }));
}

function buildStoredWorkspaceDeletePathRequestRows(): StoredWorkspaceDeletePathRequest[] {
  return [...pendingWorkspaceDeletePathByChat.entries()].map(([chatId, pending]) => ({
    chatId,
    requestedAtMs: pending.requestedAtMs,
    expiresAtMs: pending.expiresAtMs,
    source: pending.source,
    ...(typeof pending.userId === "number" ? { userId: pending.userId } : {}),
  }));
}

function buildStoredChatRuntimeSettingsRows(): StoredChatRuntimeSettings[] {
  const now = Date.now();
  const chatIds = new Set<number>();
  const adminModes = adminSecurity.snapshotAdminModes();
  const adminByChat = new Map<number, boolean>();
  for (const chatId of activeAgentByChat.keys()) {
    chatIds.add(chatId);
  }
  for (const chatId of aiShellModeByChat.keys()) {
    chatIds.add(chatId);
  }
  for (const chatId of ecoModeByChat.keys()) {
    chatIds.add(chatId);
  }
  for (const chatId of safeModeByChat.keys()) {
    chatIds.add(chatId);
  }
  for (const chatId of openAiModelByChat.keys()) {
    chatIds.add(chatId);
  }
  for (const entry of adminModes) {
    chatIds.add(entry.chatId);
    adminByChat.set(entry.chatId, entry.enabled);
  }

  return [...chatIds]
    .filter((chatId) => Number.isFinite(chatId))
    .sort((a, b) => a - b)
    .map((chatId) => {
      const row: StoredChatRuntimeSettings = {
        chatId,
        updatedAtMs: now,
      };
      const activeAgent = activeAgentByChat.get(chatId)?.trim();
      if (activeAgent) {
        row.activeAgent = activeAgent;
      }
      if (aiShellModeByChat.has(chatId)) {
        row.aiShellMode = Boolean(aiShellModeByChat.get(chatId));
      }
      if (ecoModeByChat.has(chatId)) {
        row.ecoMode = Boolean(ecoModeByChat.get(chatId));
      }
      if (safeModeByChat.has(chatId)) {
        row.safeMode = Boolean(safeModeByChat.get(chatId));
      }
      const openAiModel = openAiModelByChat.get(chatId)?.trim();
      if (openAiModel) {
        row.openAiModel = openAiModel;
      }
      if (adminByChat.has(chatId)) {
        row.adminMode = Boolean(adminByChat.get(chatId));
      }
      return row;
    });
}

function persistRuntimeStateSnapshot(source: string): void {
  try {
    sqliteState.replacePendingApprovals(buildStoredPendingApprovalRows());
    sqliteState.replacePendingPlannedActions(buildStoredPlannedActionRows());
    sqliteState.replaceWorkspaceDeleteConfirmations(buildStoredWorkspaceDeleteConfirmationRows());
    sqliteState.replaceWorkspaceDeletePathRequests(buildStoredWorkspaceDeletePathRequestRows());
    sqliteState.replaceChatRuntimeSettings(buildStoredChatRuntimeSettingsRows());
    sqliteState.upsertGlobalRuntimeSettings({
      panicMode: adminSecurity.isPanicModeEnabled(),
      updatedAtMs: Date.now(),
    });
    observability.increment("runtime_state.persist.ok", 1, { source });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`No pude persistir runtime state (${source}): ${message}`);
    observability.increment("runtime_state.persist.failed", 1, { source });
  }
}

function restoreRuntimeStateSnapshot(): void {
  const now = Date.now();
  try {
    const approvals = sqliteState
      .listPendingApprovals()
      .filter((item) => item.expiresAt > now)
      .map(
        (item): PendingApproval => ({
          id: item.id,
          kind: item.kind as PendingApproval["kind"],
          chatId: item.chatId,
          userId: item.userId,
          agentName: item.agentName,
          commandLine: item.commandLine,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          ...(item.note ? { note: item.note } : {}),
        }),
      );
    adminSecurity.replaceApprovals(approvals);

    const runtimeSettings = sqliteState.listChatRuntimeSettings();
    activeAgentByChat.clear();
    aiShellModeByChat.clear();
    ecoModeByChat.clear();
    safeModeByChat.clear();
    openAiModelByChat.clear();
    const adminModes: Array<{ chatId: number; enabled: boolean }> = [];
    for (const item of runtimeSettings) {
      const chatId = Math.floor(item.chatId);
      if (!Number.isFinite(chatId) || chatId <= 0) {
        continue;
      }
      const activeAgent = item.activeAgent?.trim() ?? "";
      if (activeAgent && agentRegistry.get(activeAgent)) {
        activeAgentByChat.set(chatId, activeAgent);
      }
      if (typeof item.aiShellMode === "boolean") {
        aiShellModeByChat.set(chatId, item.aiShellMode);
      }
      if (typeof item.ecoMode === "boolean") {
        ecoModeByChat.set(chatId, item.ecoMode);
      }
      if (typeof item.safeMode === "boolean") {
        safeModeByChat.set(chatId, item.safeMode);
      }
      const openAiModel = item.openAiModel?.trim() ?? "";
      if (openAiModel && /^[A-Za-z0-9._:-]{2,120}$/.test(openAiModel)) {
        openAiModelByChat.set(chatId, openAiModel);
      }
      if (typeof item.adminMode === "boolean") {
        adminModes.push({ chatId, enabled: item.adminMode });
      }
    }
    adminSecurity.replaceAdminModes(adminModes);
    const globalRuntime = sqliteState.getGlobalRuntimeSettings();
    if (globalRuntime) {
      adminSecurity.setPanicMode(globalRuntime.panicMode);
    }

    pendingPlannedActionsById.clear();
    for (const item of sqliteState.listPendingPlannedActions()) {
      if (item.expiresAtMs <= now) {
        continue;
      }
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(item.payloadJson) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        payload = {};
      }
      pendingPlannedActionsById.set(item.id, {
        id: item.id,
        kind: item.kind as PlannedActionKind,
        chatId: item.chatId,
        ...(typeof item.userId === "number" ? { userId: item.userId } : {}),
        requestedAtMs: item.requestedAtMs,
        expiresAtMs: item.expiresAtMs,
        summary: item.summary,
        payload,
      });
    }

    pendingWorkspaceDeleteByChat.clear();
    for (const item of sqliteState.listWorkspaceDeleteConfirmations()) {
      if (item.expiresAtMs <= now) {
        continue;
      }
      let paths: string[] = [];
      try {
        const parsed = JSON.parse(item.pathsJson) as unknown;
        if (Array.isArray(parsed)) {
          paths = parsed
            .map((entry) => (typeof entry === "string" ? normalizeWorkspaceRelativePath(entry) : ""))
            .filter(Boolean);
        }
      } catch {
        paths = [];
      }
      if (paths.length === 0) {
        continue;
      }
      pendingWorkspaceDeleteByChat.set(item.chatId, {
        paths,
        requestedAtMs: item.requestedAtMs,
        expiresAtMs: item.expiresAtMs,
        source: item.source,
        ...(typeof item.userId === "number" ? { userId: item.userId } : {}),
      });
    }

    pendingWorkspaceDeletePathByChat.clear();
    for (const item of sqliteState.listWorkspaceDeletePathRequests()) {
      if (item.expiresAtMs <= now) {
        continue;
      }
      pendingWorkspaceDeletePathByChat.set(item.chatId, {
        requestedAtMs: item.requestedAtMs,
        expiresAtMs: item.expiresAtMs,
        source: item.source,
        ...(typeof item.userId === "number" ? { userId: item.userId } : {}),
      });
    }

    observability.increment("runtime_state.restore.ok");
    persistRuntimeStateSnapshot("restore-prune");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`No pude restaurar runtime state: ${message}`);
    observability.increment("runtime_state.restore.failed");
  }
}

function startRuntimeStatePersistenceWorker(): void {
  if (runtimeStatePersistenceTimer) {
    return;
  }
  runtimeStatePersistenceTimer = setInterval(() => {
    persistRuntimeStateSnapshot("timer");
  }, RUNTIME_STATE_PERSIST_INTERVAL_MS);
  runtimeStatePersistenceTimer.unref?.();
}

const workspaceFiles = new WorkspaceFilesService(
  config.workspaceDir,
  normalizeWorkspaceRelativePath,
  isSimpleTextFilePath,
  formatBytes,
  safePathExists,
  SIMPLE_TEXT_FILE_EXTENSIONS,
);
const workspaceTextParsers = createWorkspaceTextParsers({
  normalizeIntentText,
  normalizeWorkspaceRelativePath,
  cleanWorkspacePathPhrase,
  extractQuotedSegments,
});
const {
  extractWorkspaceNameSelectorFromSegment,
  extractWorkspaceDeletePathCandidate,
  extractWorkspaceDeleteExtensions,
  extractWorkspaceDeleteContentsPath,
  decodeEscapedInlineText,
  extractNaturalWorkspaceWriteContent,
} = workspaceTextParsers;
const gmailTextParsers = createGmailTextParsers({
  normalizeIntentText,
  extractQuotedSegments,
  normalizeRecipientName,
  truncateInline,
  gmailMaxResults: config.gmailMaxResults,
});
const {
  extractEmailAddresses,
  extractRecipientNameFromText,
  parseGmailLabeledFields,
  detectGmailDraftRequested,
  extractLiteralBodyRequest,
  extractNaturalSubjectRequest,
  detectCreativeEmailCue,
  buildGmailDraftInstruction,
  shouldAvoidLiteralBodyFallback,
  parseNaturalLimit,
  buildNaturalGmailQuery,
} = gmailTextParsers;

function getActiveAgent(chatId: number): string {
  return activeAgentByChat.get(chatId) ?? config.defaultAgent;
}

function setActiveAgent(chatId: number, agentName: string): void {
  activeAgentByChat.set(chatId, agentName);
  persistRuntimeStateSnapshot("runtime:setActiveAgent");
}

function isAiShellModeEnabled(chatId: number): boolean {
  return aiShellModeByChat.get(chatId) ?? false;
}

function setAiShellMode(chatId: number, enabled: boolean): void {
  aiShellModeByChat.set(chatId, enabled);
  persistRuntimeStateSnapshot("runtime:setAiShellMode");
}

function isEcoModeEnabled(chatId: number): boolean {
  return ecoModeByChat.get(chatId) ?? config.ecoModeDefault;
}

function setEcoMode(chatId: number, enabled: boolean): void {
  ecoModeByChat.set(chatId, enabled);
  persistRuntimeStateSnapshot("runtime:setEcoMode");
}

function isSafeModeEnabled(chatId: number): boolean {
  return safeModeByChat.get(chatId) ?? false;
}

function setSafeMode(chatId: number, enabled: boolean): void {
  safeModeByChat.set(chatId, enabled);
  persistRuntimeStateSnapshot("runtime:setSafeMode");
}

function getOpenAiModelForChat(chatId: number): string {
  const custom = openAiModelByChat.get(chatId)?.trim();
  return custom || config.openAiModel;
}

function setOpenAiModelForChat(chatId: number, model: string): void {
  const normalized = model.trim();
  if (!normalized) {
    throw new Error("Modelo vacío");
  }
  if (!/^[A-Za-z0-9._:-]{2,120}$/.test(normalized)) {
    throw new Error("Modelo inválido. Usa letras, números, punto, guion, underscore o dos puntos.");
  }
  openAiModelByChat.set(chatId, normalized);
  persistRuntimeStateSnapshot("runtime:setOpenAiModel");
}

function resetOpenAiModelForChat(chatId: number): void {
  openAiModelByChat.delete(chatId);
  persistRuntimeStateSnapshot("runtime:resetOpenAiModel");
}

function buildOpenAiModelListText(): string {
  const lines = OPENAI_MODELS_BY_COST.map((item, index) => {
    return `${index + 1}. ${item.model} | costo ${item.tier} | ${item.notes}`;
  });
  return ["Modelos sugeridos (menor -> mayor costo):", ...lines].join("\n");
}

function buildOpenAiUsageLines(limit = 6): string[] {
  const snapshot = openAi.getUsageSnapshot();
  const top = snapshot.byModelAndSource.slice(0, Math.max(1, limit));
  const lines = [
    `OpenAI usage (desde proceso): calls=${snapshot.totalCalls} | in=${snapshot.totalInputTokens} | out=${snapshot.totalOutputTokens} | total=${snapshot.totalTokens} | estUSD=${formatUsageUsd(snapshot.estimatedCostUsd)}`,
  ];
  if (top.length === 0) {
    lines.push("OpenAI usage top: sin llamadas registradas");
    return lines;
  }
  lines.push(
    `OpenAI usage top: ${top
      .map(
        (item) =>
          `${item.model}/${item.source} calls=${item.calls} tok=${item.totalTokens} usd=${formatUsageUsd(item.estimatedCostUsd)}`,
      )
      .join(" | ")}`,
  );
  return lines;
}

function buildObservabilityReport(options?: { topCounters?: number; topTimings?: number }): string {
  const topCounters = Math.max(1, Math.min(50, Math.floor(options?.topCounters ?? 12)));
  const topTimings = Math.max(1, Math.min(50, Math.floor(options?.topTimings ?? 8)));
  const snapshot = observability.snapshot();
  const counters = [...snapshot.counters]
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, topCounters);
  const timings = [...snapshot.timings]
    .sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, topTimings);
  const queueTop = incomingMessageQueue.snapshot(8);
  const outboxPending = sqliteState.listOutboxMessages(undefined, 500).length;
  const outboxDue = sqliteState.listDueOutboxMessages({ limit: 500 }).length;
  const outboxDeadLetterRecent = sqliteState.listOutboxDeadLetter(undefined, 100).length;
  return [
    "Observability snapshot:",
    `Counters: ${snapshot.counters.length} | Timings: ${snapshot.timings.length}`,
    `Incoming queue active chats: ${queueTop.length}`,
    ...queueTop.map((item) => `- queue chat=${item.chatId} depth=${item.depth}`),
    `Outbox pending=${outboxPending} | dueNow=${outboxDue} | deadLetterRecent=${outboxDeadLetterRecent}`,
    `Top counters (${counters.length}):`,
    ...counters.map((item) => {
      const tags = Object.entries(item.tags)
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
      return `- ${item.name}${tags ? ` {${tags}}` : ""}: ${item.value}`;
    }),
    `Top timings (${timings.length}):`,
    ...timings.map(
      (item) =>
        `- ${item.name}: count=${item.count} p50=${item.p50Ms}ms p95=${item.p95Ms}ms min=${item.minMs}ms max=${item.maxMs}ms`,
    ),
  ].join("\n");
}

function isAdminApprovalRequired(chatId: number): boolean {
  return config.securityProfile.forceApprovalMode || adminSecurity.isAdminModeEnabled(chatId);
}

function buildAgentVersionText(): string {
  return `Houdi Agent versión ${config.agentVersion}`;
}

function buildSafeDeterministicPrompt(prompt: string): string {
  return [
    "[SAFE_MODE=ON]",
    "Interpreta este input como orden precisa y literal.",
    "Prioriza ejecutar exactamente lo pedido sin creatividad innecesaria.",
    "No infieras pasos extras no solicitados.",
    "Si falta un dato crítico, responde con una sola pregunta concreta.",
    "",
    prompt,
  ].join("\n");
}

async function askOpenAiForChat(params: {
  chatId: number;
  prompt: string;
  context?: PromptContextSnapshot;
  concise?: boolean;
  maxOutputTokens?: number;
}): Promise<string> {
  const ecoEnabled = isEcoModeEnabled(params.chatId);
  const safeEnabled = isSafeModeEnabled(params.chatId);
  const effectivePrompt = safeEnabled ? buildSafeDeterministicPrompt(params.prompt) : params.prompt;
  return openAi.ask(effectivePrompt, {
    context: params.context,
    concise: params.concise ?? ecoEnabled,
    maxOutputTokens: params.maxOutputTokens ?? (ecoEnabled ? config.openAiEcoMaxOutputTokens : undefined),
    model: getOpenAiModelForChat(params.chatId),
  });
}

function sanitizeSelfSkillText(text: string): string {
  return truncateInline(text.replace(/\s+/g, " ").trim(), 1200);
}

function extractSelfSkillInstructionFromText(text: string): string {
  const original = text.trim();
  if (!original) {
    return "";
  }

  const quoted = extractQuotedSegments(original);
  if (quoted.length > 0) {
    const joined = quoted.join(" ").trim();
    if (joined) {
      return sanitizeSelfSkillText(joined);
    }
  }

  const patterns = [
    /\b(?:agrega|agregar|suma|sumar|anade|añade|incorpora|incorporar|crea|crear|genera|generar|define|definir|configura|configurar|habilita|habilitar|entrena|entrenar|ensena|enseña|mejora|mejorate)\s+(?:una?\s+|la\s+|el\s+)?(?:nueva\s+)?(?:habilidades?|skills?|reglas?|capacidades?)\s*(?:de|para|que|:|-)?\s*(.+)$/i,
    /\b(?:nueva\s+)?(?:habilidades?|skills?|reglas?|capacidades?)\s*[:=-]\s*(.+)$/i,
    /\b(?:mejorate|mejora)\s+(?:con|para)\s+(.+)$/i,
    /\b(?:crear|crea|sumar|suma|agregar|agrega)\s+skill\s+(?:de|para|que|:|-)?\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const extracted = original.match(pattern)?.[1]?.trim();
    if (!extracted) {
      continue;
    }
    const cleaned = extracted
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^(de|para|que|sobre|acerca de)\s+/i, "")
      .trim();
    if (cleaned) {
      return sanitizeSelfSkillText(cleaned);
    }
  }

  return "";
}

function isSkillDraftMultiMessageRequested(textNormalized: string): boolean {
  return (
    /\b(varios mensajes|en varios mensajes|por partes|en partes|paso a paso|de a poco)\b/.test(textNormalized) &&
    /\b(skill|skills|habilidad|habilidades|regla|reglas|capacidad|capacidades)\b/.test(textNormalized)
  );
}

function isSkillDraftCommitRequested(textNormalized: string): boolean {
  return /\b(listo|aplica|aplicalo|aplicar|finaliza|finalizar|termina|terminar|guarda|guardar|crea|crear)\b/.test(
    textNormalized,
  );
}

function isSkillDraftCancelRequested(textNormalized: string): boolean {
  return /\b(cancela|cancelar|descarta|descartar|olvida|olvidar|aborta|abortar)\b/.test(textNormalized);
}

function isSkillDraftShowRequested(textNormalized: string): boolean {
  return (
    /\b(ver|mostrar|mostrame|muestrame|estado|resumen)\b/.test(textNormalized) &&
    /\b(borrador|draft|skill|habilidad)\b/.test(textNormalized)
  );
}

function formatSelfSkillDraftLines(lines: string[]): string {
  if (lines.length === 0) {
    return "(vacio)";
  }
  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

function parseDynamicSkillsFromAgentsFile(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === SELF_SKILLS_SECTION_TITLE);
  if (start === -1) {
    return [];
  }

  const entries: string[] = [];
  for (let idx = start + 1; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    const cleaned = line.trim();
    if (!cleaned) {
      continue;
    }
    entries.push(cleaned);
  }
  return entries;
}

async function appendDynamicSkillInstruction(instruction: string): Promise<{ relPath: string; entry: string }> {
  const cleaned = sanitizeSelfSkillText(instruction);
  if (!cleaned) {
    throw new Error("Instrucción vacía");
  }

  const relPath = "AGENTS.md";
  const fullPath = path.join(config.workspaceDir, relPath);
  await fs.mkdir(config.workspaceDir, { recursive: true });

  let current = "";
  try {
    current = await fs.readFile(fullPath, "utf8");
  } catch {
    current = "# AGENTS.md\n";
  }

  const timestamp = new Date().toISOString().slice(0, 19);
  const entry = `- [${timestamp}] ${cleaned}`;
  const entries = parseDynamicSkillsFromAgentsFile(current);

  if (entries.length === 0) {
    const next = `${current.trimEnd()}\n\n${SELF_SKILLS_SECTION_TITLE}\n${entry}\n`;
    await fs.writeFile(fullPath, next, "utf8");
  } else {
    const lines = current.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === SELF_SKILLS_SECTION_TITLE);
    let end = lines.length;
    for (let idx = start + 1; idx < lines.length; idx += 1) {
      if (/^##\s+/.test((lines[idx] ?? "").trim())) {
        end = idx;
        break;
      }
    }
    const nextLines = [...lines.slice(0, end), entry, ...lines.slice(end)];
    await fs.writeFile(fullPath, `${nextLines.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
  }

  return { relPath: relPath.replace(/\\/g, "/"), entry };
}

async function listDynamicSkillInstructions(): Promise<{ relPath: string; entries: string[] }> {
  const relPath = "AGENTS.md";
  const fullPath = path.join(config.workspaceDir, relPath);
  let content = "";
  try {
    content = await fs.readFile(fullPath, "utf8");
  } catch {
    return { relPath, entries: [] };
  }
  const entries = parseDynamicSkillsFromAgentsFile(content);
  return {
    relPath,
    entries,
  };
}

async function removeDynamicSkillInstruction(inputIndex: number): Promise<{
  relPath: string;
  removedEntry: string;
  removedIndex: number;
  remaining: number;
}> {
  if (!Number.isFinite(inputIndex) || inputIndex === 0) {
    throw new Error("Índice inválido");
  }

  const relPath = "AGENTS.md";
  const fullPath = path.join(config.workspaceDir, relPath);
  let content = "";
  try {
    content = await fs.readFile(fullPath, "utf8");
  } catch {
    throw new Error("No existe AGENTS.md para editar");
  }

  const lines = content.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === SELF_SKILLS_SECTION_TITLE);
  if (sectionStart < 0) {
    throw new Error("No hay sección Dynamic Skills");
  }

  let sectionEnd = lines.length;
  for (let idx = sectionStart + 1; idx < lines.length; idx += 1) {
    if (/^##\s+/.test((lines[idx] ?? "").trim())) {
      sectionEnd = idx;
      break;
    }
  }

  const entryLineIndexes: number[] = [];
  const entryLines: string[] = [];
  for (let idx = sectionStart + 1; idx < sectionEnd; idx += 1) {
    const cleaned = (lines[idx] ?? "").trim();
    if (!cleaned) {
      continue;
    }
    entryLineIndexes.push(idx);
    entryLines.push(cleaned);
  }

  if (entryLineIndexes.length === 0) {
    throw new Error("No hay habilidades dinámicas para eliminar");
  }

  const targetPosition = inputIndex === -1 ? entryLineIndexes.length - 1 : inputIndex - 1;
  if (targetPosition < 0 || targetPosition >= entryLineIndexes.length) {
    throw new Error(`Índice fuera de rango (1..${entryLineIndexes.length})`);
  }

  const removedIndex = targetPosition + 1;
  const removedEntry = entryLines[targetPosition] ?? "";
  const removeLineAt = entryLineIndexes[targetPosition]!;

  lines.splice(removeLineAt, 1);
  const nextContent = `${lines.join("\n").replace(/\n+$/g, "")}\n`;
  await fs.writeFile(fullPath, nextContent, "utf8");

  return {
    relPath,
    removedEntry,
    removedIndex,
    remaining: entryLineIndexes.length - 1,
  };
}

type IncomingAudio = {
  kind: "voice" | "audio" | "document";
  fileId: string;
  fileSize?: number;
  fileName: string;
  mimeType?: string;
  caption?: string;
};

type IncomingImage = {
  kind: "photo" | "document";
  fileId: string;
  fileSize?: number;
  fileName: string;
  mimeType?: string;
  caption?: string;
  messageId: number;
};

type IncomingWorkspaceFile = {
  fileId: string;
  fileSize?: number;
  fileName: string;
  mimeType?: string;
  caption?: string;
  messageId: number;
};

type ParsedPathArgument = {
  path: string;
  rest: string;
};

type DocumentIntent = {
  shouldHandle: boolean;
  references: string[];
  preferWorkspace: boolean;
  analysisRequested: boolean;
  readRequested: boolean;
};

type WebIntent = {
  shouldHandle: boolean;
  mode: "search" | "open";
  query: string;
  url?: string;
  analysisRequested: boolean;
  listRequested: boolean;
  newsRequested: boolean;
};

type NewsVertical =
  | "football"
  | "finance"
  | "technology"
  | "science"
  | "robotics"
  | "automation"
  | "ai"
  | "marketing"
  | "general";

type CuratedNewsDomains = {
  es: string[];
  en: string[];
};

type SelfMaintenanceIntent = {
  shouldHandle: boolean;
  action?: "add-skill" | "delete-skill" | "list-skills" | "restart-service" | "update-service";
  instruction?: string;
  skillIndex?: number;
};

type ConnectorNaturalAction = "status" | "start" | "stop" | "restart" | "query";

type ConnectorNaturalIntent = {
  shouldHandle: boolean;
  action?: ConnectorNaturalAction;
  includeTunnel?: boolean;
  firstName?: string;
  lastName?: string;
  sourceName?: string;
  count?: number;
  prospectOnly?: boolean;
};

type ScheduleNaturalAction = "create" | "list" | "delete" | "edit";

type ScheduleNaturalIntent = {
  shouldHandle: boolean;
  action?: ScheduleNaturalAction;
  taskRef?: string;
  taskTitle?: string;
  dueAt?: Date;
  scheduleEmail?: boolean;
  emailTo?: string;
  emailInstruction?: string;
};

type WorkspaceNameSelectorMode = "startsWith" | "contains" | "exact";

type WorkspaceNameSelector = {
  mode: WorkspaceNameSelectorMode;
  value: string;
  scopePath?: string;
};

type WorkspaceNaturalAction = "list" | "mkdir" | "move" | "rename" | "copy" | "paste" | "delete" | "send" | "write";

type WorkspaceNaturalIntent = {
  shouldHandle: boolean;
  action?: WorkspaceNaturalAction;
  path?: string;
  sourcePath?: string;
  targetPath?: string;
  selector?: WorkspaceNameSelector;
  deleteExtensions?: string[];
  deleteContentsOfPath?: string;
  append?: boolean;
  fileIndex?: number;
  content?: string;
  formatHint?: string;
};

type MemoryNaturalAction = "status" | "recall";

type MemoryNaturalIntent = {
  shouldHandle: boolean;
  action?: MemoryNaturalAction;
  query?: string;
};

type GmailNaturalAction =
  | "status"
  | "profile"
  | "list"
  | "read"
  | "send"
  | "markread"
  | "markunread"
  | "trash"
  | "untrash"
  | "star"
  | "unstar";

type GmailNaturalIntent = {
  shouldHandle: boolean;
  action?: GmailNaturalAction;
  query?: string;
  limit?: number;
  messageId?: string;
  messageIndex?: number;
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  draftRequested?: boolean;
  draftInstruction?: string;
  forceAiByMissingSubject?: boolean;
  autoContentKind?: "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last";
  recipientName?: string;
};

type GmailRecipientNaturalAction = "list" | "add" | "update" | "delete";

type GmailRecipientNaturalIntent = {
  shouldHandle: boolean;
  action?: GmailRecipientNaturalAction;
  name?: string;
  email?: string;
};

type NaturalIntentHandlerName =
  | "stoic-smalltalk"
  | "self-maintenance"
  | "connector"
  | "schedule"
  | "memory"
  | "gmail-recipients"
  | "gmail"
  | "workspace"
  | "document"
  | "web"
  | "none";

type IntentRouterFilterDecision = {
  allowed: Exclude<NaturalIntentHandlerName, "none">[];
  reason: string;
};

type IntentRouterDatasetEntry = {
  ts: string;
  chatId: number;
  userId?: number;
  source: string;
  text: string;
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
  routeCandidates: string[];
  routeFilterReason?: string;
  routeFilterAllowed?: string[];
  semantic?: {
    handler: string;
    score: number;
    reason: string;
    alternatives: Array<{ name: string; score: number }>;
  };
  ai?: {
    handler: NaturalIntentHandlerName;
    reason?: string;
  };
  semanticCalibratedConfidence?: number;
  semanticGap?: number;
  routerAbVariant?: "A" | "B";
  routerCanaryVersion?: string;
  routerLayers?: string[];
  routerLayerReason?: string;
  routerEnsembleTop?: Array<{ name: string; score: number }>;
  finalHandler: Exclude<NaturalIntentHandlerName, "none"> | "indexed-list-reference" | "none";
  handled: boolean;
};

type AiSequencePlanStep = {
  instruction: string;
  aiContentPrompt?: string;
};

type DurableUserFact = {
  key: string;
  value: string;
};

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = " [...truncado]";
  const usable = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, usable)}${marker}`;
}

function rememberIndexedListContext(params: {
  chatId: number;
  kind: IndexedListKind;
  title: string;
  source: string;
  items: Array<Omit<IndexedListItem, "index">>;
}): void {
  const items = params.items
    .slice(0, 200)
    .map((item, index) => ({
      index: index + 1,
      label: truncateInline(item.label, 220),
      reference: item.reference,
      ...(item.itemType ? { itemType: item.itemType } : {}),
    }))
    .filter((item) => item.reference.trim().length > 0);
  if (items.length === 0) {
    indexedListByChat.delete(params.chatId);
    try {
      sqliteState.deleteIndexedListContext(params.chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`No pude limpiar indexed list en SQLite: ${message}`);
    }
    return;
  }
  const context: IndexedListContext = {
    kind: params.kind,
    title: params.title,
    source: params.source,
    items,
    createdAtMs: Date.now(),
  };
  indexedListByChat.set(params.chatId, context);
  try {
    sqliteState.upsertIndexedListContext({
      chatId: params.chatId,
      kind: context.kind,
      title: context.title,
      source: context.source,
      itemsJson: JSON.stringify(context.items),
      createdAtMs: context.createdAtMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`No pude persistir indexed list en SQLite: ${message}`);
  }
}

function getIndexedListContext(chatId: number): IndexedListContext | null {
  let context = indexedListByChat.get(chatId);
  if (!context) {
    try {
      const stored = sqliteState.getIndexedListContext(chatId);
      if (stored) {
        const parsed = JSON.parse(stored.itemsJson) as IndexedListItem[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          context = {
            kind: stored.kind as IndexedListKind,
            title: stored.title,
            source: stored.source,
            items: parsed,
            createdAtMs: stored.createdAtMs,
          };
          indexedListByChat.set(chatId, context);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`No pude leer indexed list desde SQLite: ${message}`);
    }
  }
  if (!context) {
    return null;
  }
  if (Date.now() - context.createdAtMs > INDEXED_LIST_CONTEXT_TTL_MS) {
    indexedListByChat.delete(chatId);
    try {
      sqliteState.deleteIndexedListContext(chatId);
    } catch {
      // best effort
    }
    return null;
  }
  return context;
}

function parseIndexedListReferenceIntent(text: string): IndexedListReferenceIntent {
  return parseIndexedListReferenceIntentDomain(text, normalizeIntentText);
}

function rememberWorkspaceListContext(params: {
  chatId: number;
  relPath: string;
  entries: Array<{ name: string; kind: "dir" | "file" | "link" | "other" }>;
  source: string;
}): void {
  const base = normalizeWorkspaceRelativePath(params.relPath) || "";
  const items = params.entries.map((entry) => {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    const normalized = normalizeWorkspaceRelativePath(relative) || "";
    return {
      label: entry.kind === "dir" ? `${entry.name}/` : entry.name,
      reference: normalized,
      itemType: entry.kind,
    } satisfies Omit<IndexedListItem, "index">;
  });
  rememberIndexedListContext({
    chatId: params.chatId,
    kind: "workspace-list",
    title: `Contenido de ${params.relPath}`,
    source: params.source,
    items,
  });
}

function rememberStoredFilesListContext(params: {
  chatId: number;
  title: string;
  items: Array<{ relPath: string }>;
  source: string;
}): void {
  rememberIndexedListContext({
    chatId: params.chatId,
    kind: "stored-files",
    title: params.title,
    source: params.source,
    items: params.items.map((item) => ({
      label: item.relPath,
      reference: item.relPath,
      itemType: "file",
    })),
  });
}

function rememberWebResultsListContext(params: {
  chatId: number;
  title: string;
  hits: WebSearchResult[];
  source: string;
}): void {
  rememberIndexedListContext({
    chatId: params.chatId,
    kind: "web-results",
    title: params.title,
    source: params.source,
    items: params.hits.map((hit) => ({
      label: hit.title || resolveWebResultDomain(hit.url),
      reference: hit.url,
    })),
  });
}

function rememberGmailListContext(params: {
  chatId: number;
  title: string;
  messages: GmailMessageSummary[];
  source: string;
}): void {
  rememberIndexedListContext({
    chatId: params.chatId,
    kind: "gmail-list",
    title: params.title,
    source: params.source,
    items: params.messages.map((message) => ({
      label: message.subject || "(sin asunto)",
      reference: message.id,
    })),
  });
}

function summarizeMemorySnippetForRecall(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^\s*[-*]\s*\[(\d{2}:\d{2}:\d{2})\]\s*(USER|ASSISTANT):\s*/i, "")
    .replace(/^\s*\[(WEBASK|WEBOPEN|ASKFILE)\]\s*/i, "")
    .replace(/^\s*(USER|ASSISTANT):\s*/i, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateInline(cleaned || "(sin texto útil)", 240);
}

function buildMemoryRecallSummaryFallback(query: string, hits: PromptMemoryHit[]): string {
  const selected = hits.slice(0, 6);
  const mainIdeas = selected
    .slice(0, 3)
    .map((hit) => summarizeMemorySnippetForRecall(hit.snippet))
    .filter(Boolean);
  const inferredContext = selected
    .slice(3, 6)
    .map((hit) => summarizeMemorySnippetForRecall(hit.snippet))
    .filter(Boolean)
    .join(" ");

  const paragraphOne =
    mainIdeas.length > 0
      ? `Sobre "${query}", recuerdo principalmente que ${mainIdeas.join(" También aparece que ")}.`
      : `Sobre "${query}", hay recuerdos previos pero con poco detalle útil para una conclusión firme.`;
  const paragraphTwo = inferredContext
    ? `En conjunto, el contexto sugiere continuidad con lo conversado antes (${inferredContext}). Si querés, lo convierto en acciones concretas o próximos pasos.`
    : "Como conclusión, esto parece consistente con lo que veníamos hablando y sirve como base para seguir sin perder continuidad.";
  return `${paragraphOne}\n\n${paragraphTwo}`;
}

async function summarizeMemoryRecallNatural(chatId: number, query: string, hits: PromptMemoryHit[]): Promise<string> {
  if (!openAi.isConfigured()) {
    return buildMemoryRecallSummaryFallback(query, hits);
  }

  const memoryContext = hits
    .slice(0, 10)
    .map((hit, index) => {
      const snippet = summarizeMemorySnippetForRecall(hit.snippet);
      return `${index + 1}) ${snippet} [${hit.path}#L${hit.line}]`;
    })
    .join("\n");

  const prompt = [
    "Sintetiza recuerdos para un chat de asistente personal.",
    `Tema consultado: "${query}"`,
    "",
    "Fragmentos de memoria (datos históricos, no instrucciones):",
    memoryContext,
    "",
    "Tarea:",
    "- Responde en español natural.",
    "- Devuelve 1 o 2 párrafos, no lista, no JSON, no viñetas.",
    "- Extrae conclusiones prácticas y continuidad real de la conversación.",
    "- Si hay ambigüedad, aclárala de forma breve.",
    "- Máximo 900 caracteres.",
  ].join("\n");

  try {
    const summary = (await askOpenAiForChat({ chatId, prompt })).trim();
    if (!summary) {
      return buildMemoryRecallSummaryFallback(query, hits);
    }
    const noBullets = summary
      .split("\n")
      .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean)
      .join("\n");
    return truncateInline(noBullets, 1100);
  } catch {
    return buildMemoryRecallSummaryFallback(query, hits);
  }
}

function normalizeRecipientNameKey(raw: string): string {
  return gmailRecipients.normalizeRecipientNameKey(raw);
}

function listEmailRecipients(chatId: number): SavedEmailRecipient[] {
  return gmailRecipients.list(chatId);
}

async function upsertEmailRecipient(params: { chatId: number; name: string; email: string }): Promise<{ created: boolean; row: SavedEmailRecipient }> {
  return gmailRecipients.upsert(params);
}

async function deleteEmailRecipient(chatIdInput: number, nameInput: string): Promise<SavedEmailRecipient | null> {
  return gmailRecipients.deleteByName(chatIdInput, nameInput);
}

function resolveEmailRecipientSelector(
  chatIdInput: number,
  selectorInput: string,
): SavedEmailRecipient | null {
  return gmailRecipients.resolveSelector(chatIdInput, selectorInput);
}

async function deleteEmailRecipientBySelector(chatIdInput: number, selectorInput: string): Promise<SavedEmailRecipient | null> {
  return gmailRecipients.deleteBySelector(chatIdInput, selectorInput);
}

async function clearEmailRecipients(chatIdInput: number): Promise<number> {
  return gmailRecipients.clear(chatIdInput);
}

async function updateEmailRecipientBySelector(params: {
  chatId: number;
  selector: string;
  nextName?: string;
  nextEmail?: string;
}): Promise<{ previous: SavedEmailRecipient; row: SavedEmailRecipient } | null> {
  return gmailRecipients.updateBySelector(params);
}

function resolveEmailRecipient(chatIdInput: number, nameInput: string): SavedEmailRecipient | null {
  return resolveEmailRecipientSelector(chatIdInput, nameInput);
}

function cleanDurableFactValue(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\b(?:porfa|por favor|acordate|recorda(?:lo|r)?|recuerda(?:lo|r)?)\b.*$/i, "")
    .replace(/[.?!,;:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pushDurableUserFact(
  factsByKey: Map<string, DurableUserFact>,
  key: string,
  rawValue: string,
  maxWords: number = 14,
): void {
  const value = cleanDurableFactValue(rawValue);
  if (!value) {
    return;
  }
  if (value.split(/\s+/).length > maxWords) {
    return;
  }
  if (/^(no se|ninguno|ningun|ninguna|n\/a)$/i.test(value)) {
    return;
  }
  factsByKey.set(key, { key, value });
}

function extractDurableUserFacts(text: string): DurableUserFact[] {
  const original = text.trim();
  if (!original) {
    return [];
  }
  const normalized = normalizeIntentText(original);
  const factsByKey = new Map<string, DurableUserFact>();

  let rawValue = "";
  if (/\bmi\s+equipo(?:\s+de\s+futbol)?\b/.test(normalized)) {
    rawValue =
      original.match(/\bmi\s+equipo(?:\s+de\s+f[uú]tbol)?\s*(?:es|era|seria|sería|se\s+llama|:|-)?\s*(.+)$/i)?.[1] ?? "";
  }
  if (!rawValue && /\b(?:soy|me\s+hice)\s+hincha\s+de\b/.test(normalized)) {
    rawValue = original.match(/\b(?:soy|me\s+hice)\s+hincha\s+de\s+(.+)$/i)?.[1] ?? "";
  }
  if (!rawValue && /\bmi\s+club(?:\s+de\s+futbol)?\b/.test(normalized)) {
    rawValue =
      original.match(/\bmi\s+club(?:\s+de\s+f[uú]tbol)?\s*(?:es|favorito\s+es|:|-)?\s*(.+)$/i)?.[1] ?? "";
  }
  if (rawValue) {
    pushDurableUserFact(factsByKey, "equipo_futbol", rawValue, 10);
  }

  const locationRaw =
    original.match(/\b(?:estoy|vivo|resido)\s+en\s+(.+)$/i)?.[1] ??
    original.match(/\b(?:soy|vengo)\s+de\s+(.+)$/i)?.[1] ??
    "";
  if (locationRaw) {
    pushDurableUserFact(factsByKey, "ubicacion", locationRaw, 10);
  }

  const explicitEmail = original.match(/\bmi\s+(?:correo|email|mail)\s+(?:es|:)\s*([^\s]+@[^\s]+)\b/i)?.[1] ?? "";
  if (explicitEmail) {
    pushDurableUserFact(factsByKey, "email_principal", explicitEmail, 3);
  }

  if (/\b(lenguaje\s+natural|natural)\b/.test(normalized) && /\b(prefiero|quiero|usa|usar|habla|hablar)\b/.test(normalized)) {
    pushDurableUserFact(factsByKey, "preferencia_interaccion", "usar lenguaje natural", 6);
  }
  if (/\b(evita|sin)\b/.test(normalized) && /\b(comandos?|slash|barra)\b/.test(normalized)) {
    pushDurableUserFact(factsByKey, "preferencia_interaccion", "evitar comandos explicitos", 6);
  }

  return [...factsByKey.values()];
}

function parsePathArgument(input: string): ParsedPathArgument | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  const firstChar = raw[0];
  if (firstChar === '"' || firstChar === "'") {
    const quote = firstChar;
    let idx = 1;
    let value = "";
    while (idx < raw.length) {
      const current = raw[idx];
      if (current === "\\") {
        const next = raw[idx + 1];
        if (typeof next === "string") {
          value += next;
          idx += 2;
          continue;
        }
      }
      if (current === quote) {
        const rest = raw.slice(idx + 1).trim();
        return { path: value.trim(), rest };
      }
      value += current;
      idx += 1;
    }
    return null;
  }

  const firstToken = raw.split(/\s+/, 1)[0]?.trim() ?? "";
  if (!firstToken) {
    return null;
  }
  const rest = raw.slice(firstToken.length).trim();
  return { path: firstToken, rest };
}

function extractTelegramCommandName(text: string): string {
  const command = text.trim().match(/^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?\b/i)?.[1] ?? "";
  return command.toLowerCase();
}

function parseQuotedArgs(input: string): string[] {
  const raw = input.trim();
  if (!raw) {
    return [];
  }

  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of raw) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Hay comillas sin cerrar en el comando.");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function parseLooseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value === "undefined") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "si", "sí"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Valor booleano inválido: ${value}`);
}

function parseKeyValueOptions(tokens: string[]): { args: string[]; options: Record<string, string> } {
  const args: string[] = [];
  const options: Record<string, string> = {};
  for (const token of tokens) {
    const match = token.match(/^([a-z][a-z0-9_-]*)=(.+)$/i);
    if (!match) {
      args.push(token);
      continue;
    }
    const key = match[1]?.toLowerCase().trim();
    const value = match[2]?.trim();
    if (!key || !value) {
      args.push(token);
      continue;
    }
    options[key] = value;
  }
  return { args, options };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


function formatWorkspaceSelector(selector: WorkspaceNameSelector): string {
  const head =
    selector.mode === "startsWith"
      ? `empieza con "${selector.value}"`
      : selector.mode === "contains"
        ? `contiene "${selector.value}"`
        : `se llama "${selector.value}"`;
  if (selector.scopePath) {
    return `${head} en workspace/${selector.scopePath}`;
  }
  return `${head} en workspace`;
}

function workspaceFileNameMatchesSelector(fileName: string, selector: WorkspaceNameSelector): boolean {
  const name = normalizeIntentText(fileName);
  const query = normalizeIntentText(selector.value);
  if (!query) {
    return false;
  }
  if (selector.mode === "startsWith") {
    return name.startsWith(query);
  }
  if (selector.mode === "contains") {
    return name.includes(query);
  }
  const baseName = normalizeIntentText(path.parse(fileName).name);
  return name === query || baseName === query;
}

async function findWorkspaceFilesBySelector(
  selector: WorkspaceNameSelector,
  options?: { includeDirs?: boolean },
): Promise<{
  scopeRelPath: string;
  matches: Array<{ path: string; relPath: string }>;
  truncated: boolean;
}> {
  const scopeNormalized = normalizeWorkspaceRelativePath(selector.scopePath ?? "");
  const scope = resolveWorkspacePath(scopeNormalized);
  let scopeStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    scopeStat = await fs.stat(scope.fullPath);
  } catch {
    throw new Error(`No existe la carpeta base: ${scope.relPath}`);
  }

  const startDir = scopeStat.isDirectory() ? scope.fullPath : path.dirname(scope.fullPath);
  const baseWorkspace = path.resolve(config.workspaceDir);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: startDir, depth: 0 }];
  const seen = new Set<string>();
  const matches: Array<{ path: string; relPath: string }> = [];
  let truncated = false;
  let scannedDirs = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.dir)) {
      continue;
    }
    seen.add(current.dir);
    scannedDirs += 1;
    if (scannedDirs > WORKSPACE_SELECTOR_MAX_DIRS) {
      truncated = true;
      break;
    }

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (options?.includeDirs && workspaceFileNameMatchesSelector(entry.name, selector)) {
          const relative = path.relative(baseWorkspace, full).replace(/\\/g, "/");
          if (relative && !relative.startsWith("..")) {
            const normalized = normalizeWorkspaceRelativePath(relative);
            if (normalized) {
              matches.push({
                path: normalized,
                relPath: `workspace/${normalized}`,
              });
              if (matches.length >= WORKSPACE_SELECTOR_MAX_MATCHES) {
                truncated = true;
                break;
              }
            }
          }
        }
        if (current.depth < WORKSPACE_SELECTOR_MAX_DEPTH) {
          queue.push({ dir: full, depth: current.depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!workspaceFileNameMatchesSelector(entry.name, selector)) {
        continue;
      }
      const relative = path.relative(baseWorkspace, full).replace(/\\/g, "/");
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      const normalized = normalizeWorkspaceRelativePath(relative);
      if (!normalized) {
        continue;
      }
      matches.push({
        path: normalized,
        relPath: `workspace/${normalized}`,
      });
      if (matches.length >= WORKSPACE_SELECTOR_MAX_MATCHES) {
        truncated = true;
        break;
      }
    }
    if (matches.length >= WORKSPACE_SELECTOR_MAX_MATCHES) {
      break;
    }
  }

  return {
    scopeRelPath: resolveWorkspacePath(scopeNormalized).relPath,
    matches,
    truncated,
  };
}

async function findWorkspaceFilesByExtensions(params: {
  extensions: string[];
  scopePath?: string;
}): Promise<{
  scopeRelPath: string;
  matches: Array<{ path: string; relPath: string }>;
  truncated: boolean;
}> {
  const normalizedExts = Array.from(
    new Set(
      params.extensions
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => (item.startsWith(".") ? item : `.${item}`))
        .map((item) => item.replace(/[^.a-z0-9]/g, ""))
        .filter((item) => /^\.[a-z0-9]{1,12}$/.test(item)),
    ),
  );
  if (normalizedExts.length === 0) {
    return {
      scopeRelPath: resolveWorkspacePath(params.scopePath ?? "").relPath,
      matches: [],
      truncated: false,
    };
  }

  const scopeNormalized = normalizeWorkspaceRelativePath(params.scopePath ?? "");
  const scope = resolveWorkspacePath(scopeNormalized);
  let scopeStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    scopeStat = await fs.stat(scope.fullPath);
  } catch {
    throw new Error(`No existe la carpeta base: ${scope.relPath}`);
  }

  const startDir = scopeStat.isDirectory() ? scope.fullPath : path.dirname(scope.fullPath);
  const baseWorkspace = path.resolve(config.workspaceDir);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: startDir, depth: 0 }];
  const seen = new Set<string>();
  const matches: Array<{ path: string; relPath: string }> = [];
  let truncated = false;
  let scannedDirs = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.dir)) {
      continue;
    }
    seen.add(current.dir);
    scannedDirs += 1;
    if (scannedDirs > WORKSPACE_SELECTOR_MAX_DIRS) {
      truncated = true;
      break;
    }

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < WORKSPACE_SELECTOR_MAX_DEPTH) {
          queue.push({ dir: full, depth: current.depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!normalizedExts.includes(ext)) {
        continue;
      }
      const relative = path.relative(baseWorkspace, full).replace(/\\/g, "/");
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      const normalized = normalizeWorkspaceRelativePath(relative);
      if (!normalized) {
        continue;
      }
      matches.push({
        path: normalized,
        relPath: `workspace/${normalized}`,
      });
      if (matches.length >= WORKSPACE_SELECTOR_MAX_MATCHES) {
        truncated = true;
        break;
      }
    }
    if (matches.length >= WORKSPACE_SELECTOR_MAX_MATCHES) {
      break;
    }
  }

  return {
    scopeRelPath: resolveWorkspacePath(scopeNormalized).relPath,
    matches,
    truncated,
  };
}

function formatWorkspacePathPreview(paths: string[], maxItems = 8): string[] {
  const normalized = paths.map((item) => normalizeWorkspaceRelativePath(item)).filter(Boolean);
  const preview = normalized.slice(0, Math.max(1, maxItems));
  const lines = preview.map((item, index) => `${index + 1}. workspace/${item}`);
  if (normalized.length > preview.length) {
    lines.push(`... y ${normalized.length - preview.length} más`);
  }
  return lines;
}

function basenameCollisionNames(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const source of paths) {
    const key = path.basename(source).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
}

async function copyWorkspacePath(sourceInput: string, targetInput: string): Promise<{ from: string; to: string }> {
  const sourceNormalized = normalizeWorkspaceRelativePath(sourceInput);
  const targetNormalized = normalizeWorkspaceRelativePath(targetInput);
  if (!sourceNormalized || !targetNormalized) {
    throw new Error("Faltan ruta origen o destino");
  }

  const source = resolveWorkspacePath(sourceNormalized);
  const target = resolveWorkspacePath(targetNormalized);
  if (source.fullPath === target.fullPath) {
    throw new Error("Origen y destino son iguales");
  }

  let sourceStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    sourceStat = await fs.stat(source.fullPath);
  } catch {
    throw new Error(`No existe origen: ${source.relPath}`);
  }

  if (sourceStat.isDirectory() && target.fullPath.startsWith(`${source.fullPath}${path.sep}`)) {
    throw new Error("No puedes copiar una carpeta dentro de sí misma");
  }
  if (await safePathExists(target.fullPath)) {
    throw new Error(`El destino ya existe: ${target.relPath}`);
  }

  await fs.mkdir(path.dirname(target.fullPath), { recursive: true });
  await fs.cp(source.fullPath, target.fullPath, { recursive: true, force: false, errorOnExist: true });
  if (!(await safePathExists(target.fullPath))) {
    throw new Error(`Copiado incompleto, destino no encontrado: ${target.relPath}`);
  }
  return {
    from: source.relPath,
    to: target.relPath,
  };
}

async function moveWorkspacePathsToDirectory(paths: string[], targetDirInput: string): Promise<Array<{ from: string; to: string }>> {
  const targetDir = normalizeWorkspaceRelativePath(targetDirInput);
  if (!targetDir) {
    throw new Error("Indica la carpeta destino dentro de workspace");
  }
  const normalizedPaths = paths.map((item) => normalizeWorkspaceRelativePath(item)).filter(Boolean);
  if (normalizedPaths.length === 0) {
    return [];
  }
  const collisions = basenameCollisionNames(normalizedPaths);
  if (collisions.length > 0) {
    throw new Error(`Hay archivos con mismo nombre base: ${collisions.slice(0, 5).join(", ")}.`);
  }

  const planned = normalizedPaths
    .map((sourcePath) => {
      const targetPath = normalizeWorkspaceRelativePath(path.posix.join(targetDir, path.basename(sourcePath)));
      if (!targetPath) {
        return null;
      }
      return { sourcePath, targetPath };
    })
    .filter((item): item is { sourcePath: string; targetPath: string } => Boolean(item));
  const duplicateTargets = basenameCollisionNames(planned.map((item) => item.targetPath));
  if (duplicateTargets.length > 0) {
    throw new Error(`Conflicto de destino por nombre repetido: ${duplicateTargets.slice(0, 5).join(", ")}.`);
  }
  for (const plan of planned) {
    if (plan.sourcePath === plan.targetPath) {
      throw new Error(`Origen y destino son iguales: workspace/${plan.sourcePath}`);
    }
    const targetResolved = resolveWorkspacePath(plan.targetPath);
    if (await safePathExists(targetResolved.fullPath)) {
      throw new Error(`El destino ya existe: ${targetResolved.relPath}`);
    }
  }

  const moved: Array<{ from: string; to: string }> = [];
  for (const plan of planned) {
    moved.push(await moveWorkspacePath(plan.sourcePath, plan.targetPath));
  }
  return moved;
}

async function copyWorkspacePathsToDirectory(paths: string[], targetDirInput: string): Promise<Array<{ from: string; to: string }>> {
  const targetDir = normalizeWorkspaceRelativePath(targetDirInput);
  if (!targetDir) {
    throw new Error("Indica la carpeta destino dentro de workspace");
  }
  const normalizedPaths = paths.map((item) => normalizeWorkspaceRelativePath(item)).filter(Boolean);
  if (normalizedPaths.length === 0) {
    return [];
  }
  const collisions = basenameCollisionNames(normalizedPaths);
  if (collisions.length > 0) {
    throw new Error(`Hay archivos con mismo nombre base: ${collisions.slice(0, 5).join(", ")}.`);
  }

  const planned = normalizedPaths
    .map((sourcePath) => {
      const targetPath = normalizeWorkspaceRelativePath(path.posix.join(targetDir, path.basename(sourcePath)));
      if (!targetPath) {
        return null;
      }
      return { sourcePath, targetPath };
    })
    .filter((item): item is { sourcePath: string; targetPath: string } => Boolean(item));
  const duplicateTargets = basenameCollisionNames(planned.map((item) => item.targetPath));
  if (duplicateTargets.length > 0) {
    throw new Error(`Conflicto de destino por nombre repetido: ${duplicateTargets.slice(0, 5).join(", ")}.`);
  }
  for (const plan of planned) {
    if (plan.sourcePath === plan.targetPath) {
      throw new Error(`Origen y destino son iguales: workspace/${plan.sourcePath}`);
    }
    const targetResolved = resolveWorkspacePath(plan.targetPath);
    if (await safePathExists(targetResolved.fullPath)) {
      throw new Error(`El destino ya existe: ${targetResolved.relPath}`);
    }
  }

  const copied: Array<{ from: string; to: string }> = [];
  for (const plan of planned) {
    copied.push(await copyWorkspacePath(plan.sourcePath, plan.targetPath));
  }
  return copied;
}

function queueWorkspaceDeleteConfirmation(params: {
  chatId: number;
  paths: string[];
  source: string;
  userId?: number;
}): PendingWorkspaceDeleteConfirmation {
  const normalizedPaths = Array.from(
    new Set(
      params.paths
        .map((item) => normalizeWorkspaceRelativePath(item))
        .filter((item): item is string => Boolean(item)),
    ),
  );
  if (normalizedPaths.length === 0) {
    throw new Error("Indica al menos una ruta válida dentro de workspace");
  }
  if (normalizedPaths.some((item) => item === "workspace" || item === "." || item === "./")) {
    throw new Error("No se permite eliminar la carpeta raíz workspace");
  }
  const now = Date.now();
  const pending: PendingWorkspaceDeleteConfirmation = {
    paths: normalizedPaths,
    requestedAtMs: now,
    expiresAtMs: now + WORKSPACE_DELETE_CONFIRM_TTL_MS,
    source: params.source,
    userId: params.userId,
  };
  pendingWorkspaceDeleteByChat.set(params.chatId, pending);
  persistRuntimeStateSnapshot("workspace-delete-queue");
  return pending;
}

function queueWorkspaceDeletePathRequest(params: {
  chatId: number;
  source: string;
  userId?: number;
}): PendingWorkspaceDeletePathRequest {
  const now = Date.now();
  const pending: PendingWorkspaceDeletePathRequest = {
    requestedAtMs: now,
    expiresAtMs: now + WORKSPACE_DELETE_PATH_PROMPT_TTL_MS,
    source: params.source,
    userId: params.userId,
  };
  pendingWorkspaceDeletePathByChat.set(params.chatId, pending);
  persistRuntimeStateSnapshot("workspace-delete-path-queue");
  return pending;
}

function pendingWorkspaceDeleteRemainingSeconds(pending: PendingWorkspaceDeleteConfirmation): number {
  return Math.max(0, Math.round((pending.expiresAtMs - Date.now()) / 1000));
}

function pendingWorkspaceDeletePathRemainingSeconds(pending: PendingWorkspaceDeletePathRequest): number {
  return Math.max(0, Math.round((pending.expiresAtMs - Date.now()) / 1000));
}

function parseNaturalConfirmationDecision(text: string): "confirm" | "cancel" | null {
  const normalized = normalizeIntentText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 24) {
    return null;
  }

  const hasExplicitCancel = /\b(cancela(?:r|do)?|anula(?:r|do)?|deten(?:er)?|stop|aborta(?:r)?|no)\b/.test(normalized);
  const hasCancelActionPattern =
    /\b(no\s+(?:borres?|elimines?|hagas?|quiero|procedas?|confirmes?))\b/.test(normalized) ||
    /\b(mejor\s+no)\b/.test(normalized);
  if (hasExplicitCancel && (hasCancelActionPattern || /\b(cancela|cancelar|anula|anular|stop|aborta|deten)\b/.test(normalized))) {
    return "cancel";
  }

  const hasConfirm =
    /\b(si|s|yes|ok|okay|dale|va|vamos|confirmo|confirma|confirmar|procede|adelante|hazlo|hacelo|ejecuta)\b/.test(
      normalized,
    ) ||
    /\b(de\s+una)\b/.test(normalized) ||
    /\b(borra(?:lo|los)?|elimina(?:lo|los)?)\b/.test(normalized);
  if (hasConfirm) {
    return "confirm";
  }

  if (hasExplicitCancel) {
    return "cancel";
  }

  return null;
}

function stripChainSegmentLead(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:y\s+)?(?:primero|primera|primer|luego|despues|después|despues de eso|después de eso|despues de|después de)\s*/i, "")
    .trim();
}

function splitChainedInstructions(raw: string): string[] {
  const normalized = normalizeIntentText(raw);
  const hasChainCue = /\b(primero|luego|despues|después)\b/.test(normalized);
  if (!hasChainCue) {
    return [];
  }

  const parts = raw
    .split(/\b(?:y\s+)?(?:luego|despues|después|despues de eso|después de eso)\b|;/i)
    .map((entry) => stripChainSegmentLead(entry))
    .filter(Boolean);

  if (parts.length < 2) {
    return [];
  }
  return parts;
}

function parseWebOpenTarget(
  input: string,
  lastResults: WebSearchResult[] | undefined,
): { url: string; question: string; sourceIndex?: number } {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Uso: /webopen <n|url> [pregunta]");
  }

  const [targetRaw, ...rest] = raw.split(/\s+/);
  const target = targetRaw?.trim() ?? "";
  if (!target) {
    throw new Error("Uso: /webopen <n|url> [pregunta]");
  }

  const question = rest.join(" ").trim();
  if (/^\d+$/.test(target)) {
    const index = Number.parseInt(target, 10);
    if (!lastResults || lastResults.length === 0) {
      throw new Error("No hay resultados web previos en este chat. Ejecuta /web primero.");
    }
    if (!Number.isFinite(index) || index < 1 || index > lastResults.length) {
      throw new Error(`Índice fuera de rango. Usa 1..${lastResults.length}.`);
    }
    const hit = lastResults[index - 1]!;
    return {
      url: hit.url,
      question,
      sourceIndex: index,
    };
  }

  return {
    url: target,
    question,
  };
}

function stripTrailingPunctuation(raw: string): string {
  return raw.replace(/[)\]}",;:.!?]+$/g, "").trim();
}

function extractDocumentReferences(text: string, allowedExts: string[]): string[] {
  const escapedExts = allowedExts
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."))
    .map((ext) => ext.replace(".", "\\."))
    .join("|");
  if (!escapedExts) {
    return [];
  }

  const pattern = new RegExp(`"([^"\\n]+(?:${escapedExts}))"|'([^'\\n]+(?:${escapedExts}))'|([\\w./\\\\-]+(?:${escapedExts}))`, "gi");
  const matches = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = stripTrailingPunctuation((match[1] || match[2] || match[3] || "").trim());
    if (!candidate) {
      continue;
    }
    matches.add(candidate);
  }
  return [...matches];
}

function detectDocumentIntent(text: string, allowedExts: string[]): DocumentIntent {
  const normalized = text.toLowerCase();
  const references = extractDocumentReferences(text, allowedExts);
  const preferWorkspace = /\bworkspace\b/.test(normalized);

  const readRequested = [
    "leer",
    "leelo",
    "leela",
    "revisar",
    "revisa",
    "abrir",
    "que dice",
    "qué dice",
    "ver documento",
  ].some((word) => normalized.includes(word));

  const analysisRequested = [
    "analiza",
    "analizar",
    "analises",
    "analices",
    "resumi",
    "resumen",
    "resumir",
    "conclusiones",
    "riesgos",
    "explica",
    "de qué trata",
  ].some((word) => normalized.includes(word));

  const requestTone = /(quiero|quisiera|podrias|podrías|puedes|necesito)/.test(normalized);

  const shouldHandle = references.length > 0 && (readRequested || analysisRequested || requestTone);
  return {
    shouldHandle,
    references,
    preferWorkspace,
    analysisRequested,
    readRequested,
  };
}

function normalizeWorkspaceRelativePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const unquoted = trimmed.replace(/^["'`]+|["'`]+$/g, "");
  const withoutPunctuation = stripTrailingPunctuation(unquoted);
  if (!withoutPunctuation) {
    return "";
  }
  let normalized = withoutPunctuation.replace(/\\/g, "/").trim();
  normalized = normalized.replace(/^workspace(?:\/|$)/i, "");
  normalized = normalized.replace(/^\.?\//, "");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized === "." || normalized === "./") {
    return "";
  }
  return normalized;
}

function cleanWorkspacePathPhrase(raw: string): string {
  const original = raw.trim();
  if (!original) {
    return "";
  }

  const explicitWorkspacePath = original.match(/\bworkspace\/([^\s"'`]+)/i)?.[1]?.trim();
  if (explicitWorkspacePath) {
    return normalizeWorkspaceRelativePath(explicitWorkspacePath);
  }

  const normalized = original
    .replace(/^[\s:.,;!?-]+/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(?:el|la|los|las|un|una)\s+/i, "")
    .replace(/^(?:archivo|archivos|documento|documentos|carpeta|carpetas|directorio|directorios|folder|folders|ruta|path)\s+/i, "")
    .replace(/^(?:de|del|en|dentro\s+de)\s+/i, "")
    .replace(/^(?:workspace)\b\/?/i, "")
    .replace(/^(?:de|del|en)\s+workspace\b\/?/i, "")
    .replace(/\b(?:de|del|en)\s+workspace\b$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeWorkspaceRelativePath(normalized);
}

function parseWorkspaceFileIndexReference(text: string): number | null {
  return parseWorkspaceFileIndexReferenceDomain(text, normalizeIntentText);
}

function isSimpleTextFilePath(relativeInput: string): boolean {
  const normalized = normalizeWorkspaceRelativePath(relativeInput);
  if (!normalized) {
    return false;
  }
  const ext = path.extname(normalized).toLowerCase();
  return SIMPLE_TEXT_FILE_EXTENSIONS.has(ext);
}

function detectSimpleTextExtensionHint(text: string): string | undefined {
  return detectSimpleTextExtensionHintDomain(text, normalizeIntentText);
}

function resolveWorkspaceWritePathWithHint(rawPath: string, extensionHint?: string): string {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (!normalized) {
    return "";
  }
  if (isSimpleTextFilePath(normalized)) {
    return normalized;
  }

  const extRaw = (extensionHint ?? "").trim().toLowerCase();
  if (!extRaw) {
    return "";
  }
  const ext = extRaw.startsWith(".") ? extRaw : `.${extRaw}`;
  if (!SIMPLE_TEXT_FILE_EXTENSIONS.has(ext)) {
    return "";
  }

  // If the user already provided a non-allowed extension, don't mutate it silently.
  const existingExt = path.extname(normalized).toLowerCase();
  if (existingExt) {
    return "";
  }

  // Avoid turning long natural-language phrases into file paths.
  if (/\s/.test(normalized)) {
    return "";
  }

  return `${normalized}${ext}`;
}

function buildAutoWorkspaceFilePath(extensionInput?: string): string {
  const extRaw = (extensionInput ?? ".txt").trim().toLowerCase();
  const ext = extRaw.startsWith(".") ? extRaw : `.${extRaw}`;
  const safeExt = SIMPLE_TEXT_FILE_EXTENSIONS.has(ext) ? ext : ".txt";
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `generated-${stamp}${safeExt}`;
}

function extractNumberRequest(text: string): { randomRequested: boolean; explicitNumber?: number } {
  const normalized = normalizeIntentText(text);
  const explicitRaw =
    normalized.match(/\b(?:numero|nro|#)\s*(?:es|=|:)?\s*(-?\d{1,9})\b/)?.[1] ??
    normalized.match(/\b(-?\d{1,9})\b/)?.[1];
  const parsed = explicitRaw ? Number.parseInt(explicitRaw, 10) : NaN;
  const explicitNumber = Number.isFinite(parsed) ? parsed : undefined;

  const randomRequested =
    /\b(piensa|pensar|inventa|genera|elige|saca)\b/.test(normalized) &&
    /\b(numero|nro)\b/.test(normalized) &&
    !Number.isFinite(parsed);
  return {
    randomRequested,
    ...(typeof explicitNumber === "number" ? { explicitNumber } : {}),
  };
}

function isPlaceholderContentForNumber(content: string): boolean {
  const normalized = normalizeIntentText(content).replace(/\s+/g, " ").trim();
  return [
    "adentro",
    "dentro",
    "el numero adentro",
    "numero adentro",
    "con el numero adentro",
    "con numero adentro",
    "numero",
    "el numero",
    "que pensaste",
    "el numero que pensaste",
  ].includes(normalized);
}

function buildContentFromNumber(extensionInput: string | undefined, numberValue: number): string {
  const extRaw = (extensionInput ?? ".txt").trim().toLowerCase();
  const ext = extRaw.startsWith(".") ? extRaw : `.${extRaw}`;
  if (ext === ".json") {
    return `${JSON.stringify({ number: numberValue }, null, 2)}\n`;
  }
  if (ext === ".jsonl") {
    return `${JSON.stringify({ number: numberValue })}\n`;
  }
  if (ext === ".csv" || ext === ".tsv") {
    return `${numberValue}\n`;
  }
  return `${numberValue}\n`;
}

function generateRandomInt(minInclusive: number, maxInclusive: number): number {
  const min = Math.ceil(minInclusive);
  const max = Math.floor(maxInclusive);
  if (max <= min) {
    return min;
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function extractSimpleFilePathCandidate(text: string): string {
  const pattern =
    /(?:^|[\s"'`(])(?:workspace\/)?([^\s"'`()]+(?:\.[a-z0-9]{2,8}))(?:$|[\s"'`),.;!?])/gi;
  let match: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((match = pattern.exec(text)) !== null) {
    const candidate = normalizeWorkspaceRelativePath(match[1] ?? "");
    if (!candidate) {
      continue;
    }
    if (/^\.[a-z0-9]{2,8}$/i.test(candidate)) {
      continue;
    }
    if (isSimpleTextFilePath(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates.at(-1) ?? "";
}

function looksLikeWorkspacePathCandidate(raw: string): boolean {
  return looksLikeWorkspacePathCandidateDomain(raw, normalizeWorkspaceRelativePath);
}

function resolveWorkspacePath(relativeInput?: string): { fullPath: string; relPath: string } {
  return workspaceFiles.resolveWorkspacePath(relativeInput);
}

async function listWorkspaceDirectory(relativeInput?: string): Promise<{
  relPath: string;
  entries: Array<{ name: string; kind: "dir" | "file" | "link" | "other"; size?: number }>;
}> {
  return workspaceFiles.listWorkspaceDirectory(relativeInput);
}

function formatWorkspaceEntries(entries: Array<{ name: string; kind: "dir" | "file" | "link" | "other"; size?: number }>): string[] {
  return workspaceFiles.formatWorkspaceEntries(entries);
}

async function createWorkspaceDirectory(relativeInput: string): Promise<{ relPath: string }> {
  return workspaceFiles.createWorkspaceDirectory(relativeInput);
}

async function writeWorkspaceTextFile(params: {
  relativePath: string;
  content?: string;
  overwrite?: boolean;
  append?: boolean;
}): Promise<{ relPath: string; size: number; created: boolean }> {
  return workspaceFiles.writeWorkspaceTextFile(params);
}

async function moveWorkspacePath(sourceInput: string, targetInput: string): Promise<{ from: string; to: string }> {
  return workspaceFiles.moveWorkspacePath(sourceInput, targetInput);
}

async function deleteWorkspacePath(relativeInput: string): Promise<{ relPath: string; kind: "dir" | "file" | "other" }> {
  return workspaceFiles.deleteWorkspacePath(relativeInput);
}

function detectWorkspaceNaturalIntent(text: string): WorkspaceNaturalIntent {
  return detectWorkspaceNaturalIntentDomain(text, {
    normalizeIntentText,
    extractQuotedSegments,
    normalizeWorkspaceRelativePath,
    cleanWorkspacePathPhrase,
    extractSimpleFilePathCandidate,
    extractWorkspaceDeletePathCandidate,
    extractWorkspaceDeleteExtensions,
    extractWorkspaceDeleteContentsPath,
    extractWorkspaceNameSelectorFromSegment,
    pickFirstNonEmpty,
    detectSimpleTextExtensionHint,
    resolveWorkspaceWritePathWithHint,
    extractNaturalWorkspaceWriteContent,
    looksLikeWorkspacePathCandidate,
    parseWorkspaceFileIndexReference,
  });
}

function extractFirstHttpUrl(text: string): string | null {
  const match = text.match(/\bhttps?:\/\/[^\s<>"'`]+/i);
  if (!match) {
    return null;
  }
  const candidate = stripTrailingPunctuation(match[0] ?? "");
  return candidate || null;
}

function isRedditUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === "reddit.com" || hostname.endsWith(".reddit.com") || hostname === "redd.it";
  } catch {
    return false;
  }
}

function resolveWebResultDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "sitio desconocido";
  }
}

function normalizeSearchSnippet(raw: string, maxChars = 220): string {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/^[-–—•\s]+/, "")
    .trim();
  if (!cleaned) {
    return "";
  }
  return truncateInline(cleaned, maxChars);
}

const CURATED_NEWS_DOMAINS: Record<NewsVertical, CuratedNewsDomains> = {
  football: {
    es: ["ole.com.ar", "tycsports.com", "espn.com.ar", "as.com", "marca.com"],
    en: ["espn.com", "bbc.com", "goal.com", "theathletic.com"],
  },
  finance: {
    es: ["ambito.com", "cronista.com", "expansion.com", "infobae.com", "eleconomista.es"],
    en: ["reuters.com", "bloomberg.com", "cnbc.com", "ft.com", "wsj.com", "marketwatch.com"],
  },
  technology: {
    es: ["xataka.com", "genbeta.com", "hipertextual.com", "wwwhatsnew.com"],
    en: ["techcrunch.com", "theverge.com", "wired.com", "arstechnica.com", "venturebeat.com"],
  },
  science: {
    es: ["muyinteresante.com", "nationalgeographic.com.es", "agenciasinc.es"],
    en: ["nature.com", "science.org", "sciencenews.org", "space.com", "nasa.gov"],
  },
  robotics: {
    es: ["xataka.com", "elconfidencial.com"],
    en: ["therobotreport.com", "ieee.org", "spectrum.ieee.org", "roboticsbusinessreview.com"],
  },
  automation: {
    es: ["xataka.com", "genbeta.com"],
    en: ["automationworld.com", "iiot-world.com", "theautomationdaily.com"],
  },
  ai: {
    es: ["xataka.com", "genbeta.com", "hipertextual.com"],
    en: ["openai.com", "deepmind.google", "venturebeat.com", "techcrunch.com", "theverge.com"],
  },
  marketing: {
    es: ["puromarketing.com", "marketingdirecto.com", "reasonwhy.es"],
    en: ["adweek.com", "marketingweek.com", "hubspot.com", "socialmediatoday.com"],
  },
  general: {
    es: ["elpais.com", "bbc.com/mundo", "dw.com/es", "infobae.com"],
    en: ["reuters.com", "apnews.com", "bbc.com", "nytimes.com"],
  },
};

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function detectNewsVertical(rawQuery: string): NewsVertical {
  const normalized = normalizeIntentText(rawQuery);
  if (!normalized) {
    return "general";
  }
  if (/\b(futbol|futbolero|futbolera|football|soccer|boca|river|champions|premier league|liga)\b/.test(normalized)) {
    return "football";
  }
  if (/\b(finanzas?|economia|economica|economic|negocios?|mercados?|bolsa|acciones?|stocks?|crypto|cripto|bitcoin|ethereum)\b/.test(normalized)) {
    return "finance";
  }
  if (/\b(astronomia|astronomy|espacio|space|nasa|galaxia|telescopio|cosmos|astrofisica)\b/.test(normalized)) {
    return "science";
  }
  if (/\b(robotica|robotics?|robot)\b/.test(normalized)) {
    return "robotics";
  }
  if (/\b(automatizacion|automacion|automation|rpa|workflow)\b/.test(normalized)) {
    return "automation";
  }
  if (/\b(marketing|growth|seo|sem|publicidad|ads|branding)\b/.test(normalized)) {
    return "marketing";
  }
  if (/\b(ia|ai|inteligencia artificial|llm|machine learning|aprendizaje automatico|generative)\b/.test(normalized)) {
    return "ai";
  }
  if (/\b(tecnologia|tecnologias|technology|tech|software|hardware|startup|startups)\b/.test(normalized)) {
    return "technology";
  }
  if (/\b(ciencia|science|cientific)\b/.test(normalized)) {
    return "science";
  }
  return "general";
}

function buildCuratedNewsDomains(rawQuery: string): { vertical: NewsVertical; domains: string[] } {
  const vertical = detectNewsVertical(rawQuery);
  const verticalCatalog = CURATED_NEWS_DOMAINS[vertical];
  const generalCatalog = CURATED_NEWS_DOMAINS.general;
  const preferred = [
    ...verticalCatalog.es.slice(0, 3),
    ...verticalCatalog.en.slice(0, 3),
    ...generalCatalog.es.slice(0, 2),
    ...generalCatalog.en.slice(0, 2),
  ];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const domainRaw of preferred) {
    const domain = domainRaw.trim().toLowerCase();
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    deduped.push(domain);
  }
  return { vertical, domains: deduped };
}

function computeNewsSourceAuthorityScore(hit: WebSearchResult): number {
  if (isRedditUrl(hit.url)) {
    return 3;
  }
  const domain = resolveWebResultDomain(hit.url);
  if (domain === "sitio desconocido") {
    return -2;
  }
  let best = 0;
  for (const catalog of Object.values(CURATED_NEWS_DOMAINS)) {
    for (const curated of [...catalog.es, ...catalog.en]) {
      const normalized = curated.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (matchesDomain(domain, normalized)) {
        best = Math.max(best, 8);
      }
    }
  }
  return best;
}

function buildValidUtcDate(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 2000 || year > 2100) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function parseRelativeNewsDate(text: string, now: Date): Date | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return null;
  }
  if (/\b(hoy|today|just now|ahora)\b/.test(normalized)) {
    return new Date(now.getTime());
  }
  if (/\b(ayer|yesterday)\b/.test(normalized)) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  const match = normalized.match(
    /\b(\d{1,3})\s*(segundo|segundos|second|seconds|minuto|minutos|minute|minutes|hora|horas|hour|hours|dia|dias|day|days|semana|semanas|week|weeks|mes|meses|month|months)\s*(?:ago|atras)?\b/,
  );
  if (!match) {
    return null;
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2] ?? "";
  let deltaMs = 0;
  if (/segundo|second/.test(unit)) {
    deltaMs = amount * 1000;
  } else if (/minuto|minute/.test(unit)) {
    deltaMs = amount * 60_000;
  } else if (/hora|hour/.test(unit)) {
    deltaMs = amount * 60 * 60_000;
  } else if (/dia|day/.test(unit)) {
    deltaMs = amount * 24 * 60 * 60_000;
  } else if (/semana|week/.test(unit)) {
    deltaMs = amount * 7 * 24 * 60 * 60_000;
  } else if (/mes|month/.test(unit)) {
    deltaMs = amount * 30 * 24 * 60 * 60_000;
  }
  if (deltaMs <= 0) {
    return null;
  }
  return new Date(now.getTime() - deltaMs);
}

function parseAbsoluteNewsDateFromText(text: string, now: Date): Date | null {
  const normalized = normalizeIntentText(text).replace(/[,]/g, " ");
  if (!normalized) {
    return null;
  }

  const iso = normalized.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) {
    const date = buildValidUtcDate(
      Number.parseInt(iso[1] ?? "", 10),
      Number.parseInt(iso[2] ?? "", 10),
      Number.parseInt(iso[3] ?? "", 10),
    );
    if (date) {
      return date;
    }
  }

  const dmy = normalized.match(/\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](20\d{2})\b/);
  if (dmy) {
    const date = buildValidUtcDate(
      Number.parseInt(dmy[3] ?? "", 10),
      Number.parseInt(dmy[2] ?? "", 10),
      Number.parseInt(dmy[1] ?? "", 10),
    );
    if (date) {
      return date;
    }
  }

  const monthToNumber: Record<string, number> = {
    enero: 1,
    eneroo: 1,
    feb: 2,
    febrero: 2,
    mar: 3,
    marzo: 3,
    abr: 4,
    abril: 4,
    may: 5,
    mayo: 5,
    jun: 6,
    junio: 6,
    jul: 7,
    julio: 7,
    ago: 8,
    agosto: 8,
    sep: 9,
    sept: 9,
    septiembre: 9,
    oct: 10,
    octubre: 10,
    nov: 11,
    noviembre: 11,
    dic: 12,
    diciembre: 12,
    jan: 1,
    january: 1,
    february: 2,
    march: 3,
    apr: 4,
    april: 4,
    june: 6,
    july: 7,
    aug: 8,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  const monthPattern = Object.keys(monthToNumber).join("|");

  const dayMonth = normalized.match(
    new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s+)?(${monthPattern})\\s*(?:de\\s+)?(20\\d{2})?\\b`, "i"),
  );
  if (dayMonth) {
    const day = Number.parseInt(dayMonth[1] ?? "", 10);
    const month = monthToNumber[(dayMonth[2] ?? "").toLowerCase()];
    let year = Number.parseInt(dayMonth[3] ?? "", 10);
    if (!Number.isFinite(year)) {
      year = now.getUTCFullYear();
    }
    const date = buildValidUtcDate(year, month ?? 0, day);
    if (date) {
      return date;
    }
  }

  const monthDay = normalized.match(
    new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:\\s+|\\s*,\\s*)(20\\d{2})?\\b`, "i"),
  );
  if (monthDay) {
    const month = monthToNumber[(monthDay[1] ?? "").toLowerCase()];
    const day = Number.parseInt(monthDay[2] ?? "", 10);
    let year = Number.parseInt(monthDay[3] ?? "", 10);
    if (!Number.isFinite(year)) {
      year = now.getUTCFullYear();
    }
    const date = buildValidUtcDate(year, month ?? 0, day);
    if (date) {
      return date;
    }
  }

  return null;
}

function parseAbsoluteNewsDateFromUrl(rawUrl: string): Date | null {
  const normalized = rawUrl.toLowerCase();
  const byPath = normalized.match(/(?:\/|^)(20\d{2})[/-](0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])(?:\/|$)/);
  if (byPath) {
    return buildValidUtcDate(
      Number.parseInt(byPath[1] ?? "", 10),
      Number.parseInt(byPath[2] ?? "", 10),
      Number.parseInt(byPath[3] ?? "", 10),
    );
  }
  const compact = normalized.match(/(?:\/|^)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\/|$)/);
  if (compact) {
    return buildValidUtcDate(
      Number.parseInt(compact[1] ?? "", 10),
      Number.parseInt(compact[2] ?? "", 10),
      Number.parseInt(compact[3] ?? "", 10),
    );
  }
  return null;
}

function extractDetectedNewsDate(hit: WebSearchResult, now: Date = new Date()): Date | null {
  const byRelative = parseRelativeNewsDate(`${hit.title}\n${hit.snippet}`, now);
  if (byRelative) {
    return byRelative;
  }
  const byUrl = parseAbsoluteNewsDateFromUrl(hit.url);
  if (byUrl) {
    return byUrl;
  }
  const byText = parseAbsoluteNewsDateFromText(`${hit.title}\n${hit.snippet}`, now);
  if (byText) {
    return byText;
  }
  return null;
}

function computeNewsRecencyScore(date: Date | null, now: Date = new Date()): number {
  if (!date) {
    return 0;
  }
  const ageDays = (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays)) {
    return 0;
  }
  if (ageDays < -1) {
    return -10;
  }
  if (ageDays <= 1) {
    return 30;
  }
  if (ageDays <= 2) {
    return 24;
  }
  if (ageDays <= 7) {
    return 18;
  }
  if (ageDays <= 30) {
    return 12;
  }
  if (ageDays <= 90) {
    return 6;
  }
  if (ageDays <= 180) {
    return 1;
  }
  if (ageDays <= 365) {
    return -6;
  }
  return -18;
}

function buildNewsPriorityScore(hit: WebSearchResult, index: number, now: Date = new Date()): number {
  const date = extractDetectedNewsDate(hit, now);
  const recencyScore = computeNewsRecencyScore(date, now);
  const sourceAuthority = computeNewsSourceAuthorityScore(hit);
  const snippet = normalizeSearchSnippet(hit.snippet, 240);
  const snippetQuality = snippet ? Math.min(4, snippet.length / 80) : -1.2;
  const titleQuality = hit.title.trim().length >= 14 ? 1.5 : 0;
  const orderBias = Math.max(0, 7 - index * 0.7);
  return recencyScore + sourceAuthority + snippetQuality + titleQuality + orderBias;
}

function formatNewsDetectedDate(date: Date | null): string {
  if (!date) {
    return "fecha no visible";
  }
  return date.toLocaleString("es-AR", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatWebResultItem(params: {
  hit: WebSearchResult;
  index: number;
  newsRequested: boolean;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const snippet = normalizeSearchSnippet(params.hit.snippet, 210);
  const domain = resolveWebResultDomain(params.hit.url);
  const date = params.newsRequested ? extractDetectedNewsDate(params.hit, now) : null;
  return [
    `${params.index + 1}. ${params.hit.title}`,
    snippet ? `Resumen: ${snippet}` : "Resumen: sin extracto en el resultado.",
    `Fuente: ${domain}`,
    ...(params.newsRequested ? [`Fecha detectada: ${formatNewsDetectedDate(date)}`] : []),
    `Link: ${params.hit.url}`,
  ].join("\n");
}

function buildWebResultsListText(params: {
  query: string;
  hits: WebSearchResult[];
  newsRequested: boolean;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const intro = params.newsRequested
    ? `Encontré ${params.hits.length} resultados recientes sobre "${params.query}".`
    : `Encontré ${params.hits.length} resultados sobre "${params.query}".`;
  const lines = params.hits.map((hit, index) =>
    formatWebResultItem({
      hit,
      index,
      newsRequested: params.newsRequested,
      now,
    }),
  );
  const followUp = params.newsRequested
    ? "Si quieres, abro uno y te lo resumo con foco en fechas y contexto."
    : "Si quieres, abro uno y te hago un resumen breve.";
  return [intro, ...lines, followUp].join("\n\n");
}

function isLikelyNewsQuery(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return false;
  }
  const newsNoun = /\b(noticias?|novedades?|titulares?|actualidad|news)\b/.test(normalized);
  const recencyCue = /\b(hoy|ayer|ultim[oa]s?|reciente|actual(?:es)?|semana|mes)\b/.test(normalized);
  const topicCue =
    /\b(cripto|crypto|bitcoin|ethereum|blockchain|negocios|economia|economía|mercados?|finanzas?|ia|ai|inteligencia artificial|politica|política|argentina|futbol|fútbol|deportes?|tecnologia|tecnología|science|ciencia|astronomia|astronomía|robotica|robótica|automatizacion|automatización|marketing)\b/.test(
      normalized,
    );
  return newsNoun || (topicCue && recencyCue);
}

function mergeWebSearchResults(results: WebSearchResult[], limitInput: number): WebSearchResult[] {
  const limit = Math.max(1, Math.floor(limitInput || 1));
  const merged: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const key = result.url.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(result);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}

function prioritizeNewsResultsWithRedditCap(params: {
  redditHits: WebSearchResult[];
  generalHits: WebSearchResult[];
  limit: number;
  redditCap: number;
}): WebSearchResult[] {
  const now = new Date();
  const deduped = mergeWebSearchResults(
    [...params.redditHits, ...params.generalHits],
    Math.max(params.limit * 4, params.limit),
  );
  const ranked = deduped.map((hit, index) => {
    const detectedDate = extractDetectedNewsDate(hit, now);
    const score = buildNewsPriorityScore(hit, index, now);
    return {
      hit,
      index,
      score,
      detectedDate,
      reddit: isRedditUrl(hit.url),
    };
  });
  const isWithinFreshWindow = (date: Date): boolean => {
    const ageDays = (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000);
    return ageDays >= -1 && ageDays <= NEWS_MAX_AGE_DAYS;
  };
  const freshDated = ranked.filter((item) => item.detectedDate && isWithinFreshWindow(item.detectedDate));
  const undated = ranked.filter((item) => !item.detectedDate);
  const stale = ranked.filter((item) => item.detectedDate && !isWithinFreshWindow(item.detectedDate));
  let pool: typeof ranked = [];
  if (freshDated.length > 0) {
    pool = [...freshDated, ...undated];
  } else if (undated.length > 0) {
    pool = undated;
  } else {
    pool = stale;
  }
  if (pool.length < params.limit) {
    pool = [...pool, ...ranked.filter((item) => !pool.some((entry) => entry.hit.url === item.hit.url))];
  }
  const byScore = (a: (typeof pool)[number], b: (typeof pool)[number]): number => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const aTime = a.detectedDate?.getTime() ?? 0;
    const bTime = b.detectedDate?.getTime() ?? 0;
    if (bTime !== aTime) {
      return bTime - aTime;
    }
    return a.index - b.index;
  };
  const maxReddit = Math.max(0, params.redditCap);
  const reddit = pool.filter((item) => item.reddit).sort(byScore).slice(0, maxReddit);
  const selected = new Set(reddit.map((item) => item.hit.url));
  const nonReddit = pool
    .filter((item) => !item.reddit)
    .sort(byScore)
    .slice(0, Math.max(0, params.limit - reddit.length));
  const combined = [...reddit, ...nonReddit];
  if (combined.length < params.limit) {
    const filler = ranked
      .sort(byScore)
      .filter((item) => !selected.has(item.hit.url) && !combined.some((entry) => entry.hit.url === item.hit.url))
      .slice(0, params.limit - combined.length);
    combined.push(...filler);
  }
  return combined.slice(0, params.limit).map((item) => item.hit);
}

function sanitizeNaturalWebQuery(raw: string): string {
  return raw
    .replace(/\b(por favor|porfa|gracias)\b/gi, " ")
    .replace(/\b(dime|decime|contame|cuentame|cuéntame|mostrame|muestrame|muéstrame)\b/gi, " ")
    .replace(
      /\b(busca(?:me)?|buscar|investiga(?:r)?|averigua(?:r)?|googlea(?:r)?|navega(?:r)?|consulta(?:r)?|abre|abrir|abr[ií]|lee|leer|revisa(?:r)?|analiza(?:r)?|resum[ií](?:r)?|explica(?:r)?|muestra(?:r)?)\b/gi,
      " ",
    )
    .replace(/\b(en la web|en internet|por internet|online|en google)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFreshNewsSearchQuery(rawQuery: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.toLocaleString("es-AR", { month: "long" }).toLowerCase();
  const cleanedTopic = rawQuery
    .replace(/\b(ultim[oa]s?|ultim[oa]|noticias?|novedades?|titulares?|actualidad|actual(?:es)?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const base = cleanedTopic || rawQuery.trim();
  if (!base) {
    return `ultimas noticias hoy ultimas horas ${month} ${year}`;
  }
  return `${base} ultimas noticias hoy ultimas horas ${month} ${year}`.replace(/\s+/g, " ").trim();
}

function formatRedditPostDate(createdUtc: number): string {
  if (!Number.isFinite(createdUtc) || createdUtc <= 0) {
    return "fecha-desconocida";
  }
  try {
    return new Date(createdUtc * 1000).toISOString().slice(0, 10);
  } catch {
    return "fecha-desconocida";
  }
}

function formatIsoDateCompact(isoRaw: string): string {
  const raw = isoRaw.trim();
  if (!raw) {
    return "fecha desconocida";
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw.slice(0, 19);
  }
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/d";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 2 : 6,
  }).format(value);
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/d";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function redditPostsToWebSearchResults(posts: RedditPostResult[]): WebSearchResult[] {
  return posts.map((post) => {
    const datePart = formatRedditPostDate(post.createdUtc);
    const metrics = `r/${post.subreddit} | ${datePart} | score ${post.score} | comentarios ${post.numComments}`;
    const textPart = normalizeSearchSnippet(post.selfText, 170);
    return {
      title: post.title,
      url: post.url || post.permalink,
      snippet: textPart ? `${metrics} | ${textPart}` : metrics,
    };
  });
}

function detectWebIntent(text: string): WebIntent {
  const original = text.trim();
  if (!original) {
    return {
      shouldHandle: false,
      mode: "search",
      query: "",
      analysisRequested: false,
      listRequested: false,
      newsRequested: false,
    };
  }

  const normalized = original.toLowerCase();
  const url = extractFirstHttpUrl(original);
  const requestTone = /(quiero|quisiera|necesito|podr[ií]as|puedes|me ayudas|ayudame|ayúdame|dime|decime|contame|cuentame|cuéntame)/.test(
    normalized,
  );
  const webQualifier = /\b(web|internet|google|online|link|links|enlace|enlaces|fuente|fuentes)\b/.test(
    normalized,
  );
  const searchVerb = /\b(busca|buscar|búscame|buscame|investiga|averigua|googlea|navega|consulta|encontra|encuentra)\b/.test(
    normalized,
  );
  const newsNoun = /\b(noticias?|novedades?|titulares?|actualidad)\b/.test(normalized);
  const topicNoun =
    /\b(cripto|crypto|bitcoin|ethereum|blockchain|negocios|economia|economía|mercados?|finanzas?|ia|ai|inteligencia artificial|politica|política|argentina|futbol|fútbol|deportes?|tecnologia|tecnología|science|ciencia|astronomia|astronomía|robotica|robótica|automatizacion|automatización|marketing)\b/.test(
      normalized,
    );
  const newsRequested = newsNoun || (topicNoun && /\b(ultim[oa]s?|actual(?:es)?|hoy|reciente)\b/.test(normalized));
  const openVerb = /\b(abre|abrir|abrí|lee|leer|revisa|revisa|analiza|analizar)\b/.test(normalized);
  const analysisRequested = /\?|analiza|analizar|resum|explica|compar|conclusion|conclusión|riesgo|que dice|qué dice|hoy|ultimo|último|actual|reciente|noticia|precio/.test(
    normalized,
  );
  const listRequested = /\b(lista|listame|listáme|links|enlaces|resultados|fuentes|solo links|solo enlaces)\b/.test(
    normalized,
  );
  const onlyUrlShared = Boolean(url && original.replace(url, "").trim().length === 0);
  const shouldOpen = Boolean(url && (openVerb || analysisRequested || requestTone || webQualifier || onlyUrlShared));
  const shouldSearch =
    !url &&
    (searchVerb ||
      (webQualifier && (requestTone || analysisRequested || listRequested)) ||
      newsRequested ||
      (requestTone && topicNoun));
  const shouldHandle = shouldOpen || shouldSearch;

  const rawQuery = url ? original.replace(url, " ") : original;
  const cleanedQuery = sanitizeNaturalWebQuery(rawQuery);
  const query = cleanedQuery || (url ? "" : original);

  return {
    shouldHandle,
    mode: shouldOpen ? "open" : "search",
    query,
    url: url ?? undefined,
    analysisRequested,
    listRequested,
    newsRequested,
  };
}

async function runWebSearchQuery(params: {
  rawQuery: string;
  newsRequested: boolean;
}): Promise<{
  hits: WebSearchResult[];
  query: string;
  usedFallbackQuery: boolean;
}> {
  const rawQuery = params.rawQuery.trim();
  const query = params.newsRequested ? buildFreshNewsSearchQuery(rawQuery) : rawQuery;

  const runSearch = async (queryText: string): Promise<WebSearchResult[]> => {
    if (!params.newsRequested) {
      return webBrowser.search(queryText, config.webSearchMaxResults);
    }

    const expandedLimit = Math.min(
      10,
      Math.max(config.webSearchMaxResults + NEWS_MAX_REDDIT_RESULTS, config.webSearchMaxResults * 2),
    );
    const curated = buildCuratedNewsDomains(rawQuery || queryText);
    const perDomainLimit = Math.max(2, Math.min(4, Math.ceil(expandedLimit / 3)));
    const domainSearchTasks = curated.domains
      .slice(0, NEWS_MAX_SPECIALIZED_DOMAIN_QUERIES)
      .map((domain) =>
        webBrowser.search(`${queryText} site:${domain} ultimos 7 dias last 7 days`, perDomainLimit),
      );

    const to = new Date();
    const from = new Date(to.getTime() - NEWS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const [redditPosts, recentGeneralHits, generalHits, specializedResults] = await Promise.all([
      redditApi.searchPosts({
        query: queryText,
        limit: Math.max(NEWS_MAX_REDDIT_RESULTS * 2, expandedLimit),
        sort: "new",
        time: "week",
      }),
      webBrowser.search(`${queryText} hoy ultimas horas`, expandedLimit),
      webBrowser.search(queryText, expandedLimit),
      Promise.allSettled(domainSearchTasks),
    ]);
    const redditHits = redditPostsToWebSearchResults(redditPosts);
    const specializedHits = specializedResults.flatMap((entry) =>
      entry.status === "fulfilled" ? entry.value : [],
    );
    const mergedGeneral = mergeWebSearchResults(
      [...specializedHits, ...recentGeneralHits, ...generalHits],
      expandedLimit * 3,
    );
    return prioritizeNewsResultsWithRedditCap({
      redditHits,
      generalHits: mergedGeneral,
      limit: config.webSearchMaxResults,
      redditCap: NEWS_MAX_REDDIT_RESULTS,
    });
  };

  let hits = await runSearch(query);
  const usedFallbackQuery =
    params.newsRequested && hits.length === 0 && rawQuery.length > 0 && rawQuery !== query;
  if (usedFallbackQuery) {
    hits = await runSearch(rawQuery);
  }

  return {
    hits,
    query,
    usedFallbackQuery,
  };
}

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function detectSelfMaintenanceIntent(text: string): SelfMaintenanceIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeIntentText(original);
  const isQuestion = original.includes("?");

  const listSkillsRequested =
    /\b(que|cuales)\b.*\b(habilidades|skills|reglas)\b/.test(normalized) &&
    /\b(tenes|tienes|agregadas|dinamicas|dynamicas|actuales)\b/.test(normalized);
  if (listSkillsRequested) {
    return { shouldHandle: true, action: "list-skills" };
  }

  const deleteSkillIntent =
    /\b(elimina|eliminar|borra|borrar|quita|quitar|remueve|remover)\b/.test(normalized) &&
    /\b(habilidad|skills?|reglas?|capacidad(?:es)?)\b/.test(normalized);
  if (!isQuestion && deleteSkillIntent) {
    const wantsLast = /\b(ultimo|ultima|final)\b/.test(normalized);
    const indexRaw =
      normalized.match(/\b(?:habilidad|skill|regla|capacidad)\s*(?:numero|nro|#)?\s*(\d{1,3})\b/)?.[1] ??
      normalized.match(/\b(?:numero|nro|#)\s*(\d{1,3})\b/)?.[1] ??
      normalized.match(/\b(\d{1,3})\b/)?.[1];
    const parsedIndex = indexRaw ? Number.parseInt(indexRaw, 10) : NaN;
    if (wantsLast) {
      return { shouldHandle: true, action: "delete-skill", skillIndex: -1 };
    }
    if (Number.isFinite(parsedIndex) && parsedIndex > 0) {
      return { shouldHandle: true, action: "delete-skill", skillIndex: parsedIndex };
    }
    return { shouldHandle: true, action: "delete-skill" };
  }

  const restartRequested =
    /\b(reinicia|reiniciate|reiniciar|restart)\b.*\b(agente|bot|servicio)\b/.test(normalized) ||
    /\b(reinicia|reiniciate|reiniciar|restart)\b.*\b(houdi)\b/.test(normalized);
  if (!isQuestion && restartRequested) {
    return { shouldHandle: true, action: "restart-service" };
  }

  const updateVerb =
    /\b(actualiza|actualizar|actualizate|updatea|updatear|upgradea|upgrade|sincroniza|sincronizar|ponete al dia|ponte al dia)\b/.test(
      normalized,
    );
  const updateNoun = /\b(agente|bot|houdi|repo|repositorio|version|versiones|codigo|release)\b/.test(normalized);
  if (!isQuestion && updateVerb && updateNoun) {
    return { shouldHandle: true, action: "update-service" };
  }

  if (!isQuestion && isSkillDraftMultiMessageRequested(normalized)) {
    const instruction = extractSelfSkillInstructionFromText(original);
    return instruction
      ? { shouldHandle: true, action: "add-skill", instruction }
      : { shouldHandle: true, action: "add-skill" };
  }

  const addSkillVerb =
    /\b(agrega|agregar|suma|sumar|anade|añade|incorpora|incorporar|crea|crear|genera|generar|define|definir|configura|configurar|habilita|habilitar|entrena|entrenar|ensena|enseña|mejorate|mejora|arma|armar|construi|construir)\b/.test(
      normalized,
    );
  const addSkillNoun = /\b(habilidades?|skills?|reglas?|capacidades?)\b/.test(normalized);
  const addSkillIntent = addSkillVerb && addSkillNoun;
  const conciseSkillDefinition = /\b(?:nueva\s+)?(?:habilidades?|skills?|reglas?|capacidades?)\s*[:=-]\s*.+/.test(
    normalized,
  );
  if (addSkillIntent || conciseSkillDefinition) {
    const instruction = extractSelfSkillInstructionFromText(original);
    if (instruction) {
      return { shouldHandle: true, action: "add-skill", instruction };
    }
    return { shouldHandle: true, action: "add-skill" };
  }

  return { shouldHandle: false };
}

function detectConnectorNaturalIntent(text: string, options?: { allowImplicit?: boolean }): ConnectorNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeIntentText(original);
  const mentionsConnector = /\b\/?lim\b/.test(normalized) || /\blim-api\b/.test(normalized);
  const mentionsCloudflared = /\b(cloudflared|tunel|tunnel|cloudflare)\b/.test(normalized);
  const explicitContext = mentionsConnector || mentionsCloudflared;

  const extractLimTaggedValue = (fieldPattern: string): string => {
    const match = original.match(
      new RegExp(
        `\\b${fieldPattern}\\s*[:=]\\s*([\\s\\S]*?)(?=\\s+(?:first[_\\s-]?name|last[_\\s-]?name|fuente|source|count)\\s*[:=]|$)`,
        "i",
      ),
    );
    return (match?.[1] ?? "").trim();
  };
  const firstName = extractLimTaggedValue("first[_\\s-]?name");
  const lastName = extractLimTaggedValue("last[_\\s-]?name");
  const sourceName = extractLimTaggedValue("(?:fuente|source)");
  const countMatch = original.match(/\bcount\s*[:=]\s*(\d{1,2})\b/i);
  const naturalCountMatch =
    original.match(/\b(?:ultimos?|últimos?)\s+(\d{1,2})\s+mensajes?\b/i) ??
    original.match(/\b(\d{1,2})\s+mensajes?\b/i);
  const parsedCount = Number.parseInt(countMatch?.[1] ?? naturalCountMatch?.[1] ?? "", 10);
  const count = Number.isFinite(parsedCount) ? Math.max(1, Math.min(10, parsedCount)) : 3;
  const asksProspectOnly =
    /\b(prospecto|lead|contacto)\b/.test(normalized) ||
    /\b(no\s+(?:propios?|mios?|mías?|mias|nuestros?|nuestras?))\b/.test(normalized) ||
    /\b(sin\s+(?:propios?|mios?|mías?|mias|nuestros?|nuestras?))\b/.test(normalized) ||
    /\b(entrantes|recibidos)\b/.test(normalized);
  const queryVerb =
    /\b(consulta|consultar|busca|buscar|trae|traer|lee|leer|revisa|revisar|ver|mira|mirar|mensaje|mensajes)\b/.test(
      normalized,
    );
  const hasLimParams = Boolean(firstName && lastName && sourceName);
  if ((explicitContext || Boolean(options?.allowImplicit)) && queryVerb && hasLimParams) {
    return {
      shouldHandle: true,
      action: "query",
      firstName,
      lastName,
      sourceName,
      count,
      prospectOnly: asksProspectOnly,
    };
  }
  const fullNameMatch = original.match(
    /\b(?:de|para)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ'`.-]+)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ'`.-]+)\b/i,
  );
  if ((explicitContext || Boolean(options?.allowImplicit)) && queryVerb && sourceName && fullNameMatch) {
    return {
      shouldHandle: true,
      action: "query",
      firstName: (fullNameMatch?.[1] ?? "").trim(),
      lastName: (fullNameMatch?.[2] ?? "").trim(),
      sourceName,
      count,
      prospectOnly: asksProspectOnly,
    };
  }
  const naturalSourceMatch = original.match(
    /\b(?:en|desde|fuente|source)\s+([A-Za-z0-9ÁÉÍÓÚáéíóúÑñ'`._-]+(?:\s+[A-Za-z0-9ÁÉÍÓÚáéíóúÑñ'`._-]+){0,3})\s*$/i,
  );
  const naturalSourceRaw = (naturalSourceMatch?.[1] ?? "").trim();
  const naturalSource = naturalSourceRaw
    .replace(/\b(?:ultimos?|últimos?|mensajes?|mensaje|prospecto|no|propios?|mios?|mías?|mias)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const naturalNameBeforeSource = naturalSource
    ? original.slice(0, naturalSourceMatch?.index ?? original.length)
    : original;
  const naturalNameMatch = naturalNameBeforeSource.match(
    /\b(?:de|del|para|a)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ'`.-]+)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ'`.-]+)\b/i,
  );
  if ((explicitContext || Boolean(options?.allowImplicit)) && queryVerb && naturalSource && naturalNameMatch) {
    return {
      shouldHandle: true,
      action: "query",
      firstName: (naturalNameMatch[1] ?? "").trim(),
      lastName: (naturalNameMatch[2] ?? "").trim(),
      sourceName: naturalSource,
      count,
      prospectOnly: asksProspectOnly,
    };
  }
  if ((explicitContext || Boolean(options?.allowImplicit)) && naturalSource && naturalNameMatch) {
    return {
      shouldHandle: true,
      action: "query",
      firstName: (naturalNameMatch[1] ?? "").trim(),
      lastName: (naturalNameMatch[2] ?? "").trim(),
      sourceName: naturalSource,
      count,
      prospectOnly: asksProspectOnly,
    };
  }

  const afterLimRaw = original.match(/\b(?:\/?lim)\b[:\s,-]*(.+)$/i)?.[1]?.trim() ?? "";
  const limInlineMatch = afterLimRaw.match(
    /^(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúÑñ'`.-]+)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ'`.-]+)\s+(?:en|desde|fuente|source)\s+(.+)$/i,
  );
  if ((explicitContext || Boolean(options?.allowImplicit)) && limInlineMatch) {
    const sourceInline = (limInlineMatch[3] ?? "")
      .replace(/\bcount\s*[:=]\s*\d{1,2}\b/gi, "")
      .replace(/\b(?:ultimos?|últimos?)\s+\d{1,2}\s+mensajes?\b/gi, "")
      .trim();
    if (sourceInline) {
      return {
        shouldHandle: true,
        action: "query",
        firstName: (limInlineMatch[1] ?? "").trim(),
        lastName: (limInlineMatch[2] ?? "").trim(),
        sourceName: sourceInline,
        count,
        prospectOnly: asksProspectOnly,
      };
    }
  }

  // Fallback flexible: "lim Rodrigo Toscano Linkedin_Marylin [count:2]"
  const rawNoCount = original
    .replace(/^\s*(?:consulta(?:r)?|revisa(?:r)?|busca(?:r)?|trae(?:r)?|lee(?:r)?|mira(?:r)?|ver)\b\s*/i, " ")
    .replace(/\bcount\s*[:=]\s*\d{1,2}\b/gi, " ")
    .replace(/\b(?:ultimos?|últimos?)\s+\d{1,2}\s+mensajes?\b/gi, " ")
    .trim();
  const fallbackTokens = rawNoCount
    .split(/\s+/)
    .map((token) => token.replace(/^[,;:.]+|[,;:.]+$/g, "").trim())
    .filter(Boolean)
    .filter(
      (token) =>
        !/^(lim|connector|message|retriever|mensajes?|mensaje|de|en|del|para|consulta|consultar|revisa|revisar|ver|mira|mirar|trae|traer|busca|buscar|lee|leer)$/i.test(
          token,
        ),
    );
  if ((explicitContext || Boolean(options?.allowImplicit)) && fallbackTokens.length >= 3) {
    const maybeFirstName = fallbackTokens[0] ?? "";
    const maybeLastName = fallbackTokens[1] ?? "";
    const maybeSource = fallbackTokens.slice(2).join(" ").trim();
    if (maybeFirstName && maybeLastName && maybeSource) {
      return {
        shouldHandle: true,
        action: "query",
        firstName: maybeFirstName,
        lastName: maybeLastName,
        sourceName: maybeSource,
        count,
        prospectOnly: asksProspectOnly,
      };
    }
  }

  const restartRequested = /\b(reinicia|reiniciar|reiniciala|reinicialo|restart|rearranca|rearrancar)\b/.test(
    normalized,
  );
  const startRequested =
    /\b(prende|prender|prendela|prendelo|inicia|iniciar|arranca|arrancar|levanta|levantar|enciende|encender|monta|montar|corre|correr|ejecuta|ejecutar)\b/.test(
      normalized,
    ) && !restartRequested;
  const stopRequested =
    /\b(detene|detener|detenela|detenelo|apaga|apagar|apagala|apagarlo|para|parar|frena|frenar|baja|bajar|corta|cortar)\b/.test(
      normalized,
    ) && !restartRequested;
  const statusRequested =
    /\b(estado|status|activo|activa|corriendo|funcionando|arrancad|levantad|encendid|apagad|respond|caido|caida)\b/.test(
      normalized,
    );

  const hasControlSignal = restartRequested || startRequested || stopRequested || statusRequested;
  const implicitAllowed = Boolean(options?.allowImplicit) && hasControlSignal;
  if (!explicitContext && !implicitAllowed) {
    return { shouldHandle: false };
  }

  let action: ConnectorNaturalAction = "status";
  if (restartRequested) {
    action = "restart";
  } else if (stopRequested && !startRequested) {
    action = "stop";
  } else if (startRequested) {
    action = "start";
  } else if (statusRequested || explicitContext) {
    action = "status";
  }

  let includeTunnel = true;
  if (/\b(solo app|solo api|sin tunel|sin tunnel|solo local|local solamente)\b/.test(normalized)) {
    includeTunnel = false;
  }
  if (/\b(cloudflared|tunel|tunnel|public[ao]?|internet|extern[ao]|dominio|url)\b/.test(normalized)) {
    includeTunnel = true;
  }

  return {
    shouldHandle: true,
    action,
    includeTunnel,
  };
}

function tryParseConnectorIntentWithAi(raw: string): ConnectorNaturalIntent | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as Record<string, unknown>;
    const actionRaw = typeof parsed.action === "string" ? normalizeIntentText(parsed.action) : "";
    const allowedActions = new Set<ConnectorNaturalAction>(["query", "status", "start", "stop", "restart"]);
    if (!allowedActions.has(actionRaw as ConnectorNaturalAction)) {
      return null;
    }
    const firstName = typeof parsed.firstName === "string" ? parsed.firstName.trim() : "";
    const lastName = typeof parsed.lastName === "string" ? parsed.lastName.trim() : "";
    const sourceName = typeof parsed.sourceName === "string" ? parsed.sourceName.trim() : "";
    const countRaw = Number.parseInt(String(parsed.count ?? ""), 10);
    const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(10, countRaw)) : undefined;
    const prospectOnly = typeof parsed.prospectOnly === "boolean" ? parsed.prospectOnly : undefined;

    return {
      shouldHandle: true,
      action: actionRaw as ConnectorNaturalAction,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(sourceName ? { sourceName } : {}),
      ...(typeof count === "number" ? { count } : {}),
      ...(typeof prospectOnly === "boolean" ? { prospectOnly } : {}),
    };
  } catch {
    return null;
  }
}

async function classifyConnectorIntentWithAi(params: { chatId: number; text: string }): Promise<ConnectorNaturalIntent | null> {
  if (!openAi.isConfigured()) {
    return null;
  }
  const text = params.text.trim();
  if (!text) {
    return null;
  }
  const prompt = [
    "Extrae intención LIM desde un mensaje de usuario.",
    "Responde SOLO JSON válido con estas claves:",
    "{",
    '  "action": "query|status|start|stop|restart",',
    '  "firstName": "string|null",',
    '  "lastName": "string|null",',
    '  "sourceName": "string|null",',
    '  "count": number|null,',
    '  "prospectOnly": boolean',
    "}",
    "",
    "Reglas:",
    "- Si pide mensajes/contacto, action=query.",
    "- Si action=query, intenta extraer firstName, lastName, sourceName y count (default 3).",
    "- No inventes datos; usa null si no está.",
    "- Si dice 'no propios/entrantes/prospecto', prospectOnly=true.",
    "",
    `Mensaje: ${text}`,
  ].join("\n");

  try {
    const answer = await askOpenAiForChat({
      chatId: params.chatId,
      prompt,
      concise: true,
      maxOutputTokens: 180,
    });
    return tryParseConnectorIntentWithAi(answer);
  } catch {
    return null;
  }
}

const SCHEDULE_WEEKDAY_TO_INDEX: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const SCHEDULE_MONTH_TO_INDEX: Record<string, number> = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000);
}

function parseScheduleRelativeDateTime(normalized: string, now: Date): Date | null {
  const inPattern =
    normalized.match(
      /\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(minuto|minutos|min|mins|hora|horas|h|hs|dia|dias|semana|semanas)\b/,
    ) ?? normalized.match(/\b(\d{1,3})\s*(minuto|minutos|hora|horas|dia|dias|semana|semanas)\b/);
  if (inPattern) {
    const rawAmount = (inPattern[1] ?? "").trim();
    const unit = (inPattern[2] ?? "").trim();
    let amount = 0;
    if (rawAmount === "un" || rawAmount === "una") {
      amount = 1;
    } else if (rawAmount === "media") {
      amount = 0.5;
    } else {
      const parsed = Number.parseFloat(rawAmount);
      amount = Number.isFinite(parsed) ? parsed : 0;
    }
    if (amount > 0) {
      const minuteUnits = ["minuto", "minutos", "min", "mins"];
      const hourUnits = ["hora", "horas", "h", "hs"];
      const dayUnits = ["dia", "dias"];
      const weekUnits = ["semana", "semanas"];
      let minutesToAdd = 0;
      if (minuteUnits.includes(unit)) {
        minutesToAdd = Math.round(amount);
      } else if (hourUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 60);
      } else if (dayUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 24 * 60);
      } else if (weekUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 7 * 24 * 60);
      }
      if (minutesToAdd > 0) {
        return addMinutes(now, minutesToAdd);
      }
    }
  }

  if (/\ben un rato\b/.test(normalized)) {
    return addMinutes(now, 30);
  }
  if (/\bahora\b/.test(normalized) && /\b(recorda|recuerda|tarea|recordatorio|agenda|programa)\b/.test(normalized)) {
    return addMinutes(now, 1);
  }

  return null;
}

function parseScheduleTime(normalized: string): { hour: number; minute: number } | null {
  if (/\bmediodia\b/.test(normalized)) {
    return { hour: 12, minute: 0 };
  }
  if (/\bmedianoche\b/.test(normalized)) {
    return { hour: 0, minute: 0 };
  }

  const hhmm = normalized.match(/\b(?:a\s+las\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)?\b/);
  if (hhmm) {
    let hour = Number.parseInt(hhmm[1] ?? "", 10);
    const minute = Number.parseInt(hhmm[2] ?? "", 10);
    const ampm = (hhmm[3] ?? "").toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
      return null;
    }
    if (ampm) {
      if (hour < 1 || hour > 12) {
        return null;
      }
      if (ampm === "pm" && hour < 12) {
        hour += 12;
      }
      if (ampm === "am" && hour === 12) {
        hour = 0;
      }
    }
    if (hour < 0 || hour > 23) {
      return null;
    }
    return { hour, minute };
  }

  const ampmOnly = normalized.match(/\b(?:a\s+las\s+)?(\d{1,2})\s*(am|pm)\b/);
  if (ampmOnly) {
    let hour = Number.parseInt(ampmOnly[1] ?? "", 10);
    const ampm = (ampmOnly[2] ?? "").toLowerCase();
    if (!Number.isFinite(hour) || hour < 1 || hour > 12) {
      return null;
    }
    if (ampm === "pm" && hour < 12) {
      hour += 12;
    }
    if (ampm === "am" && hour === 12) {
      hour = 0;
    }
    return { hour, minute: 0 };
  }

  const simple = normalized.match(/\ba\s+las\s+(\d{1,2})\b/);
  if (simple) {
    const hour = Number.parseInt(simple[1] ?? "", 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
      return null;
    }
    return { hour, minute: 0 };
  }

  return null;
}

function parseScheduleExplicitDate(
  normalized: string,
  now: Date,
): { year: number; month: number; day: number; fromKeywordToday: boolean } | null {
  const yearNow = now.getFullYear();
  const monthNow = now.getMonth();
  const dayNow = now.getDate();

  if (/\bpasado manana\b/.test(normalized)) {
    const date = new Date(yearNow, monthNow, dayNow + 2, 0, 0, 0, 0);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      fromKeywordToday: false,
    };
  }
  if (/\bmanana\b/.test(normalized)) {
    const date = new Date(yearNow, monthNow, dayNow + 1, 0, 0, 0, 0);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      fromKeywordToday: false,
    };
  }
  if (/\bhoy\b/.test(normalized)) {
    return {
      year: yearNow,
      month: monthNow,
      day: dayNow,
      fromKeywordToday: true,
    };
  }

  const isoDate = normalized.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate) {
    const year = Number.parseInt(isoDate[1] ?? "", 10);
    const month = Number.parseInt(isoDate[2] ?? "", 10) - 1;
    const day = Number.parseInt(isoDate[3] ?? "", 10);
    const candidate = new Date(year, month, day, 0, 0, 0, 0);
    if (
      candidate.getFullYear() === year &&
      candidate.getMonth() === month &&
      candidate.getDate() === day
    ) {
      return { year, month, day, fromKeywordToday: false };
    }
  }

  const slashDate = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashDate) {
    const day = Number.parseInt(slashDate[1] ?? "", 10);
    const month = Number.parseInt(slashDate[2] ?? "", 10) - 1;
    let year = yearNow;
    if (slashDate[3]) {
      const rawYear = Number.parseInt(slashDate[3] ?? "", 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    }
    const candidate = new Date(year, month, day, 0, 0, 0, 0);
    if (
      candidate.getFullYear() === year &&
      candidate.getMonth() === month &&
      candidate.getDate() === day
    ) {
      return { year, month, day, fromKeywordToday: false };
    }
  }

  const longDate = normalized.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{2,4}))?\b/,
  );
  if (longDate) {
    const day = Number.parseInt(longDate[1] ?? "", 10);
    const monthName = longDate[2] ?? "";
    const month = SCHEDULE_MONTH_TO_INDEX[monthName];
    let year = yearNow;
    if (longDate[3]) {
      const rawYear = Number.parseInt(longDate[3] ?? "", 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    }
    if (typeof month === "number") {
      const candidate = new Date(year, month, day, 0, 0, 0, 0);
      if (
        candidate.getFullYear() === year &&
        candidate.getMonth() === month &&
        candidate.getDate() === day
      ) {
        return { year, month, day, fromKeywordToday: false };
      }
    }
  }

  const weekday = normalized.match(/\b(?:(proximo)\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (weekday) {
    const forceNext = Boolean(weekday[1]);
    const targetName = weekday[2] ?? "";
    const targetDow = SCHEDULE_WEEKDAY_TO_INDEX[targetName];
    if (typeof targetDow === "number") {
      const currentDow = now.getDay();
      let delta = (targetDow - currentDow + 7) % 7;
      if (delta === 0 && forceNext) {
        delta = 7;
      }
      const candidate = new Date(yearNow, monthNow, dayNow + delta, 0, 0, 0, 0);
      return {
        year: candidate.getFullYear(),
        month: candidate.getMonth(),
        day: candidate.getDate(),
        fromKeywordToday: delta === 0,
      };
    }
  }

  return null;
}

function parseNaturalScheduleDateTime(text: string, nowInput?: Date): { dueAt?: Date; hasTemporalSignal: boolean } {
  const now = nowInput ? new Date(nowInput.getTime()) : new Date();
  const normalized = normalizeIntentText(text);

  const relative = parseScheduleRelativeDateTime(normalized, now);
  if (relative) {
    return { dueAt: relative, hasTemporalSignal: true };
  }

  const datePart = parseScheduleExplicitDate(normalized, now);
  const timePart = parseScheduleTime(normalized);
  const hasTemporalSignal = Boolean(datePart || timePart);
  if (!hasTemporalSignal) {
    return { hasTemporalSignal: false };
  }

  const base = datePart
    ? new Date(datePart.year, datePart.month, datePart.day, 0, 0, 0, 0)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  if (timePart) {
    base.setHours(timePart.hour, timePart.minute, 0, 0);
  } else {
    if (datePart?.fromKeywordToday) {
      const soon = addMinutes(now, 10);
      base.setHours(soon.getHours(), soon.getMinutes(), 0, 0);
    } else {
      base.setHours(9, 0, 0, 0);
    }
  }

  if (!datePart && timePart && base.getTime() <= now.getTime()) {
    base.setDate(base.getDate() + 1);
  }

  return { dueAt: base, hasTemporalSignal: true };
}

function stripScheduleTemporalPhrases(text: string): string {
  return text
    .replace(
      /\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(?:minuto|minutos|min|mins|hora|horas|h|hs|dia|dias|semana|semanas)\b/gi,
      " ",
    )
    .replace(/\bpasado\s+manana\b/gi, " ")
    .replace(/\bmanana\b/gi, " ")
    .replace(/\bhoy\b/gi, " ")
    .replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, " ")
    .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, " ")
    .replace(
      /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{2,4}))?\b/gi,
      " ",
    )
    .replace(/\b(?:(proximo)\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/gi, " ")
    .replace(/\bmediodia\b/gi, " ")
    .replace(/\bmedianoche\b/gi, " ")
    .replace(/\b(?:a\s+las\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b(?:a\s+las\s+)?(\d{1,2})\s*(?:am|pm)\b/gi, " ")
    .replace(/\ba\s+las\s+(\d{1,2})\b/gi, " ")
    .replace(/\ben un rato\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectAgentVersionIntent(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return false;
  }
  if (
    /\b(que version|cual es tu version|decime tu version|dime tu version|version del agente|version de houdi|tu version)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return /\b(version)\b/.test(normalized) && /\b(houdi|agente|bot|asistente)\b/.test(normalized);
}

function sanitizeScheduleTitle(raw: string): string {
  const cleaned = raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(de|para|que|sobre|acerca de)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateInline(cleaned, 400);
}

function extractTaskTitleForCreate(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    return sanitizeScheduleTitle(quoted.join(" "));
  }

  const cleaned = stripScheduleTemporalPhrases(text)
    .replace(
      /\b(recordame|recordarme|recuerdame|recordar|agenda|agendame|agendar|programa|programar|crea|crear|genera|generar|tarea|tareas|recordatorio|recordatorios|por favor|porfa)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeScheduleTitle(cleaned);
}

function inferDefaultSelfEmailRecipient(text: string): string {
  const normalized = normalizeIntentText(text);
  const selfDirected =
    /\b(enviame|enviarme|mandame|mandarme|mandame|mandáme|enviamelo|enviámelo)\b/.test(normalized) ||
    /\b(a mi|para mi|a mí|para mí)\b/.test(normalized);
  if (!selfDirected) {
    return "";
  }
  return config.gmailAccountEmail?.trim().toLowerCase() || "";
}

function extractScheduledEmailInstruction(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    return truncateInline(quoted.join(" ").trim(), 1000);
  }

  const cleaned = stripScheduleTemporalPhrases(text)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
    .replace(
      /\b(enviame|enviarme|envia|enviar|manda|mandar|mandame|mandarme|correo|mail|email|gmail|a|para|hoy|esta tarde|esta noche|esta manana|esta mañana)\b/gi,
      " ",
    )
    .replace(/\b(con asunto|asunto|mensaje|cuerpo|texto)\s*[:=-]?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return truncateInline(cleaned, 1000);
}

function extractTaskTitleForEdit(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    return sanitizeScheduleTitle(quoted.join(" "));
  }

  const explicit =
    text.match(/\b(?:texto|descripcion|descripción|detalle|mensaje)\s*[:=-]\s*(.+)$/i)?.[1]?.trim() ??
    text.match(/\b(?:que diga|que sea)\s+(.+)$/i)?.[1]?.trim() ??
    "";
  if (explicit) {
    return sanitizeScheduleTitle(explicit);
  }

  const cleaned = stripScheduleTemporalPhrases(text)
    .replace(
      /\b(edita|editar|cambia|cambiar|modifica|modificar|reprograma|reprogramar|mueve|mover|actualiza|actualizar|pospone|posponer|tarea|recordatorio|numero|nro|#)\b/gi,
      " ",
    )
    .replace(/\b\d{1,3}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeScheduleTitle(cleaned);
}

function extractScheduleTaskRef(text: string): string | null {
  const normalized = normalizeIntentText(text);
  if (/\b(ultima|ultimo|last)\b/.test(normalized)) {
    return "last";
  }

  const taskId = text.match(/\btsk-[a-z0-9-]+\b/i)?.[0];
  if (taskId) {
    return taskId;
  }

  const numeric =
    normalized.match(/\b(?:tarea|recordatorio)\s*(?:numero|nro|#)?\s*(\d{1,3})\b/)?.[1] ??
    normalized.match(/\b(?:numero|nro|#)\s*(\d{1,3})\b/)?.[1];
  if (numeric) {
    return numeric;
  }
  return null;
}

function detectScheduleNaturalIntent(text: string): ScheduleNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeIntentText(original);
  const scheduleNouns = /\b(recordatorio|recordatorios|tarea|tareas|agenda)\b/.test(normalized);
  const parsedSchedule = parseNaturalScheduleDateTime(original, new Date());
  const hasEmailNoun = /\b(correo|mail|email|gmail)\b/.test(normalized);
  const hasSendVerb = /\b(envia|enviar|enviame|enviarme|manda|mandar|mandame|mandarme)\b/.test(normalized);

  const listRequested =
    /\b(lista|listar|mostra|mostrar|ver|cuales|cuantas|pendientes)\b/.test(normalized) &&
    scheduleNouns;
  if (listRequested || /\b(?:mis\s+)?(?:tareas|recordatorios)\b/.test(normalized) && /\b(que|cuales|ver|mostrar)\b/.test(normalized)) {
    return { shouldHandle: true, action: "list" };
  }

  const deleteRequested =
    /\b(elimina|eliminar|borra|borrar|quita|quitar|cancela|cancelar|remove|delete)\b/.test(normalized) &&
    scheduleNouns;
  if (deleteRequested) {
    return {
      shouldHandle: true,
      action: "delete",
      taskRef: extractScheduleTaskRef(original) ?? undefined,
    };
  }

  const editRequested =
    /\b(edita|editar|cambia|cambiar|modifica|modificar|reprograma|reprogramar|mueve|mover|actualiza|actualizar|pospone|posponer)\b/.test(
      normalized,
    ) && scheduleNouns;
  if (editRequested) {
    const taskRef = extractScheduleTaskRef(original) ?? undefined;
    const taskTitle = extractTaskTitleForEdit(original);
    return {
      shouldHandle: true,
      action: "edit",
      taskRef,
      ...(taskTitle ? { taskTitle } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  const createRequested =
    /\b(recordame|recordarme|recuerdame|agenda|agendame|agendar|programa|programar|crear|crea|genera|generar)\b/.test(
      normalized,
    ) && (scheduleNouns || parsedSchedule.hasTemporalSignal);
  const scheduledEmailRequested = parsedSchedule.hasTemporalSignal && hasEmailNoun && hasSendVerb;
  if (scheduledEmailRequested) {
    const to = extractEmailAddresses(original)[0] ?? inferDefaultSelfEmailRecipient(original);
    const emailInstruction = extractScheduledEmailInstruction(original);
    const taskTitle = sanitizeScheduleTitle(
      `Enviar email${to ? ` a ${to}` : ""}${emailInstruction ? `: ${emailInstruction}` : ""}`,
    );
    return {
      shouldHandle: true,
      action: "create",
      scheduleEmail: true,
      ...(taskTitle ? { taskTitle } : {}),
      ...(to ? { emailTo: to } : {}),
      ...(emailInstruction ? { emailInstruction } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  if (createRequested || (scheduleNouns && parsedSchedule.hasTemporalSignal)) {
    const taskTitle = extractTaskTitleForCreate(original);
    return {
      shouldHandle: true,
      action: "create",
      ...(taskTitle ? { taskTitle } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  return { shouldHandle: false };
}

function cleanMemoryNaturalQuery(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^[,.:;!?¿¡\s-]+|[,.:;!?¿¡\s-]+$/g, "")
    .replace(/^(de|sobre|si|que|acerca de|lo de)\s+/i, "")
    .replace(/\b(porfa|por favor|gracias)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericMemoryQuery(query: string): boolean {
  const normalized = normalizeIntentText(query);
  return (
    !normalized ||
    ["eso", "esto", "algo", "tema", "ese tema", "este tema", "lo", "lo de siempre"].includes(normalized)
  );
}

function extractMemoryNaturalQueryFromInput(input: string): string {
  const text = input.trim();
  if (!text) {
    return "";
  }

  const patterns = [
    /\b(?:te\s+acordas|te\s+acuerdas|te\s+recordas|te\s+recuerdas)\s+(?:de|sobre|si|acerca\s+de)?\s*(.+)$/i,
    /\b(?:recordas|recuerdas|acordas|acuerdas)\s+(?:de|sobre|si|acerca\s+de)?\s*(.+)$/i,
    /\b(?:que|qué)\s+(?:te\s+)?(?:acordas|acuerdas|recordas|recuerdas)\s+(?:de|sobre)?\s*(.+)$/i,
    /\b(?:busca(?:r)?|consulta(?:r)?|revisa(?:r)?|lee(?:r)?|mostra(?:r)?|trae)\s+(?:en\s+)?(?:tu\s+)?(?:la\s+)?(?:memoria|memory)\s*(?:sobre|de|acerca\s+de)?\s*(.+)$/i,
    /\b(?:en\s+)?(?:tu\s+)?(?:la\s+)?(?:memoria|memory)\s*(?:sobre|de|acerca\s+de)?\s*(.+)$/i,
    /\b(?:me\s+dijiste|me\s+habias\s+dicho|habiamos\s+hablado|hablamos|comentamos)\s*(?:de|sobre)?\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const value = cleanMemoryNaturalQuery(pattern.exec(text)?.[1] ?? "");
    if (value) {
      return value;
    }
  }

  return "";
}

function extractMemoryNaturalQuery(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    const combined = cleanMemoryNaturalQuery(quoted.join(" "));
    if (combined) {
      return combined;
    }
  }

  const fromOriginal = extractMemoryNaturalQueryFromInput(text);
  if (fromOriginal) {
    return fromOriginal;
  }

  const normalized = normalizeIntentText(text);
  return extractMemoryNaturalQueryFromInput(normalized);
}

function detectMemoryNaturalIntent(text: string): MemoryNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeIntentText(original);
  const directProfileRecall =
    /\b(?:cual|que)\b.*\b(?:mi|yo)\b.*\b(?:equipo|club|cuadro)\b/.test(normalized) ||
    /\bde\s+que\s+(?:equipo|club|cuadro)\s+soy\b/.test(normalized) ||
    /\bcual\s+es\s+mi\s+equipo\b/.test(normalized);
  if (directProfileRecall) {
    return {
      shouldHandle: true,
      action: "recall",
      query: "equipo futbol",
    };
  }

  const scheduleLike = /\b(recordame|recordarme|recuerdame|recordatorio|recordatorios|agenda|tarea|tareas|programa|programar)\b/.test(
    normalized,
  );
  if (scheduleLike) {
    return { shouldHandle: false };
  }

  const hasMemoryWord = /\b(memoria|memory)\b/.test(normalized);
  const hasRecallVerb = /\b(te\s+acordas|te\s+acuerdas|te\s+recordas|te\s+recuerdas|recordas|recuerdas|acordas|acuerdas)\b/.test(
    normalized,
  );
  const hasConversationRecall =
    /\b(me\s+dijiste|me\s+habias\s+dicho|habiamos\s+hablado|hablamos|comentamos)\b/.test(normalized) ||
    /\b(lo\s+que\s+hablamos|lo\s+que\s+dijimos)\b/.test(normalized);
  const explicitMemorySearch = /\b(busca|buscar|consulta|consultar|revisa|revisar|lee|leer|mostra|mostrar|trae)\b.*\b(memoria|memory)\b/.test(
    normalized,
  );

  const statusRequested =
    hasMemoryWord &&
    /\b(estado|status|funciona|funcionando|activa|activo|ok|anda|andando|habilitada|habilitado)\b/.test(normalized);

  if (statusRequested && !hasRecallVerb && !hasConversationRecall && !explicitMemorySearch) {
    return { shouldHandle: true, action: "status" };
  }

  const shouldRecall = hasRecallVerb || hasConversationRecall || explicitMemorySearch;
  if (!shouldRecall) {
    return { shouldHandle: false };
  }

  const query = extractMemoryNaturalQuery(original);
  if (!query && statusRequested) {
    return { shouldHandle: true, action: "status" };
  }

  return {
    shouldHandle: true,
    action: "recall",
    ...(query ? { query } : {}),
  };
}

function formatScheduleDateTime(date: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return `${date.toLocaleString("es-AR", { hour12: false })} (${tz})`;
}

function rememberLastDocumentSnapshot(chatId: number, docPath: string, text: string): void {
  const pathClean = docPath.trim();
  const textClean = text.trim();
  if (!pathClean || !textClean) {
    return;
  }
  lastDocumentByChat.set(chatId, {
    path: pathClean,
    text: truncateInline(textClean, 30_000),
    updatedAt: new Date().toISOString(),
  });
}

function extractQuotedSegments(text: string): string[] {
  const pattern = /"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|«([^»\n]+)»/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[1] || match[2] || match[3] || match[4] || "").trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function detectGmailRecipientNaturalIntent(text: string): GmailRecipientNaturalIntent {
  return detectGmailRecipientNaturalIntentDomain(text, {
    normalizeIntentText,
    extractQuotedSegments,
    extractEmailAddresses,
    extractRecipientNameFromText,
    inferDefaultSelfEmailRecipient,
    detectGmailAutoContentKind,
    parseGmailLabeledFields,
    extractLiteralBodyRequest,
    extractNaturalSubjectRequest,
    detectCreativeEmailCue,
    detectGmailDraftRequested,
    buildGmailDraftInstruction,
    shouldAvoidLiteralBodyFallback,
    parseNaturalLimit,
    buildNaturalGmailQuery,
    gmailAccountEmail: config.gmailAccountEmail,
  });
}

function getRecentConversationContext(chatId: number, currentUserText: string, limit: number): string[] {
  let turns = recentConversationByChat.get(chatId) ?? [];
  if (turns.length === 0) {
    try {
      const stored = sqliteState.listRecentConversationTurns(chatId, Math.max(limit + 6, 20));
      if (stored.length > 0) {
        turns = stored.map((turn) => ({
          role: turn.role,
          text: turn.text,
          source: turn.source,
          atMs: turn.atMs,
        }));
        recentConversationByChat.set(chatId, turns.slice(-RECENT_CONVERSATION_TURN_LIMIT));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`No pude leer conversación reciente desde SQLite: ${message}`);
    }
  }
  if (turns.length === 0) {
    return [];
  }
  const trimmedCurrent = currentUserText.trim();
  const filtered = turns.filter((turn, idx) => {
    if (turn.role !== "user") {
      return true;
    }
    if (idx !== turns.length - 1) {
      return true;
    }
    return turn.text.trim() !== trimmedCurrent;
  });
  const picked = filtered.slice(-Math.max(1, limit));
  return picked.map((turn) => `${turn.role}: ${truncateInline(turn.text, 400)}`);
}

function getRecentEmailRouterContext(chatId: number, currentUserText: string): string[] {
  return getRecentConversationContext(chatId, currentUserText, RECENT_EMAIL_ROUTER_CONTEXT_TURNS);
}

function uniqueRouteCandidates(candidates: Exclude<NaturalIntentHandlerName, "none">[]): Exclude<NaturalIntentHandlerName, "none">[] {
  return Array.from(new Set(candidates));
}

function narrowRouteCandidates(
  base: Exclude<NaturalIntentHandlerName, "none">[],
  subset: Exclude<NaturalIntentHandlerName, "none">[],
): Exclude<NaturalIntentHandlerName, "none">[] {
  const allowedSet = new Set(subset);
  const next = base.filter((candidate) => allowedSet.has(candidate));
  return next.length > 0 ? next : base;
}

function buildIntentRouterContextFilter(params: {
  chatId: number;
  text: string;
  candidates: Exclude<NaturalIntentHandlerName, "none">[];
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
}): IntentRouterFilterDecision | null {
  const decision = buildIntentRouterContextFilterDomain(
    {
      ...params,
      candidates: params.candidates,
    },
    {
      normalizeIntentText,
      parseIndexedListReferenceIntent,
      getIndexedListContext,
      getPendingWorkspaceDelete: (chatId) => pendingWorkspaceDeleteByChat.get(chatId) ?? null,
      getPendingWorkspaceDeletePath: (chatId) => pendingWorkspaceDeletePathByChat.get(chatId) ?? null,
      getLastGmailResultsCount: (chatId) => lastGmailResultsByChat.get(chatId)?.length ?? 0,
      getLastListedFilesCount: (chatId) => lastListedFilesByChat.get(chatId)?.length ?? 0,
      getLastConnectorContextAt: (chatId) => lastConnectorContextByChat.get(chatId) ?? 0,
      connectorContextTtlMs: CONNECTOR_CONTEXT_TTL_MS,
    },
  );
  if (!decision) {
    return null;
  }
  return {
    allowed: decision.allowed as Exclude<NaturalIntentHandlerName, "none">[],
    reason: decision.reason,
  };
}

function buildIntentRouterScoreBoosts(params: {
  chatId: number;
  text: string;
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
}): Partial<Record<IntentRouteName, number>> {
  const normalized = normalizeIntentText(params.text);
  const boosts: Partial<Record<IntentRouteName, number>> = {};
  const addBoost = (name: IntentRouteName, value: number) => {
    boosts[name] = (boosts[name] ?? 0) + value;
  };

  if (params.hasMailContext && !params.hasMemoryRecallCue) {
    addBoost("gmail", 0.04);
    addBoost("gmail-recipients", 0.03);
  }
  if (params.hasMemoryRecallCue) {
    addBoost("memory", 0.05);
  }
  if (/\b(workspace|archivo|carpeta|documento|pdf|txt|csv|json|md)\b/.test(normalized)) {
    addBoost("workspace", 0.02);
    addBoost("document", 0.02);
  }
  if (/\b(web|internet|noticias|reddit|url|link)\b/.test(normalized)) {
    addBoost("web", 0.02);
  }

  const listContext = getIndexedListContext(params.chatId);
  if (listContext?.kind === "gmail-list") {
    addBoost("gmail", 0.05);
    addBoost("gmail-recipients", 0.03);
  } else if (listContext?.kind === "workspace-list" || listContext?.kind === "stored-files") {
    addBoost("workspace", 0.04);
    addBoost("document", 0.03);
  } else if (listContext?.kind === "web-results") {
    addBoost("web", 0.05);
  }

  return boosts;
}

function buildIntentRouterForChat(chatId: number): {
  router: IntentSemanticRouter;
  abVariant: "A" | "B";
  effectiveAlpha: number;
  effectiveMinGap: number;
  canaryVersionId: string | null;
} {
  const abVariant = resolveIntentRouterAbVariant(chatId, {
    enabled: config.intentRouterAbEnabled,
    splitPercent: config.intentRouterAbSplitPercent,
    variantBAlpha: config.intentRouterAbVariantBAlpha,
    variantBMinGap: config.intentRouterAbVariantBMinGap,
    variantBThresholdShift: config.intentRouterAbVariantBThresholdShift,
  });
  const baseRoutes = semanticIntentRouter.listRoutes();
  const canaryResolvedRoutes = routerVersionStore.resolveRoutesForChat(chatId, baseRoutes);
  const canaryStatus = routerVersionStore.getCanaryStatus();
  const canaryVersionId =
    canaryStatus.enabled &&
    canaryStatus.versionId &&
    Math.abs(chatId) % 100 < canaryStatus.splitPercent
      ? canaryStatus.versionId
      : null;
  const effectiveRoutes = dynamicIntentRoutes.buildEffectiveRoutes(chatId, canaryResolvedRoutes).map((route) => ({
    ...route,
    threshold:
      abVariant === "B"
        ? Math.max(0.01, Math.min(0.99, route.threshold + config.intentRouterAbVariantBThresholdShift))
        : route.threshold,
  }));
  const effectiveAlpha = abVariant === "B" ? config.intentRouterAbVariantBAlpha : semanticIntentRouter.getHybridAlpha();
  const effectiveMinGap = abVariant === "B" ? config.intentRouterAbVariantBMinGap : semanticIntentRouter.getMinScoreGap();
  return {
    router: new IntentSemanticRouter({
      routes: effectiveRoutes,
      hybridAlpha: effectiveAlpha,
      minScoreGap: effectiveMinGap,
    }),
    abVariant,
    effectiveAlpha,
    effectiveMinGap,
    canaryVersionId,
  };
}

function shouldRunAiJudgeForEnsemble(decision: SemanticRouteDecision | null): boolean {
  if (!decision) {
    return true;
  }
  const top = decision.alternatives[0];
  const second = decision.alternatives[1];
  const gap = top && second ? top.score - second.score : 1;
  return decision.score < 0.74 || gap < 0.06;
}

async function saveCurrentRouterSnapshot(label: string): Promise<string> {
  const snapshot = routerVersionStore.createSnapshot({
    label,
    routes: semanticIntentRouter.listRoutes(),
    hybridAlpha: semanticIntentRouter.getHybridAlpha(),
    minScoreGap: semanticIntentRouter.getMinScoreGap(),
  });
  await routerVersionStore.save(config.intentRouterVersionsFile);
  return snapshot.id;
}

async function applyRouterSnapshotById(versionId: string): Promise<boolean> {
  const snapshot = routerVersionStore.rollbackTo(versionId);
  if (!snapshot) {
    return false;
  }
  const nextRouter = new IntentSemanticRouter({
    routes: snapshot.routes,
    hybridAlpha: snapshot.hybridAlpha,
    minScoreGap: snapshot.minScoreGap,
  });
  await nextRouter.saveToFile(config.intentRouterRoutesFile);
  await semanticIntentRouter.loadFromFile(config.intentRouterRoutesFile, {
    createIfMissing: true,
  });
  await routerVersionStore.save(config.intentRouterVersionsFile);
  return true;
}

function buildIntentClarificationQuestion(alternatives: Array<{ name: string; score: number }>): string {
  const top = alternatives[0]?.name ?? "";
  const second = alternatives[1]?.name ?? "";
  const pair = [top, second].filter(Boolean).sort().join("|");
  if (pair === "document|workspace") {
    return "Necesito precisión: ¿quieres editar/crear archivo en workspace o solo leer/analizar un documento?";
  }
  if (pair === "gmail|web") {
    return "Necesito precisión: ¿quieres enviar/leer un email o buscar información en la web?";
  }
  if (pair === "gmail-recipients|gmail") {
    return "Necesito precisión: ¿quieres gestionar contactos/destinatarios o enviar/leer correos?";
  }
  if (pair === "memory|workspace") {
    return "Necesito precisión: ¿quieres consultar memoria previa o modificar archivos en workspace?";
  }
  const topChoices = alternatives
    .slice(0, 2)
    .map((item) => item.name)
    .join(" / ");
  return `Estoy entre dos intenciones (${topChoices}). ¿Puedes aclarar en una frase la acción exacta?`;
}

async function appendIntentRouterDatasetEntry(entry: IntentRouterDatasetEntry): Promise<void> {
  await intentRouterStatsRepository.append(entry);
}

async function buildIntentRouterStatsReport(limit: number): Promise<string> {
  return await buildIntentRouterStatsReportDomain({
    limit,
    repository: intentRouterStatsRepository,
    toProjectRelativePath,
    datasetFilePath: intentRouterDatasetFilePath,
    routeThresholds: semanticIntentRouter.listRouteThresholds().map((item) => ({
      name: item.name,
      threshold: item.threshold,
    })),
    alertMinPrecision: config.intentRouterAlertPrecisionMin,
    alertMinSamples: config.intentRouterAlertMinSamples,
  });
}

function tryParseNaturalRouteDecision(raw: string): {
  handler: NaturalIntentHandlerName;
  reason?: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as {
      handler?: unknown;
      reason?: unknown;
    };
    const handler = typeof parsed.handler === "string" ? parsed.handler.trim().toLowerCase() : "";
    const allowed = new Set<NaturalIntentHandlerName>([
      "stoic-smalltalk",
      "self-maintenance",
      "connector",
      "schedule",
      "memory",
      "gmail-recipients",
      "gmail",
      "workspace",
      "document",
      "web",
      "none",
    ]);
    if (!allowed.has(handler as NaturalIntentHandlerName)) {
      return null;
    }
    const reason = typeof parsed.reason === "string" ? truncateInline(parsed.reason.trim(), 180) : "";
    return {
      handler: handler as NaturalIntentHandlerName,
      ...(reason ? { reason } : {}),
    };
  } catch {
    return null;
  }
}

async function classifyNaturalIntentRouteWithAi(params: {
  chatId: number;
  text: string;
  candidates: Exclude<NaturalIntentHandlerName, "none">[];
}): Promise<{ handler: NaturalIntentHandlerName; reason?: string } | null> {
  const text = params.text.trim();
  if (!openAi.isConfigured() || text.length < NATURAL_INTENT_ROUTER_MIN_TEXT_CHARS) {
    return null;
  }
  const background = getRecentConversationContext(params.chatId, text, RECENT_INTENT_ROUTER_CONTEXT_TURNS);
  const candidateList = Array.from(new Set(params.candidates));
  if (candidateList.length === 0) {
    return null;
  }
  const prompt = [
    "Clasifica una instruccion de usuario a UN handler del bot.",
    "Devuelve SOLO JSON valido.",
    "",
    "Handlers disponibles:",
    "- stoic-smalltalk: charla corta estoica/motivacional.",
    "- self-maintenance: tareas del propio agente (skills, update, restart).",
    "- connector: estado/start/stop/restart de LIM/tunnel y consulta de mensajes LIM (first_name, last_name, fuente).",
    "- schedule: crear/listar/editar/eliminar tareas o recordatorios.",
    "- memory: preguntas de memoria/recuerdo/contexto previo.",
    "- gmail-recipients: ABM de destinatarios guardados.",
    "- gmail: leer/enviar/gestionar correos.",
    "- workspace: archivos/carpetas locales, borrar, mover, listar, enviar.",
    "- document: leer/analizar contenido documental.",
    "- web: buscar noticias o informacion en internet.",
    "- none: si no corresponde a ningun handler.",
    "",
    "Reglas:",
    `- Debes elegir un valor de esta lista: ${[...candidateList, "none"].join(", ")}`,
    "- Si hay ambiguedad fuerte, usa none.",
    "- Prioriza gmail-recipients sobre gmail cuando habla de destinatarios/contactos.",
    "",
    'Formato de salida: {"handler":"<valor>","reason":"motivo breve"}',
    `Pedido actual: ${text}`,
    ...(background.length > 0
      ? ["Contexto reciente (ultimos turnos):", ...background]
      : ["Contexto reciente: (vacio)"]),
  ].join("\n");
  const promptContext = await buildPromptContextForQuery(text, { chatId: params.chatId });
  try {
    const answer = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
    return tryParseNaturalRouteDecision(answer);
  } catch {
    return null;
  }
}

function tryParseAiSequencePlan(raw: string): { mode: "single" | "sequence"; steps: AiSequencePlanStep[]; reason?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as {
      mode?: unknown;
      steps?: unknown;
      reason?: unknown;
    };
    const modeRaw = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
    if (modeRaw !== "single" && modeRaw !== "sequence") {
      return null;
    }
    const steps = (Array.isArray(parsed.steps) ? parsed.steps : [])
      .map((entry) => {
        const instruction =
          typeof (entry as { instruction?: unknown })?.instruction === "string"
            ? truncateInline((entry as { instruction: string }).instruction.trim(), 700)
            : "";
        const aiContentPrompt =
          typeof (entry as { ai_content_prompt?: unknown })?.ai_content_prompt === "string"
            ? truncateInline((entry as { ai_content_prompt: string }).ai_content_prompt.trim(), 700)
            : "";
        if (!instruction) {
          return null;
        }
        return {
          instruction,
          ...(aiContentPrompt ? { aiContentPrompt } : {}),
        };
      })
      .filter((item): item is AiSequencePlanStep => Boolean(item))
      .slice(0, AI_SEQUENCE_ROUTER_MAX_STEPS);
    const reason = typeof parsed.reason === "string" ? truncateInline(parsed.reason.trim(), 180) : "";
    return {
      mode: modeRaw,
      steps,
      ...(reason ? { reason } : {}),
    };
  } catch {
    return null;
  }
}

async function classifySequencedIntentPlanWithAi(params: {
  chatId: number;
  text: string;
}): Promise<{ steps: AiSequencePlanStep[]; reason?: string } | null> {
  const text = params.text.trim();
  if (!openAi.isConfigured() || text.length < NATURAL_INTENT_ROUTER_MIN_TEXT_CHARS) {
    return null;
  }
  const background = getRecentConversationContext(params.chatId, text, RECENT_INTENT_ROUTER_CONTEXT_TURNS);
  const prompt = [
    "Eres un router de instrucciones secuenciadas.",
    "Debes decidir si el pedido es single o sequence.",
    "Si es sequence, devuelve pasos concretos en orden de ejecucion.",
    "Devuelve SOLO JSON valido.",
    "",
    "Dominios de ejecucion disponibles: workspace, gmail, gmail-recipients, web, document, memory, schedule, connector, self-maintenance, stoic-smalltalk.",
    "",
    "Reglas:",
    "- Usa mode=sequence solo si hay 2 o mas acciones distintas o dependientes.",
    "- Si no, usa mode=single y steps vacio.",
    "- Cada step.instruction debe ser accionable por el agente en lenguaje natural.",
    "- Si un paso necesita texto creativo/largo, agrega ai_content_prompt y usa {{ai_content}} dentro de instruction.",
    `- Maximo ${AI_SEQUENCE_ROUTER_MAX_STEPS} pasos.`,
    "",
    'Formato: {"mode":"single|sequence","steps":[{"instruction":"string","ai_content_prompt":"string opcional"}],"reason":"motivo breve"}',
    `Pedido actual: ${text}`,
    ...(background.length > 0
      ? ["Contexto reciente (ultimos turnos):", ...background]
      : ["Contexto reciente: (vacio)"]),
  ].join("\n");
  const promptContext = await buildPromptContextForQuery(text, { chatId: params.chatId });
  try {
    const answer = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
    const parsed = tryParseAiSequencePlan(answer);
    if (!parsed || parsed.mode !== "sequence" || parsed.steps.length < 2) {
      return null;
    }
    return {
      steps: parsed.steps,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  } catch {
    return null;
  }
}

async function generateSequenceStepContentWithAi(params: {
  chatId: number;
  userText: string;
  stepInstruction: string;
  contentPrompt: string;
}): Promise<string | null> {
  const prompt = [
    "Genera SOLO el contenido solicitado.",
    "No expliques nada, no uses markdown, no agregues encabezados.",
    "",
    `Pedido original: ${params.userText}`,
    `Paso: ${params.stepInstruction}`,
    `Contenido a generar: ${params.contentPrompt}`,
  ].join("\n");
  const promptContext = await buildPromptContextForQuery(params.userText, { chatId: params.chatId });
  try {
    const answer = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
    const content = answer.trim();
    return content || null;
  } catch {
    return null;
  }
}

function materializeSequenceStepInstruction(step: AiSequencePlanStep, aiContent: string | null): string {
  if (!aiContent) {
    return step.instruction;
  }
  if (step.instruction.includes("{{ai_content}}")) {
    return step.instruction.replace(/\{\{ai_content\}\}/g, aiContent);
  }
  return `${step.instruction}\ncontenido: ${aiContent}`;
}

function tryParseEmailModeDecision(raw: string): { mode: "improvise" | "literal"; literalBody?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as { mode?: unknown; literal_body?: unknown };
    const modeRaw = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
    if (modeRaw !== "improvise" && modeRaw !== "literal") {
      return null;
    }
    const literalBody = typeof parsed.literal_body === "string" ? parsed.literal_body.trim() : "";
    return modeRaw === "literal"
      ? { mode: "literal", ...(literalBody ? { literalBody } : {}) }
      : { mode: "improvise" };
  } catch {
    return null;
  }
}

async function classifyMissingSubjectEmailModeWithAi(params: {
  chatId: number;
  userText: string;
}): Promise<{ mode: "improvise" | "literal"; literalBody?: string }> {
  const fallbackLiteral = extractLiteralBodyRequest(params.userText);
  if (!openAi.isConfigured()) {
    return fallbackLiteral ? { mode: "literal", literalBody: fallbackLiteral } : { mode: "improvise" };
  }
  const background = getRecentEmailRouterContext(params.chatId, params.userText);
  const prompt = [
    "Clasifica una instruccion de envio de email.",
    "Objetivo: elegir SOLO entre dos modos.",
    '- "improvise": IA redacta asunto y cuerpo nuevos segun pedido.',
    '- "literal": enviar texto literal pedido por usuario.',
    "Debes maximizar el objetivo real del usuario y no copiar el prompt si pide creatividad.",
    "",
    "Reglas de decision:",
    "- Si el usuario pide 'que diga ...', 'texto exacto ...' o equivalente, usa literal.",
    "- Si pide crear/redactar/improvisar/cancion/poema/mensaje alegre, usa improvise.",
    "- Si hay ambiguedad, prioriza improvise.",
    "",
    "Devuelve SOLO JSON valido:",
    '{"mode":"improvise"|"literal","literal_body":"string opcional solo si mode=literal"}',
    "",
    `Pedido actual: ${params.userText}`,
    ...(background.length > 0 ? ["Contexto previo (ultimos 3 turnos):", ...background] : ["Contexto previo: (vacio)"]),
  ].join("\n");
  const promptContext = await buildPromptContextForQuery(params.userText, { chatId: params.chatId });
  const answer = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
  const parsed = tryParseEmailModeDecision(answer);
  if (!parsed) {
    return fallbackLiteral ? { mode: "literal", literalBody: fallbackLiteral } : { mode: "improvise" };
  }
  if (parsed.mode === "literal" && !parsed.literalBody) {
    return fallbackLiteral ? { mode: "literal", literalBody: fallbackLiteral } : { mode: "improvise" };
  }
  return parsed;
}

function tryParseGmailDraftJson(raw: string): { subject: string; body: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as { subject?: unknown; body?: unknown };
    const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!subject || !body) {
      return null;
    }
    return { subject, body };
  } catch {
    return null;
  }
}

async function draftGmailMessageWithAi(params: {
  chatId: number;
  to: string;
  instruction: string;
}): Promise<{ subject: string; body: string } | null> {
  if (!openAi.isConfigured()) {
    return null;
  }

  const instruction = params.instruction.trim();
  if (!instruction) {
    return null;
  }

  const prompt = [
    "Redacta un email profesional en español.",
    `Destinatario: ${params.to}`,
    `Instrucción del usuario: ${instruction}`,
    "Devuelve SOLO JSON válido con este schema exacto:",
    '{"subject":"string","body":"string"}',
    "Reglas:",
    "- subject claro (max 90 caracteres).",
    "- body natural, concreto, con saltos de línea.",
    "- No incluyas markdown ni texto fuera del JSON.",
  ].join("\n");

  try {
    const promptContext = await buildPromptContextForQuery(instruction, { chatId: params.chatId });
    const answer = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
    return tryParseGmailDraftJson(answer);
  } catch {
    return null;
  }
}

function hasAssistantReferenceCue(textNormalized: string): boolean {
  return /\b(ultimo\s+mensaje|mensaje\s+anterior|respuesta\s+que\s+me\s+diste|esta\s+respuesta|esa\s+respuesta|lo\s+que\s+dijiste|anteultimo|anteultima|segunda\s+respuesta|tercera\s+respuesta|respuesta\s*#\s*\d+|mensaje\s*#\s*\d+|de\s+arriba)\b/.test(
    textNormalized,
  );
}

function resolveAssistantReplyIndexFromText(textNormalized: string): number {
  const normalized = normalizeIntentText(textNormalized);
  if (!normalized) {
    return 0;
  }
  if (/\b(ultima|ultimo|reciente|anterior|mensaje anterior|respuesta anterior|de arriba)\b/.test(normalized)) {
    return 0;
  }
  if (/\b(anteultimo|anteultima)\b/.test(normalized)) {
    return 1;
  }

  const ordinalMap: Record<string, number> = {
    primera: 1,
    primero: 1,
    segunda: 2,
    segundo: 2,
    tercera: 3,
    tercero: 3,
    cuarta: 4,
    cuarto: 4,
    quinta: 5,
    quinto: 5,
  };
  for (const [word, value] of Object.entries(ordinalMap)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized) && /\b(respuesta|mensaje)\b/.test(normalized)) {
      return Math.max(0, value - 1);
    }
  }

  const explicitIndexRaw =
    normalized.match(/\b(?:respuesta|mensaje)\s*(?:numero|nro|#)\s*(\d{1,2})\b/)?.[1] ??
    normalized.match(/\b(?:#)\s*(\d{1,2})\b/)?.[1];
  if (explicitIndexRaw) {
    const parsed = Number.parseInt(explicitIndexRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed - 1;
    }
  }
  return 0;
}

function resolveAssistantReplyByReference(chatId: number, text: string): AssistantReplySnapshot | null {
  const history = assistantReplyHistoryByChat.get(chatId) ?? [];
  if (history.length === 0) {
    return null;
  }
  const index = resolveAssistantReplyIndexFromText(text);
  const safeIndex = Math.max(0, Math.min(history.length - 1, index));
  return history[safeIndex] ?? null;
}

function detectGmailAutoContentKind(
  textNormalized: string,
): "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last" | undefined {
  if (hasAssistantReferenceCue(textNormalized)) {
    return "assistant-last";
  }
  if (/\b(contenido\s+del\s+documento|contenido\s+de\s+documento|contenido\s+del\s+archivo|del\s+documento)\b/.test(textNormalized)) {
    return "document";
  }
  if (/\b(enviarl[oa]|mandarl[oa]|enviarlo|enviarla|mandarlo|mandarla)\b/.test(textNormalized)) {
    return "document";
  }
  if (/\b(poema|poesia|poes[ií]a)\b/.test(textNormalized)) {
    return "poem";
  }
  if (/\b(reflexion|reflexion\s+estoica|estoic|estoicco|estoic[oa]s?|estoicismo|marco\s+aurelio)\b/.test(textNormalized)) {
    return "stoic";
  }
  if (/\b(ultimas?|ultimos?|noticias?|news|actualidad|titulares?)\b/.test(textNormalized)) {
    return "news";
  }
  if (/\b(recordatorios?|tareas?\s+pendientes?|pendientes?)\b/.test(textNormalized)) {
    return "reminders";
  }
  return undefined;
}

function buildEmailNewsQueryFromText(text: string): string {
  const cleaned = sanitizeNaturalWebQuery(text)
    .replace(/\b(enviame|enviarme|envia|enviar|correo|mail|email|gmail)\b/gi, " ")
    .replace(/\b(ultimas?|ultimos?|noticias?|news|resumen)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "noticias del dia";
}

async function resolveEmailDocumentContent(chatId: number, userText: string): Promise<{ path: string; text: string } | null> {
  const supportedRefs = extractDocumentReferences(userText, documentReader.getSupportedFormats());
  const simpleRef = extractSimpleFilePathCandidate(userText);
  const candidates = Array.from(new Set([simpleRef, ...supportedRefs].filter(Boolean)));

  for (const candidate of candidates) {
    try {
      const result = await documentReader.readDocument(candidate);
      if (result.text.trim()) {
        return { path: result.path, text: result.text };
      }
    } catch {
      // fallback below
    }

    try {
      const resolved = resolveWorkspacePath(candidate);
      const raw = await fs.readFile(resolved.fullPath, "utf8");
      if (raw.trim()) {
        return { path: resolved.relPath, text: raw };
      }
    } catch {
      // ignore candidate and continue
    }
  }

  const snapshot = lastDocumentByChat.get(chatId);
  if (!snapshot || !snapshot.text.trim()) {
    return null;
  }
  return {
    path: snapshot.path,
    text: snapshot.text,
  };
}

async function buildGmailAutoContent(params: {
  chatId: number;
  kind: "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last";
  userText: string;
}): Promise<{ subject: string; body: string }> {
  if (params.kind === "assistant-last") {
    const lastAssistant = resolveAssistantReplyByReference(params.chatId, params.userText);
    if (!lastAssistant || !lastAssistant.text.trim()) {
      return {
        subject: "Última respuesta",
        body: "No encontré una respuesta previa reciente para reenviar.",
      };
    }
    return {
      subject: "Respuesta previa de Houdi",
      body: truncateInline(lastAssistant.text, 20_000),
    };
  }

  if (params.kind === "document") {
    const doc = await resolveEmailDocumentContent(params.chatId, params.userText);
    if (!doc) {
      return {
        subject: "Documento para enviar",
        body: "No encontré un documento reciente para enviar. Indica el archivo (ej: supermercado.txt) o léelo primero.",
      };
    }
    return {
      subject: `Contenido de ${path.basename(doc.path)}`,
      body: truncateInline(doc.text, 20_000),
    };
  }

  if (params.kind === "reminders") {
    const pending = scheduledTasks.listPending(params.chatId).slice(0, 25);
    const lines =
      pending.length > 0
        ? pending.map((task, idx) => `${idx + 1}. ${task.title} (${formatScheduleDateTime(new Date(task.dueAt))})`)
        : ["No hay recordatorios pendientes."];
    return {
      subject: "Resumen de recordatorios pendientes",
      body: ["Recordatorios pendientes:", ...lines].join("\n"),
    };
  }

  if (params.kind === "news") {
    if (!config.enableWebBrowse) {
      return {
        subject: "Resumen de noticias",
        body: "La navegación web está deshabilitada en este agente (ENABLE_WEB_BROWSE=false).",
      };
    }
    const rawQuery = buildEmailNewsQueryFromText(params.userText);
    const searchResult = await runWebSearchQuery({
      rawQuery,
      newsRequested: true,
    });
    const hits = searchResult.hits.slice(0, 6);
    const lines =
      hits.length > 0
        ? hits.map((hit, idx) => `${idx + 1}. ${hit.title}\n${hit.snippet ? `${truncateInline(hit.snippet, 220)}\n` : ""}${hit.url}`)
        : ["No encontré noticias recientes relevantes."];
    return {
      subject: `Noticias recientes: ${rawQuery}`,
      body: ["Resumen breve de últimas noticias:", ...lines].join("\n\n"),
    };
  }

  if (params.kind === "stoic") {
    if (openAi.isConfigured()) {
      try {
        const prompt = [
          "Redacta un email breve en español con una reflexión estoica original.",
          "Estilo: sobrio, concreto, útil para actuar hoy.",
          "Incluye 1 idea práctica aplicable en el día.",
          "Sin markdown. Solo texto plano.",
        ].join("\n");
        const promptContext = await buildPromptContextForQuery(params.userText, { chatId: params.chatId });
        const reflection = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
        if (reflection.trim()) {
          return {
            subject: "Reflexión estoica del día",
            body: reflection.trim(),
          };
        }
      } catch {
        // fallback below
      }
    }
    const fallbackPool = [
      "No controlas lo que llega, sí cómo respondes. Hoy elegí una sola acción difícil y hacela primero; el carácter se entrena en lo incómodo.",
      "La ansiedad suele hablar de futuro; la disciplina trabaja en el presente. Definí el próximo paso concreto y ejecutalo sin negociar.",
      "Si algo externo te altera, recordá: el juicio es tuyo. Reemplazá reacción por criterio, y convertí el obstáculo en práctica.",
      "No esperes motivación para empezar. Empezá para construirla. Diez minutos de foco valen más que una hora de intención.",
    ];
    const picked = fallbackPool[Math.floor(Math.random() * fallbackPool.length)] ?? fallbackPool[0]!;
    return {
      subject: "Reflexión estoica del día",
      body: picked,
    };
  }

  // poem
  if (openAi.isConfigured()) {
    try {
      const prompt = "Escribe un poema breve en español (10-14 versos), tono sobrio y elegante, sin markdown.";
      const promptContext = await buildPromptContextForQuery(params.userText, { chatId: params.chatId });
      const poem = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
      if (poem.trim()) {
        return {
          subject: "Poema del día",
          body: poem.trim(),
        };
      }
    } catch {
      // fallback below
    }
  }
  return {
    subject: "Poema del día",
    body: "Entre ruido y prisa, guardo el centro.\nLo que depende de mí, lo trabajo.\nLo demás, lo suelto.",
  };
}

function detectWorkspaceAutoContentKind(textNormalized: string):
  | "poem"
  | "joke"
  | "stoic"
  | "summary"
  | "generic"
  | undefined {
  if (/\b(poema|poesia|poes[ií]a)\b/.test(textNormalized)) {
    return "poem";
  }
  if (/\b(chiste|broma)\b/.test(textNormalized)) {
    return "joke";
  }
  if (/\b(reflexion|estoic|marco\s+aurelio)\b/.test(textNormalized)) {
    return "stoic";
  }
  if (/\b(resumen|resumir|sintesis|síntesis)\b/.test(textNormalized)) {
    return "summary";
  }
  if (/\b(escrib\w*|redact\w*|contenido|texto)\b/.test(textNormalized)) {
    return "generic";
  }
  return undefined;
}

function extractWorkspaceInlineWritePrompt(text: string): string {
  const fromWriteVerb =
    text.match(/\b(?:escrib\w*|redact\w*|poner|pon)\s+([\s\S]+)$/i)?.[1] ??
    text.match(/\b(?:contenido|texto)\s*(?::|=)\s*([\s\S]+)$/i)?.[1] ??
    "";
  return fromWriteVerb
    .replace(/^(?:un|una|el|la|los|las)\s+/i, "")
    .replace(/\s+(?:en|dentro(?:\s+de)?)\s+(?:el\s+)?(?:archivo|documento|file)\b[\s\S]*$/i, "")
    .trim();
}

async function buildWorkspaceAutoContent(params: {
  chatId: number;
  userText: string;
  pathHint?: string;
}): Promise<string | null> {
  const normalized = normalizeIntentText(params.userText);
  const kind = detectWorkspaceAutoContentKind(normalized);
  if (!kind) {
    return null;
  }
  const inlinePrompt = extractWorkspaceInlineWritePrompt(params.userText);
  if (
    inlinePrompt &&
    !/\b(poema|poesia|poes[ií]a|chiste|broma|resumen|reflexion|estoic)\b/.test(normalizeIntentText(inlinePrompt))
  ) {
    return inlinePrompt;
  }

  if (!openAi.isConfigured()) {
    return inlinePrompt || null;
  }

  try {
    let prompt = "Escribe texto breve en español, claro y sin markdown.";
    if (kind === "poem") {
      prompt = "Escribe un poema breve en español (8-12 versos), tono elegante, sin markdown.";
    } else if (kind === "joke") {
      prompt = "Escribe un chiste breve en español, apto para todo público, sin markdown.";
    } else if (kind === "stoic") {
      prompt = "Escribe una reflexión estoica breve en español, práctica y concreta, sin markdown.";
    } else if (kind === "summary") {
      prompt = "Escribe un resumen breve y claro en español, sin markdown.";
    } else if (inlinePrompt) {
      prompt = `Redacta un texto breve en español sobre: ${inlinePrompt}\nSin markdown.`;
    }
    const promptContext = await buildPromptContextForQuery(params.userText, { chatId: params.chatId });
    const content = await askOpenAiForChat({
      chatId: params.chatId,
      prompt: [
        prompt,
        params.pathHint ? `Destino sugerido: ${params.pathHint}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      context: promptContext,
    });
    const trimmed = content.trim();
    return trimmed || null;
  } catch {
    return inlinePrompt || null;
  }
}

function detectGmailNaturalIntent(text: string): GmailNaturalIntent {
  return detectGmailNaturalIntentDomain(text, {
    normalizeIntentText,
    extractQuotedSegments,
    extractEmailAddresses,
    extractRecipientNameFromText,
    inferDefaultSelfEmailRecipient,
    detectGmailAutoContentKind,
    parseGmailLabeledFields,
    extractLiteralBodyRequest,
    extractNaturalSubjectRequest,
    detectCreativeEmailCue,
    detectGmailDraftRequested,
    buildGmailDraftInstruction,
    shouldAvoidLiteralBodyFallback,
    parseNaturalLimit,
    buildNaturalGmailQuery,
    gmailAccountEmail: config.gmailAccountEmail,
  });
}

function rememberGmailListResults(chatId: number, messages: GmailMessageSummary[]): void {
  lastGmailResultsByChat.set(chatId, messages);
  const firstId = messages[0]?.id;
  if (firstId) {
    lastGmailMessageIdByChat.set(chatId, firstId);
  }
}

function rememberGmailMessage(chatId: number, messageId: string): void {
  const normalized = messageId.trim();
  if (!normalized) {
    return;
  }
  lastGmailMessageIdByChat.set(chatId, normalized);
}

function resolveGmailMessageIdForChat(params: {
  chatId: number;
  messageId?: string;
  messageIndex?: number;
}): string | null {
  const directId = params.messageId?.trim();
  if (directId) {
    return directId;
  }

  const indexed = params.messageIndex;
  const recent = lastGmailResultsByChat.get(params.chatId) ?? [];
  if (typeof indexed === "number") {
    if (indexed === -1) {
      return recent[0]?.id ?? lastGmailMessageIdByChat.get(params.chatId) ?? null;
    }
    if (indexed >= 1 && indexed <= recent.length) {
      return recent[indexed - 1]?.id ?? null;
    }
  }

  return lastGmailMessageIdByChat.get(params.chatId) ?? null;
}

function getGmailAccessIssue(ctx: ChatReplyContext): string | null {
  const activeAgentName = getActiveAgent(ctx.chat.id);
  const activeProfile = agentRegistry.require(activeAgentName);
  const hasGmailPermission =
    activeProfile.allowCommands.includes("gmail-api") || activeAgentName === "operator";
  if (!hasGmailPermission) {
    return [
      `El agente activo (${activeProfile.name}) no permite Gmail API.`,
      'Agrega "gmail-api" al agente o cambia a uno que lo incluya (ej: /agent set admin).',
    ].join("\n");
  }

  const status = gmailAccount.getStatus();
  if (!status.enabled) {
    return "Gmail account está deshabilitado (ENABLE_GMAIL_ACCOUNT=false).";
  }
  if (!status.configured) {
    return `Gmail account incompleto. Faltan: ${status.missing.join(", ")}`;
  }

  return null;
}

async function safePathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toProjectRelativePath(filePath: string): string {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function buildReferenceCandidates(reference: string, preferWorkspace: boolean): string[] {
  const normalized = stripTrailingPunctuation(reference.replace(/\\/g, "/").trim());
  if (!normalized) {
    return [];
  }

  const hasPathSeparator = normalized.includes("/");
  if (path.isAbsolute(normalized)) {
    return [normalized];
  }

  const candidates: string[] = [];
  if (hasPathSeparator) {
    if (preferWorkspace && !normalized.startsWith("workspace/")) {
      candidates.push(`workspace/${normalized}`);
    }
    candidates.push(normalized);
  } else {
    if (preferWorkspace) {
      candidates.push(`workspace/${normalized}`);
    }
    candidates.push(normalized);
  }

  return Array.from(new Set(candidates));
}

async function findDocumentByName(name: string, preferWorkspace: boolean): Promise<string | null> {
  const target = name.toLowerCase();
  const roots = [
    ...(preferWorkspace ? [path.join(process.cwd(), "workspace")] : []),
    process.cwd(),
  ];
  const queue: Array<{ dir: string; depth: number }> = [];
  const seenDirs = new Set<string>();

  for (const root of roots) {
    if (await safePathExists(root)) {
      queue.push({ dir: root, depth: 0 });
    }
  }

  let scanned = 0;
  while (queue.length > 0 && scanned < DOCUMENT_SEARCH_MAX_DIRS) {
    const current = queue.shift()!;
    if (seenDirs.has(current.dir)) {
      continue;
    }
    seenDirs.add(current.dir);
    scanned += 1;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) {
        return toProjectRelativePath(absolute);
      }
      if (entry.isDirectory() && current.depth < DOCUMENT_SEARCH_MAX_DEPTH) {
        queue.push({ dir: absolute, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

async function resolveDocumentReference(references: string[], preferWorkspace: boolean): Promise<string | null> {
  for (const reference of references) {
    const candidates = buildReferenceCandidates(reference, preferWorkspace);
    for (const candidate of candidates) {
      const absolute = path.resolve(process.cwd(), candidate);
      if (await safePathExists(absolute)) {
        return toProjectRelativePath(absolute);
      }
    }

    if (!reference.includes("/") && !reference.includes("\\")) {
      const found = await findDocumentByName(reference, preferWorkspace);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

async function listSavedImages(
  chatId: number,
  limitInput?: number,
): Promise<Array<{ relPath: string; size: number; modifiedAt: string }>> {
  const root = path.join(config.workspaceDir, "images", `chat-${chatId}`);
  return await listStoredFilesUnderRoot(root, limitInput);
}

async function listSavedWorkspaceFiles(
  chatId: number,
  limitInput?: number,
): Promise<Array<{ relPath: string; size: number; modifiedAt: string }>> {
  const root = path.join(config.workspaceDir, "files", `chat-${chatId}`);
  return await listStoredFilesUnderRoot(root, limitInput);
}

async function listRecentStoredFilesForChat(
  chatId: number,
  limitInput?: number,
): Promise<Array<{ relPath: string; size: number; modifiedAt: string }>> {
  const limit = Math.max(1, Math.min(150, Math.floor(limitInput ?? 30)));
  const [workspaceFiles, imageFiles] = await Promise.all([
    listSavedWorkspaceFiles(chatId, limit),
    listSavedImages(chatId, limit),
  ]);

  return [...workspaceFiles, ...imageFiles]
    .map((item) => ({
      ...item,
      modifiedMs: new Date(item.modifiedAt).getTime(),
    }))
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .slice(0, limit)
    .map(({ relPath, size, modifiedAt }) => ({ relPath, size, modifiedAt }));
}

async function resolveStoredFileReference(params: {
  chatId: number;
  reference?: string;
  index?: number;
}): Promise<{ fullPath: string; relPath: string; size: number }> {
  const index = params.index;
  if (Number.isFinite(index) && (index ?? 0) > 0) {
    const desired = Number(index);
    const cached = lastListedFilesByChat.get(params.chatId);
    const list = cached && cached.length > 0 ? cached : await listRecentStoredFilesForChat(params.chatId, 60);
    if (list.length === 0) {
      throw new Error("No hay archivos listados para resolver por número. Usa /files primero o indica ruta.");
    }
    if (desired < 1 || desired > list.length) {
      throw new Error(`Número fuera de rango. Usa 1..${list.length}.`);
    }
    return await resolveStoredFileReference({
      chatId: params.chatId,
      reference: list[desired - 1]?.relPath,
    });
  }

  const reference = (params.reference ?? "").trim();
  if (!reference) {
    throw new Error("Indica la ruta del archivo dentro de workspace o un número de /files.");
  }
  const normalized = normalizeWorkspaceRelativePath(reference);
  if (!normalized) {
    throw new Error("No pude interpretar la ruta del archivo.");
  }
  const resolved = resolveWorkspacePath(normalized);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved.fullPath);
  } catch {
    throw new Error(`No existe: ${resolved.relPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`No es un archivo: ${resolved.relPath}`);
  }
  return {
    fullPath: resolved.fullPath,
    relPath: resolved.relPath,
    size: stat.size,
  };
}

async function sendWorkspaceFileToChat(params: {
  ctx: ChatReplyContext;
  source: string;
  userId?: number;
  reference?: string;
  index?: number;
}): Promise<string> {
  if (typeof params.ctx.replyWithDocument !== "function") {
    throw new Error("Este contexto no soporta envío de documentos.");
  }

  const resolved = await resolveStoredFileReference({
    chatId: params.ctx.chat.id,
    reference: params.reference,
    index: params.index,
  });
  if (resolved.size > config.fileMaxFileBytes) {
    const limitMb = Math.round(config.fileMaxFileBytes / (1024 * 1024));
    throw new Error(`El archivo excede el límite configurado para envío (${limitMb}MB).`);
  }

  await params.ctx.replyWithDocument(new InputFile(resolved.fullPath, path.basename(resolved.fullPath)), {
    caption: `Archivo: ${resolved.relPath}`,
  });
  const responseText = [
    "Archivo enviado.",
    `ruta: ${resolved.relPath}`,
    `tamano: ${formatBytes(resolved.size)}`,
  ].join("\n");
  await safeAudit({
    type: "workspace.file_sent",
    chatId: params.ctx.chat.id,
    userId: params.userId,
    details: {
      source: params.source,
      path: resolved.relPath,
      size: resolved.size,
      hasReference: Boolean(params.reference?.trim()),
      index: params.index,
    },
  });
  return responseText;
}

async function listStoredFilesUnderRoot(
  root: string,
  limitInput?: number,
): Promise<Array<{ relPath: string; size: number; modifiedAt: string }>> {
  const limit = Math.max(1, Math.min(100, Math.floor(limitInput ?? 20)));
  if (!(await safePathExists(root))) {
    return [];
  }

  const collected: Array<{ relPath: string; size: number; modifiedAt: string; modifiedMs: number }> = [];
  let dateDirs: Dirent[] = [];
  try {
    dateDirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dirEntry of dateDirs) {
    if (!dirEntry.isDirectory()) {
      continue;
    }
    const dateDir = path.join(root, dirEntry.name);
    let files: Dirent[] = [];
    try {
      files = await fs.readdir(dateDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const fileEntry of files) {
      if (!fileEntry.isFile()) {
        continue;
      }
      const fullPath = path.join(dateDir, fileEntry.name);
      try {
        const stat = await fs.stat(fullPath);
        const modifiedMs = stat.mtime.getTime();
        collected.push({
          relPath: toProjectRelativePath(fullPath),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          modifiedMs: Number.isFinite(modifiedMs) ? modifiedMs : 0,
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  collected.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return collected.slice(0, limit).map((item) => ({
    relPath: item.relPath,
    size: item.size,
    modifiedAt: item.modifiedAt,
  }));
}

function isLikelyAudioDocument(mimeType?: string, fileName?: string): boolean {
  const mime = mimeType?.toLowerCase().trim();
  if (mime?.startsWith("audio/")) {
    return true;
  }
  const lowerName = fileName?.toLowerCase().trim() ?? "";
  return [
    ".mp3",
    ".m4a",
    ".ogg",
    ".wav",
    ".webm",
    ".flac",
    ".mp4",
    ".mpeg",
    ".mpga",
  ].some((ext) => lowerName.endsWith(ext));
}

function isLikelyImageDocument(mimeType?: string, fileName?: string): boolean {
  const mime = mimeType?.toLowerCase().trim();
  if (mime?.startsWith("image/")) {
    return true;
  }
  const lowerName = fileName?.toLowerCase().trim() ?? "";
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
    ".heic",
  ].some((ext) => lowerName.endsWith(ext));
}

function extractIncomingImage(message: {
  message_id: number;
  caption?: string;
  photo?: Array<{
    file_id: string;
    file_size?: number;
    width?: number;
    height?: number;
  }>;
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
}): IncomingImage | null {
  const caption = message.caption?.trim() || undefined;

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const sorted = [...message.photo].sort((a, b) => {
      const bySize = (b.file_size ?? 0) - (a.file_size ?? 0);
      if (bySize !== 0) {
        return bySize;
      }
      const areaA = (a.width ?? 0) * (a.height ?? 0);
      const areaB = (b.width ?? 0) * (b.height ?? 0);
      return areaB - areaA;
    });
    const best = sorted[0];
    if (best) {
      return {
        kind: "photo",
        fileId: best.file_id,
        fileSize: best.file_size,
        fileName: `photo-${message.message_id}.jpg`,
        mimeType: "image/jpeg",
        caption,
        messageId: message.message_id,
      };
    }
  }

  if (message.document && isLikelyImageDocument(message.document.mime_type, message.document.file_name)) {
    return {
      kind: "document",
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
      fileName: message.document.file_name?.trim() || `image-doc-${message.message_id}.jpg`,
      mimeType: message.document.mime_type,
      caption,
      messageId: message.message_id,
    };
  }

  return null;
}

function sanitizeFileNameSegment(raw: string): string {
  const cleaned = raw
    .replace(/\.[^.]+$/g, "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .trim();
  if (!cleaned) {
    return "image";
  }
  return cleaned.slice(0, 40);
}

function extensionFromMimeType(mimeType?: string): string {
  const mime = mimeType?.toLowerCase().trim() ?? "";
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return ".jpg";
  }
  if (mime === "image/png") {
    return ".png";
  }
  if (mime === "image/webp") {
    return ".webp";
  }
  if (mime === "image/gif") {
    return ".gif";
  }
  if (mime === "image/bmp") {
    return ".bmp";
  }
  if (mime === "image/tiff") {
    return ".tiff";
  }
  if (mime === "image/heic") {
    return ".heic";
  }
  return ".jpg";
}

function pickImageExtension(input: { fileName?: string; mimeType?: string; telegramFilePath?: string }): string {
  const fromName = path.extname(input.fileName ?? "").toLowerCase();
  if (fromName && /^\.[a-z0-9]{2,5}$/.test(fromName)) {
    return fromName;
  }
  const fromTelegramPath = path.extname(input.telegramFilePath ?? "").toLowerCase();
  if (fromTelegramPath && /^\.[a-z0-9]{2,5}$/.test(fromTelegramPath)) {
    return fromTelegramPath;
  }
  return extensionFromMimeType(input.mimeType);
}

function mimeTypeFromImageExtension(extensionInput: string): string {
  const extension = extensionInput.toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".bmp") {
    return "image/bmp";
  }
  if (extension === ".tif" || extension === ".tiff") {
    return "image/tiff";
  }
  if (extension === ".heic") {
    return "image/heic";
  }
  return "image/jpeg";
}

function resolveIncomingImageMimeType(input: {
  fileName?: string;
  mimeType?: string;
  telegramFilePath?: string;
}): string {
  const mime = input.mimeType?.trim().toLowerCase();
  if (mime && mime.startsWith("image/")) {
    return mime;
  }
  const ext = pickImageExtension(input);
  return mimeTypeFromImageExtension(ext);
}

function extractIncomingWorkspaceFile(message: {
  message_id: number;
  caption?: string;
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
}): IncomingWorkspaceFile | null {
  const document = message.document;
  if (!document) {
    return null;
  }
  if (isLikelyAudioDocument(document.mime_type, document.file_name)) {
    return null;
  }
  if (isLikelyImageDocument(document.mime_type, document.file_name)) {
    return null;
  }
  return {
    fileId: document.file_id,
    fileSize: document.file_size,
    fileName: document.file_name?.trim() || `file-${message.message_id}`,
    mimeType: document.mime_type,
    caption: message.caption?.trim() || undefined,
    messageId: message.message_id,
  };
}

function pickGenericFileExtension(input: { fileName?: string; telegramFilePath?: string }): string {
  const fromName = path.extname(input.fileName ?? "").toLowerCase();
  if (fromName && /^\.[a-z0-9]{1,12}$/.test(fromName)) {
    return fromName;
  }
  const fromTelegramPath = path.extname(input.telegramFilePath ?? "").toLowerCase();
  if (fromTelegramPath && /^\.[a-z0-9]{1,12}$/.test(fromTelegramPath)) {
    return fromTelegramPath;
  }
  return "";
}

function sanitizeIncomingWorkspaceFileName(raw: string): string {
  const baseName = path.basename(raw.trim()).replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").trim();
  const normalized = baseName.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "archivo";
  }
  return normalized.slice(0, 180);
}

async function resolveUniqueIncomingWorkspaceFilePath(params: {
  dir: string;
  desiredName: string;
}): Promise<string> {
  const ext = path.extname(params.desiredName);
  const stem = ext ? params.desiredName.slice(0, -ext.length) : params.desiredName;
  for (let attempt = 0; attempt <= 500; attempt += 1) {
    const candidateName = attempt === 0 ? params.desiredName : `${stem} (${attempt + 1})${ext}`;
    const candidatePath = path.join(params.dir, candidateName);
    try {
      await fs.access(candidatePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/enoent/i.test(message)) {
        return candidatePath;
      }
      throw error;
    }
  }
  throw new Error("No pude asignar un nombre único para el archivo adjunto");
}

async function saveIncomingImage(params: {
  incoming: IncomingImage;
  imageBuffer: Buffer;
  telegramFilePath?: string;
  chatId: number;
}): Promise<{ fullPath: string; relPath: string }> {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toISOString().slice(11, 19).replace(/:/g, "");
  const ext = pickImageExtension({
    fileName: params.incoming.fileName,
    mimeType: params.incoming.mimeType,
    telegramFilePath: params.telegramFilePath,
  });
  const base = sanitizeFileNameSegment(params.incoming.fileName);
  const random = Math.random().toString(36).slice(2, 7);
  const fileName = `${timePart}-m${params.incoming.messageId}-${base}-${random}${ext}`;

  const dir = path.join(config.workspaceDir, "images", `chat-${params.chatId}`, datePart);
  await fs.mkdir(dir, { recursive: true });

  const fullPath = path.join(dir, fileName);
  await fs.writeFile(fullPath, params.imageBuffer);
  return {
    fullPath,
    relPath: toProjectRelativePath(fullPath),
  };
}

async function saveIncomingWorkspaceFile(params: {
  incoming: IncomingWorkspaceFile;
  fileBuffer: Buffer;
  telegramFilePath?: string;
  chatId: number;
}): Promise<{ fullPath: string; relPath: string }> {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const fallbackExt = pickGenericFileExtension({
    fileName: params.incoming.fileName,
    telegramFilePath: params.telegramFilePath,
  });
  const desiredNameRaw = params.incoming.fileName?.trim() || `archivo-${params.incoming.messageId}${fallbackExt}`;
  const desiredName = sanitizeIncomingWorkspaceFileName(desiredNameRaw);

  const dir = path.join(config.workspaceDir, "files", `chat-${params.chatId}`, datePart);
  await fs.mkdir(dir, { recursive: true });

  const fullPath = await resolveUniqueIncomingWorkspaceFilePath({
    dir,
    desiredName,
  });
  await fs.writeFile(fullPath, params.fileBuffer);
  return {
    fullPath,
    relPath: toProjectRelativePath(fullPath),
  };
}

function extractIncomingAudio(message: {
  message_id: number;
  caption?: string;
  voice?: { file_id: string; file_size?: number; mime_type?: string };
  audio?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
}): IncomingAudio | null {
  const caption = message.caption?.trim() || undefined;

  if (message.voice) {
    return {
      kind: "voice",
      fileId: message.voice.file_id,
      fileSize: message.voice.file_size,
      fileName: `voice-${message.message_id}.ogg`,
      mimeType: message.voice.mime_type,
      caption,
    };
  }

  if (message.audio) {
    return {
      kind: "audio",
      fileId: message.audio.file_id,
      fileSize: message.audio.file_size,
      fileName: message.audio.file_name?.trim() || `audio-${message.message_id}.mp3`,
      mimeType: message.audio.mime_type,
      caption,
    };
  }

  if (message.document && isLikelyAudioDocument(message.document.mime_type, message.document.file_name)) {
    return {
      kind: "document",
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
      fileName: message.document.file_name?.trim() || `audio-doc-${message.message_id}`,
      mimeType: message.document.mime_type,
      caption,
    };
  }

  return null;
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
  replyWithDocument?: (document: InputFile, options?: { caption?: string }) => Promise<unknown>;
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

function formatApprovalCommandLabel(commandLine: string): string {
  if (commandLine === SELF_UPDATE_APPROVAL_COMMAND) {
    return "/selfupdate (git pull + build + restart)";
  }
  return commandLine;
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

function isAgenticCanaryEnabled(chatId: number, feature = "agentic-controls"): boolean {
  return agenticCanary.isEnabledForChat(chatId, feature);
}

function getPolicyCapabilityBlockReason(chatId: number, capability: AgentCapability): string | null {
  if (isSafeModeEnabled(chatId) && policyEngine.isBlockedInSafeMode(capability)) {
    return `Bloqueado por SAFE mode para capacidad ${capability}.`;
  }
  return null;
}

function purgeExpiredPlannedActions(): void {
  const now = Date.now();
  let removed = 0;
  for (const [id, item] of pendingPlannedActionsById.entries()) {
    if (item.expiresAtMs <= now) {
      pendingPlannedActionsById.delete(id);
      removed += 1;
    }
  }
  if (removed > 0) {
    persistRuntimeStateSnapshot("planned-purge");
  }
}

function randomPlannedActionId(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

function createPlannedAction(params: {
  kind: PlannedActionKind;
  chatId: number;
  userId?: number;
  summary: string;
  payload: Record<string, unknown>;
}): PendingPlannedAction {
  purgeExpiredPlannedActions();
  let id = "";
  for (let i = 0; i < 30; i += 1) {
    id = randomPlannedActionId();
    if (!pendingPlannedActionsById.has(id)) {
      break;
    }
  }
  if (!id || pendingPlannedActionsById.has(id)) {
    throw new Error("No pude generar ID para acción planificada.");
  }
  const now = Date.now();
  const item: PendingPlannedAction = {
    id,
    kind: params.kind,
    chatId: params.chatId,
    userId: params.userId,
    requestedAtMs: now,
    expiresAtMs: now + PLANNED_ACTION_TTL_MS,
    summary: truncateInline(params.summary, 1000),
    payload: params.payload,
  };
  pendingPlannedActionsById.set(id, item);
  persistRuntimeStateSnapshot("planned-create");
  return item;
}

function consumePlannedAction(id: string, chatId: number): PendingPlannedAction | null {
  purgeExpiredPlannedActions();
  const item = pendingPlannedActionsById.get(id.trim());
  if (!item || item.chatId !== chatId) {
    return null;
  }
  pendingPlannedActionsById.delete(item.id);
  persistRuntimeStateSnapshot("planned-consume");
  return item;
}

function denyPlannedAction(id: string, chatId: number): PendingPlannedAction | null {
  purgeExpiredPlannedActions();
  const item = pendingPlannedActionsById.get(id.trim());
  if (!item || item.chatId !== chatId) {
    return null;
  }
  pendingPlannedActionsById.delete(item.id);
  persistRuntimeStateSnapshot("planned-deny");
  return item;
}

function plannedActionRemainingSeconds(item: PendingPlannedAction): number {
  return Math.max(0, Math.round((item.expiresAtMs - Date.now()) / 1000));
}

async function maybeRequirePlannedConfirmation(params: {
  ctx: ChatReplyContext;
  kind: PlannedActionKind;
  capability: AgentCapability;
  summary: string;
  payload: Record<string, unknown>;
  source: string;
  userId?: number;
}): Promise<boolean> {
  const canaryEnabled = isAgenticCanaryEnabled(params.ctx.chat.id, "plan-preview");
  if (!canaryEnabled || !policyEngine.isPreviewRequired(params.capability)) {
    return false;
  }
  const planned = createPlannedAction({
    kind: params.kind,
    chatId: params.ctx.chat.id,
    userId: params.userId,
    summary: params.summary,
    payload: params.payload,
  });
  await reliableReply(
    params.ctx,
    [
      "Plan Preview (acción sensible):",
      planned.summary,
      `plan_id: ${planned.id}`,
      `expira en: ${plannedActionRemainingSeconds(planned)}s`,
      "Confirma con /confirm <plan_id> o cancela con /cancelplan <plan_id>.",
    ].join("\n"),
    { source: params.source },
  );
  await safeAudit({
    type: "plan.preview.created",
    chatId: params.ctx.chat.id,
    userId: params.userId,
    details: {
      planId: planned.id,
      kind: planned.kind,
      capability: params.capability,
      summary: truncateInline(params.summary, 300),
      source: params.source,
    },
  });
  return true;
}

async function reliableReply(
  ctx: ChatReplyContext,
  text: string,
  options?: {
    source?: string;
    allowOutbox?: boolean;
  },
): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const allowOutbox = options?.allowOutbox ?? true;
    if (allowOutbox) {
      try {
        const failedAttempt = 1;
        sqliteState.enqueueOutboxMessage({
          chatId: ctx.chat.id,
          text,
          source: options?.source ?? "reply",
          createdAtMs: Date.now(),
          attempts: failedAttempt,
          nextAttemptAtMs: Date.now() + computeOutboxBackoffMs(failedAttempt),
          lastError: truncateInline(message, 300),
        });
        observability.increment("outbox.enqueued", 1, {
          source: options?.source ?? "reply",
          chatId: ctx.chat.id,
          reason: "reply_error",
        });
      } catch (enqueueError) {
        const enqueueMessage = enqueueError instanceof Error ? enqueueError.message : String(enqueueError);
        logWarn(`No pude encolar outbox: ${enqueueMessage}`);
      }
    }
    throw error;
  }
}

function computeOutboxBackoffMs(failedAttemptCount: number): number {
  const attempt = Math.max(1, Math.floor(failedAttemptCount));
  return OUTBOX_BACKOFF_MS[Math.min(attempt - 1, OUTBOX_BACKOFF_MS.length - 1)] ?? OUTBOX_BACKOFF_MS.at(-1) ?? 30_000;
}

function handleOutboxDeliveryFailure(params: {
  entry: StoredOutboxMessage;
  message: string;
  source: string;
}): "retry" | "dead-letter" {
  const failedAttempt = Math.max(1, params.entry.attempts + 1);
  const truncated = truncateInline(params.message, 300);
  if (failedAttempt >= OUTBOX_MAX_RETRIES) {
    sqliteState.moveOutboxToDeadLetter(params.entry.id, {
      failureReason: `[${params.source}] ${truncateInline(params.message, 220)}`,
      failedAtMs: Date.now(),
    });
    observability.increment("outbox.dead_letter", 1, {
      source: params.source,
      chatId: params.entry.chatId,
      attempts: failedAttempt,
    });
    return "dead-letter";
  }

  const nextAttemptAtMs = Date.now() + computeOutboxBackoffMs(failedAttempt);
  sqliteState.markOutboxAttempt(params.entry.id, {
    lastError: truncated,
    nextAttemptAtMs,
  });
  observability.increment("outbox.retry_scheduled", 1, {
    source: params.source,
    chatId: params.entry.chatId,
    attempts: failedAttempt,
  });
  return "retry";
}

async function flushOutboxForChat(ctx: ChatReplyContext, maxItems = 10): Promise<{ delivered: number; pending: number }> {
  const list = sqliteState.listOutboxMessages(ctx.chat.id, maxItems);
  let delivered = 0;
  for (const entry of list) {
    try {
      await ctx.reply(entry.text);
      sqliteState.ackOutboxMessage(entry.id);
      delivered += 1;
      observability.increment("outbox.delivered", 1, {
        source: "manual_flush",
        chatId: entry.chatId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      handleOutboxDeliveryFailure({
        entry,
        message,
        source: "manual_flush",
      });
      break;
    }
  }
  const pending = sqliteState.listOutboxMessages(ctx.chat.id, 200).length;
  return { delivered, pending };
}

async function recoverDueOutboxMessages(source: "startup" | "timer"): Promise<{
  processed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
}> {
  const due = sqliteState.listDueOutboxMessages({
    limit: OUTBOX_RECOVERY_BATCH_SIZE,
  });
  if (due.length === 0) {
    return {
      processed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    };
  }

  let delivered = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const entry of due) {
    try {
      await bot.api.sendMessage(entry.chatId, entry.text);
      sqliteState.ackOutboxMessage(entry.id);
      delivered += 1;
      observability.increment("outbox.delivered", 1, {
        source,
        chatId: entry.chatId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = handleOutboxDeliveryFailure({
        entry,
        message,
        source,
      });
      if (action === "dead-letter") {
        deadLettered += 1;
      } else {
        retried += 1;
      }
    }
  }

  return {
    processed: due.length,
    delivered,
    retried,
    deadLettered,
  };
}

async function runOutboxRecoveryTick(source: "startup" | "timer"): Promise<void> {
  if (outboxRecoveryInFlight) {
    observability.increment("outbox.recovery.skipped_in_flight", 1, { source });
    return;
  }
  outboxRecoveryInFlight = true;
  const startedAt = Date.now();
  try {
    const stats = await recoverDueOutboxMessages(source);
    observability.increment("outbox.recovery.tick", 1, {
      source,
      processed: stats.processed,
      delivered: stats.delivered,
      retried: stats.retried,
      deadLettered: stats.deadLettered,
    });
    observability.timing("outbox.recovery.tick_ms", Date.now() - startedAt);
    if (stats.processed > 0) {
      logInfo(
        `Outbox recovery (${source}): processed=${stats.processed} delivered=${stats.delivered} retried=${stats.retried} dead=${stats.deadLettered}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Outbox recovery (${source}) falló: ${message}`);
    observability.increment("outbox.recovery.failed", 1, { source });
  } finally {
    outboxRecoveryInFlight = false;
  }
}

function startOutboxRecoveryWorker(): void {
  if (outboxRecoveryTimer) {
    return;
  }
  outboxRecoveryTimer = setInterval(() => {
    void runOutboxRecoveryTick("timer");
  }, OUTBOX_RECOVERY_INTERVAL_MS);
  outboxRecoveryTimer.unref?.();
  void runOutboxRecoveryTick("startup");
}

async function runInIncomingQueue<T>(params: {
  chatId: number;
  source: string;
  executor: () => Promise<T>;
}): Promise<T> {
  const depthBefore = incomingMessageQueue.getDepth(params.chatId);
  observability.increment("incoming.queue.enqueue", 1, {
    source: params.source,
    chatId: params.chatId,
    depth: depthBefore + 1,
  });
  try {
    const queued = await incomingMessageQueue.enqueue(params.chatId, params.executor);
    observability.timing("incoming.queue.wait_ms", queued.waitMs);
    return queued.result;
  } catch (error) {
    observability.increment("incoming.queue.failed", 1, {
      source: params.source,
      chatId: params.chatId,
    });
    throw error;
  }
}

async function buildPromptContextForQuery(query: string, options?: { chatId?: number }) {
  const text = query.trim();
  if (!text) {
    return undefined;
  }
  try {
    await contextMemory.flushBeforeReasoning(options?.chatId);
    return await contextMemory.buildPromptContext(text, {
      chatId: options?.chatId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`No pude construir contexto de memoria: ${message}`);
    return undefined;
  }
}

async function appendConversationTurn(params: {
  chatId: number;
  role: "user" | "assistant";
  text: string;
  source: string;
  userId?: number;
}) {
  const startedAt = Date.now();
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const recent = recentConversationByChat.get(params.chatId) ?? [];
  recentConversationByChat.set(
    params.chatId,
    [
      ...recent,
      {
        role: params.role,
        text: truncateInline(text, 4_000),
        source: params.source,
        atMs: Date.now(),
      },
    ].slice(-RECENT_CONVERSATION_TURN_LIMIT),
  );
  try {
    sqliteState.appendConversationTurn({
      chatId: params.chatId,
      role: params.role,
      text: truncateInline(text, 4_000),
      source: params.source,
      atMs: Date.now(),
      userId: params.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`No pude persistir turno en SQLite: ${message}`);
  }
  try {
    await contextMemory.appendConversationTurn({
      chatId: params.chatId,
      role: params.role,
      text,
      source: params.source,
      userId: params.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`No pude persistir turno de conversación: ${message}`);
  }

  if (params.role === "assistant") {
    const snapshot: AssistantReplySnapshot = {
      text: truncateInline(text, 30_000),
      source: params.source,
      atMs: Date.now(),
    };
    lastAssistantReplyByChat.set(params.chatId, snapshot);
    const previous = assistantReplyHistoryByChat.get(params.chatId) ?? [];
    const next = [snapshot, ...previous].slice(0, ASSISTANT_REPLY_HISTORY_LIMIT);
    assistantReplyHistoryByChat.set(params.chatId, next);
  }

  if (params.role === "user") {
    const durableFacts = extractDurableUserFacts(text);
    if (durableFacts.length > 0) {
      for (const durableFact of durableFacts) {
        try {
          const result = await contextMemory.upsertLongTermFact({
            key: durableFact.key,
            value: durableFact.value,
            source: params.source,
            chatId: params.chatId,
            userId: params.userId,
          });
          await safeAudit({
            type: "memory.longterm_upsert",
            chatId: params.chatId,
            userId: params.userId,
            details: {
              key: result.key,
              value: result.value,
              updated: result.updated,
              path: result.path,
              source: params.source,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logWarn(`No pude actualizar memoria de largo plazo: ${message}`);
        }
      }
    }

    try {
      await interestLearning.recordUserText({
        chatId: params.chatId,
        text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`No pude actualizar aprendizaje de intereses: ${message}`);
    }
  }
  observability.increment("conversation.turn.appended", 1, { role: params.role, source: params.source });
  observability.timing("conversation.turn.append.latency_ms", Date.now() - startedAt);
}

async function replyLong(ctx: { reply: (text: string) => Promise<unknown> }, text: string) {
  const chunks = splitForTelegram(text);
  for (const chunk of chunks) {
    await reliableReply(ctx as ChatReplyContext, chunk, { source: "replyLong" });
  }
}

function isDetailedAnswerRequested(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return false;
  }
  return /\b(detalle|detallado|detallada|en detalle|en profundidad|profundo|profunda|extenso|extensa|largo|larga|expand|amplia|amplía|desarrolla|desarrollar|exhaustiv|paso a paso|completo|completa)\b/.test(
    normalized,
  );
}

function compactEcoFreeChatAnswer(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= 2) {
    return `${lines[0]}\n${lines[1]}`;
  }
  if (lines.length === 1) {
    const sentences = lines[0]
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (sentences.length >= 2) {
      return `${sentences[0]}\n${sentences[1]}`;
    }
    return lines[0];
  }
  return truncateInline(text.trim(), 220);
}

async function replyProgress(ctx: { reply: (text: string) => Promise<unknown>; chat?: { id: number } }, text: string) {
  if (!config.progressNotices) {
    return;
  }
  if (typeof ctx.chat?.id === "number") {
    lastTaskActivityByChat.set(ctx.chat.id, {
      text: truncateInline(text, 240),
      atMs: Date.now(),
    });
  }
  const notice = progressNoticeService.build(text, ctx.chat?.id);
  await ctx.reply(notice);
}

type CapturedProfileCommandResult = {
  ok: boolean;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type ConnectorServiceState = {
  unit: string;
  loadState: string;
  activeState: string;
  subState: string;
  error?: string;
};

type ConnectorEndpointProbe = {
  url: string;
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  summary: string;
};

type ConnectorStatusSnapshot = {
  app: ConnectorServiceState;
  tunnel: ConnectorServiceState;
  localProbe: ConnectorEndpointProbe;
  publicProbe: ConnectorEndpointProbe;
};

function sanitizeSystemdUnitName(raw: string, fallback: string): string {
  const value = raw.trim();
  if (/^[a-zA-Z0-9@._:-]+$/.test(value)) {
    return value;
  }
  return fallback;
}

function getConnectorUnitNames(): { appUnit: string; tunnelUnit: string } {
  return {
    appUnit: sanitizeSystemdUnitName(config.limAppService, "houdi-lim-app.service"),
    tunnelUnit: sanitizeSystemdUnitName(config.limTunnelService, "houdi-lim-tunnel.service"),
  };
}

function normalizeConnectorHealthUrl(raw: string, fallback: string): string {
  const value = raw.trim();
  if (!value) {
    return fallback;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // fallback below
  }
  return fallback;
}

function getConnectorHealthUrls(): { localUrl: string; publicUrl: string } {
  return {
    localUrl: normalizeConnectorHealthUrl(config.limLocalHealthUrl, "http://127.0.0.1:3333/health"),
    publicUrl: normalizeConnectorHealthUrl(config.limPublicHealthUrl, "http://127.0.0.1:3333/health"),
  };
}

type LimQueryResult = {
  ok: boolean;
  found?: boolean;
  account?: string;
  contact?: string;
  totalMessages?: number;
  returnedMessages?: number;
  queryUsed?: string;
  messages?: Array<{
    index?: number;
    direction?: string;
    time?: string;
    text?: string;
  }>;
  error?: string;
  detail?: string;
};

function normalizeLimSourceKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveLimAccountFromSource(sourceName: string): { account?: string; error?: string } {
  const raw = sourceName.trim();
  if (!raw) {
    return { error: "fuente vacia" };
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw)) {
    return { error: "fuente no puede ser email" };
  }
  const normalized = normalizeLimSourceKey(raw);
  if (!normalized) {
    return { error: "fuente invalida" };
  }
  const fromMap = config.limSourceAccountMap[normalized];
  return { account: fromMap || normalized };
}

function buildLimMessagesUrl(account: string, firstName: string, lastName: string, count: number): string {
  const { localUrl } = getConnectorHealthUrls();
  const base = new URL(localUrl);
  base.pathname = "/messages";
  base.search = "";
  base.searchParams.set("account", account);
  base.searchParams.set("first_name", firstName);
  base.searchParams.set("last_name", lastName);
  base.searchParams.set("count", String(Math.max(1, Math.min(10, Math.floor(count)))));
  return base.toString();
}

async function queryLimMessages(params: {
  firstName: string;
  lastName: string;
  sourceName: string;
  count?: number;
  prospectOnly?: boolean;
}): Promise<LimQueryResult> {
  const firstName = params.firstName.trim();
  const lastName = params.lastName.trim();
  const sourceName = params.sourceName.trim();
  if (!firstName || !lastName || !sourceName) {
    return { ok: false, error: "missing_params", detail: "first_name, last_name y fuente son obligatorios." };
  }
  const resolved = resolveLimAccountFromSource(sourceName);
  if (!resolved.account) {
    return { ok: false, error: "invalid_source", detail: resolved.error || "fuente invalida" };
  }

  const endpoint = buildLimMessagesUrl(resolved.account, firstName, lastName, params.count ?? 3);
  const controller = new AbortController();
  const timeoutMs = Math.max(120_000, config.limHealthTimeoutMs * 8);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const detail =
        (parsed && (typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "")) ||
        `HTTP ${response.status}`;
      return {
        ok: false,
        account: resolved.account,
        error: "lim_http_error",
        detail,
      };
    }

    const rows = Array.isArray(parsed?.messages) ? parsed?.messages : [];
    const mappedRows = rows
      .slice(0, 50)
      .map((row) => (typeof row === "object" && row !== null ? row : {}))
      .map((row) => ({
        index: typeof row.index === "number" ? row.index : undefined,
        direction: typeof row.direction === "string" ? row.direction : undefined,
        time: typeof row.time === "string" ? row.time : undefined,
        text: typeof row.text === "string" ? row.text : undefined,
      }));
    const isProspectDirection = (value?: string): boolean => {
      const direction = normalizeIntentText(value ?? "");
      if (!direction) {
        return true;
      }
      if (/\b(out|outgoing|sent|mine|my|self|own|agent|bot|me|yo|mio|mia|propio|nuestra)\b/.test(direction)) {
        return false;
      }
      if (/\b(in|incoming|inbound|received|prospect|lead|contact|cliente|reply)\b/.test(direction)) {
        return true;
      }
      return true;
    };
    const filteredRows = params.prospectOnly ? mappedRows.filter((row) => isProspectDirection(row.direction)) : mappedRows;
    const maxRows = Math.max(1, Math.min(10, Math.floor(params.count ?? 3)));
    const selectedRowsPrimary = filteredRows.slice(0, maxRows);
    const selectedRows =
      params.prospectOnly && selectedRowsPrimary.length === 0 && mappedRows.length > 0
        ? mappedRows.slice(0, maxRows)
        : selectedRowsPrimary;
    return {
      ok: Boolean(parsed?.ok),
      found: Boolean(parsed?.found),
      account: typeof parsed?.account === "string" ? parsed.account : resolved.account,
      contact: typeof parsed?.contact === "string" ? parsed.contact : undefined,
      totalMessages: typeof parsed?.totalMessages === "number" ? parsed.totalMessages : undefined,
      returnedMessages: selectedRows.length,
      queryUsed: typeof parsed?.queryUsed === "string" ? parsed.queryUsed : undefined,
      messages: selectedRows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      account: resolved.account,
      error: "lim_request_failed",
      detail: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runProfileCommandCapture(params: {
  profile: AgentProfile;
  commandLine: string;
}): Promise<CapturedProfileCommandResult> {
  let started;
  try {
    started = taskRunner.start(params.profile, params.commandLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: "",
      error: message,
    };
  }

  const result = await started.done;
  return {
    ok: result.task.status === "completed",
    status: result.task.status,
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function readUserServiceState(profile: AgentProfile, unit: string): Promise<ConnectorServiceState> {
  const commandLine = `systemctl --user show --property=LoadState,ActiveState,SubState --value ${unit}`;
  const result = await runProfileCommandCapture({
    profile,
    commandLine,
  });
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const loadState = lines[0] ?? "unknown";
  const activeState = lines[1] ?? "unknown";
  const subState = lines[2] ?? "unknown";
  const errorText = [result.stderr, result.error]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim();
  return {
    unit,
    loadState,
    activeState,
    subState,
    ...(errorText ? { error: truncateInline(errorText, 220) } : {}),
  };
}

function stringifyProbeValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

async function probeConnectorHealth(url: string): Promise<ConnectorEndpointProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, config.limHealthTimeoutMs);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
      },
    });
    const body = await response.text();
    const compactBody = body.replace(/\s+/g, " ").trim();
    const details: string[] = [`http ${response.status}`];
    let okFlag: string | undefined;
    let readyFlag: string | undefined;

    if (compactBody) {
      try {
        const parsed = JSON.parse(compactBody) as Record<string, unknown>;
        okFlag = stringifyProbeValue(parsed.ok);
        readyFlag = stringifyProbeValue(parsed.ready);
      } catch {
        // ignore non-json body
      }
    }

    if (okFlag) {
      details.push(`ok=${okFlag}`);
    }
    if (readyFlag) {
      details.push(`ready=${readyFlag}`);
    }
    if (!okFlag && compactBody && compactBody.length <= 120) {
      details.push(`body=${compactBody}`);
    }

    return {
      url,
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      summary: truncateInline(details.join(" | "), 220),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      url,
      ok: false,
      latencyMs: Date.now() - startedAt,
      summary: isAbort ? `timeout after ${timeoutMs}ms` : truncateInline(message, 220),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatConnectorServiceState(state: ConnectorServiceState): string {
  if (state.loadState === "not-found") {
    return `not-found (${state.unit})`;
  }
  if (state.loadState === "masked") {
    return `masked (${state.unit})`;
  }
  const suffix = state.subState && state.subState !== state.activeState ? `/${state.subState}` : "";
  const base = `${state.activeState}${suffix} (${state.unit})`;
  if (state.error) {
    return `${base} | ${state.error}`;
  }
  return base;
}

function formatConnectorProbe(probe: ConnectorEndpointProbe): string {
  const latencyText = typeof probe.latencyMs === "number" ? `${probe.latencyMs}ms` : "n/a";
  return `${probe.ok ? "ok" : "error"} | ${probe.summary} | ${latencyText}`;
}

async function collectConnectorStatus(profile: AgentProfile): Promise<ConnectorStatusSnapshot> {
  const { appUnit, tunnelUnit } = getConnectorUnitNames();
  const { localUrl, publicUrl } = getConnectorHealthUrls();
  const [app, tunnel, localProbe, publicProbe] = await Promise.all([
    readUserServiceState(profile, appUnit),
    readUserServiceState(profile, tunnelUnit),
    probeConnectorHealth(localUrl),
    probeConnectorHealth(publicUrl),
  ]);
  return {
    app,
    tunnel,
    localProbe,
    publicProbe,
  };
}

function buildConnectorStatusText(params: {
  actionLabel?: string;
  includeTunnel: boolean;
  snapshot: ConnectorStatusSnapshot;
}): string {
  const { localUrl, publicUrl } = getConnectorHealthUrls();
  const lines = [
    params.actionLabel ? params.actionLabel : "Estado LIM:",
    `App: ${formatConnectorServiceState(params.snapshot.app)}`,
    `Tunnel: ${formatConnectorServiceState(params.snapshot.tunnel)}`,
    `Health local (${localUrl}): ${formatConnectorProbe(params.snapshot.localProbe)}`,
    `Health publico (${publicUrl}): ${formatConnectorProbe(params.snapshot.publicProbe)}`,
  ];
  if (params.snapshot.app.loadState === "not-found" || (params.includeTunnel && params.snapshot.tunnel.loadState === "not-found")) {
    lines.push("Setup pendiente: ejecuta scripts/install-lim-user-services.sh");
  }
  return lines.join("\n");
}

async function runCommandForProfile(params: {
  ctx: ChatReplyContext;
  profile: AgentProfile;
  commandLine: string;
  source: string;
  note?: string;
}): Promise<void> {
  const actor = getActor(params.ctx);
  const trace = startRunTrace({
    chatId: actor.chatId,
    userId: actor.userId,
    action: "exec",
    source: params.source,
  });

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
        ...finishRunTrace({
          trace,
          status: "error",
          error: message,
        }),
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
      `run_id: ${trace.id}`,
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
      runId: trace.id,
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
      ...finishRunTrace({ trace, status: result.task.status === "completed" ? "ok" : "error" }),
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

type LocalCommandExecutionResult = {
  command: string;
  args: string[];
  commandLine: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
};

type SelfUpdateStatusSnapshot = {
  branch: string;
  remoteBranch: string;
  currentShort: string;
  remoteShort: string;
  behindCount: number;
  dirtyFiles: string[];
};

type SelfUpdateApplyResult = {
  updated: boolean;
  previousShort: string;
  currentShort: string;
  changedFiles: string[];
  ranNpmInstall: boolean;
};

function appendStdioTail(base: string, chunk: string, maxChars: number): string {
  const next = base + chunk;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(next.length - maxChars);
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatSelfUpdateFilePreview(paths: string[], limit: number): string[] {
  const selected = paths.slice(0, Math.max(1, Math.floor(limit)));
  const lines = selected.map((filePath, index) => `${index + 1}. ${filePath}`);
  if (paths.length > selected.length) {
    lines.push(`... y ${paths.length - selected.length} más`);
  }
  return lines;
}

function parseSelfUpdateCount(raw: string, label: string): number {
  const value = raw.trim();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`No pude interpretar ${label}: "${value || "vacío"}"`);
  }
  return parsed;
}

async function runLocalCommandStep(params: {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<LocalCommandExecutionResult> {
  const args = params.args ?? [];
  const cwd = params.cwd ?? process.cwd();
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs ?? SELF_UPDATE_SHORT_TIMEOUT_MS));
  const maxChars = Math.max(2000, Math.floor(params.maxChars ?? SELF_UPDATE_STDIO_MAX_CHARS));
  const startedAt = Date.now();
  const commandLine = [params.command, ...args].join(" ");

  const child = spawn(params.command, args, {
    cwd,
    env: process.env,
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let settled = false;

  return await new Promise<LocalCommandExecutionResult>((resolve) => {
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        command: params.command,
        args,
        commandLine,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore kill failures; result is resolved by close/error handlers.
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendStdioTail(stdout, chunk.toString("utf8"), maxChars);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendStdioTail(stderr, chunk.toString("utf8"), maxChars);
    });

    child.on("close", (code, signalCode) => {
      exitCode = code;
      signal = signalCode;
      finish();
    });

    child.on("error", (error) => {
      exitCode = 1;
      signal = null;
      stderr = appendStdioTail(stderr, `${error.message}\n`, maxChars);
      finish();
    });
  });
}

async function runLocalCommandOrThrow(
  stepLabel: string,
  params: {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    maxChars?: number;
  },
): Promise<LocalCommandExecutionResult> {
  const result = await runLocalCommandStep(params);
  if (result.timedOut) {
    throw new Error(`${stepLabel} excedió el timeout (${params.timeoutMs ?? SELF_UPDATE_SHORT_TIMEOUT_MS}ms).`);
  }
  if (result.exitCode === 0) {
    return result;
  }

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const details = [
    `${stepLabel} falló (exit=${result.exitCode ?? "null"}, signal=${result.signal ?? "none"}).`,
    `Comando: ${result.commandLine}`,
    ...(stdout ? [`stdout: ${truncateInline(stdout, 900)}`] : []),
    ...(stderr ? [`stderr: ${truncateInline(stderr, 1200)}`] : []),
  ];
  throw new Error(details.join("\n"));
}

async function inspectSelfUpdateStatus(): Promise<SelfUpdateStatusSnapshot> {
  const repoCheck = await runLocalCommandOrThrow("Verificación de repositorio Git", {
    command: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
  });
  if (!/\btrue\b/i.test(repoCheck.stdout)) {
    throw new Error("El proyecto no está dentro de un repositorio Git.");
  }

  const branchResult = await runLocalCommandOrThrow("Lectura de rama activa", {
    command: "git",
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
    timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
  });
  const branch = branchResult.stdout.trim();
  if (!branch || branch.toUpperCase() === "HEAD") {
    throw new Error("No pude resolver la rama activa (HEAD detached).");
  }

  await runLocalCommandOrThrow("Sincronización con remoto", {
    command: "git",
    args: ["fetch", SELF_UPDATE_GIT_REMOTE, "--prune"],
    timeoutMs: SELF_UPDATE_FETCH_TIMEOUT_MS,
  });

  const remoteBranch = `${SELF_UPDATE_GIT_REMOTE}/${branch}`;
  const [currentResult, remoteResult, behindResult, dirtyResult] = await Promise.all([
    runLocalCommandOrThrow("Lectura de commit local", {
      command: "git",
      args: ["rev-parse", "--short", "HEAD"],
      timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
    }),
    runLocalCommandOrThrow("Lectura de commit remoto", {
      command: "git",
      args: ["rev-parse", "--short", remoteBranch],
      timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
    }),
    runLocalCommandOrThrow("Cálculo de commits pendientes", {
      command: "git",
      args: ["rev-list", "--count", `HEAD..${remoteBranch}`],
      timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
    }),
    runLocalCommandOrThrow("Lectura de cambios locales", {
      command: "git",
      args: ["status", "--porcelain"],
      timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
    }),
  ]);

  return {
    branch,
    remoteBranch,
    currentShort: currentResult.stdout.trim(),
    remoteShort: remoteResult.stdout.trim(),
    behindCount: parseSelfUpdateCount(behindResult.stdout, "commits pendientes"),
    dirtyFiles: splitNonEmptyLines(dirtyResult.stdout),
  };
}

async function applySelfUpdateFromStatus(status: SelfUpdateStatusSnapshot): Promise<SelfUpdateApplyResult> {
  if (status.behindCount <= 0) {
    return {
      updated: false,
      previousShort: status.currentShort,
      currentShort: status.currentShort,
      changedFiles: [],
      ranNpmInstall: false,
    };
  }

  const previousShort = status.currentShort;
  await runLocalCommandOrThrow("Descarga de nueva versión (git pull --ff-only)", {
    command: "git",
    args: ["pull", "--ff-only", SELF_UPDATE_GIT_REMOTE, status.branch],
    timeoutMs: SELF_UPDATE_FETCH_TIMEOUT_MS,
  });

  const currentResult = await runLocalCommandOrThrow("Lectura de commit actualizado", {
    command: "git",
    args: ["rev-parse", "--short", "HEAD"],
    timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
  });
  const currentShort = currentResult.stdout.trim();

  if (!currentShort || currentShort === previousShort) {
    return {
      updated: false,
      previousShort,
      currentShort: currentShort || previousShort,
      changedFiles: [],
      ranNpmInstall: false,
    };
  }

  const changedResult = await runLocalCommandOrThrow("Listado de archivos actualizados", {
    command: "git",
    args: ["diff", "--name-only", `${previousShort}..${currentShort}`],
    timeoutMs: SELF_UPDATE_SHORT_TIMEOUT_MS,
    maxChars: 40_000,
  });
  const changedFiles = splitNonEmptyLines(changedResult.stdout);
  const ranNpmInstall =
    changedFiles.includes("package.json") ||
    changedFiles.includes("package-lock.json") ||
    changedFiles.some((entry) => entry.startsWith("package-lock."));

  if (ranNpmInstall) {
    await runLocalCommandOrThrow("Instalación de dependencias", {
      command: "npm",
      args: ["install"],
      timeoutMs: SELF_UPDATE_INSTALL_TIMEOUT_MS,
      maxChars: 20_000,
    });
  }

  await runLocalCommandOrThrow("Compilación de proyecto", {
    command: "npm",
    args: ["run", "build"],
    timeoutMs: SELF_UPDATE_BUILD_TIMEOUT_MS,
    maxChars: 20_000,
  });

  return {
    updated: true,
    previousShort,
    currentShort,
    changedFiles,
    ranNpmInstall,
  };
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
  persistRuntimeStateSnapshot("approval-create");

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

  await reliableReply(params.ctx, 
    [
      `Aprobación requerida: ${approval.id}`,
      `Tipo: ${approval.kind}`,
      `Agente: ${approval.agentName}`,
      `Comando: ${formatApprovalCommandLabel(approval.commandLine)}`,
      `Expira en: ${approvalRemainingSeconds(approval)}s`,
      "Usa /approve <id> para ejecutar o /deny <id> para cancelar.",
    ].join("\n"), { source: "approval.request" });
}

async function executePlannedAction(params: { ctx: ChatReplyContext; planned: PendingPlannedAction }): Promise<void> {
  if (params.planned.kind === "exec") {
    const commandLine = String(params.planned.payload.commandLine ?? "").trim();
    const profileName = String(params.planned.payload.profileName ?? "").trim();
    if (!commandLine || !profileName) {
      await params.ctx.reply("Plan inválido: faltan datos de ejecución.");
      return;
    }
    const profile = agentRegistry.get(profileName);
    if (!profile) {
      await params.ctx.reply(`El agente ${profileName} ya no existe.`);
      return;
    }
    if (policyEngine.isApprovalRequired("exec") || isAdminApprovalRequired(params.ctx.chat.id)) {
      await queueApproval({
        ctx: params.ctx,
        profile,
        commandLine,
        kind: "exec",
        note: "confirmed via /confirm",
      });
      return;
    }
    await runCommandForProfile({
      ctx: params.ctx,
      profile,
      commandLine,
      source: "planned-confirmed",
    });
    return;
  }

  if (params.planned.kind === "gmail-send") {
    const to = String(params.planned.payload.to ?? "").trim();
    const subject = String(params.planned.payload.subject ?? "").trim();
    const body = String(params.planned.payload.body ?? "").trim();
    const ccRaw = String(params.planned.payload.cc ?? "").trim();
    const bccRaw = String(params.planned.payload.bcc ?? "").trim();
    const sent = await gmailAccount.sendMessage({
      to,
      subject,
      body,
      ...(ccRaw ? { cc: ccRaw } : {}),
      ...(bccRaw ? { bcc: bccRaw } : {}),
    });
    rememberGmailMessage(params.ctx.chat.id, sent.id);
    await reliableReply(
      params.ctx,
      [`Email enviado (confirmado).`, `to: ${to}`, `subject: ${subject}`, `messageId: ${sent.id}`].join("\n"),
      { source: "planned.gmail.send" },
    );
    await safeAudit({
      type: "gmail.send.confirmed",
      chatId: params.ctx.chat.id,
      userId: params.ctx.from?.id,
      details: {
        to,
        subjectLength: subject.length,
        bodyLength: body.length,
        messageId: sent.id,
      },
    });
    return;
  }

  if (params.planned.kind === "workspace-delete") {
    const targetPath = String(params.planned.payload.path ?? "").trim();
    if (!targetPath) {
      await params.ctx.reply("Plan inválido: falta ruta a eliminar.");
      return;
    }
    const deleted = await deleteWorkspacePath(targetPath);
    await reliableReply(
      params.ctx,
      [`Eliminado (confirmado).`, `ruta: ${deleted.relPath}`, `tipo: ${deleted.kind}`].join("\n"),
      { source: "planned.workspace.delete" },
    );
    await safeAudit({
      type: "workspace.delete.confirmed",
      chatId: params.ctx.chat.id,
      userId: params.ctx.from?.id,
      details: {
        path: deleted.relPath,
        kind: deleted.kind,
      },
    });
  }
}

async function requestAgentServiceRestart(params: {
  ctx: ChatReplyContext;
  source: string;
  note?: string;
  skipAdminApproval?: boolean;
}): Promise<void> {
  if (adminSecurity.isPanicModeEnabled()) {
    await params.ctx.reply("Panic mode está activo: ejecución bloqueada.");
    return;
  }

  const profile = agentRegistry.require(getActiveAgent(params.ctx.chat.id));
  if (!profile.allowCommands.includes("systemctl")) {
    await params.ctx.reply(
      [
        `El agente activo (${profile.name}) no permite reiniciar servicio.`,
        "Habilita systemctl en allowCommands o cambia de agente.",
      ].join("\n"),
    );
    return;
  }

  if (isAdminApprovalRequired(params.ctx.chat.id) && !params.skipAdminApproval) {
    await queueApproval({
      ctx: params.ctx,
      profile,
      commandLine: SELF_RESTART_SERVICE_COMMAND,
      kind: "exec",
      note: params.note ?? `requested via ${params.source}`,
    });
    return;
  }

  await params.ctx.reply("Reiniciando servicio del agente...");
  await runCommandForProfile({
    ctx: params.ctx,
    profile,
    commandLine: SELF_RESTART_SERVICE_COMMAND,
    source: params.source,
    note: params.note ?? `requested via ${params.source}`,
  });
}

async function executeAgentSelfUpdate(params: {
  ctx: ChatReplyContext;
  source: string;
  note?: string;
  userId?: number;
  checkOnly: boolean;
}): Promise<void> {
  if (selfUpdateInProgress) {
    await params.ctx.reply("Ya hay una actualización en curso. Espera a que termine y vuelve a intentar.");
    return;
  }

  selfUpdateInProgress = true;
  const startedAtMs = Date.now();
  const actor = getActor(params.ctx);

  try {
    await params.ctx.reply(
      params.checkOnly
        ? "Revisando si hay actualizaciones disponibles en el repositorio..."
        : "Iniciando actualización del agente desde el repositorio remoto...",
    );
    const status = await inspectSelfUpdateStatus();

    if (params.checkOnly) {
      const responseLines = [
        "Estado de actualización:",
        `rama: ${status.branch}`,
        `local: ${status.currentShort}`,
        `remoto: ${status.remoteShort} (${status.remoteBranch})`,
        `commits pendientes: ${status.behindCount}`,
        `cambios locales sin commit: ${status.dirtyFiles.length}`,
      ];
      if (status.dirtyFiles.length > 0) {
        responseLines.push("Archivos locales modificados:");
        responseLines.push(...formatSelfUpdateFilePreview(status.dirtyFiles, 8));
      }
      responseLines.push(
        status.behindCount > 0
          ? 'Hay actualización disponible. Ejecuta "/selfupdate" para aplicarla.'
          : "No hay actualizaciones pendientes.",
      );
      await replyLong(params.ctx, responseLines.join("\n"));
      await safeAudit({
        type: "selfupdate.check",
        chatId: actor.chatId,
        userId: params.userId ?? actor.userId,
        details: {
          source: params.source,
          branch: status.branch,
          local: status.currentShort,
          remote: status.remoteShort,
          behindCount: status.behindCount,
          dirtyCount: status.dirtyFiles.length,
        },
      });
      return;
    }

    if (status.dirtyFiles.length > 0) {
      const responseLines = [
        "No puedo actualizar automáticamente porque hay cambios locales sin commit.",
        "Esto evita pisar cambios y perder datos.",
        "Archivos detectados:",
        ...formatSelfUpdateFilePreview(status.dirtyFiles, 10),
        "",
        "Opciones:",
        "1) commitear o descartar cambios locales",
        "2) volver a ejecutar /selfupdate",
      ];
      await replyLong(params.ctx, responseLines.join("\n"));
      await safeAudit({
        type: "selfupdate.blocked_dirty",
        chatId: actor.chatId,
        userId: params.userId ?? actor.userId,
        details: {
          source: params.source,
          branch: status.branch,
          local: status.currentShort,
          remote: status.remoteShort,
          dirtyCount: status.dirtyFiles.length,
          dirtyPreview: status.dirtyFiles.slice(0, 12),
        },
      });
      return;
    }

    if (status.behindCount <= 0) {
      await params.ctx.reply(
        [
          "Ya estás en la última versión.",
          `rama: ${status.branch}`,
          `commit: ${status.currentShort}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "selfupdate.up_to_date",
        chatId: actor.chatId,
        userId: params.userId ?? actor.userId,
        details: {
          source: params.source,
          branch: status.branch,
          local: status.currentShort,
          remote: status.remoteShort,
        },
      });
      return;
    }

    await replyProgress(
      params.ctx,
      `Actualización detectada (${status.behindCount} commit${status.behindCount === 1 ? "" : "s"}). Aplicando cambios...`,
    );
    const applied = await applySelfUpdateFromStatus(status);
    if (!applied.updated) {
      await params.ctx.reply("No hubo cambios efectivos para aplicar (ya estabas actualizado).");
      return;
    }

    const responseLines = [
      "Actualización aplicada correctamente.",
      `rama: ${status.branch}`,
      `commit anterior: ${applied.previousShort}`,
      `commit actual: ${applied.currentShort}`,
      `commits aplicados: ${status.behindCount}`,
      `dependencias: ${applied.ranNpmInstall ? "npm install ejecutado" : "sin cambios en package*.json"}`,
      `archivos actualizados: ${applied.changedFiles.length}`,
      ...formatSelfUpdateFilePreview(applied.changedFiles, 12),
      "",
      "Reiniciando servicio para activar la nueva versión...",
    ];
    await replyLong(params.ctx, responseLines.join("\n"));
    await safeAudit({
      type: "selfupdate.applied",
      chatId: actor.chatId,
      userId: params.userId ?? actor.userId,
      details: {
        source: params.source,
        branch: status.branch,
        from: applied.previousShort,
        to: applied.currentShort,
        behindCount: status.behindCount,
        ranNpmInstall: applied.ranNpmInstall,
        changedFilesCount: applied.changedFiles.length,
        changedFilesPreview: applied.changedFiles.slice(0, 20),
        durationMs: Date.now() - startedAtMs,
      },
    });

    await requestAgentServiceRestart({
      ctx: params.ctx,
      source: `${params.source}:self-update`,
      note: params.note ?? `requested via ${params.source}`,
      skipAdminApproval: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await replyLong(
      params.ctx,
      [
        "No pude completar la actualización automática.",
        message,
      ].join("\n\n"),
    );
    await safeAudit({
      type: "selfupdate.failed",
      chatId: actor.chatId,
      userId: params.userId ?? actor.userId,
      details: {
        source: params.source,
        error: message,
        durationMs: Date.now() - startedAtMs,
      },
    });
  } finally {
    selfUpdateInProgress = false;
  }
}

async function requestAgentSelfUpdate(params: {
  ctx: ChatReplyContext;
  source: string;
  note?: string;
  userId?: number;
  checkOnly?: boolean;
}): Promise<void> {
  if (adminSecurity.isPanicModeEnabled()) {
    await params.ctx.reply("Panic mode está activo: ejecución bloqueada.");
    return;
  }

  const profile = agentRegistry.require(getActiveAgent(params.ctx.chat.id));
  if (!profile.allowCommands.includes("systemctl")) {
    await params.ctx.reply(
      [
        `El agente activo (${profile.name}) no permite auto-actualización.`,
        "Habilita systemctl en allowCommands o cambia de agente.",
      ].join("\n"),
    );
    return;
  }

  const checkOnly = Boolean(params.checkOnly);
  if (!checkOnly && isAdminApprovalRequired(params.ctx.chat.id)) {
    await queueApproval({
      ctx: params.ctx,
      profile,
      commandLine: SELF_UPDATE_APPROVAL_COMMAND,
      kind: "exec",
      note: params.note ?? `requested via ${params.source}`,
    });
    return;
  }

  await executeAgentSelfUpdate({
    ctx: params.ctx,
    source: params.source,
    note: params.note,
    userId: params.userId,
    checkOnly,
  });
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
  const promptContext = await buildPromptContextForQuery(instruction, {
    chatId: ctx.chat.id,
  });

  await replyProgress(ctx, `Analizando instrucción para shell (${profile.name})...`);

  const plan = await openAi.planShellAction({
    instruction,
    allowedCommands: profile.allowCommands,
    cwd: profile.cwd,
    context: promptContext,
    model: getOpenAiModelForChat(ctx.chat.id),
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

  if (isAdminApprovalRequired(ctx.chat.id)) {
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

restoreRuntimeStateSnapshot();
startRuntimeStatePersistenceWorker();

const bot = new Bot(config.telegramBotToken);
let scheduleDeliveryLoopRunning = false;
let spontaneousSuggestionLoopRunning = false;

function parseScheduledEmailPayload(raw?: string): { to?: string; instruction?: string } | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { to?: unknown; instruction?: unknown };
    const to = typeof parsed.to === "string" ? parsed.to.trim().toLowerCase() : "";
    const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
    return {
      ...(to ? { to } : {}),
      ...(instruction ? { instruction } : {}),
    };
  } catch {
    return null;
  }
}

async function buildScheduledEmailBody(params: { chatId: number; instruction: string }): Promise<string> {
  const instruction = params.instruction.trim();
  const normalized = normalizeIntentText(instruction);
  const sections: string[] = [];

  if (/\b(recordatorios?|tareas?|pendientes?)\b/.test(normalized)) {
    const pending = scheduledTasks.listPending(params.chatId).slice(0, 20);
    const lines =
      pending.length > 0
        ? pending.map((task, idx) => `${idx + 1}. ${task.title} (${formatScheduleDateTime(new Date(task.dueAt))})`)
        : ["No hay recordatorios pendientes."];
    sections.push(["Recordatorios pendientes:", ...lines].join("\n"));
  }

  const asksNews = /\b(noticias?|novedades?|titulares?|actualidad|news)\b/.test(normalized);
  if (asksNews && config.enableWebBrowse) {
    const rawTopic = instruction || "futbol";
    const rawQuery = sanitizeNaturalWebQuery(rawTopic) || rawTopic;
    const searchResult = await runWebSearchQuery({
      rawQuery,
      newsRequested: true,
    });
    const hits = searchResult.hits.slice(0, 4);
    const lines =
      hits.length > 0
        ? hits.map((hit, idx) => `${idx + 1}. ${hit.title}\n${hit.url}`)
        : ["No encontré noticias recientes para ese tema."];
    sections.push(["Noticias recientes:", ...lines].join("\n"));
  }

  if (/\b(estoic|marco aurelio|reflexion|reflexión)\b/.test(normalized)) {
    sections.push(
      [
        "Reflexión estoica:",
        "Enfócate en lo que sí controlas hoy: tu atención, tus decisiones y tu carácter.",
        "Lo externo cambia; tu criterio y disciplina son tu ventaja sostenible.",
      ].join("\n"),
    );
  }

  if (sections.length === 0) {
    if (openAi.isConfigured()) {
      const prompt = [
        "Redacta un email breve en español.",
        `Instrucción: ${instruction || "enviar una actualización útil"}`,
        "Sin markdown. Solo texto plano.",
      ].join("\n");
      const promptContext = await buildPromptContextForQuery(instruction || "email programado", {
        chatId: params.chatId,
      });
      const drafted = await askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
      if (drafted.trim()) {
        return drafted.trim();
      }
    }
    return instruction || "Recordatorio automático de Houdi Agent.";
  }

  return sections.join("\n\n");
}

async function deliverScheduledGmailTask(task: { chatId: number; deliveryPayload?: string; title: string }): Promise<void> {
  const payload = parseScheduledEmailPayload(task.deliveryPayload);
  const to = payload?.to?.trim() || config.gmailAccountEmail?.trim() || "";
  if (!to) {
    throw new Error("No hay destinatario configurado para envío programado.");
  }

  const instruction = payload?.instruction?.trim() || task.title;
  const body = await buildScheduledEmailBody({
    chatId: task.chatId,
    instruction,
  });
  const subject = `Houdi | ${new Date().toLocaleString("es-AR", { hour12: false })}`;

  await gmailAccount.sendMessage({
    to,
    subject,
    body: body.trim() || "Actualización automática de Houdi Agent.",
  });
}

async function processDueScheduledTasks(): Promise<void> {
  if (scheduleDeliveryLoopRunning) {
    return;
  }
  scheduleDeliveryLoopRunning = true;
  try {
    const due = scheduledTasks.dueTasks(new Date());
    for (const task of due) {
      try {
        if (task.deliveryKind === "gmail-send") {
          await deliverScheduledGmailTask(task);
          await bot.api.sendMessage(
            task.chatId,
            [
              "Email programado enviado.",
              `id: ${task.id}`,
              `cuando: ${formatScheduleDateTime(new Date(task.dueAt))}`,
              `detalle: ${task.title}`,
            ].join("\n"),
          );
          await scheduledTasks.markDelivered(task.id, new Date());
          await safeAudit({
            type: "schedule.delivered",
            chatId: task.chatId,
            userId: task.userId,
            details: {
              taskId: task.id,
              deliveryKind: "gmail-send",
            },
          });
          continue;
        }
        await bot.api.sendMessage(
          task.chatId,
          [
            "Recordatorio programado",
            `id: ${task.id}`,
            `cuando: ${formatScheduleDateTime(new Date(task.dueAt))}`,
            `detalle: ${task.title}`,
          ].join("\n"),
        );
        await scheduledTasks.markDelivered(task.id, new Date());
        await safeAudit({
          type: "schedule.delivered",
          chatId: task.chatId,
          userId: task.userId,
          details: {
            taskId: task.id,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await scheduledTasks.markDeliveryFailure(task.id, message, new Date());
        } catch {
          // ignore secondary failures
        }
        await safeAudit({
          type: "schedule.delivery_failed",
          chatId: task.chatId,
          userId: task.userId,
          details: {
            taskId: task.id,
            error: message,
          },
        });
      }
    }
  } finally {
    scheduleDeliveryLoopRunning = false;
  }
}

function interestCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    gmail: "correo",
    schedule: "agenda",
    web: "web",
    news: "noticias",
    documents: "documentos",
    self: "configuracion del agente",
    shell: "automatizacion",
    audio: "audio",
  };
  return labels[category] ?? category;
}

async function buildSpontaneousSuggestion(chatId: number): Promise<{ type: string; text: string } | null> {
  const summary = interestLearning.getSummary(chatId, config.suggestionsMaxPerDay);
  if (!summary || summary.observations < config.suggestionsMinObservations) {
    return null;
  }
  if (!config.enableWebBrowse) {
    return {
      type: "news",
      text: "Sugerencia: activa ENABLE_WEB_BROWSE=true para recibir noticias recientes segun tus intereses.",
    };
  }

  const topKeywords = summary.topKeywords.slice(0, 3).map((item) => item.keyword).filter(Boolean);
  const queryBase = topKeywords.length > 0 ? topKeywords.join(" ") : "tecnologia economia ia";
  const searchResult = await runWebSearchQuery({
    rawQuery: queryBase,
    newsRequested: true,
  });
  const hits = searchResult.hits.slice(0, 3);
  if (hits.length === 0) {
    return {
      type: "news",
      text: [
        "Sugerencia proactiva (noticias):",
        `No encontre novedades recientes para "${queryBase}".`,
        "Puedes agregar un interes especifico con: /interests add <tema>.",
      ].join("\n"),
    };
  }

  const now = new Date();
  const lines = hits.map((hit, idx) => {
    const date = extractDetectedNewsDate(hit, now);
    return [
      `${idx + 1}. ${hit.title}`,
      `Fecha detectada: ${formatNewsDetectedDate(date)}`,
      `Fuente: ${resolveWebResultDomain(hit.url)}`,
      hit.url,
    ].join("\n");
  });
  return {
    type: "news",
    text: [
      "Sugerencia proactiva (noticias segun tus intereses):",
      `Tema base: ${queryBase}`,
      "",
      ...lines,
      "",
      "Si quieres, abro una y te hago resumen con contexto y fechas.",
    ].join("\n"),
  };
}

async function processSpontaneousSuggestions(): Promise<void> {
  if (!config.suggestionsEnabled) {
    return;
  }
  if (spontaneousSuggestionLoopRunning) {
    return;
  }
  spontaneousSuggestionLoopRunning = true;
  try {
    const now = new Date();
    const eligibleChatIds = interestLearning.listEligibleChatIds({
      now,
      maxPerDay: config.suggestionsMaxPerDay,
      minIntervalMs: config.suggestionsMinIntervalMinutes * 60 * 1000,
      minObservations: config.suggestionsMinObservations,
    });
    for (const chatId of eligibleChatIds) {
      const candidate = await buildSpontaneousSuggestion(chatId);
      if (!candidate) {
        continue;
      }
      try {
        await bot.api.sendMessage(chatId, candidate.text);
        await interestLearning.markSuggestionSent(chatId, candidate.type, new Date());
        await safeAudit({
          type: "interest.suggestion_sent",
          chatId,
          details: {
            suggestionType: candidate.type,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await safeAudit({
          type: "interest.suggestion_failed",
          chatId,
          details: {
            suggestionType: candidate.type,
            error: message,
          },
        });
      }
    }
  } finally {
    spontaneousSuggestionLoopRunning = false;
  }
}

const schedulePollHandle = setInterval(() => {
  void processDueScheduledTasks();
}, Math.max(1000, config.schedulePollMs));
if (typeof schedulePollHandle.unref === "function") {
  schedulePollHandle.unref();
}
void processDueScheduledTasks();

if (config.suggestionsEnabled) {
  const suggestionsPollHandle = setInterval(() => {
    void processSpontaneousSuggestions();
  }, Math.max(30_000, config.suggestionsPollMs));
  if (typeof suggestionsPollHandle.unref === "function") {
    suggestionsPollHandle.unref();
  }
  void processSpontaneousSuggestions();
}

const idempotencyPruneHandle = setInterval(() => {
  const pruned = idempotency.pruneExpired();
  if (pruned > 0) {
    observability.increment("bridge.http.idempotency.pruned", pruned);
  }
}, Math.max(60_000, Math.floor(config.idempotencyTtlMs / 4)));
if (typeof idempotencyPruneHandle.unref === "function") {
  idempotencyPruneHandle.unref();
}

async function downloadTelegramFile(
  fileId: string,
  purpose: "audio" | "imagen" | "archivo" = "archivo",
): Promise<{ buffer: Buffer; filePath: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram no devolvió file_path para descargar el ${purpose}`);
  }
  const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(fileUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Descarga desde Telegram falló (${response.status})`);
    }
    const data = await response.arrayBuffer();
    return {
      buffer: Buffer.from(data),
      filePath: file.file_path,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadTelegramFileBuffer(fileId: string): Promise<Buffer> {
  const result = await downloadTelegramFile(fileId, "archivo");
  return result.buffer;
}

async function maybeHandleNaturalSelfMaintenanceInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const text = params.text.trim();
  if (!text) {
    return false;
  }
  const normalizedText = normalizeIntentText(text);
  let persistedUserTurn = false;
  const persistUserTurnIfNeeded = async () => {
    if (!params.persistUserTurn || persistedUserTurn) {
      return;
    }
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text,
      source: params.source,
    });
    persistedUserTurn = true;
  };

  const activeDraft = selfSkillDrafts.getDraft(params.ctx.chat.id);
  if (activeDraft) {
    await persistUserTurnIfNeeded();
    try {
      if (isSkillDraftCancelRequested(normalizedText)) {
        await selfSkillDrafts.clearDraft(params.ctx.chat.id);
        await params.ctx.reply("Borrador de habilidad descartado.");
        await safeAudit({
          type: "selfskill.draft_cancel",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            lines: activeDraft.lines.length,
          },
        });
        return true;
      }

      if (isSkillDraftShowRequested(normalizedText)) {
        await params.ctx.reply(
          [
            `Borrador de habilidad (${activeDraft.lines.length} lineas):`,
            formatSelfSkillDraftLines(activeDraft.lines),
            "",
            "Di 'listo, crea la habilidad' para aplicarlo o 'cancelar habilidad' para descartar.",
          ].join("\n"),
        );
        return true;
      }

      if (isSkillDraftCommitRequested(normalizedText)) {
        const extra = extractSelfSkillInstructionFromText(text);
        if (extra && extra.length > 0) {
          try {
            await selfSkillDrafts.appendLine(params.ctx.chat.id, extra);
          } catch {
            // ignore optional extra line
          }
        }
        const instruction = sanitizeSelfSkillText(selfSkillDrafts.buildInstruction(params.ctx.chat.id));
        if (!instruction) {
          await params.ctx.reply(
            "El borrador esta vacio. Agrega una linea primero (ej: 'agrega: responder siempre en bullets').",
          );
          return true;
        }

        const saved = await appendDynamicSkillInstruction(instruction);
        await selfSkillDrafts.clearDraft(params.ctx.chat.id);
        await params.ctx.reply(
          [
            `Habilidad agregada en ${saved.relPath}:`,
            saved.entry,
            "",
            "Se aplicara en proximas respuestas.",
          ].join("\n"),
        );
        await safeAudit({
          type: "selfskill.draft_commit",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            relPath: saved.relPath,
            length: instruction.length,
          },
        });
        return true;
      }

      const updated = await selfSkillDrafts.appendLine(params.ctx.chat.id, text);
      await params.ctx.reply(
        [
          `Anotado en borrador de habilidad (${updated.lines.length} lineas).`,
          "Puedes seguir enviando mas lineas.",
          "Cuando termines: 'listo, crea la habilidad'.",
        ].join("\n"),
      );
      await safeAudit({
        type: "selfskill.draft_append",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          lines: updated.lines.length,
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await params.ctx.reply(`No pude procesar el borrador de habilidad: ${message}`);
      await safeAudit({
        type: "selfskill.draft_failed",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          error: message,
        },
      });
      return true;
    }
  }

  const intent = detectSelfMaintenanceIntent(text);
  if (!intent.shouldHandle || !intent.action) {
    return false;
  }

  await persistUserTurnIfNeeded();

  try {
    if (intent.action === "list-skills") {
      const result = await listDynamicSkillInstructions();
      if (result.entries.length === 0) {
        await params.ctx.reply("No hay habilidades dinámicas agregadas todavía.");
        return true;
      }
      await replyLong(
        params.ctx,
        [
          `Habilidades dinámicas en ${result.relPath}:`,
          ...result.entries.map((entry, index) => `${index + 1}. ${entry}`),
        ].join("\n"),
      );
      await safeAudit({
        type: "selfskill.intent_list",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          count: result.entries.length,
        },
      });
      return true;
    }

    if (intent.action === "add-skill") {
      const instruction = intent.instruction?.trim() ?? "";
      const requestedDraft = isSkillDraftMultiMessageRequested(normalizedText);
      if (!instruction || requestedDraft) {
        const started = await selfSkillDrafts.startDraft({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          ...(instruction ? { seedLine: instruction } : {}),
        });
        const firstLineInfo =
          started.lines.length > 0
            ? `Primera linea guardada (${started.lines.length}).`
            : "Todavia no hay lineas en el borrador.";
        await params.ctx.reply(
          [
            "Modo borrador de habilidad activado.",
            firstLineInfo,
            "Enviame los detalles en varios mensajes.",
            "Para aplicar: 'listo, crea la habilidad'.",
            "Para ver borrador: 'mostrame el borrador skill'.",
            "Para cancelar: 'cancelar habilidad'.",
          ].join("\n"),
        );
        await safeAudit({
          type: "selfskill.draft_start",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            seed: Boolean(instruction),
          },
        });
        return true;
      }

      const saved = await appendDynamicSkillInstruction(instruction);
      await params.ctx.reply(
        [
          `Habilidad agregada en ${saved.relPath}:`,
          saved.entry,
          "",
          "Se aplicara en proximas respuestas.",
        ].join("\n"),
      );
      await safeAudit({
        type: "selfskill.intent_add",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          length: instruction.length,
          relPath: saved.relPath,
        },
      });
      return true;
    }

    if (intent.action === "delete-skill") {
      const skillIndex = intent.skillIndex;
      if (typeof skillIndex !== "number" || !Number.isFinite(skillIndex) || skillIndex === 0) {
        await params.ctx.reply(
          "Indica qué habilidad eliminar. Ejemplos: 'elimina la habilidad 2' o 'elimina la última habilidad'.",
        );
        return true;
      }

      const removed = await removeDynamicSkillInstruction(skillIndex);
      await params.ctx.reply(
        [
          `Habilidad eliminada (${removed.removedIndex}) en ${removed.relPath}:`,
          removed.removedEntry,
          `Restantes: ${removed.remaining}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "selfskill.intent_delete",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          skillIndex,
          removedIndex: removed.removedIndex,
          remaining: removed.remaining,
        },
      });
      return true;
    }

    if (intent.action === "restart-service") {
      await requestAgentServiceRestart({
        ctx: params.ctx,
        source: `${params.source}:self-maintenance`,
        note: "requested via natural self-maintenance",
      });
      await safeAudit({
        type: "selfrestart.intent",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
        },
      });
      return true;
    }

    if (intent.action === "update-service") {
      await requestAgentSelfUpdate({
        ctx: params.ctx,
        source: `${params.source}:self-maintenance`,
        note: "requested via natural self-maintenance",
        userId: params.userId,
      });
      await safeAudit({
        type: "selfupdate.intent",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
        },
      });
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude aplicar auto-mantenimiento: ${message}`);
    await safeAudit({
      type: "selfmaintenance.intent_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        error: message,
      },
    });
    return true;
  }

  return false;
}

async function maybeHandleNaturalConnectorInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const chatId = params.ctx.chat.id;
  const now = Date.now();
  const normalizedText = normalizeIntentText(params.text);
  const hasExplicitLimCue = /\b\/?lim\b/.test(normalizedText) || /\blim-api\b/.test(normalizedText);

  if (!hasExplicitLimCue) {
    return false;
  }

  const normalizedTextForIntent = normalizeIntentText(params.text);
  const hasLikelyQueryCue =
    /\b(mensaje|mensajes|prospecto|contacto|lead|ultimo|último|ultimos|últimos|de\s+[a-záéíóúñ'`.-]+\s+[a-záéíóúñ'`.-]+)\b/i.test(
      normalizedTextForIntent,
    );
  const parsedIntent = detectConnectorNaturalIntent(params.text);
  const hasInvalidQueryName =
    parsedIntent.action === "query" &&
    /\b(revisa|revisar|consulta|consultar|busca|buscar|trae|traer|lee|leer|mira|mirar|ver)\b/.test(
      normalizeIntentText(parsedIntent.firstName ?? ""),
    );
  const needsAiFallback =
    !parsedIntent.shouldHandle ||
    !parsedIntent.action ||
    (parsedIntent.action === "query" &&
      (!parsedIntent.firstName || !parsedIntent.lastName || !parsedIntent.sourceName || hasInvalidQueryName)) ||
    (parsedIntent.action === "status" && hasLikelyQueryCue);
  const aiIntent = needsAiFallback
    ? await classifyConnectorIntentWithAi({
        chatId,
        text: params.text,
      })
    : null;
  const intent = aiIntent?.shouldHandle && aiIntent.action ? aiIntent : parsedIntent;

  if (!intent.shouldHandle || !intent.action) {
    return false;
  }
  if (!config.enableLimControl) {
    await params.ctx.reply("LIM está deshabilitado por configuración (ENABLE_LIM_CONTROL=false).");
    await safeAudit({
      type: "connector.intent_disabled",
      chatId,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
      },
    });
    return true;
  }

  lastConnectorContextByChat.set(chatId, now);

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  if (intent.action === "query") {
    const firstName = intent.firstName?.trim() ?? "";
    const lastName = intent.lastName?.trim() ?? "";
    const sourceName = intent.sourceName?.trim() ?? "";
    if (!firstName || !lastName || !sourceName) {
      await params.ctx.reply(
        'Para consultar LIM indica: "consulta LIM first_name:Juan last_name:Perez fuente:account_demo_c_jack [count:3]".',
      );
      return true;
    }

    await replyProgress(params.ctx, `Consultando LIM: ${firstName} ${lastName} | fuente ${sourceName}...`);
    const result = await queryLimMessages({
      firstName,
      lastName,
      sourceName,
      count: intent.count ?? 3,
      prospectOnly: intent.prospectOnly ?? false,
    });
    if (!result.ok) {
      await params.ctx.reply(
        [
          "No pude consultar LIM.",
          `Detalle: ${truncateInline(result.detail || result.error || "error desconocido", 260)}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "connector.intent_query_failed",
        chatId,
        userId: params.userId,
        details: {
          source: params.source,
          action: intent.action,
          firstName,
          lastName,
          sourceName,
          count: intent.count ?? 3,
          error: result.error || "",
          detail: result.detail || "",
        },
      });
      return true;
    }

    const lines: string[] = [];
    lines.push(`LIM | ${result.contact || `${firstName} ${lastName}`}`);
    lines.push(`Cuenta: ${result.account || "-"}`);
    lines.push(`Encontrado: ${result.found ? "sí" : "no"} | Total: ${result.totalMessages ?? 0} | Devueltos: ${result.returnedMessages ?? 0}`);
    if (result.queryUsed) {
      lines.push(`Query usada: ${result.queryUsed}`);
    }
    if ((result.messages?.length ?? 0) > 0) {
      lines.push("");
      lines.push("Mensajes:");
      for (const [index, message] of (result.messages ?? []).entries()) {
        lines.push(
          [
            `${index + 1}. ${truncateInline(message.text || "(sin texto)", 280)}`,
            `dir: ${message.direction || "-"} | hora: ${message.time || "-"} | idx: ${message.index ?? "-"}`,
          ].join("\n"),
        );
      }
    }
    const responseText = lines.join("\n");
    await replyLong(params.ctx, responseText);
    await appendConversationTurn({
      chatId,
      userId: params.userId,
      role: "assistant",
      text: truncateInline(responseText, 3000),
      source: `${params.source}:connector-intent`,
    });
    await safeAudit({
      type: "connector.intent_query",
      chatId,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        firstName,
        lastName,
        sourceName,
        count: intent.count ?? 3,
        account: result.account || "",
        found: result.found ?? false,
        returnedMessages: result.returnedMessages ?? 0,
      },
    });
    return true;
  }

  const profile = agentRegistry.require(getActiveAgent(chatId));
  if (!profile.allowCommands.includes("systemctl")) {
    await params.ctx.reply(
      [
        `El agente activo (${profile.name}) no permite controlar servicios systemd.`,
        "Cambia a un agente con 'systemctl' en allowCommands (ej: /agent set admin).",
      ].join("\n"),
    );
    await safeAudit({
      type: "connector.intent_blocked_agent",
      chatId,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        agent: profile.name,
      },
    });
    return true;
  }

  const includeTunnel = intent.includeTunnel ?? true;
  const { appUnit, tunnelUnit } = getConnectorUnitNames();
  const units = includeTunnel ? [appUnit, tunnelUnit] : [appUnit];

  try {
    if (intent.action === "status") {
      const snapshot = await collectConnectorStatus(profile);
      const responseText = buildConnectorStatusText({
        includeTunnel,
        snapshot,
      });
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 2800),
        source: `${params.source}:connector-intent`,
      });
      await safeAudit({
        type: "connector.intent_status",
        chatId,
        userId: params.userId,
        details: {
          source: params.source,
          includeTunnel,
          appState: snapshot.app.activeState,
          tunnelState: snapshot.tunnel.activeState,
          localProbe: snapshot.localProbe.summary,
          publicProbe: snapshot.publicProbe.summary,
        },
      });
      return true;
    }

    if (adminSecurity.isPanicModeEnabled()) {
      await params.ctx.reply("Panic mode está activo: ejecución bloqueada.");
      await safeAudit({
        type: "connector.intent_blocked_panic",
        chatId,
        userId: params.userId,
        details: {
          source: params.source,
          action: intent.action,
          includeTunnel,
        },
      });
      return true;
    }

    const commandLine = `systemctl --user ${intent.action} ${units.join(" ")}`;
    if (isAdminApprovalRequired(chatId)) {
      await queueApproval({
        ctx: params.ctx,
        profile,
        commandLine,
        kind: "exec",
        note: `connector natural intent (${intent.action})`,
      });
      await safeAudit({
        type: "connector.intent_approval_queued",
        chatId,
        userId: params.userId,
        details: {
          source: params.source,
          action: intent.action,
          includeTunnel,
          commandLine,
        },
      });
      return true;
    }

    await replyProgress(params.ctx, `Gestionando LIM (${intent.action})...`);
    const commandResult = await runProfileCommandCapture({
      profile,
      commandLine,
    });
    if (!commandResult.ok) {
      const detail =
        commandResult.error ||
        commandResult.stderr ||
        commandResult.stdout ||
        `status=${commandResult.status} exit=${commandResult.exitCode ?? "null"}`;
      await params.ctx.reply(
        [
          `No pude ejecutar la acción LIM (${intent.action}).`,
          `Comando: ${commandLine}`,
          `Detalle: ${truncateInline(detail, 280)}`,
          "Si faltan units, ejecuta scripts/install-lim-user-services.sh",
        ].join("\n"),
      );
      await safeAudit({
        type: "connector.intent_command_failed",
        chatId,
        userId: params.userId,
        details: {
          source: params.source,
          action: intent.action,
          includeTunnel,
          commandLine,
          error: detail,
        },
      });
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 1200);
    });

    const snapshot = await collectConnectorStatus(profile);
    const responseText = buildConnectorStatusText({
      actionLabel: `Accion aplicada: ${intent.action} (${includeTunnel ? "app+tunnel" : "solo app"}).`,
      includeTunnel,
      snapshot,
    });
    await replyLong(params.ctx, responseText);
    await appendConversationTurn({
      chatId,
      userId: params.userId,
      role: "assistant",
      text: truncateInline(responseText, 2800),
      source: `${params.source}:connector-intent`,
    });
    await safeAudit({
      type: "connector.intent_command_ok",
      chatId,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        includeTunnel,
        commandLine,
        appState: snapshot.app.activeState,
        tunnelState: snapshot.tunnel.activeState,
        localProbe: snapshot.localProbe.summary,
        publicProbe: snapshot.publicProbe.summary,
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude operar LIM: ${message}`);
    await safeAudit({
      type: "connector.intent_failed",
      chatId,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        includeTunnel,
        error: message,
      },
    });
    return true;
  }
}

function formatScheduleTaskLines(tasks: Array<{ id: string; title: string; dueAt: string }>): string[] {
  return tasks.map((task, index) => {
    const dueAt = new Date(task.dueAt);
    return [`${index + 1}. ${task.title}`, `id: ${task.id}`, `cuando: ${formatScheduleDateTime(dueAt)}`].join("\n");
  });
}

async function maybeHandleNaturalScheduleInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const intent = detectScheduleNaturalIntent(params.text);
  if (!intent.shouldHandle || !intent.action) {
    return false;
  }

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  try {
    if (intent.action === "list") {
      const pending = scheduledTasks.listPending(params.ctx.chat.id);
      if (pending.length === 0) {
        await params.ctx.reply("No hay tareas programadas pendientes.");
        return true;
      }
      await replyLong(
        params.ctx,
        [
          `Tareas pendientes (${pending.length}):`,
          ...formatScheduleTaskLines(pending),
        ].join("\n\n"),
      );
      await safeAudit({
        type: "schedule.intent_list",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          count: pending.length,
        },
      });
      return true;
    }

    if (intent.action === "create") {
      if (!intent.dueAt || !Number.isFinite(intent.dueAt.getTime())) {
        await params.ctx.reply(
          "No pude inferir fecha/hora. Ejemplos: 'recordame mañana a las 10 pagar expensas' o 'en 2 horas llamo a Juan'.",
        );
        return true;
      }
      const dueAt = intent.dueAt;
      if (dueAt.getTime() <= Date.now() + 10_000) {
        await params.ctx.reply(
          "La fecha/hora quedó en pasado o demasiado cerca. Indícame una hora futura (ej: en 10 minutos).",
        );
        return true;
      }
      const title = intent.taskTitle?.trim() ?? "";
      if (!title) {
        await params.ctx.reply("No pude inferir la tarea. Ejemplo: 'recordame mañana a las 10 pagar expensas'.");
        return true;
      }

      if (intent.scheduleEmail) {
        const accessIssue = getGmailAccessIssue(params.ctx);
        if (accessIssue) {
          await params.ctx.reply(accessIssue);
          return true;
        }
      }

      const scheduledEmailTo = intent.emailTo?.trim() || "";
      if (intent.scheduleEmail && !scheduledEmailTo && !config.gmailAccountEmail?.trim()) {
        await params.ctx.reply(
          "No tengo destinatario para el email programado. Configura GMAIL_ACCOUNT_EMAIL o indícalo en el mensaje.",
        );
        return true;
      }

      const created = await scheduledTasks.createTask({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        title,
        dueAt,
        ...(intent.scheduleEmail ? { deliveryKind: "gmail-send" as const } : {}),
        ...(intent.scheduleEmail
          ? {
              deliveryPayload: JSON.stringify({
                to: scheduledEmailTo || config.gmailAccountEmail?.trim() || "",
                instruction: intent.emailInstruction?.trim() || title,
              }),
            }
          : {}),
      });
      const pending = scheduledTasks.listPending(params.ctx.chat.id);
      const index = Math.max(1, pending.findIndex((item) => item.id === created.id) + 1);
      const responseText = [
        intent.scheduleEmail ? "Email programado." : "Tarea programada.",
        `#${index} | id: ${created.id}`,
        `cuando: ${formatScheduleDateTime(new Date(created.dueAt))}`,
        `detalle: ${created.title}`,
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:schedule-intent`,
      });
      await safeAudit({
        type: "schedule.intent_create",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          taskId: created.id,
          dueAt: created.dueAt,
        },
      });
      return true;
    }

    if (intent.action === "delete") {
      const ref = intent.taskRef?.trim() ?? "";
      if (!ref) {
        await params.ctx.reply("Indica qué tarea eliminar. Ejemplos: 'elimina tarea 2' o 'borra la última tarea'.");
        return true;
      }
      const target = scheduledTasks.resolveTaskByRef(params.ctx.chat.id, ref);
      if (!target) {
        await params.ctx.reply("No encontré esa tarea pendiente. Usa 'lista mis tareas' para ver índices.");
        return true;
      }
      const canceled = await scheduledTasks.cancelTask(target.id);
      const responseText = [`Tarea eliminada.`, `id: ${canceled.id}`, `detalle: ${canceled.title}`].join("\n");
      await params.ctx.reply(responseText);
      await safeAudit({
        type: "schedule.intent_delete",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          taskId: canceled.id,
        },
      });
      return true;
    }

    if (intent.action === "edit") {
      const ref = intent.taskRef?.trim() ?? "";
      if (!ref) {
        await params.ctx.reply("Indica qué tarea editar. Ejemplo: 'edita tarea 2 para mañana 18:30'.");
        return true;
      }
      const target = scheduledTasks.resolveTaskByRef(params.ctx.chat.id, ref);
      if (!target) {
        await params.ctx.reply("No encontré esa tarea pendiente. Usa 'lista mis tareas' para ver índices.");
        return true;
      }

      const changes: { title?: string; dueAt?: Date } = {};
      if (intent.taskTitle?.trim()) {
        changes.title = intent.taskTitle.trim();
      }
      if (intent.dueAt && Number.isFinite(intent.dueAt.getTime())) {
        if (intent.dueAt.getTime() <= Date.now() + 10_000) {
          await params.ctx.reply("La nueva fecha/hora debe ser futura.");
          return true;
        }
        changes.dueAt = intent.dueAt;
      }

      if (!changes.title && !changes.dueAt) {
        await params.ctx.reply(
          "No detecté cambios. Ejemplos: 'edita tarea 2 para mañana 18' o 'edita tarea 2 texto: llamar a Juan'.",
        );
        return true;
      }

      const updated = await scheduledTasks.updateTask(target.id, changes);
      const responseText = [
        "Tarea actualizada.",
        `id: ${updated.id}`,
        `cuando: ${formatScheduleDateTime(new Date(updated.dueAt))}`,
        `detalle: ${updated.title}`,
      ].join("\n");
      await params.ctx.reply(responseText);
      await safeAudit({
        type: "schedule.intent_edit",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          taskId: updated.id,
          changedDueAt: Boolean(changes.dueAt),
          changedTitle: Boolean(changes.title),
        },
      });
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude gestionar la tarea programada: ${message}`);
    await safeAudit({
      type: "schedule.intent_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        error: message,
      },
    });
    return true;
  }

  return false;
}

async function maybeHandleNaturalMemoryInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const intent = detectMemoryNaturalIntent(params.text);
  if (!intent.shouldHandle || !intent.action) {
    return false;
  }

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  try {
    if (intent.action === "status") {
      const status = await contextMemory.getStatus();
      const responseText = [
        "Estado de memoria:",
        `workspace: ${status.workspaceDir}`,
        `long-term (MEMORY.md): ${status.longTermMemoryExists ? "sí" : "no"}`,
        `archivos diarios: ${status.memoryFilesCount}`,
        `archivo de hoy: ${status.todayMemoryFile}`,
        `backend preferido: ${status.backendPreferred}`,
        `backend activo: ${status.backendLastUsed}`,
        `fallbacks acumulados: ${status.backendFallbackCount}`,
        ...(status.backendLastFallbackError ? [`ultimo fallback: ${status.backendLastFallbackError}`] : []),
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:memory-intent`,
      });
      await safeAudit({
        type: "memory.intent_status",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          memoryFilesCount: status.memoryFilesCount,
          longTermMemoryExists: status.longTermMemoryExists,
          backendPreferred: status.backendPreferred,
          backendLastUsed: status.backendLastUsed,
          backendFallbackCount: status.backendFallbackCount,
        },
      });
      return true;
    }

    const query = intent.query?.trim() ?? "";
    if (!query || isGenericMemoryQuery(query)) {
      await params.ctx.reply(
        [
          "Puedo buscar en memoria, pero necesito el tema.",
          "Ejemplos:",
          " - te acordás de lo que hablamos de Gmail",
          " - recordás el tema del pdf de contratos",
          " - buscá en memoria sobre tareas programadas",
        ].join("\n"),
      );
      await safeAudit({
        type: "memory.intent_missing_query",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          text: params.text,
        },
      });
      return true;
    }

    await replyProgress(params.ctx, `Buscando en memoria: ${query}`);
    const hits = await contextMemory.searchMemoryWithContext(query, {
      limit: config.memoryMaxResults,
      chatId: params.ctx.chat.id,
    });
    if (hits.length === 0) {
      const responseText = [
        `No encontré memoria sobre: "${query}"`,
        "Si quieres, guarda una nota con /remember para futuras búsquedas.",
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:memory-intent`,
      });
      await safeAudit({
        type: "memory.intent_empty",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          query,
        },
      });
      return true;
    }

    const responseText = await summarizeMemoryRecallNatural(params.ctx.chat.id, query, hits);
    await replyLong(params.ctx, responseText);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: truncateInline(responseText, 2600),
      source: `${params.source}:memory-intent`,
    });
    await safeAudit({
      type: "memory.intent_recall",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        query,
        hits: hits.length,
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude consultar memoria: ${message}`);
    await safeAudit({
      type: "memory.intent_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        error: message,
      },
    });
    return true;
  }
}

async function maybeHandleNaturalWorkspaceInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const intent = detectWorkspaceNaturalIntent(params.text);
  if (!intent.shouldHandle || !intent.action) {
    return false;
  }

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  try {
    if (intent.action === "list") {
      const listed = await listWorkspaceDirectory(intent.path);
      rememberWorkspaceListContext({
        chatId: params.ctx.chat.id,
        relPath: listed.relPath,
        entries: listed.entries,
        source: `${params.source}:workspace-intent`,
      });
      const responseText =
        listed.entries.length === 0
          ? `Carpeta vacia: ${listed.relPath}`
          : [
              `Contenido de ${listed.relPath} (${listed.entries.length}):`,
              ...formatWorkspaceEntries(listed.entries),
            ].join("\n");
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 2600),
        source: `${params.source}:workspace-intent`,
      });
      await safeAudit({
        type: "workspace.intent_list",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          path: listed.relPath,
          count: listed.entries.length,
        },
      });
      return true;
    }

    if (intent.action === "write") {
      let filePath = intent.path?.trim() ?? "";
      const formatHint = intent.formatHint ?? detectSimpleTextExtensionHint(params.text);
      const normalizedWriteRequest = normalizeIntentText(params.text);
      const explicitWriteContentCue =
        /\b(escrib\w*|redact\w*|contenido|texto|poema|poesia|poes[ií]a|chiste|broma|resumen|reflexion|estoic)\b/.test(
          normalizedWriteRequest,
        );
      const explicitCreationCue =
        /\b(crea|crear|nuevo|nueva|genera|generar|escrib\w*|guard\w*|redact\w*|arm\w*)\b/.test(
          normalizedWriteRequest,
        ) && !/\b(elimina|eliminar|borra|borrar|quita|quitar|mueve|mover|renombra|renombrar)\b/.test(
          normalizedWriteRequest,
        );
      const numberRequest = extractNumberRequest(params.text);
      const placeholderContent =
        typeof intent.content === "string" && isPlaceholderContentForNumber(intent.content);
      let content = typeof intent.content === "string" ? intent.content : undefined;
      if (!content && hasAssistantReferenceCue(normalizeIntentText(params.text))) {
        const lastAssistant = resolveAssistantReplyByReference(params.ctx.chat.id, params.text);
        if (lastAssistant?.text.trim()) {
          content = lastAssistant.text;
        }
      }
      if (!content) {
        const normalizedWrite = normalizeIntentText(params.text);
        const wantsMailCopy =
          /\b(copia|copi[aá]|copiar|guarda|deja|guardar)\b/.test(normalizedWrite) &&
          /\b(mensaje|correo|mail|email)\b/.test(normalizedWrite);
        if (wantsMailCopy) {
          const snapshot = lastSentEmailByChat.get(params.ctx.chat.id);
          if (snapshot) {
            content = [`To: ${snapshot.to}`, `Subject: ${snapshot.subject}`, "", snapshot.body].join("\n");
          }
        }
      }
      let autoNumberUsed: number | undefined;
      if (
        (!content || placeholderContent) &&
        (typeof numberRequest.explicitNumber === "number" || numberRequest.randomRequested)
      ) {
        const numberValue =
          typeof numberRequest.explicitNumber === "number"
            ? numberRequest.explicitNumber
            : generateRandomInt(0, 9999);
        autoNumberUsed = numberValue;
        const extForContent = formatHint || path.extname(filePath) || ".txt";
        content = buildContentFromNumber(extForContent, numberValue);
      }

      if ((!content || !content.trim()) && explicitWriteContentCue) {
        const autoContent = await buildWorkspaceAutoContent({
          chatId: params.ctx.chat.id,
          userText: params.text,
          ...(filePath ? { pathHint: filePath } : {}),
        });
        if (autoContent?.trim()) {
          content = autoContent.trim();
        }
      }

      const autoPathGenerated = !filePath;
      const appendMode = Boolean(intent.append);
      const explicitOverwriteCue =
        /\b(sobrescrib\w*|reemplaz\w*|actualiz\w*|modific\w*|edit\w*|dibuj\w*|traz\w*)\b/.test(normalizedWriteRequest) &&
        !/\b(no\s+sobrescrib\w*|sin\s+sobrescrib\w*)\b/.test(normalizedWriteRequest);
      if (!filePath && !explicitCreationCue) {
        await params.ctx.reply(
          [
            "Detecté intención de crear/escribir archivo, pero falta nombre/ruta.",
            "Indica una ruta dentro de workspace (ej: reportes/hoy.csv).",
          ].join("\n"),
        );
        return true;
      }
      if (!filePath) {
        filePath = buildAutoWorkspaceFilePath(formatHint);
      }
      const resolvedWritePath = resolveWorkspacePath(filePath);
      const targetFileExists = await safePathExists(resolvedWritePath.fullPath);
      const overwriteMode =
        !appendMode &&
        (explicitOverwriteCue || (!explicitCreationCue && targetFileExists) || (targetFileExists && explicitWriteContentCue));
      const written = await writeWorkspaceTextFile({
        relativePath: filePath,
        ...(typeof content === "string" ? { content } : {}),
        ...(appendMode ? { append: true } : {}),
        ...(overwriteMode ? { overwrite: true } : {}),
      });
      if (typeof content === "string" && content.trim()) {
        rememberLastDocumentSnapshot(params.ctx.chat.id, written.relPath, content);
      }
      const responseText = [
        written.created
          ? "Archivo creado en workspace."
          : appendMode
            ? "Contenido agregado al archivo en workspace."
            : overwriteMode
              ? "Archivo sobrescrito en workspace."
              : "Archivo actualizado en workspace.",
        ...(autoPathGenerated ? ["nombre: autogenerado"] : []),
        `ruta: ${written.relPath}`,
        `tamano: ${formatBytes(written.size)}`,
        ...(typeof autoNumberUsed === "number" ? [`numero: ${autoNumberUsed}`] : []),
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:workspace-intent`,
      });
      await safeAudit({
        type: "workspace.intent_write",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          path: written.relPath,
          size: written.size,
          created: written.created,
          append: appendMode,
          overwrite: overwriteMode,
          contentChars: typeof content === "string" ? content.length : 0,
          autoPathGenerated,
          autoNumberUsed,
        },
      });
      return true;
    }

    if (intent.action === "mkdir") {
      const folderPath = intent.path?.trim() ?? "";
      if (!folderPath) {
        await params.ctx.reply(
          [
            "Indica la carpeta a crear dentro de workspace.",
            "Ejemplos:",
            " - crea carpeta reportes/2026",
            " - crea carpeta proyectos/cliente-a",
          ].join("\n"),
        );
        return true;
      }
      const created = await createWorkspaceDirectory(folderPath);
      const responseText = `Carpeta creada: ${created.relPath}`;
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:workspace-intent`,
      });
      await safeAudit({
        type: "workspace.intent_mkdir",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          path: created.relPath,
        },
      });
      return true;
    }

    if (intent.action === "move" || intent.action === "rename") {
      if (intent.selector) {
        const targetPath = intent.targetPath?.trim() ?? "";
        if (!targetPath) {
          await params.ctx.reply(
            [
              "Indica la carpeta destino dentro de workspace.",
              "Ejemplo:",
              ' - mueve archivos que empiezan con "log_" a archivados/logs',
            ].join("\n"),
          );
          return true;
        }

        const selected = await findWorkspaceFilesBySelector(intent.selector);
        if (selected.matches.length === 0) {
          await params.ctx.reply(`No encontré archivos cuya condición sea: ${formatWorkspaceSelector(intent.selector)}.`);
          return true;
        }
        const moved = await moveWorkspacePathsToDirectory(
          selected.matches.map((item) => item.path),
          targetPath,
        );
        const responseText = [
          `Movidos ${moved.length} archivo(s).`,
          `selector: ${formatWorkspaceSelector(intent.selector)}`,
          `destino: ${resolveWorkspacePath(targetPath).relPath}`,
          ...formatWorkspacePathPreview(moved.map((item) => normalizeWorkspaceRelativePath(item.to)), 8),
        ].join("\n");
        await replyLong(params.ctx, responseText);
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: truncateInline(responseText, 2600),
          source: `${params.source}:workspace-intent`,
        });
        await safeAudit({
          type: "workspace.intent_move",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            action: intent.action,
            selector: formatWorkspaceSelector(intent.selector),
            count: moved.length,
            targetPath: resolveWorkspacePath(targetPath).relPath,
            truncatedSelector: selected.truncated,
          },
        });
        return true;
      }

      const sourcePath = intent.sourcePath?.trim() ?? "";
      const targetPath = intent.targetPath?.trim() ?? "";
      if (!sourcePath || !targetPath) {
        const examples =
          intent.action === "rename"
            ? [" - renombra archivo-viejo.txt a archivo-nuevo.txt", " - cambia nombre de carpeta/a a carpeta/b"]
            : [" - mueve reporte.pdf a archivados/reporte.pdf", " - traslada carpeta/a hacia carpeta/b/a"];
        await params.ctx.reply(
          [
            "Indica origen y destino dentro de workspace.",
            "Ejemplos:",
            ...examples,
          ].join("\n"),
        );
        return true;
      }

      const moved = await moveWorkspacePath(sourcePath, targetPath);
      const responseText = [
        intent.action === "rename" ? "Renombrado." : "Movido.",
        `origen: ${moved.from}`,
        `destino: ${moved.to}`,
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:workspace-intent`,
      });
      await safeAudit({
        type: "workspace.intent_move",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          action: intent.action,
          from: moved.from,
          to: moved.to,
        },
      });
      return true;
    }

    if (intent.action === "copy") {
      if (intent.selector) {
        const selected = await findWorkspaceFilesBySelector(intent.selector);
        if (selected.matches.length === 0) {
          await params.ctx.reply(`No encontré archivos cuya condición sea: ${formatWorkspaceSelector(intent.selector)}.`);
          return true;
        }

        const targetPath = intent.targetPath?.trim() ?? "";
        if (!targetPath) {
          workspaceClipboardByChat.set(params.ctx.chat.id, {
            paths: selected.matches.map((item) => item.path),
            copiedAtMs: Date.now(),
            source: params.source,
            selector: intent.selector,
          });
          const responseText = [
            `Copiados al portapapeles ${selected.matches.length} archivo(s).`,
            `selector: ${formatWorkspaceSelector(intent.selector)}`,
            'Ahora puedes decir: "pegar en <carpeta>"',
            ...formatWorkspacePathPreview(selected.matches.map((item) => item.path), 8),
          ].join("\n");
          await replyLong(params.ctx, responseText);
          await appendConversationTurn({
            chatId: params.ctx.chat.id,
            userId: params.userId,
            role: "assistant",
            text: truncateInline(responseText, 2600),
            source: `${params.source}:workspace-intent`,
          });
          await safeAudit({
            type: "workspace.intent_copy_clipboard",
            chatId: params.ctx.chat.id,
            userId: params.userId,
            details: {
              source: params.source,
              selector: formatWorkspaceSelector(intent.selector),
              count: selected.matches.length,
              truncatedSelector: selected.truncated,
            },
          });
          return true;
        }

        const copied = await copyWorkspacePathsToDirectory(
          selected.matches.map((item) => item.path),
          targetPath,
        );
        const responseText = [
          `Copiados ${copied.length} archivo(s).`,
          `selector: ${formatWorkspaceSelector(intent.selector)}`,
          `destino: ${resolveWorkspacePath(targetPath).relPath}`,
          ...formatWorkspacePathPreview(copied.map((item) => normalizeWorkspaceRelativePath(item.to)), 8),
        ].join("\n");
        await replyLong(params.ctx, responseText);
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: truncateInline(responseText, 2600),
          source: `${params.source}:workspace-intent`,
        });
        await safeAudit({
          type: "workspace.intent_copy",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            selector: formatWorkspaceSelector(intent.selector),
            count: copied.length,
            targetPath: resolveWorkspacePath(targetPath).relPath,
            truncatedSelector: selected.truncated,
          },
        });
        return true;
      }

      const sourcePath = intent.sourcePath?.trim() ?? "";
      const targetPath = intent.targetPath?.trim() ?? "";
      if (!sourcePath && !targetPath) {
        await params.ctx.reply(
          [
            "Indica qué copiar.",
            "Ejemplos:",
            " - copia reporte.pdf a backup/reporte.pdf",
            ' - copia archivos que contienen "factura" a archivados/facturas',
          ].join("\n"),
        );
        return true;
      }
      if (sourcePath && !targetPath) {
        workspaceClipboardByChat.set(params.ctx.chat.id, {
          paths: [sourcePath],
          copiedAtMs: Date.now(),
          source: params.source,
        });
        await params.ctx.reply(
          [
            "Archivo copiado al portapapeles.",
            `origen: ${resolveWorkspacePath(sourcePath).relPath}`,
            'Ahora puedes decir: "pegar en <carpeta>"',
          ].join("\n"),
        );
        return true;
      }
      if (!sourcePath || !targetPath) {
        await params.ctx.reply("Indica origen y destino para copiar dentro de workspace.");
        return true;
      }
      const copied = await copyWorkspacePath(sourcePath, targetPath);
      const responseText = [
        "Copiado.",
        `origen: ${copied.from}`,
        `destino: ${copied.to}`,
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:workspace-intent`,
      });
      await safeAudit({
        type: "workspace.intent_copy",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          from: copied.from,
          to: copied.to,
        },
      });
      return true;
    }

    if (intent.action === "paste") {
      const targetPath = intent.targetPath?.trim() ?? "";
      if (!targetPath) {
        await params.ctx.reply('Indica la carpeta destino. Ejemplo: "pegar en archivados/2026".');
        return true;
      }
      const clipboard = workspaceClipboardByChat.get(params.ctx.chat.id);
      if (!clipboard || clipboard.paths.length === 0) {
        await params.ctx.reply('No hay archivos en portapapeles. Primero usa "copiar ...".');
        return true;
      }

      const copied = await copyWorkspacePathsToDirectory(clipboard.paths, targetPath);
      const responseText = [
        `Pegados ${copied.length} archivo(s).`,
        `destino: ${resolveWorkspacePath(targetPath).relPath}`,
        ...formatWorkspacePathPreview(copied.map((item) => normalizeWorkspaceRelativePath(item.to)), 8),
      ].join("\n");
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 2600),
        source: `${params.source}:workspace-intent`,
      });
      await safeAudit({
        type: "workspace.intent_paste",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          count: copied.length,
          targetPath: resolveWorkspacePath(targetPath).relPath,
          clipboardSource: clipboard.source,
        },
      });
      return true;
    }

    if (intent.action === "send") {
      const targetPath = intent.path?.trim() ?? "";
      const fileIndex = intent.fileIndex;
      if (!targetPath && (!Number.isFinite(fileIndex) || (fileIndex ?? 0) <= 0)) {
        await params.ctx.reply(
          [
            "Indica qué archivo enviar desde workspace.",
            "Ejemplos:",
            " - enviame files/chat-123/2026-02-19/reporte.pdf",
            " - enviame el archivo 2",
          ].join("\n"),
        );
        return true;
      }

      const responseText = await sendWorkspaceFileToChat({
        ctx: params.ctx,
        source: `${params.source}:workspace-intent`,
        userId: params.userId,
        ...(targetPath ? { reference: targetPath } : {}),
        ...(Number.isFinite(fileIndex) && (fileIndex ?? 0) > 0 ? { index: Number(fileIndex) } : {}),
      });
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:workspace-intent`,
      });
      return true;
    }

    if (intent.action === "delete") {
      if (intent.deleteContentsOfPath) {
        pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
        const scope = resolveWorkspacePath(intent.deleteContentsOfPath);
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(scope.fullPath);
        } catch {
          await params.ctx.reply(`No existe la carpeta: ${scope.relPath}`);
          return true;
        }
        if (!stat.isDirectory()) {
          await params.ctx.reply(`La ruta indicada no es carpeta: ${scope.relPath}`);
          return true;
        }
        const entries = await fs.readdir(scope.fullPath, { withFileTypes: true });
        const paths = entries
          .map((entry) => normalizeWorkspaceRelativePath(path.posix.join(intent.deleteContentsOfPath!, entry.name)))
          .filter(Boolean);
        if (paths.length === 0) {
          await params.ctx.reply(`La carpeta ya está vacía: ${scope.relPath}`);
          return true;
        }
        const pending = queueWorkspaceDeleteConfirmation({
          chatId: params.ctx.chat.id,
          paths,
          source: params.source,
          userId: params.userId,
        });
        const responseText = [
          "Confirmación requerida para eliminar en workspace.",
          `alcance: contenido completo de ${scope.relPath}`,
          `rutas: ${pending.paths.length}`,
          `expira en: ${pendingWorkspaceDeleteRemainingSeconds(pending)}s`,
          ...formatWorkspacePathPreview(pending.paths, 8),
          'Responde "si" para confirmar o "no" para cancelar.',
        ].join("\n");
        await replyLong(params.ctx, responseText);
        return true;
      }

      if (intent.deleteExtensions && intent.deleteExtensions.length > 0) {
        pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
        const selected = await findWorkspaceFilesByExtensions({
          extensions: intent.deleteExtensions,
          ...(intent.path?.trim() ? { scopePath: intent.path.trim() } : {}),
        });
        if (selected.matches.length === 0) {
          await params.ctx.reply(
            [
              "No encontré archivos con esas extensiones.",
              `extensiones: ${intent.deleteExtensions.join(", ")}`,
              `alcance: ${selected.scopeRelPath}`,
            ].join("\n"),
          );
          return true;
        }
        const pending = queueWorkspaceDeleteConfirmation({
          chatId: params.ctx.chat.id,
          paths: selected.matches.map((item) => item.path),
          source: params.source,
          userId: params.userId,
        });
        const responseText = [
          "Confirmación requerida para eliminar en workspace.",
          `extensiones: ${intent.deleteExtensions.join(", ")}`,
          `alcance: ${selected.scopeRelPath}`,
          `rutas: ${pending.paths.length}${selected.truncated ? " (limitado por tope)" : ""}`,
          `expira en: ${pendingWorkspaceDeleteRemainingSeconds(pending)}s`,
          ...formatWorkspacePathPreview(pending.paths, 8),
          'Responde "si" para confirmar o "no" para cancelar.',
        ].join("\n");
        await replyLong(params.ctx, responseText);
        return true;
      }

      if (intent.selector) {
        pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
        const selected = await findWorkspaceFilesBySelector(intent.selector, { includeDirs: true });
        if (selected.matches.length === 0) {
          await params.ctx.reply(`No encontré archivos cuya condición sea: ${formatWorkspaceSelector(intent.selector)}.`);
          return true;
        }
        const pending = queueWorkspaceDeleteConfirmation({
          chatId: params.ctx.chat.id,
          paths: selected.matches.map((item) => item.path),
          source: params.source,
          userId: params.userId,
        });
        const responseText = [
          "Confirmación requerida para eliminar en workspace.",
          `selector: ${formatWorkspaceSelector(intent.selector)}`,
          `rutas: ${pending.paths.length}`,
          `expira en: ${pendingWorkspaceDeleteRemainingSeconds(pending)}s`,
          ...formatWorkspacePathPreview(pending.paths, 8),
          'Responde "si" para confirmar o "no" para cancelar.',
        ].join("\n");
        await replyLong(params.ctx, responseText);
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: truncateInline(responseText, 2600),
          source: `${params.source}:workspace-intent`,
        });
        await safeAudit({
          type: "workspace.intent_delete_pending",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            selector: formatWorkspaceSelector(intent.selector),
            count: pending.paths.length,
            ttlSeconds: pendingWorkspaceDeleteRemainingSeconds(pending),
            truncatedSelector: selected.truncated,
          },
        });
        return true;
      }

      const targetPath = intent.path?.trim() ?? "";
      if (!targetPath) {
        const pendingPath = queueWorkspaceDeletePathRequest({
          chatId: params.ctx.chat.id,
          source: params.source,
          userId: params.userId,
        });
        await params.ctx.reply(
          [
            "Indica qué ruta eliminar dentro de workspace.",
            "Ejemplos:",
            " - elimina files/chat-123/2026-02-19/reporte.pdf",
            " - borra carpeta archivados/enero",
            'Puedes responder solo con la ruta (ej: "vrand" o "/vrand").',
            `expira en: ${pendingWorkspaceDeletePathRemainingSeconds(pendingPath)}s`,
          ].join("\n"),
        );
        return true;
      }
      pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
      const pending = queueWorkspaceDeleteConfirmation({
        chatId: params.ctx.chat.id,
        paths: [targetPath],
        source: params.source,
        userId: params.userId,
      });
      const responseText = [
        "Confirmación requerida para eliminar en workspace.",
        `ruta: workspace/${pending.paths[0]}`,
        `expira en: ${pendingWorkspaceDeleteRemainingSeconds(pending)}s`,
        'Responde "si" para confirmar o "no" para cancelar.',
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:workspace-intent`,
      });
      await safeAudit({
        type: "workspace.intent_delete_pending",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          count: pending.paths.length,
          path: `workspace/${pending.paths[0]}`,
          ttlSeconds: pendingWorkspaceDeleteRemainingSeconds(pending),
        },
      });
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude operar workspace: ${message}`);
    await safeAudit({
      type: "workspace.intent_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        error: message,
      },
    });
    return true;
  }

  return false;
}

async function maybeHandlePendingWorkspaceDeletePathInput(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
}): Promise<boolean> {
  const pending = pendingWorkspaceDeletePathByChat.get(params.ctx.chat.id);
  if (!pending) {
    return false;
  }
  if (typeof pending.userId === "number" && typeof params.userId === "number" && pending.userId !== params.userId) {
    return false;
  }

  const commandName = extractTelegramCommandName(params.text);
  if (commandName && KNOWN_TELEGRAM_COMMANDS.has(commandName)) {
    return false;
  }

  if (pending.expiresAtMs <= Date.now()) {
    pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
    const responseText = "La espera de ruta para eliminar expiró. Vuelve a pedir la eliminación.";
    await params.ctx.reply(responseText);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: responseText,
      source: `${params.source}:workspace-delete-path`,
    });
    await safeAudit({
      type: "workspace.intent_delete_path_expired",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        requestedSource: pending.source,
      },
    });
    return true;
  }

  const decision = parseNaturalConfirmationDecision(params.text);
  if (decision === "cancel") {
    pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
    const responseText = "Cancelado. No inicié eliminación en workspace.";
    await params.ctx.reply(responseText);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: responseText,
      source: `${params.source}:workspace-delete-path`,
    });
    await safeAudit({
      type: "workspace.intent_delete_path_cancelled",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        requestedSource: pending.source,
      },
    });
    return true;
  }

  if (decision === "confirm") {
    const responseText = [
      "Todavía me falta la ruta a eliminar en workspace.",
      'Puedes responder solo con la ruta (ej: "vrand" o "/vrand").',
      `expira en: ${pendingWorkspaceDeletePathRemainingSeconds(pending)}s`,
    ].join("\n");
    await params.ctx.reply(responseText);
    return true;
  }

  const candidatePath = extractWorkspaceDeletePathCandidate(params.text);
  if (!candidatePath) {
    return false;
  }

  pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
  await appendConversationTurn({
    chatId: params.ctx.chat.id,
    userId: params.userId,
    role: "user",
    text: params.text,
    source: params.source,
  });

  const deletePending = queueWorkspaceDeleteConfirmation({
    chatId: params.ctx.chat.id,
    paths: [candidatePath],
    source: pending.source,
    userId: pending.userId ?? params.userId,
  });
  const responseText = [
    "Confirmación requerida para eliminar en workspace.",
    `ruta: workspace/${deletePending.paths[0]}`,
    `expira en: ${pendingWorkspaceDeleteRemainingSeconds(deletePending)}s`,
    'Responde "si" para confirmar o "no" para cancelar.',
  ].join("\n");
  await params.ctx.reply(responseText);
  await appendConversationTurn({
    chatId: params.ctx.chat.id,
    userId: params.userId,
    role: "assistant",
    text: responseText,
    source: `${params.source}:workspace-delete-path`,
  });
  await safeAudit({
    type: "workspace.intent_delete_path_captured",
    chatId: params.ctx.chat.id,
    userId: params.userId,
    details: {
      source: params.source,
      requestedSource: pending.source,
      path: `workspace/${deletePending.paths[0]}`,
      ttlSeconds: pendingWorkspaceDeleteRemainingSeconds(deletePending),
    },
  });
  return true;
}

async function maybeHandlePendingWorkspaceDeleteConfirmation(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
}): Promise<boolean> {
  const pending = pendingWorkspaceDeleteByChat.get(params.ctx.chat.id);
  if (!pending) {
    return false;
  }
  if (typeof pending.userId === "number" && typeof params.userId === "number" && pending.userId !== params.userId) {
    return false;
  }

  const decision = parseNaturalConfirmationDecision(params.text);
  if (!decision) {
    return false;
  }

  await appendConversationTurn({
    chatId: params.ctx.chat.id,
    userId: params.userId,
    role: "user",
    text: params.text,
    source: params.source,
  });

  if (pending.expiresAtMs <= Date.now()) {
    pendingWorkspaceDeleteByChat.delete(params.ctx.chat.id);
    const responseText = "La confirmación expiró. Vuelve a pedir la eliminación para reintentar.";
    await params.ctx.reply(responseText);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: responseText,
      source: `${params.source}:workspace-delete-confirm`,
    });
    await safeAudit({
      type: "workspace.intent_delete_confirm_expired",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        requestedSource: pending.source,
        count: pending.paths.length,
        pathsPreview: pending.paths.slice(0, 10).map((item) => `workspace/${item}`),
      },
    });
    return true;
  }

  pendingWorkspaceDeleteByChat.delete(params.ctx.chat.id);

  if (decision === "cancel") {
    const responseText = [
      "Cancelado. No eliminé archivos en workspace.",
      `cantidad: ${pending.paths.length}`,
      ...formatWorkspacePathPreview(pending.paths, 8),
    ].join("\n");
    await params.ctx.reply(responseText);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: responseText,
      source: `${params.source}:workspace-delete-confirm`,
    });
    await safeAudit({
      type: "workspace.intent_delete_cancelled",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        requestedSource: pending.source,
        count: pending.paths.length,
        pathsPreview: pending.paths.slice(0, 10).map((item) => `workspace/${item}`),
      },
    });
    return true;
  }

  try {
    const deletedItems: Array<{ relPath: string; kind: "dir" | "file" | "other" }> = [];
    const failedItems: Array<{ path: string; error: string }> = [];
    for (const targetPath of pending.paths) {
      try {
        const deleted = await deleteWorkspacePath(targetPath);
        deletedItems.push(deleted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedItems.push({ path: targetPath, error: message });
      }
    }

    const responseLines = [
      "Resultado de eliminación en workspace.",
      `eliminados: ${deletedItems.length}`,
      `fallidos: ${failedItems.length}`,
    ];
    if (deletedItems.length > 0) {
      responseLines.push(...formatWorkspacePathPreview(deletedItems.map((item) => normalizeWorkspaceRelativePath(item.relPath)), 8));
    }
    if (failedItems.length > 0) {
      responseLines.push("Errores:");
      responseLines.push(
        ...failedItems.slice(0, 5).map((item, index) => `${index + 1}. workspace/${item.path} -> ${item.error}`),
      );
    }
    const responseText = responseLines.join("\n");
    await replyLong(params.ctx, responseText);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: truncateInline(responseText, 2600),
      source: `${params.source}:workspace-delete-confirm`,
    });
    await safeAudit({
      type: "workspace.intent_delete_confirmed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        requestedSource: pending.source,
        deletedCount: deletedItems.length,
        failedCount: failedItems.length,
        deletedPreview: deletedItems.slice(0, 10).map((item) => item.relPath),
        failedPreview: failedItems.slice(0, 10).map((item) => `workspace/${item.path}`),
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const responseText = `No pude eliminar en workspace: ${message}`;
    await params.ctx.reply(responseText);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: responseText,
      source: `${params.source}:workspace-delete-confirm`,
    });
    await safeAudit({
      type: "workspace.intent_delete_confirm_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        requestedSource: pending.source,
        count: pending.paths.length,
        pathsPreview: pending.paths.slice(0, 10).map((item) => `workspace/${item}`),
        error: message,
      },
    });
    return true;
  }
}

async function maybeHandleNaturalDocumentInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const intent = detectDocumentIntent(params.text, documentReader.getSupportedFormats());
  if (!intent.shouldHandle) {
    return false;
  }

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  const resolvedPath = await resolveDocumentReference(intent.references, intent.preferWorkspace);
  if (!resolvedPath) {
    await params.ctx.reply(
      [
        `Detecté intención de leer documento, pero no encontré: ${intent.references.join(", ")}`,
        "Prueba con ruta explícita o usa /readfile.",
        'Ejemplo: /readfile "workspace/documento.pdf"',
      ].join("\n"),
    );
    await safeAudit({
      type: "doc.intent_not_found",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        references: intent.references,
      },
    });
    return true;
  }

  let documentResult;
  try {
    documentResult = await documentReader.readDocument(resolvedPath);
    rememberLastDocumentSnapshot(params.ctx.chat.id, documentResult.path, documentResult.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude leer ${resolvedPath}: ${message}`);
    await safeAudit({
      type: "doc.intent_read_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        path: resolvedPath,
        error: message,
      },
    });
    return true;
  }

  if (!openAi.isConfigured()) {
    const preview = truncateInline(documentResult.text, 3000);
    await replyLong(
      params.ctx,
      [
        `Documento: ${documentResult.path}`,
        `Formato: ${documentResult.format}`,
        `Extractor: ${documentResult.extractor}`,
        "",
        preview || "(No se extrajo texto útil)",
      ].join("\n"),
    );
    return true;
  }

  const shouldAnalyze = intent.analysisRequested || !intent.readRequested;
  if (!shouldAnalyze) {
    const preview = truncateInline(documentResult.text, 3000);
    await replyLong(
      params.ctx,
      [
        `Documento: ${documentResult.path}`,
        `Formato: ${documentResult.format}`,
        `Extractor: ${documentResult.extractor}`,
        "",
        preview || "(No se extrajo texto útil)",
      ].join("\n"),
    );
    await safeAudit({
      type: "doc.intent_read_only",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        path: documentResult.path,
        format: documentResult.format,
      },
    });
    return true;
  }

  await replyProgress(params.ctx, `Documento detectado: ${documentResult.path}. Analizando...`);

  const prompt = [
    "Analiza el siguiente documento local para responder al usuario.",
    `Instrucción del usuario: ${params.text}`,
    `Archivo: ${documentResult.path}`,
    `Formato: ${documentResult.format}`,
    `Texto truncado por límite interno: ${documentResult.truncated ? "sí" : "no"}`,
    "",
    "Contenido del documento:",
    documentResult.text,
  ].join("\n");

  try {
    const promptContext = await buildPromptContextForQuery(`${params.text}\n${documentResult.path}`, {
      chatId: params.ctx.chat.id,
    });
    const answer = await askOpenAiForChat({ chatId: params.ctx.chat.id, prompt, context: promptContext });
    await replyLong(params.ctx, answer);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: answer,
      source: `${params.source}:doc-intent`,
    });

    await safeAudit({
      type: "doc.intent_handled",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        path: documentResult.path,
        format: documentResult.format,
        extractedChars: documentResult.extractedChars,
        answerLength: answer.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude analizar el documento con OpenAI: ${message}`);
    await safeAudit({
      type: "doc.intent_analyze_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        path: documentResult.path,
        error: message,
      },
    });
  }

  return true;
}

async function maybeHandleNaturalWebInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const intent = detectWebIntent(params.text);
  if (!intent.shouldHandle) {
    return false;
  }

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  if (!config.enableWebBrowse) {
    await params.ctx.reply("Navegación web deshabilitada por configuración (ENABLE_WEB_BROWSE=false).");
    await safeAudit({
      type: "web.intent_disabled",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        text: params.text,
      },
    });
    return true;
  }

  if (intent.mode === "open" && intent.url) {
    await replyProgress(params.ctx, `Abriendo ${intent.url}...`);
    try {
      const page = await webBrowser.open(intent.url);
      const header = [
        `URL: ${page.finalUrl}`,
        `Título: ${page.title}`,
        `Tipo: ${page.contentType || "desconocido"}`,
        `Truncado: ${page.truncated ? "sí" : "no"}`,
      ].join("\n");

      const shouldAnalyze = openAi.isConfigured() && (intent.analysisRequested || intent.query.length > 0);
      if (!shouldAnalyze) {
        const preview = truncateInline(page.text, 3500);
        const responseText = [
          header,
          "",
          preview || "(sin contenido textual útil)",
          "",
          openAi.isConfigured()
            ? "Si quieres análisis, pide algo como: 'de este link, resumilo en 5 puntos'."
            : "OpenAI no está configurado para análisis; puedo mostrar contenido y fuentes.",
        ].join("\n");
        await replyLong(params.ctx, responseText);
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: truncateInline(responseText, 2000),
          source: `${params.source}:web-intent`,
        });
        await safeAudit({
          type: "web.intent_open_preview",
          chatId: params.ctx.chat.id,
          userId: params.userId,
          details: {
            source: params.source,
            url: intent.url,
            finalUrl: page.finalUrl,
            analyzed: false,
          },
        });
        return true;
      }

      const ecoEnabled = isEcoModeEnabled(params.ctx.chat.id);
      const question =
        intent.query.trim() || "Resume el contenido principal, los datos clave y los posibles riesgos.";
      const prompt = [
        "Analiza este contenido web y responde la instrucción del usuario.",
        `Instrucción del usuario: ${params.text}`,
        `URL: ${page.finalUrl}`,
        `Título: ${page.title}`,
        `Tipo: ${page.contentType}`,
        "",
        "Contenido:",
        page.text,
        "",
        `Foco del análisis: ${question}`,
        "",
        ...(ecoEnabled
          ? [
              "MODO ECO: respuesta ultra-concisa.",
              "Formato exacto:",
              "1) 3 bullets máximos con hallazgos clave.",
              "2) 1 acción recomendada.",
              "No agregues secciones extra.",
            ]
          : ["Al final, incluye una línea de fuente con la URL usada."]),
      ].join("\n");

      const promptContext = await buildPromptContextForQuery(`${params.text}\n${page.title}`, {
        chatId: params.ctx.chat.id,
      });
      const answerRaw = await askOpenAiForChat({ chatId: params.ctx.chat.id, prompt, context: promptContext });
      const answer = ecoEnabled ? truncateInline(answerRaw, 900) : answerRaw;
      await replyLong(params.ctx, answer);
      await params.ctx.reply(`Fuente: ${page.finalUrl}`);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: `${answer}\nFuente: ${page.finalUrl}`,
        source: `${params.source}:web-intent`,
      });
      await safeAudit({
        type: "web.intent_open",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          url: intent.url,
          finalUrl: page.finalUrl,
          analyzed: true,
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await params.ctx.reply(`No pude abrir esa URL: ${message}`);
      await safeAudit({
        type: "web.intent_open_failed",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          url: intent.url,
          error: message,
        },
      });
      return true;
    }
  }

  const rawQuery = intent.query || params.text;
  const query = intent.newsRequested ? buildFreshNewsSearchQuery(rawQuery) : rawQuery;
  await replyProgress(
    params.ctx,
    intent.newsRequested
      ? `Buscando noticias recientes (máx ${NEWS_MAX_REDDIT_RESULTS} Reddit): ${query}`
      : `Buscando en web: ${query}`,
  );

  let usedFallbackQuery = false;
  try {
    const searchResult = await runWebSearchQuery({
      rawQuery,
      newsRequested: intent.newsRequested,
    });
    const hits = searchResult.hits;
    usedFallbackQuery = searchResult.usedFallbackQuery;
    if (hits.length === 0) {
      await params.ctx.reply(
        intent.newsRequested ? "No encontré noticias recientes relevantes sobre ese tema." : "Sin resultados relevantes.",
      );
      await safeAudit({
        type: "web.intent_search_empty",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          query,
          rawQuery,
          usedFallbackQuery,
          newsRequested: intent.newsRequested,
          redditPriority: intent.newsRequested,
          redditCap: NEWS_MAX_REDDIT_RESULTS,
        },
      });
      return true;
    }

    lastWebResultsByChat.set(params.ctx.chat.id, hits);
    rememberWebResultsListContext({
      chatId: params.ctx.chat.id,
      title: `Resultados web: ${rawQuery.trim() || query}`,
      hits,
      source: `${params.source}:web-intent`,
    });
    const shouldSynthesize = openAi.isConfigured() && !intent.listRequested;
    if (!shouldSynthesize) {
      const responseText = buildWebResultsListText({
        query: rawQuery.trim() || query,
        hits,
        newsRequested: intent.newsRequested,
      });
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 2200),
        source: `${params.source}:web-intent`,
      });
      await safeAudit({
        type: "web.intent_search_list",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          query,
          rawQuery,
          usedFallbackQuery,
          newsRequested: intent.newsRequested,
          redditPriority: intent.newsRequested,
          redditCap: NEWS_MAX_REDDIT_RESULTS,
          results: hits.length,
        },
      });
      return true;
    }

    const top = hits.slice(0, intent.newsRequested ? 5 : 3);
    const pages = await Promise.allSettled(top.map(async (hit) => ({ hit, page: await webBrowser.open(hit.url) })));
    const sources: Array<{ title: string; url: string; text: string }> = [];
    for (const item of pages) {
      if (item.status !== "fulfilled") {
        continue;
      }
      const excerpt = truncateInline(item.value.page.text, 5000);
      if (!excerpt) {
        continue;
      }
      sources.push({
        title: item.value.page.title || item.value.hit.title,
        url: item.value.page.finalUrl || item.value.hit.url,
        text: excerpt,
      });
    }

    if (sources.length === 0) {
      await params.ctx.reply("Encontré resultados, pero no pude extraer contenido utilizable.");
      await safeAudit({
        type: "web.intent_search_extract_failed",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          query,
          rawQuery,
          usedFallbackQuery,
          newsRequested: intent.newsRequested,
          redditPriority: intent.newsRequested,
          redditCap: NEWS_MAX_REDDIT_RESULTS,
          results: hits.length,
        },
      });
      return true;
    }

    const sourceBlocks = sources
      .map(
        (source, index) =>
          [
            `Fuente ${index + 1}: ${source.title}`,
            `URL: ${source.url}`,
            source.text,
          ].join("\n"),
      )
      .join("\n\n---\n\n");

    const ecoEnabled = isEcoModeEnabled(params.ctx.chat.id);
    const prompt = [
      "Responde la consulta del usuario usando SOLO la evidencia de las fuentes provistas.",
      intent.newsRequested
        ? `El pedido es de noticias: prioriza hechos de los ultimos ${NEWS_MAX_AGE_DAYS} dias y menciona fechas concretas (día/mes/año) cuando estén disponibles.`
        : "Si la evidencia no alcanza, dilo explícitamente.",
      intent.newsRequested
        ? `Usa como máximo ${NEWS_MAX_REDDIT_RESULTS} fuentes de Reddit y completa con otros sitios relevantes; marca qué puntos requieren validación adicional.`
        : "Sé claro y breve.",
      intent.newsRequested
        ? `No uses como base noticias de más de ${NEWS_MAX_AGE_DAYS} días; si no hay suficiente evidencia reciente, dilo explícitamente.`
        : "Evita suposiciones.",
      "No devuelvas JSON, YAML ni bloques de código.",
      ...(ecoEnabled
        ? [
            "MODO ECO: salida mínima en español.",
            "Formato exacto y único:",
            "1) 3 bullets máximos con lo más reciente/relevante.",
            "2) 1 acción recomendada.",
            "3) Fuentes usadas: máximo 3 links.",
            "No agregues texto extra.",
          ]
        : [
            "Entrega una respuesta natural en español con este formato:",
            "1) Resumen breve (3-5 viñetas).",
            "2) Lecturas recomendadas: hasta 5 ítems con título, mini-resumen y link.",
            "Si no tienes evidencia suficiente, dilo explícitamente.",
          ]),
      `Consulta del usuario: ${params.text}`,
      `Consulta web ejecutada: ${usedFallbackQuery ? `${query} (fallback: ${rawQuery})` : query}`,
      "",
      "Fuentes:",
      sourceBlocks,
      "",
      ...(ecoEnabled ? [] : ["Incluye al final una sección 'Fuentes usadas:' con las URLs en viñetas."]),
    ].join("\n");

    const promptContext = await buildPromptContextForQuery(params.text, {
      chatId: params.ctx.chat.id,
    });
    const answerRaw = await askOpenAiForChat({ chatId: params.ctx.chat.id, prompt, context: promptContext });
    const answer = ecoEnabled ? truncateInline(answerRaw, 1200) : answerRaw;
    await replyLong(params.ctx, answer);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: answer,
      source: `${params.source}:web-intent`,
    });
    await safeAudit({
      type: "web.intent_search_synth",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        query,
        rawQuery,
        usedFallbackQuery,
        newsRequested: intent.newsRequested,
        redditPriority: intent.newsRequested,
        redditCap: NEWS_MAX_REDDIT_RESULTS,
        results: hits.length,
        sources: sources.length,
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude buscar en web: ${message}`);
    await safeAudit({
      type: "web.intent_search_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        query,
        rawQuery,
        usedFallbackQuery,
        newsRequested: intent.newsRequested,
        redditPriority: intent.newsRequested,
        redditCap: NEWS_MAX_REDDIT_RESULTS,
        error: message,
      },
    });
    return true;
  }
}

async function maybeHandleNaturalGmailRecipientsInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const intent = detectGmailRecipientNaturalIntent(params.text);
  if (!intent.shouldHandle || !intent.action) {
    return false;
  }

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  try {
    if (intent.action === "list") {
      const list = listEmailRecipients(params.ctx.chat.id);
      if (list.length === 0) {
        await params.ctx.reply("No hay destinatarios guardados.");
        return true;
      }
      const lines = list.map((item, idx) => `${idx + 1}. ${item.name} <${item.email}>`);
      await replyLong(params.ctx, [`Destinatarios guardados (${list.length}):`, ...lines].join("\n"));
      return true;
    }

    if (intent.action === "delete") {
      const name = intent.name?.trim() ?? "";
      if (!name) {
        await params.ctx.reply("Indica el nombre a eliminar. Ejemplo: elimina destinatario Maria.");
        return true;
      }
      const removed = await deleteEmailRecipient(params.ctx.chat.id, name);
      if (!removed) {
        await params.ctx.reply(`No encontré destinatario "${name}".`);
        return true;
      }
      await params.ctx.reply(`Destinatario eliminado: ${removed.name} <${removed.email}>`);
      return true;
    }

    if (intent.action === "add" || intent.action === "update") {
      const name = intent.name?.trim() ?? "";
      const email = intent.email?.trim() ?? "";
      if (!name || !email) {
        await params.ctx.reply(
          "Faltan datos. Ejemplo: agrega destinatario Maria maria@empresa.com",
        );
        return true;
      }
      const result = await upsertEmailRecipient({
        chatId: params.ctx.chat.id,
        name,
        email,
      });
      await params.ctx.reply(
        result.created
          ? `Destinatario agregado: ${result.row.name} <${result.row.email}>`
          : `Destinatario actualizado: ${result.row.name} <${result.row.email}>`,
      );
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude operar destinatarios: ${message}`);
    return true;
  }

  return false;
}

async function maybeHandleNaturalGmailInstruction(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const intent = detectGmailNaturalIntent(params.text);
  if (!intent.shouldHandle || !intent.action) {
    return false;
  }

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  try {
    if (intent.action === "status") {
      const activeProfile = agentRegistry.require(getActiveAgent(params.ctx.chat.id));
      const gmailStatus = gmailAccount.getStatus();
      const responseText = [
        `Gmail API permitido en agente: ${activeProfile.allowCommands.includes("gmail-api") ? "sí" : "no"}`,
        `ENABLE_GMAIL_ACCOUNT: ${gmailStatus.enabled ? "true" : "false"}`,
        `Configurado: ${gmailStatus.configured ? "sí" : "no"}`,
        `Faltantes: ${gmailStatus.missing.length > 0 ? gmailStatus.missing.join(", ") : "-"}`,
        `Cuenta: ${gmailStatus.accountEmail || "(no informada)"}`,
        `Límite por consulta: ${gmailStatus.maxResults}`,
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:gmail-intent`,
      });
      await safeAudit({
        type: "gmail.intent_status",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          enabled: gmailStatus.enabled,
          configured: gmailStatus.configured,
          missing: gmailStatus.missing,
        },
      });
      return true;
    }

    const accessIssue = getGmailAccessIssue(params.ctx);
    if (accessIssue) {
      await params.ctx.reply(accessIssue);
      await safeAudit({
        type: "gmail.intent_blocked",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          action: intent.action,
          issue: accessIssue,
        },
      });
      return true;
    }

    if (intent.action === "profile") {
      const profile = await gmailAccount.getProfile();
      const responseText = [
        "Perfil Gmail:",
        `email: ${profile.emailAddress || "-"}`,
        `messagesTotal: ${profile.messagesTotal}`,
        `threadsTotal: ${profile.threadsTotal}`,
        `historyId: ${profile.historyId || "-"}`,
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:gmail-intent`,
      });
      await safeAudit({
        type: "gmail.intent_profile",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          email: profile.emailAddress,
          messagesTotal: profile.messagesTotal,
          threadsTotal: profile.threadsTotal,
        },
      });
      return true;
    }

    if (intent.action === "list") {
      const query = intent.query?.trim() || undefined;
      await replyProgress(params.ctx, `Consultando Gmail${query ? ` (query: ${query})` : ""}...`);
      const messages = await gmailAccount.listMessages(query, intent.limit);
      if (messages.length === 0) {
        await params.ctx.reply("Sin mensajes para ese filtro.");
        return true;
      }
      rememberGmailListResults(params.ctx.chat.id, messages);
      rememberGmailListContext({
        chatId: params.ctx.chat.id,
        title: `Gmail: ${query || "inbox"}`,
        messages,
        source: `${params.source}:gmail-intent`,
      });
      const lines = messages.map((message, index) =>
        [
          `${index + 1}. ${message.subject || "(sin asunto)"}`,
          `id: ${message.id}`,
          `from: ${message.from || "-"}`,
          `date: ${message.date || "-"}`,
          message.snippet ? `snippet: ${truncateInline(message.snippet, 220)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const responseText = [`Mensajes (${messages.length}):`, ...lines].join("\n\n");
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 2600),
        source: `${params.source}:gmail-intent`,
      });
      await safeAudit({
        type: "gmail.intent_list",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          count: messages.length,
          query: query ?? "",
          limit: intent.limit ?? null,
        },
      });
      return true;
    }

    if (intent.action === "send") {
      const blockReason = getPolicyCapabilityBlockReason(params.ctx.chat.id, "gmail.send");
      if (blockReason) {
        await params.ctx.reply(blockReason);
        return true;
      }
      let to = intent.to?.trim() ?? "";
      if (!to && intent.recipientName?.trim()) {
        const resolvedRecipient = resolveEmailRecipient(params.ctx.chat.id, intent.recipientName.trim());
        if (resolvedRecipient) {
          to = resolvedRecipient.email;
        }
      }
      let subject = intent.subject?.trim() || "Mensaje desde Houdi Agent";
      let body = intent.body?.trim() || "";
      const isDefaultSubject = subject === "Mensaje desde Houdi Agent";
      const isDefaultBody = body === "" || body === "Mensaje enviado desde Houdi Agent.";
      if (!to) {
        await params.ctx.reply(
          intent.recipientName?.trim()
            ? `No encontré destinatario "${intent.recipientName}". Agrégalo con: agrega destinatario ${intent.recipientName} <email>.`
            : "No pude inferir el destinatario. Ejemplo natural: 'envía un correo a ana@empresa.com asunto: Hola cuerpo: te contacto por...'",
        );
        return true;
      }
      if (intent.autoContentKind && (isDefaultBody || intent.draftRequested)) {
        await replyProgress(params.ctx, "Armando contenido del email...");
        const autoContent = await buildGmailAutoContent({
          chatId: params.ctx.chat.id,
          kind: intent.autoContentKind,
          userText: params.text,
        });
        if (isDefaultSubject || intent.draftRequested) {
          subject = autoContent.subject;
        }
        body = autoContent.body;
      }
      if (intent.forceAiByMissingSubject) {
        const modeDecision = await classifyMissingSubjectEmailModeWithAi({
          chatId: params.ctx.chat.id,
          userText: params.text,
        });
        if (modeDecision.mode === "literal") {
          const literalBody = modeDecision.literalBody?.trim() || extractLiteralBodyRequest(params.text);
          if (!literalBody) {
            await params.ctx.reply(
              [
                "No envié el correo: IA eligió modo literal, pero no encontró texto literal claro.",
                'Prueba con: "que diga <texto>" o define asunto/cuerpo explícitos.',
              ].join("\n"),
            );
            return true;
          }
          body = literalBody;
          if (!subject || subject === "Mensaje desde Houdi Agent") {
            subject = "Mensaje literal solicitado";
          }
        } else {
          const instruction = intent.draftInstruction?.trim() || params.text.trim();
          if (!openAi.isConfigured()) {
            await params.ctx.reply(
              [
                "No envié el correo: falta OPENAI para improvisar asunto y cuerpo.",
                "Opciones:",
                '1) Define asunto y cuerpo explícitos (ej: asunto: X cuerpo: Y).',
                "2) Configura OPENAI_API_KEY.",
              ].join("\n"),
            );
            return true;
          }
          await replyProgress(params.ctx, "Redactando asunto y cuerpo con IA...");
          const draft = await draftGmailMessageWithAi({
            chatId: params.ctx.chat.id,
            to,
            instruction,
          });
          if (!draft) {
            await params.ctx.reply(
              [
                "No envié el correo: no pude improvisar asunto/cuerpo con IA en este intento.",
                "Reintenta o define asunto/cuerpo explícitos.",
              ].join("\n"),
            );
            return true;
          }
          subject = draft.subject;
          body = draft.body;
        }
      }
      if (intent.draftRequested && !intent.autoContentKind && !intent.forceAiByMissingSubject) {
        const instruction = intent.draftInstruction?.trim() || params.text.trim();
        if (openAi.isConfigured()) {
          await replyProgress(params.ctx, "Redactando email...");
          const draft = await draftGmailMessageWithAi({
            chatId: params.ctx.chat.id,
            to,
            instruction,
          });
          if (draft) {
            subject = draft.subject;
            body = draft.body;
          }
        } else {
          body = body || instruction;
          if (!subject || subject === "Mensaje desde Houdi Agent") {
            subject = "Mensaje generado por instrucción";
          }
        }
      }
      if (!body) {
        body = "Mensaje enviado desde Houdi Agent.";
      }
      if (
        await maybeRequirePlannedConfirmation({
          ctx: params.ctx,
          kind: "gmail-send",
          capability: "gmail.send",
          summary: [`to: ${to}`, `subject: ${subject}`, `body_chars: ${body.length}`].join("\n"),
          payload: {
            to,
            subject,
            body,
            cc: intent.cc ?? "",
            bcc: intent.bcc ?? "",
          },
          source: `${params.source}:gmail-intent-send`,
          userId: params.userId,
        })
      ) {
        return true;
      }
      await replyProgress(params.ctx, `Enviando email a ${to}...`);
      const sent = await gmailAccount.sendMessage({
        to,
        subject,
        body,
        cc: intent.cc,
        bcc: intent.bcc,
      });
      lastSentEmailByChat.set(params.ctx.chat.id, {
        to,
        subject,
        body,
        sentAt: new Date().toISOString(),
      });
      rememberGmailMessage(params.ctx.chat.id, sent.id);
      const responseText = [
        "Email enviado.",
        `to: ${to}`,
        `subject: ${subject}`,
        `messageId: ${sent.id}`,
        `threadId: ${sent.threadId}`,
      ].join("\n");
      await params.ctx.reply(responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: responseText,
        source: `${params.source}:gmail-intent`,
      });
      await safeAudit({
        type: "gmail.intent_send",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          to,
          subjectLength: subject.length,
          bodyLength: body.length,
          cc: intent.cc ?? "",
          bcc: intent.bcc ? "[set]" : "",
          messageId: sent.id,
          threadId: sent.threadId,
        },
      });
      return true;
    }

    let messageId = resolveGmailMessageIdForChat({
      chatId: params.ctx.chat.id,
      messageId: intent.messageId,
      messageIndex: intent.messageIndex,
    });
    if (!messageId && intent.action === "read" && intent.messageIndex === -1) {
      const latestMessages = await gmailAccount.listMessages(undefined, 1);
      if (latestMessages.length > 0) {
        rememberGmailListResults(params.ctx.chat.id, latestMessages);
        messageId = latestMessages[0]?.id ?? null;
      }
    }
    if (!messageId) {
      await params.ctx.reply("No pude identificar qué correo quieres operar. Pide primero una lista o indica el messageId.");
      return true;
    }

    if (intent.action === "read") {
      const detail = await gmailAccount.readMessage(messageId);
      rememberGmailMessage(params.ctx.chat.id, detail.id);
      const responseText = [
        `Subject: ${detail.subject || "(sin asunto)"}`,
        `From: ${detail.from || "-"}`,
        `To: ${detail.to || "-"}`,
        `Date: ${detail.date || "-"}`,
        `Labels: ${detail.labelIds.join(", ") || "-"}`,
        `MessageId: ${detail.id}`,
        "",
        detail.bodyText || detail.snippet || "(sin cuerpo legible)",
      ].join("\n");
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 3000),
        source: `${params.source}:gmail-intent`,
      });
      await safeAudit({
        type: "gmail.intent_read",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          messageId: detail.id,
          subjectLength: detail.subject.length,
        },
      });
      return true;
    }

    if (intent.action === "markread") {
      await gmailAccount.markRead(messageId);
    } else if (intent.action === "markunread") {
      await gmailAccount.markUnread(messageId);
    } else if (intent.action === "trash") {
      await gmailAccount.trashMessage(messageId);
    } else if (intent.action === "untrash") {
      await gmailAccount.untrashMessage(messageId);
    } else if (intent.action === "star") {
      await gmailAccount.star(messageId);
    } else if (intent.action === "unstar") {
      await gmailAccount.unstar(messageId);
    }

    rememberGmailMessage(params.ctx.chat.id, messageId);
    const actionReply = `OK: ${intent.action} aplicado a ${messageId}`;
    await params.ctx.reply(actionReply);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "assistant",
      text: actionReply,
      source: `${params.source}:gmail-intent`,
    });
    await safeAudit({
      type: "gmail.intent_modify",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        messageId,
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`Error Gmail: ${message}`);
    await safeAudit({
      type: "gmail.intent_failed",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        action: intent.action,
        error: message,
      },
    });
    return true;
  }
}

function detectStoicSmalltalkIntent(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return false;
  }
  const askedThinking =
    /\b(en que estas pensando|en que andas|en que estas|en que andas ahora|que andas haciendo|que estas haciendo)\b/.test(
      normalized,
    ) || /\bque pensas\b/.test(normalized);
  const askedBeautiful =
    /\b(dime|decime|contame|cuentame)\s+algo\s+(bonito|lindo|linda|inspirador|inspiradora)\b/.test(normalized);
  const askedStoic =
    /\b(dame|decime|dime|contame)\s+(una\s+)?(frase|reflexion|idea)\s+(estoica|estoico|de marco aurelio)\b/.test(
      normalized,
    );
  return askedThinking || askedBeautiful || askedStoic;
}

function isLikelyOperationalInstruction(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /\b(crea|crear|arma|guardar|guarda|archivo|workspace|carpeta|mueve|elimina|borra|lista|gmail|correo|email|mail|agenda|recordatorio|tarea|web|busca|abrir|readfile|mkfile|selfupdate|selfrestart|shell)\b/.test(
    normalized,
  );
}

function hasActiveStoicSmalltalkSession(chatId: number): boolean {
  const session = stoicSmalltalkByChat.get(chatId);
  if (!session) {
    return false;
  }
  if (Date.now() > session.expiresAtMs || session.turnsRemaining <= 0) {
    stoicSmalltalkByChat.delete(chatId);
    return false;
  }
  return true;
}

function shouldContinueStoicSmalltalk(chatId: number, text: string): boolean {
  if (!hasActiveStoicSmalltalkSession(chatId)) {
    return false;
  }
  if (isLikelyOperationalInstruction(text)) {
    stoicSmalltalkByChat.delete(chatId);
    return false;
  }
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return false;
  }
  const shortFollowUp = normalized.split(/\s+/).length <= 18;
  const conversationalCue = /\?|^\b(y|ok|dale|sigue|segui|contame|dime|decime|mas|más|por que|porque|como|cómo|y eso)\b/.test(
    normalized,
  );
  const assistantReferenceFollowup =
    hasAssistantReferenceCue(normalized) &&
    /\b(cuenta|conta|contame|dime|decime|mas|más|explica|amplia|amplía)\b/.test(normalized);
  return shortFollowUp || conversationalCue || assistantReferenceFollowup;
}

async function buildStoicSmalltalkReply(chatId: number, userText: string): Promise<string> {
  const activity = lastTaskActivityByChat.get(chatId);
  const hasRecentActivity = Boolean(activity && Date.now() - activity.atMs <= TASK_ACTIVITY_TTL_MS);
  if (hasRecentActivity) {
    return [
      "Estoy enfocado en una tarea concreta ahora mismo.",
      `Contexto: ${activity?.text ?? "procesando"}`,
      "Como diría un estoico: primero el deber, luego el resto.",
    ].join("\n");
  }

  const previous = stoicSmalltalkByChat.get(chatId);
  const referencedAssistant = hasAssistantReferenceCue(normalizeIntentText(userText))
    ? resolveAssistantReplyByReference(chatId, userText)
    : null;
  if (openAi.isConfigured()) {
    try {
      const prompt = [
        "Responde en español con tono estoico, cálido y concreto.",
        "Debe sonar conversacional y natural, no como cita académica.",
        "Extensión máxima: 4 líneas.",
        "Incluye una idea accionable.",
        referencedAssistant?.text ? `Respuesta referenciada por el usuario: ${referencedAssistant.text}` : "",
        previous?.lastReplyText ? `Respuesta previa del asistente: ${previous.lastReplyText}` : "",
        `Mensaje actual del usuario: ${userText}`,
      ]
        .filter(Boolean)
        .join("\n");
      const promptContext = await buildPromptContextForQuery(userText, { chatId });
      const answer = await askOpenAiForChat({ chatId, prompt, context: promptContext });
      if (answer.trim()) {
        return truncateInline(answer.trim(), 800);
      }
    } catch {
      // fallback below
    }
  }

  const variants = [
    "Ahora mismo practico algo simple: foco en lo que puedo controlar y calma frente a lo demás.",
    "Ando en modo estoico: menos ruido, más criterio, un paso útil a la vez.",
    "Algo bonito: el obstáculo no frena el camino, a veces lo revela.",
    "Hoy me quedo con esta: no gobiernas el viento, pero sí tu forma de remar.",
    "Pienso en esto: la serenidad no es pasividad, es disciplina con dirección.",
  ];
  return variants[Math.floor(Math.random() * variants.length)] ?? variants[0]!;
}

async function maybeHandleNaturalStoicSmalltalk(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const explicit = detectStoicSmalltalkIntent(params.text);
  const followUp = shouldContinueStoicSmalltalk(params.ctx.chat.id, params.text);
  if (!explicit && !followUp) {
    return false;
  }
  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }
  const responseText = await buildStoicSmalltalkReply(params.ctx.chat.id, params.text);
  const prev = stoicSmalltalkByChat.get(params.ctx.chat.id);
  stoicSmalltalkByChat.set(params.ctx.chat.id, {
    expiresAtMs: Date.now() + STOIC_SMALLTALK_TTL_MS,
    turnsRemaining: Math.max(0, (prev?.turnsRemaining ?? STOIC_SMALLTALK_MAX_TURNS) - 1),
    lastUserText: truncateInline(params.text, 400),
    lastReplyText: truncateInline(responseText, 700),
  });
  await params.ctx.reply(responseText);
  await appendConversationTurn({
    chatId: params.ctx.chat.id,
    userId: params.userId,
    role: "assistant",
    text: responseText,
    source: `${params.source}:stoic-smalltalk`,
  });
  return true;
}

async function maybeHandleNaturalIndexedListReference(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const listContext = getIndexedListContext(params.ctx.chat.id);
  if (!listContext) {
    return false;
  }
  const intent = parseIndexedListReferenceIntent(params.text);
  if (!intent.shouldHandle || !intent.action) {
    return false;
  }

  const selectedIndexesRaw = intent.selectAll
    ? listContext.items.map((item) => item.index)
    : intent.indexes;
  const selectedIndexSet = new Set<number>(selectedIndexesRaw);
  if (intent.selectLast && listContext.items.length >= 1) {
    selectedIndexSet.add(listContext.items.length);
  }
  if (intent.selectPenultimate && listContext.items.length >= 2) {
    selectedIndexSet.add(listContext.items.length - 1);
  }
  const selectedIndexes = Array.from(selectedIndexSet)
    .sort((a, b) => a - b)
    .filter((index) => index >= 1 && index <= listContext.items.length)
    .slice(0, INDEXED_LIST_ACTION_MAX_ITEMS);
  if (selectedIndexes.length === 0) {
    await params.ctx.reply(`No pude mapear índices válidos para esa lista. Rango disponible: 1..${listContext.items.length}.`);
    return true;
  }
  const selectedItems = selectedIndexes
    .map((index) => listContext.items[index - 1])
    .filter((item): item is IndexedListItem => Boolean(item));

  if (params.persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId: params.userId,
      role: "user",
      text: params.text,
      source: params.source,
    });
  }

  try {
    if (listContext.kind === "web-results") {
      if (intent.action === "delete") {
        const before = lastWebResultsByChat.get(params.ctx.chat.id) ?? [];
        const removeSet = new Set(selectedIndexes);
        const kept = before.filter((_, index) => !removeSet.has(index + 1));
        lastWebResultsByChat.set(params.ctx.chat.id, kept);
        rememberWebResultsListContext({
          chatId: params.ctx.chat.id,
          title: listContext.title,
          hits: kept,
          source: `${params.source}:list-ref`,
        });
        const responseText = `Quité ${before.length - kept.length} resultado(s) de la lista web actual. Quedan ${kept.length}.`;
        await params.ctx.reply(responseText);
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: responseText,
          source: `${params.source}:list-ref`,
        });
        return true;
      }

      const blocks: string[] = [];
      for (const item of selectedItems) {
        await replyProgress(params.ctx, `${intent.action === "read" ? "Leyendo" : "Abriendo"} resultado ${item.index}...`);
        try {
          const page = await webBrowser.open(item.reference);
          const snippet = truncateInline(page.text, intent.action === "read" ? 1800 : 900);
          blocks.push(
            [
              `${item.index}. ${page.title || item.label}`,
              `URL: ${page.finalUrl}`,
              snippet || "(sin contenido textual útil)",
            ].join("\n"),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          blocks.push(`${item.index}. No pude abrir ${item.reference}: ${message}`);
        }
      }
      const responseText = [`Resultados ${intent.action === "read" ? "leídos" : "abiertos"}:`, ...blocks].join("\n\n");
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 2600),
        source: `${params.source}:list-ref`,
      });
      return true;
    }

    if (listContext.kind === "gmail-list") {
      const accessIssue = getGmailAccessIssue(params.ctx);
      if (accessIssue) {
        await params.ctx.reply(accessIssue);
        return true;
      }

      if (intent.action === "delete") {
        const trashed: string[] = [];
        for (const item of selectedItems) {
          await gmailAccount.trashMessage(item.reference);
          trashed.push(item.reference);
        }
        const responseText = [
          `Moví ${trashed.length} correo(s) a papelera.`,
          ...trashed.map((id, index) => `${index + 1}. ${id}`),
        ].join("\n");
        await replyLong(params.ctx, responseText);
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: truncateInline(responseText, 2600),
          source: `${params.source}:list-ref`,
        });
        return true;
      }

      const blocks: string[] = [];
      for (const item of selectedItems) {
        const detail = await gmailAccount.readMessage(item.reference);
        rememberGmailMessage(params.ctx.chat.id, detail.id);
        blocks.push(
          [
            `${item.index}. ${detail.subject || "(sin asunto)"}`,
            `From: ${detail.from || "-"}`,
            `Date: ${detail.date || "-"}`,
            detail.bodyText || detail.snippet || "(sin cuerpo legible)",
          ].join("\n"),
        );
      }
      const responseText = blocks.join("\n\n---\n\n");
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 3000),
        source: `${params.source}:list-ref`,
      });
      return true;
    }

    if (listContext.kind === "stored-files" || listContext.kind === "workspace-list") {
      if (intent.action === "delete") {
        pendingWorkspaceDeletePathByChat.delete(params.ctx.chat.id);
        const pending = queueWorkspaceDeleteConfirmation({
          chatId: params.ctx.chat.id,
          paths: selectedItems.map((item) => item.reference),
          source: `${params.source}:list-ref`,
          userId: params.userId,
        });
        const responseText = [
          "Confirmación requerida para eliminar en workspace.",
          `lista: ${listContext.title}`,
          `rutas: ${pending.paths.length}`,
          `expira en: ${pendingWorkspaceDeleteRemainingSeconds(pending)}s`,
          ...formatWorkspacePathPreview(pending.paths, 8),
          'Responde "si" para confirmar o "no" para cancelar.',
        ].join("\n");
        await replyLong(params.ctx, responseText);
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "assistant",
          text: truncateInline(responseText, 2600),
          source: `${params.source}:list-ref`,
        });
        return true;
      }

      const blocks: string[] = [];
      for (const item of selectedItems) {
        if ((item.itemType ?? "file") === "dir") {
          const listed = await listWorkspaceDirectory(item.reference);
          const listPreview = listed.entries.length === 0 ? "(carpeta vacía)" : formatWorkspaceEntries(listed.entries).slice(0, 12).join("\n");
          blocks.push([`${item.index}. ${listed.relPath}`, listPreview].join("\n"));
          continue;
        }
        if (intent.action === "open") {
          await sendWorkspaceFileToChat({
            ctx: params.ctx,
            source: `${params.source}:list-ref`,
            userId: params.userId,
            reference: item.reference,
          });
          blocks.push(`${item.index}. Archivo enviado: workspace/${normalizeWorkspaceRelativePath(item.reference)}`);
          continue;
        }
        try {
          const read = await documentReader.readDocument(item.reference);
          rememberLastDocumentSnapshot(params.ctx.chat.id, read.path, read.text);
          blocks.push(
            [
              `${item.index}. ${read.path}`,
              `formato: ${read.format}`,
              truncateInline(read.text || "(sin contenido textual útil)", 1800),
            ].join("\n"),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          blocks.push(`${item.index}. No pude leer ${item.reference}: ${message}`);
        }
      }
      const responseText = blocks.join("\n\n---\n\n");
      await replyLong(params.ctx, responseText);
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "assistant",
        text: truncateInline(responseText, 2600),
        source: `${params.source}:list-ref`,
      });
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`No pude operar esa referencia de lista: ${message}`);
    return true;
  }

  return false;
}

async function maybeHandleNaturalIntentPipeline(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn: boolean;
}): Promise<boolean> {
  const hasPendingWorkspaceDeleteConfirmation = (chatId: number): boolean => {
    const now = Date.now();
    const pendingDelete = pendingWorkspaceDeleteByChat.get(chatId);
    if (pendingDelete && pendingDelete.expiresAtMs > now) {
      return true;
    }
    const pendingDeletePath = pendingWorkspaceDeletePathByChat.get(chatId);
    if (pendingDeletePath && pendingDeletePath.expiresAtMs > now) {
      return true;
    }
    return false;
  };

  const chained = splitChainedInstructions(params.text);
  if (chained.length >= 2) {
    if (params.persistUserTurn) {
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId: params.userId,
        role: "user",
        text: params.text,
        source: params.source,
      });
    }
    await params.ctx.reply(`Ejecutando flujo encadenado (${chained.length} pasos)...`);
    const stepSummary: Array<{ index: number; text: string; handled: boolean }> = [];
    let pausedByConfirmation = false;
    let pausedAtStep = 0;
    for (let index = 0; index < chained.length; index += 1) {
      const stepText = chained[index] ?? "";
      await params.ctx.reply(`Paso ${index + 1}/${chained.length}: ${truncateInline(stepText, 120)}`);
      const handled = await maybeHandleNaturalIntentPipeline({
        ...params,
        text: stepText,
        source: `${params.source}:chain-${index + 1}`,
        persistUserTurn: false,
      });
      if (!handled) {
        await params.ctx.reply(`No pude interpretar el paso ${index + 1}: "${stepText}"`);
      }
      stepSummary.push({
        index: index + 1,
        text: truncateInline(stepText, 120),
        handled,
      });
      if (hasPendingWorkspaceDeleteConfirmation(params.ctx.chat.id)) {
        pausedByConfirmation = true;
        pausedAtStep = index + 1;
        await params.ctx.reply(
          `Flujo en pausa en paso ${pausedAtStep}/${chained.length}: necesito tu confirmación ("si" o "no") antes de continuar.`,
        );
        break;
      }
    }
    const okCount = stepSummary.filter((item) => item.handled).length;
    const failedCount = stepSummary.length - okCount;
    const lines = stepSummary.map(
      (item) => `${item.index}. ${item.handled ? "OK" : "NO"} | ${item.text}`,
    );
    await replyLong(
      params.ctx,
      [
        "Resumen de flujo encadenado",
        `pasos: ${chained.length} | procesados: ${stepSummary.length} | ok: ${okCount} | no interpretados: ${failedCount}${pausedByConfirmation ? ` | pausado en paso ${pausedAtStep}` : ""}`,
        ...lines,
      ].join("\n"),
    );
    return true;
  }

  if (!params.source.includes(":seq-step-") && !params.source.includes(":chain-")) {
    const sequencedPlan = await classifySequencedIntentPlanWithAi({
      chatId: params.ctx.chat.id,
      text: params.text,
    });
    if (sequencedPlan && sequencedPlan.steps.length >= 2) {
      if (params.persistUserTurn) {
        await appendConversationTurn({
          chatId: params.ctx.chat.id,
          userId: params.userId,
          role: "user",
          text: params.text,
          source: params.source,
        });
      }
      await params.ctx.reply(`Ejecutando plan secuenciado (${sequencedPlan.steps.length} pasos)...`);
      const stepSummary: Array<{ index: number; text: string; handled: boolean }> = [];
      let pausedByConfirmation = false;
      let pausedAtStep = 0;
      for (let index = 0; index < sequencedPlan.steps.length; index += 1) {
        const step = sequencedPlan.steps[index]!;
        const aiContent = step.aiContentPrompt
          ? await generateSequenceStepContentWithAi({
              chatId: params.ctx.chat.id,
              userText: params.text,
              stepInstruction: step.instruction,
              contentPrompt: step.aiContentPrompt,
            })
          : null;
        const stepText = materializeSequenceStepInstruction(step, aiContent);
        await params.ctx.reply(`Paso ${index + 1}/${sequencedPlan.steps.length}: ${truncateInline(step.instruction, 140)}`);
        const handled = await maybeHandleNaturalIntentPipeline({
          ...params,
          text: stepText,
          source: `${params.source}:seq-step-${index + 1}`,
          persistUserTurn: false,
        });
        if (!handled) {
          await params.ctx.reply(`No pude interpretar el paso ${index + 1}: "${truncateInline(step.instruction, 200)}"`);
        }
        stepSummary.push({
          index: index + 1,
          text: truncateInline(step.instruction, 120),
          handled,
        });
        if (hasPendingWorkspaceDeleteConfirmation(params.ctx.chat.id)) {
          pausedByConfirmation = true;
          pausedAtStep = index + 1;
          await params.ctx.reply(
            `Plan en pausa en paso ${pausedAtStep}/${sequencedPlan.steps.length}: necesito tu confirmación ("si" o "no") antes de continuar.`,
          );
          break;
        }
      }
      const okCount = stepSummary.filter((item) => item.handled).length;
      const failedCount = stepSummary.length - okCount;
      await safeAudit({
        type: "intent.plan.sequence",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          steps: sequencedPlan.steps.length,
          processed: stepSummary.length,
          processedOk: okCount,
          failed: failedCount,
          pausedByConfirmation,
          pausedAtStep: pausedAtStep > 0 ? pausedAtStep : null,
          ...(sequencedPlan.reason ? { reason: sequencedPlan.reason } : {}),
          textPreview: truncateInline(params.text, 220),
        },
      });
      const lines = stepSummary.map((item) => `${item.index}. ${item.handled ? "OK" : "NO"} | ${item.text}`);
      await replyLong(
        params.ctx,
        [
          "Resumen de plan secuenciado",
          `pasos: ${sequencedPlan.steps.length} | procesados: ${stepSummary.length} | ok: ${okCount} | no interpretados: ${failedCount}${pausedByConfirmation ? ` | pausado en paso ${pausedAtStep}` : ""}`,
          ...lines,
        ].join("\n"),
      );
      return true;
    }
  }

  const normalized = normalizeIntentText(params.text);
  const hasMailContext = /\b(correo|correos|mail|mails|email|emails|gmail|inbox|bandeja)\b/.test(normalized);
  const hasMemoryRecallCue =
    /\b(te\s+acordas|te\s+acuerdas|te\s+recordas|te\s+recuerdas|recordas|recuerdas|memoria|memory|habiamos\s+hablado|hablamos)\b/.test(
      normalized,
    );

  const baseHandlers: Array<{
    name: Exclude<NaturalIntentHandlerName, "none">;
    fn: (params: {
      ctx: ChatReplyContext;
      text: string;
      source: string;
      userId?: number;
      persistUserTurn: boolean;
    }) => Promise<boolean>;
  }> = [
    { name: "stoic-smalltalk", fn: maybeHandleNaturalStoicSmalltalk },
    { name: "self-maintenance", fn: maybeHandleNaturalSelfMaintenanceInstruction },
    { name: "connector", fn: maybeHandleNaturalConnectorInstruction },
    { name: "schedule", fn: maybeHandleNaturalScheduleInstruction },
    { name: "memory", fn: maybeHandleNaturalMemoryInstruction },
    { name: "gmail-recipients", fn: maybeHandleNaturalGmailRecipientsInstruction },
    { name: "gmail", fn: maybeHandleNaturalGmailInstruction },
    { name: "workspace", fn: maybeHandleNaturalWorkspaceInstruction },
    { name: "document", fn: maybeHandleNaturalDocumentInstruction },
    { name: "web", fn: maybeHandleNaturalWebInstruction },
  ];

  const handlers =
    hasMailContext && !hasMemoryRecallCue
      ? [
          baseHandlers[0]!,
          baseHandlers[1]!,
          baseHandlers[2]!,
          baseHandlers[3]!,
          baseHandlers[4]!,
          baseHandlers[5]!,
          baseHandlers[6]!,
          baseHandlers[7]!,
          baseHandlers[8]!,
          baseHandlers[9]!,
        ]
      : baseHandlers;

  let routedHandlers = handlers;
  let semanticRouteDecision: SemanticRouteDecision | null = null;
  let aiRouteDecision: { handler: NaturalIntentHandlerName; reason?: string } | null = null;
  let semanticCalibratedConfidence: number | null = null;
  let semanticGap: number | null = null;
  let routerAbVariant: "A" | "B" = "A";
  let routerCanaryVersion: string | null = null;
  let routerLayerDecision: RouteLayerDecision | null = null;
  let ensembleTop: Array<{ name: Exclude<NaturalIntentHandlerName, "none">; score: number }> = [];
  const routeCandidates = handlers.map((item) => item.name as Exclude<NaturalIntentHandlerName, "none">);
  const indexedListContext = getIndexedListContext(params.ctx.chat.id);
  routerLayerDecision = applyIntentRouteLayers(routeCandidates, {
    normalizedText: normalized,
    hasMailContext,
    hasMemoryRecallCue,
    indexedListKind: indexedListContext?.kind ?? null,
    hasPendingWorkspaceDelete: hasPendingWorkspaceDeleteConfirmation(params.ctx.chat.id),
  });
  const layerAllowedCandidates = routerLayerDecision
    ? narrowRouteCandidates(
        routeCandidates,
        routerLayerDecision.allowed as Exclude<NaturalIntentHandlerName, "none">[],
      )
    : routeCandidates;
  const routeFilterDecision = buildIntentRouterContextFilter({
    chatId: params.ctx.chat.id,
    text: params.text,
    candidates: layerAllowedCandidates,
    hasMailContext,
    hasMemoryRecallCue,
  });
  const semanticAllowedCandidates = routeFilterDecision
    ? (routeFilterDecision.allowed as Exclude<NaturalIntentHandlerName, "none">[])
    : layerAllowedCandidates;
  const routeScoreBoosts = buildIntentRouterScoreBoosts({
    chatId: params.ctx.chat.id,
    text: params.text,
    hasMailContext,
    hasMemoryRecallCue,
  });
  const chatScopedRouter = buildIntentRouterForChat(params.ctx.chat.id);
  routerAbVariant = chatScopedRouter.abVariant;
  routerCanaryVersion = chatScopedRouter.canaryVersionId;

  semanticRouteDecision = chatScopedRouter.router.route(params.text, {
    allowed: semanticAllowedCandidates as IntentRouteName[],
    boosts: routeScoreBoosts,
    topK: 3,
  });
  if (semanticRouteDecision) {
    const second = semanticRouteDecision.alternatives[1];
    semanticGap = second ? semanticRouteDecision.score - second.score : null;
    semanticCalibratedConfidence = intentConfidenceCalibrator.calibrate(
      semanticRouteDecision.handler,
      semanticRouteDecision.score,
    );
  }

  if (shouldRunAiJudgeForEnsemble(semanticRouteDecision)) {
    aiRouteDecision = await classifyNaturalIntentRouteWithAi({
      chatId: params.ctx.chat.id,
      text: params.text,
      candidates: semanticAllowedCandidates,
    });
  }

  if (semanticRouteDecision) {
    await safeAudit({
      type: "intent.router.semantic",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        selected: semanticRouteDecision.handler,
        score: semanticRouteDecision.score,
        calibratedConfidence: semanticCalibratedConfidence,
        gap: semanticGap,
        reason: semanticRouteDecision.reason,
        alternatives: semanticRouteDecision.alternatives,
        boosts: routeScoreBoosts,
        routerAbVariant,
        routerCanaryVersion,
        alpha: chatScopedRouter.effectiveAlpha,
        minGap: chatScopedRouter.effectiveMinGap,
        textPreview: truncateInline(params.text, 220),
      },
    });
  }
  if (aiRouteDecision && aiRouteDecision.handler !== "none") {
    await safeAudit({
      type: "intent.router.ai",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        selected: aiRouteDecision.handler,
        ...(aiRouteDecision.reason ? { reason: aiRouteDecision.reason } : {}),
        routerAbVariant,
        routerCanaryVersion,
        textPreview: truncateInline(params.text, 220),
      },
    });
  }

  const ranked = rankIntentCandidatesWithEnsemble({
    candidates: semanticAllowedCandidates,
    semanticAlternatives: semanticRouteDecision?.alternatives,
    aiSelected: aiRouteDecision?.handler && aiRouteDecision.handler !== "none" ? aiRouteDecision.handler : null,
    layerAllowed: routerLayerDecision?.allowed ?? routeCandidates,
    contextualBoosts: routeScoreBoosts,
    calibratedConfidence: semanticCalibratedConfidence,
  });
  ensembleTop = ranked
    .map((item) => ({
      name: item.name as Exclude<NaturalIntentHandlerName, "none">,
      score: item.score,
    }))
    .slice(0, 5);
  if (ensembleTop.length > 0) {
    const orderedByEnsemble = ensembleTop
      .map((item) => handlers.find((handler) => handler.name === item.name))
      .filter((handler): handler is (typeof handlers)[number] => Boolean(handler));
    if (orderedByEnsemble.length > 0) {
      const used = new Set(orderedByEnsemble.map((item) => item.name));
      routedHandlers = [...orderedByEnsemble, ...handlers.filter((item) => !used.has(item.name))];
    }
  }

  if (
    semanticRouteDecision &&
    typeof semanticCalibratedConfidence === "number" &&
    semanticCalibratedConfidence < 0.5 &&
    typeof semanticGap === "number" &&
    semanticGap < 0.07
  ) {
    await params.ctx.reply(buildIntentClarificationQuestion(semanticRouteDecision.alternatives));
    await appendIntentRouterDatasetEntry({
      ts: new Date().toISOString(),
      chatId: params.ctx.chat.id,
      ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
      source: params.source,
      text: truncateInline(params.text.trim(), 500),
      hasMailContext,
      hasMemoryRecallCue,
      routeCandidates,
      ...(routeFilterDecision
        ? { routeFilterReason: routeFilterDecision.reason, routeFilterAllowed: routeFilterDecision.allowed }
        : {}),
      ...(semanticRouteDecision
        ? {
            semantic: {
              handler: semanticRouteDecision.handler,
              score: semanticRouteDecision.score,
              reason: semanticRouteDecision.reason,
              alternatives: semanticRouteDecision.alternatives as Array<{
                name: Exclude<NaturalIntentHandlerName, "none">;
                score: number;
              }>,
            },
          }
        : {}),
      ...(aiRouteDecision ? { ai: aiRouteDecision } : {}),
      semanticCalibratedConfidence,
      semanticGap,
      routerAbVariant,
      ...(routerCanaryVersion ? { routerCanaryVersion } : {}),
      ...(routerLayerDecision ? { routerLayers: routerLayerDecision.layers, routerLayerReason: routerLayerDecision.reason } : {}),
      routerEnsembleTop: ensembleTop,
      finalHandler: "none",
      handled: true,
    });
    return true;
  }

  for (const handler of routedHandlers) {
    const handled = await handler.fn(params);
    if (handled) {
      await safeAudit({
        type: "intent.route",
        chatId: params.ctx.chat.id,
        userId: params.userId,
        details: {
          source: params.source,
          handler: handler.name,
          mailContext: hasMailContext,
          memoryRecallCue: hasMemoryRecallCue,
          routeCandidates,
          routeFilterReason: routeFilterDecision?.reason ?? routerLayerDecision?.reason ?? null,
          routeFilterAllowed: routeFilterDecision?.allowed ?? null,
          routeLayers: routerLayerDecision?.layers ?? null,
          semanticRouterSelected: semanticRouteDecision?.handler ?? null,
          semanticRouterScore: semanticRouteDecision?.score ?? null,
          semanticCalibratedConfidence,
          semanticGap,
          routerAbVariant,
          routerCanaryVersion,
          ensembleTop,
          aiRouterSelected: aiRouteDecision?.handler ?? null,
          textPreview: truncateInline(params.text, 220),
        },
      });
      await appendIntentRouterDatasetEntry({
        ts: new Date().toISOString(),
        chatId: params.ctx.chat.id,
        ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
        source: params.source,
        text: truncateInline(params.text.trim(), 500),
        hasMailContext,
        hasMemoryRecallCue,
        routeCandidates,
        ...(routeFilterDecision
          ? { routeFilterReason: routeFilterDecision.reason, routeFilterAllowed: routeFilterDecision.allowed }
          : routerLayerDecision
            ? { routeFilterReason: routerLayerDecision.reason, routeFilterAllowed: routerLayerDecision.allowed }
            : {}),
        ...(semanticRouteDecision
          ? {
              semantic: {
                handler: semanticRouteDecision.handler,
                score: semanticRouteDecision.score,
                reason: semanticRouteDecision.reason,
                alternatives: semanticRouteDecision.alternatives as Array<{
                  name: Exclude<NaturalIntentHandlerName, "none">;
                  score: number;
                }>,
              },
            }
        : {}),
        ...(aiRouteDecision ? { ai: aiRouteDecision } : {}),
        semanticCalibratedConfidence: semanticCalibratedConfidence ?? undefined,
        semanticGap: semanticGap ?? undefined,
        routerAbVariant,
        ...(routerCanaryVersion ? { routerCanaryVersion } : {}),
        ...(routerLayerDecision ? { routerLayers: routerLayerDecision.layers, routerLayerReason: routerLayerDecision.reason } : {}),
        routerEnsembleTop: ensembleTop,
        finalHandler: handler.name,
        handled: true,
      });
      return true;
    }
  }
  const handledByListReference = await maybeHandleNaturalIndexedListReference(params);
  if (handledByListReference) {
    await safeAudit({
      type: "intent.route",
      chatId: params.ctx.chat.id,
      userId: params.userId,
      details: {
        source: params.source,
        handler: "indexed-list-reference",
        mailContext: hasMailContext,
        memoryRecallCue: hasMemoryRecallCue,
        routeCandidates,
        routeFilterReason: routeFilterDecision?.reason ?? routerLayerDecision?.reason ?? null,
        routeFilterAllowed: routeFilterDecision?.allowed ?? null,
        routeLayers: routerLayerDecision?.layers ?? null,
        routerAbVariant,
        routerCanaryVersion,
        ensembleTop,
        textPreview: truncateInline(params.text, 220),
      },
    });
    await appendIntentRouterDatasetEntry({
      ts: new Date().toISOString(),
      chatId: params.ctx.chat.id,
      ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
      source: params.source,
      text: truncateInline(params.text.trim(), 500),
      hasMailContext,
      hasMemoryRecallCue,
      routeCandidates,
      ...(routeFilterDecision
        ? { routeFilterReason: routeFilterDecision.reason, routeFilterAllowed: routeFilterDecision.allowed }
        : routerLayerDecision
          ? { routeFilterReason: routerLayerDecision.reason, routeFilterAllowed: routerLayerDecision.allowed }
          : {}),
      ...(semanticRouteDecision
        ? {
            semantic: {
              handler: semanticRouteDecision.handler,
              score: semanticRouteDecision.score,
              reason: semanticRouteDecision.reason,
              alternatives: semanticRouteDecision.alternatives as Array<{
                name: Exclude<NaturalIntentHandlerName, "none">;
                score: number;
              }>,
            },
          }
        : {}),
      ...(aiRouteDecision ? { ai: aiRouteDecision } : {}),
      semanticCalibratedConfidence: semanticCalibratedConfidence ?? undefined,
      semanticGap: semanticGap ?? undefined,
      routerAbVariant,
      ...(routerCanaryVersion ? { routerCanaryVersion } : {}),
      ...(routerLayerDecision ? { routerLayers: routerLayerDecision.layers, routerLayerReason: routerLayerDecision.reason } : {}),
      routerEnsembleTop: ensembleTop,
      finalHandler: "indexed-list-reference",
      handled: true,
    });
    return true;
  }
  await appendIntentRouterDatasetEntry({
    ts: new Date().toISOString(),
    chatId: params.ctx.chat.id,
    ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
    source: params.source,
    text: truncateInline(params.text.trim(), 500),
    hasMailContext,
    hasMemoryRecallCue,
    routeCandidates,
    ...(routeFilterDecision
      ? { routeFilterReason: routeFilterDecision.reason, routeFilterAllowed: routeFilterDecision.allowed }
      : routerLayerDecision
        ? { routeFilterReason: routerLayerDecision.reason, routeFilterAllowed: routerLayerDecision.allowed }
        : {}),
    ...(semanticRouteDecision
      ? {
          semantic: {
            handler: semanticRouteDecision.handler,
            score: semanticRouteDecision.score,
            reason: semanticRouteDecision.reason,
            alternatives: semanticRouteDecision.alternatives as Array<{
              name: Exclude<NaturalIntentHandlerName, "none">;
              score: number;
            }>,
          },
        }
      : {}),
    ...(aiRouteDecision ? { ai: aiRouteDecision } : {}),
    semanticCalibratedConfidence: semanticCalibratedConfidence ?? undefined,
    semanticGap: semanticGap ?? undefined,
    routerAbVariant,
    ...(routerCanaryVersion ? { routerCanaryVersion } : {}),
    ...(routerLayerDecision ? { routerLayers: routerLayerDecision.layers, routerLayerReason: routerLayerDecision.reason } : {}),
    routerEnsembleTop: ensembleTop,
    finalHandler: "none",
    handled: false,
  });
  return false;
}

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
  const ecoMode = isEcoModeEnabled(chatId) ? "on" : "off";
  const safeMode = isSafeModeEnabled(chatId) ? "on" : "off";
  const adminMode = isAdminApprovalRequired(chatId) ? "on" : "off";
  const panicMode = adminSecurity.isPanicModeEnabled() ? "on" : "off";
  await ctx.reply(
    [
      buildAgentVersionText(),
      "Houdi Agent activo.",
      `Agente actual: ${active}`,
      `Shell IA: ${shellMode}`,
      `ECO mode: ${ecoMode}`,
      `SAFE mode: ${safeMode}`,
      `Admin mode: ${adminMode}`,
      `Perfil seguridad: ${config.securityProfile.name}`,
      `Panic mode: ${panicMode}`,
      "Usa /help para ver comandos.",
    ].join("\n"),
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "Comandos:",
      "/version - Ver versión del agente",
      "/model [show|list|set <modelo>|reset] - Ver/cambiar modelo OpenAI para este chat",
      "/status - Estado del host y tareas en ejecución",
      "/doctor - Diagnóstico operativo rápido del agente",
      "/usage [topN|reset] - Métricas de tokens/costo OpenAI desde el arranque",
      "/domains - Estado de dominios modulares cargados",
      "/policy - Política agéntica activa (preview/approval/safe blocks)",
      "/agenticcanary [status|<0-100>] - Rollout runtime de controles agénticos",
      "/agent - Ver agente activo y lista",
      "/agent set <nombre> - Cambiar agente activo para este chat",
      "/ask <pregunta> - Consultar IA de OpenAI",
      "/readfile <ruta> - Extraer texto de PDF/documentos de oficina",
      "/askfile <ruta> <pregunta> - Consultar IA sobre archivo local",
      "/mkfile <ruta> [contenido] - Crear archivo de texto simple en workspace",
      "/files [limit] - Listar archivos guardados en workspace",
      "/getfile <ruta|n> - Enviar archivo del workspace al chat",
      "/images [limit] - Listar imágenes guardadas para este chat",
      "/workspace ... - Operar archivos/carpetas en workspace (list, mkdir, mv, rename, rm, send)",
      "/web <consulta> - Buscar en la web",
      '/lim first_name:<nombre> last_name:<apellido> fuente:<origen> [count:3] - Consultar LIM',
      "/crypto [consulta] [limit] - Precios crypto con CoinGecko",
      "/weather [ubicación] - Clima actual y próximos días (Open-Meteo)",
      "/reddit <consulta> [limit] - Buscar posts en Reddit (API)",
      "/webopen <n|url> [pregunta] - Abrir resultado web y opcionalmente analizarlo",
      "/webask <consulta> - Buscar + sintetizar respuesta con fuentes",
      "/agenda ... - Crear/listar/editar/eliminar tareas programadas",
      "/gmail ... - Consultar/operar tu cuenta Gmail conectada",
      "/remember <nota> - Guardar nota en memoria diaria",
      "/memory - Estado de memoria",
      "/memory search <texto> - Buscar en memoria",
      "/memory view <path> [from] [lines] - Ver fragmento de memoria",
      "/interests [status|add|del|clear|suggest] - Gestion de intereses de noticias",
      "/suggest now|status - Forzar sugerencia o ver cuota/config",
      "/selfskill <instrucción> - Agregar habilidad persistente en AGENTS.md",
      "/selfskill list - Ver habilidades agregadas",
      "/selfskill del <n|last> - Eliminar habilidad agregada",
      "/selfskill draft <start|add|show|apply|cancel> - Armar skill en varios mensajes",
      "/selfrestart - Reiniciar servicio del agente",
      "/selfupdate [check] - Actualizar a la última versión del repositorio",
      "/eco on|off|status - Modo ahorro de tokens (respuestas más compactas)",
      "/safe on|off|status - Modo determinista para interpretar órdenes precisas",
      "/intentstats [n] - Métricas de enrutamiento y sugerencias de threshold",
      "/intentfit [n] [iter] - Ajusta thresholds del router semántico con dataset",
      "/intentreload - Recarga configuración de rutas semánticas desde archivo",
      "/intentroutes - Ver rutas/thresholds y parámetros del router semántico",
      "/intentcalibrate [n] - Reentrena calibración de confianza por bins",
      "/intentcurate [n] [apply] - Sugiere/promueve utterances desde errores",
      "/intentab - Estado de experimento A/B del router",
      "/intentversion [list|save [label]|rollback <id>] - Versionado/rollback de rutas",
      "/intentcanary [status|set <id> <pct>|off] - Canary rollout de versión de router",
      "Enviar nota de voz/audio - Se transcribe y se responde con IA",
      "Enviar archivo (document) - Se guarda en workspace/files/...",
      "Enviar imagen/foto - Se guarda en workspace/images/... y puede analizarse con IA",
      "/shell <instrucción> - IA propone y ejecuta comando shell",
      "/shellmode on|off - Habilitar shell IA en chat libre",
      "/exec <cmd> [args] - Ejecutar comando permitido por el agente",
      "/reboot - Solicitar reinicio de PC (si está habilitado)",
      "/adminmode on|off - Requerir aprobación antes de ejecutar",
      "/approvals - Ver aprobaciones pendientes",
      "/approve <id> - Aprobar ejecución pendiente",
      "/deny <id> - Rechazar ejecución pendiente",
      "/confirm <plan_id> - Confirmar plan preview sensible",
      "/cancelplan <plan_id> - Cancelar plan preview sensible",
      "/outbox [status|flush|recover] - Estado/reintento de respuestas pendientes",
      "/metrics [reset] - Snapshot de observabilidad (counters/timings/colas)",
      "/panic on|off|status - Bloqueo global de ejecución",
      "/tasks - Ver tareas activas",
      "/kill <taskId> - Terminar tarea activa",
      "",
      "Chat libre: escribe un mensaje normal (sin /) y responde OpenAI.",
      "Si mencionas un archivo (.pdf/.docx/.xlsx/etc) y pides leer/analizar, lo procesa automáticamente.",
      "Si pides recordatorios o tareas con fecha/hora, los agenda y dispara automáticamente.",
      "Si pides listar/leer/enviar correos o consultar estado/perfil Gmail, lo hace en lenguaje natural.",
      "Si habilitas integración de LIM, puede operar estado/iniciar/detener/reiniciar app+tunnel en lenguaje natural.",
      "Si pides buscar en web/internet o compartes una URL para analizar, navega sin comandos.",
      "Si preguntas 'te acordás/recordás de ...', consulta memoria en lenguaje natural.",
      "Si pides listar/crear/mover/copiar/pegar/renombrar/eliminar/enviar archivos o carpetas en workspace, lo opera en lenguaje natural.",
      'También entiende selectores por nombre: "empiezan con", "contienen" o "se llaman".',
      "Tambien puedes crear archivos simples (.txt/.csv/.json/.md/etc) con lenguaje natural.",
      "Si pides agregar una habilidad o reiniciar el agente, también puede hacerlo en lenguaje natural.",
      "Tambien puede armar una habilidad en varios mensajes con borrador natural y sugerir contenido proactivamente segun recurrencia (con cuota diaria).",
      "Si shellmode=on, el chat libre puede proponer comandos para ejecutar.",
      "Con adminmode=on, toda ejecución requiere /approve.",
    ].join("\n"),
  );
});

bot.command("version", async (ctx) => {
  await ctx.reply(buildAgentVersionText());
});

bot.command("model", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  const [subRaw, ...rest] = input.split(/\s+/).filter(Boolean);
  const sub = (subRaw ?? "show").toLowerCase();
  const value = rest.join(" ").trim();

  if (!input || ["show", "status"].includes(sub)) {
    const current = getOpenAiModelForChat(ctx.chat.id);
    const isDefault = !openAiModelByChat.has(ctx.chat.id);
    await ctx.reply(
      [
        `Modelo OpenAI actual (chat): ${current}`,
        `Modelo OpenAI default (.env): ${config.openAiModel}`,
        `Origen: ${isDefault ? "default" : "override por chat"}`,
        buildOpenAiModelListText(),
        "Uso: /model list | /model set <modelo> | /model reset",
      ].join("\n"),
    );
    return;
  }

  if (["list", "models"].includes(sub)) {
    await ctx.reply(buildOpenAiModelListText());
    return;
  }

  if (["set", "use"].includes(sub)) {
    if (!value) {
      await ctx.reply("Uso: /model set <modelo>\nEjemplo: /model set gpt-4o-mini");
      return;
    }
    try {
      setOpenAiModelForChat(ctx.chat.id, value);
      await ctx.reply(
        `Modelo OpenAI actualizado para este chat: ${getOpenAiModelForChat(ctx.chat.id)}\n(override runtime, no modifica .env)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude actualizar el modelo: ${message}`);
    }
    return;
  }

  if (["reset", "clear", "default"].includes(sub)) {
    resetOpenAiModelForChat(ctx.chat.id);
    await ctx.reply(`Modelo OpenAI reseteado al default: ${config.openAiModel}`);
    return;
  }

  await ctx.reply("Uso: /model [show|list|set <modelo>|reset]");
});

bot.command("status", async (ctx) => {
  const runningCount = taskRunner.listRunning().length;
  const usedMemMb = Math.round((os.totalmem() - os.freemem()) / (1024 * 1024));
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  const pendingCount = adminSecurity.listApprovals(ctx.chat.id).length;
  const pendingOutboxCount = sqliteState.listOutboxMessages(ctx.chat.id, 500).length;
  const deadLetterOutboxCount = sqliteState.listOutboxDeadLetter(ctx.chat.id, 200).length;
  const queueDepthChat = incomingMessageQueue.getDepth(ctx.chat.id);
  const queueActiveChats = incomingMessageQueue.snapshot(200).length;
  const activeProfile = agentRegistry.require(getActiveAgent(ctx.chat.id));
  let memoryStatusLine = "Memoria: n/d";
  try {
    const memoryStatus = await contextMemory.getStatus();
    memoryStatusLine = [
      `Memoria: diarios=${memoryStatus.memoryFilesCount}`,
      `long-term=${memoryStatus.longTermMemoryExists ? "sí" : "no"}`,
      `today=${memoryStatus.todayMemoryFile}`,
      `backend=${memoryStatus.backendLastUsed} (pref=${memoryStatus.backendPreferred})`,
      `fallbacks=${memoryStatus.backendFallbackCount}`,
    ].join(" | ");
  } catch {
    memoryStatusLine = "Memoria: error al leer estado";
  }
  const gmailStatus = gmailAccount.getStatus();
  const gmailSummary = !gmailStatus.enabled
    ? "off"
    : gmailStatus.configured
      ? `on (${gmailStatus.accountEmail || "cuenta no indicada"})`
      : `on (incompleto: ${gmailStatus.missing.join(", ")})`;
  const imageStorePath = toProjectRelativePath(path.join(config.workspaceDir, "images", `chat-${ctx.chat.id}`));
  const scheduledPendingCount = scheduledTasks.listPending(ctx.chat.id).length;
  const selfSkillDraft = selfSkillDrafts.getDraft(ctx.chat.id);
  const interestSummary = interestLearning.getSummary(ctx.chat.id, config.suggestionsMaxPerDay);
  const suggestionStatusLine = interestSummary
    ? `Sugerencias: obs=${interestSummary.observations} | hoy=${interestSummary.suggestionsToday}/${interestSummary.suggestionsMaxPerDay} | top=${interestSummary.topCategories[0]?.category ? interestCategoryLabel(interestSummary.topCategories[0].category) : "n/d"}`
    : `Sugerencias: sin perfil aun (min obs=${config.suggestionsMinObservations})`;
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
      `Version: ${config.agentVersion}`,
      `Host: ${os.hostname()}`,
      `OS: ${os.platform()} ${os.release()}`,
      `Uptime: ${Math.round(os.uptime() / 60)} min`,
      `CPU load (1/5/15): ${os.loadavg().map((n) => n.toFixed(2)).join(" / ")}`,
      `Memoria: ${usedMemMb}MB / ${totalMemMb}MB`,
      `Tareas activas: ${runningCount}`,
      `Agente actual: ${getActiveAgent(ctx.chat.id)}`,
      `Shell IA: ${isAiShellModeEnabled(ctx.chat.id) ? "on" : "off"}`,
      `ECO mode: ${isEcoModeEnabled(ctx.chat.id) ? `on (max ${config.openAiEcoMaxOutputTokens} tok)` : "off"}`,
      `SAFE mode: ${isSafeModeEnabled(ctx.chat.id) ? "on" : "off"}`,
      `Agentic canary: ${agenticCanary.getRolloutPercent()}% (chat=${isAgenticCanaryEnabled(ctx.chat.id) ? "on" : "off"})`,
      `Admin mode: ${isAdminApprovalRequired(ctx.chat.id) ? "on" : "off"}`,
      `Perfil seguridad: ${config.securityProfile.name}`,
      `Panic mode: ${adminSecurity.isPanicModeEnabled() ? "on" : "off"}`,
      `Reboot command: ${config.enableRebootCommand ? "habilitado" : "deshabilitado"} (${rebootAllowedInAgent ? "permitido en agente actual" : "no permitido en agente actual"})`,
      `Aprobaciones pendientes (chat): ${pendingCount}`,
      `Outbox pendiente (chat): ${pendingOutboxCount} | dead-letter recientes: ${deadLetterOutboxCount}`,
      `Incoming queue: depth(chat)=${queueDepthChat} | chats activos=${queueActiveChats}`,
      `OpenAI: ${openAi.isConfigured() ? `configurado (chat=${getOpenAiModelForChat(ctx.chat.id)} | default=${openAi.getModel()})` : "no configurado"}`,
      `OpenAI audio model: ${openAi.isConfigured() ? config.openAiAudioModel : "n/d"}`,
      ...buildOpenAiUsageLines(3),
      `Intent router: routes=${semanticIntentRouter.listRoutes().length} | alpha=${semanticIntentRouter.getHybridAlpha().toFixed(2)} | minGap=${semanticIntentRouter.getMinScoreGap().toFixed(3)} | file=${toProjectRelativePath(config.intentRouterRoutesFile)}`,
      `Intent router versions: file=${toProjectRelativePath(config.intentRouterVersionsFile)} | snapshots=${routerVersionStore.listSnapshots().length} | active=${routerVersionStore.getActiveSnapshot()?.id ?? "n/a"}`,
      `Intent router chat-routes: chats=${dynamicIntentRoutes.listChatIds().length} | file=${toProjectRelativePath(config.intentRouterChatRoutesFile)}`,
      `Intent router calibration: file=${toProjectRelativePath(config.intentRouterCalibrationFile)} | ab=${config.intentRouterAbEnabled ? `on (split=${config.intentRouterAbSplitPercent}%)` : "off"}`,
      `Domains: ${domainRegistry.list().length}`,
      `Intent router cache: ${JSON.stringify(semanticIntentRouter.getDecisionCacheStats())}`,
      `Lector docs: maxFile=${Math.round(config.docMaxFileBytes / (1024 * 1024))}MB | maxText=${config.docMaxTextChars} chars`,
      `Web browse: ${config.enableWebBrowse ? `on (max results ${config.webSearchMaxResults})` : "off"}`,
      `Gmail account: ${gmailSummary}`,
      `LIM control: ${config.enableLimControl ? `on | appDir=${toProjectRelativePath(config.limAppDir)} | appUnit=${config.limAppService} | tunnelUnit=${config.limTunnelService}` : "off"}`,
      `Archivos inbound: maxFile=${Math.round(config.fileMaxFileBytes / (1024 * 1024))}MB | store=${toProjectRelativePath(path.join(config.workspaceDir, "files", `chat-${ctx.chat.id}`))}`,
      `Imagenes: maxFile=${Math.round(config.imageMaxFileBytes / (1024 * 1024))}MB | store=${imageStorePath}`,
      `Agenda: pending=${scheduledPendingCount} | poll=${config.schedulePollMs}ms | file=${config.scheduleFile}`,
      `State DB: ${toProjectRelativePath(config.stateDbFile)} | idempotencyTTL=${config.idempotencyTtlMs}ms | runtimePersist=${RUNTIME_STATE_PERSIST_INTERVAL_MS}ms`,
      `Selfskill draft: ${selfSkillDraft ? `activo (${selfSkillDraft.lines.length} lineas)` : "off"} | file=${config.selfSkillDraftsFile}`,
      `${suggestionStatusLine} | enabled=${config.suggestionsEnabled ? "on" : "off"} | poll=${config.suggestionsPollMs}ms`,
      `Workspace: ${config.workspaceDir}`,
      memoryStatusLine,
    ].join("\n"),
  );
});

bot.command("doctor", async (ctx) => {
  try {
    const report = await runDoctor({
      openAiConfigured: openAi.isConfigured(),
      gmail: gmailAccount.getStatus(),
      botToken: config.telegramBotToken,
    });
    await replyLong(ctx, formatDoctorReport(report));
    await safeAudit({
      type: "doctor.run",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        ok: report.ok,
        warn: report.warn,
        fail: report.fail,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude ejecutar doctor: ${message}`);
  }
});

bot.command("usage", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  const normalized = input.toLowerCase();
  if (normalized === "reset") {
    openAi.resetUsageSnapshot();
    await ctx.reply("Métricas OpenAI reiniciadas para este proceso.");
    return;
  }

  const parsed = input ? Number.parseInt(input, 10) : NaN;
  const topN = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20) : 8;
  const snapshot = openAi.getUsageSnapshot();
  const lines = [
    ...buildOpenAiUsageLines(topN),
    "",
    ...snapshot.byModelAndSource.slice(0, topN).map((item, index) => {
      return `${index + 1}. ${item.model}/${item.source} | calls=${item.calls} | in=${item.inputTokens} | out=${item.outputTokens} | total=${item.totalTokens} | estUSD=${formatUsageUsd(item.estimatedCostUsd)}`;
    }),
  ];
  await replyLong(ctx, lines.join("\n"));
});

bot.command("metrics", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();
  if (raw === "reset") {
    observability.reset();
    await ctx.reply("Observability reset ejecutado para este proceso.");
    await safeAudit({
      type: "metrics.reset",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
    });
    return;
  }

  const text = buildObservabilityReport();
  await replyLong(ctx, text);
  await safeAudit({
    type: "metrics.snapshot",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      raw,
    },
  });
});

bot.command("domains", async (ctx) => {
  await replyLong(ctx, domainRegistry.formatSummary());
});

bot.command("intentstats", async (ctx) => {
  const rawLimit = String(ctx.match ?? "").trim();
  const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : NaN;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20_000) : 2_000;
  try {
    const report = await buildIntentRouterStatsReport(limit);
    await replyLong(ctx, report);
    await safeAudit({
      type: "intent.router.stats",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        limit,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude generar intent stats: ${message}`);
  }
});

bot.command("intentroutes", async (ctx) => {
  try {
    const routes = semanticIntentRouter.listRoutes();
    const chatRoutes = dynamicIntentRoutes.getRoutesForChat(ctx.chat.id);
    const effective = dynamicIntentRoutes.buildEffectiveRoutes(ctx.chat.id, routes);
    const lines = [
      "Intent router routes",
      `file: ${toProjectRelativePath(config.intentRouterRoutesFile)}`,
      `versions: ${toProjectRelativePath(config.intentRouterVersionsFile)}`,
      `chat-routes: ${toProjectRelativePath(config.intentRouterChatRoutesFile)}`,
      `alpha: ${semanticIntentRouter.getHybridAlpha().toFixed(3)}`,
      `minGap: ${semanticIntentRouter.getMinScoreGap().toFixed(3)}`,
      `routes_global: ${routes.length}`,
      `routes_chat_override: ${chatRoutes ? chatRoutes.length : 0}`,
      `routes_effective_chat: ${effective.length}`,
      "",
      ...effective.map(
        (route) =>
          `- ${route.name} | threshold=${route.threshold.toFixed(3)} | utterances=${route.utterances.length} | negatives=${route.negativeUtterances?.length ?? 0}`,
      ),
    ];
    await replyLong(ctx, lines.join("\n"));
    await safeAudit({
      type: "intent.router.routes",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        routes: routes.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude listar intent routes: ${message}`);
  }
});

bot.command("intentreload", async (ctx) => {
  try {
    await semanticIntentRouter.loadFromFile(config.intentRouterRoutesFile, {
      createIfMissing: true,
    });
    try {
      await dynamicIntentRoutes.loadFromFile(config.intentRouterChatRoutesFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/enoent/i.test(message)) {
        logWarn(`No pude recargar chat-routes: ${message}`);
      }
    }
    try {
      await intentConfidenceCalibrator.loadFromFile(config.intentRouterCalibrationFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/enoent/i.test(message)) {
        logWarn(`No pude recargar calibración: ${message}`);
      }
    }
    try {
      await routerVersionStore.load(config.intentRouterVersionsFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/enoent/i.test(message)) {
        logWarn(`No pude recargar versiones de router: ${message}`);
      }
    }
    semanticIntentRouter.clearDecisionCache();
    const routes = semanticIntentRouter.listRoutes();
    await ctx.reply(
      [
        "Intent router recargado.",
        `file: ${toProjectRelativePath(config.intentRouterRoutesFile)}`,
        `versions: ${toProjectRelativePath(config.intentRouterVersionsFile)}`,
        `chat-routes: ${toProjectRelativePath(config.intentRouterChatRoutesFile)}`,
        `calibration: ${toProjectRelativePath(config.intentRouterCalibrationFile)}`,
        `alpha: ${semanticIntentRouter.getHybridAlpha().toFixed(3)}`,
        `minGap: ${semanticIntentRouter.getMinScoreGap().toFixed(3)}`,
        `routes: ${routes.length}`,
        `chat_overrides: ${dynamicIntentRoutes.listChatIds().length}`,
      ].join("\n"),
    );
    await safeAudit({
      type: "intent.router.reload",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        routes: routes.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude recargar intent routes: ${message}`);
  }
});

bot.command("intentfit", async (ctx) => {
  const raw = String(ctx.match ?? "").trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const parsedLimit = tokens[0] ? Number.parseInt(tokens[0], 10) : NaN;
  const parsedIter = tokens[1] ? Number.parseInt(tokens[1], 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 20_000) : 2_000;
  const maxIter = Number.isFinite(parsedIter) && parsedIter > 0 ? Math.min(parsedIter, 5_000) : 700;
  try {
    const routeNames = new Set(semanticIntentRouter.listRoutes().map((route) => route.name));
    const rows = await intentRouterStatsRepository.read(limit);
    const labeled = rows
      .filter((entry) => routeNames.has(entry.finalHandler as IntentRouteName))
      .map((entry) => ({
        text: entry.text,
        finalHandler: entry.finalHandler,
      }));
    if (labeled.length < 25) {
      await ctx.reply(
        [
          "No hay suficientes muestras etiquetadas para /intentfit.",
          `muestras útiles: ${labeled.length} (mínimo recomendado: 25)`,
          `limit consultado: ${limit}`,
        ].join("\n"),
      );
      return;
    }

    const fitResult: FitResult = semanticIntentRouter.fitThresholdsFromDataset(labeled, {
      maxIter,
    });
    const negativesAdded = semanticIntentRouter.augmentNegativesFromDataset(labeled, 20);
    await semanticIntentRouter.saveToFile(config.intentRouterRoutesFile);
    const versionId = await saveCurrentRouterSnapshot(`fit-${new Date().toISOString()}`);

    const changedRoutes = Object.keys(fitResult.afterThresholds)
      .filter((name) => fitResult.beforeThresholds[name] !== fitResult.afterThresholds[name])
      .sort((a, b) => a.localeCompare(b));
    const thresholdLines =
      changedRoutes.length === 0
        ? ["thresholds: sin cambios"]
        : changedRoutes.map(
            (name) =>
              `- ${name}: ${fitResult.beforeThresholds[name].toFixed(3)} -> ${fitResult.afterThresholds[name].toFixed(3)}`,
          );

    await replyLong(
      ctx,
      [
        "Intent router fit completado.",
        `file: ${toProjectRelativePath(config.intentRouterRoutesFile)}`,
        `muestras etiquetadas: ${fitResult.totalLabeled}`,
        `iteraciones: ${maxIter}`,
        `accuracy before: ${(fitResult.beforeAccuracy * 100).toFixed(2)}%`,
        `accuracy after: ${(fitResult.afterAccuracy * 100).toFixed(2)}%`,
        `improved: ${fitResult.improved ? "sí" : "no"}`,
        `negatives_added: ${Object.keys(negativesAdded).length === 0 ? "0" : JSON.stringify(negativesAdded)}`,
        `version_id: ${versionId}`,
        ...thresholdLines,
      ].join("\n"),
    );
    await safeAudit({
      type: "intent.router.fit",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        limit,
        maxIter,
        totalLabeled: fitResult.totalLabeled,
        beforeAccuracy: Number(fitResult.beforeAccuracy.toFixed(4)),
        afterAccuracy: Number(fitResult.afterAccuracy.toFixed(4)),
        improved: fitResult.improved,
        negativesAdded,
        versionId,
        changedRoutes,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude ejecutar intent fit: ${message}`);
  }
});

bot.command("intentcalibrate", async (ctx) => {
  const raw = String(ctx.match ?? "").trim();
  const parsedLimit = raw ? Number.parseInt(raw, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 20_000) : 4_000;
  try {
    const rows = await intentRouterStatsRepository.read(limit);
    const samples = rows
      .filter((row) => row.semantic && row.finalHandler && row.finalHandler !== "none")
      .map((row) => ({
        predictedRoute: row.semantic!.handler,
        score: row.semantic!.score,
        finalRoute: row.finalHandler,
      }));
    if (samples.length < 40) {
      await ctx.reply(
        [
          "No hay suficientes muestras para calibrar.",
          `muestras útiles: ${samples.length} (mínimo recomendado: 40)`,
        ].join("\n"),
      );
      return;
    }
    intentConfidenceCalibrator.fit(samples);
    await intentConfidenceCalibrator.saveToFile(config.intentRouterCalibrationFile);
    await ctx.reply(
      [
        "Calibración de confianza actualizada.",
        `muestras: ${samples.length}`,
        `file: ${toProjectRelativePath(config.intentRouterCalibrationFile)}`,
      ].join("\n"),
    );
    await safeAudit({
      type: "intent.router.calibrate",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        limit,
        samples: samples.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude calibrar intent router: ${message}`);
  }
});

bot.command("intentcurate", async (ctx) => {
  const raw = String(ctx.match ?? "").trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const parsedLimit = tokens[0] ? Number.parseInt(tokens[0], 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 20_000) : 4_000;
  const applyMode = tokens.some((token) => ["apply", "aplicar", "yes", "si", "sí"].includes(token.toLowerCase()));
  try {
    const rows = await intentRouterStatsRepository.read(limit);
    const routeNames = new Set(semanticIntentRouter.listRoutes().map((item) => item.name));
    const suggestions = buildCurationSuggestions(rows, routeNames, 3);
    if (suggestions.length === 0) {
      await ctx.reply("No encontré sugerencias de curación con ese dataset.");
      return;
    }
    if (applyMode) {
      let addedTotal = 0;
      const baseRoutes = semanticIntentRouter.listRoutes();
      for (const suggestion of suggestions) {
        addedTotal += dynamicIntentRoutes.appendUtterances(
          ctx.chat.id,
          suggestion.route as IntentRouteName,
          suggestion.utterances,
          baseRoutes,
        );
      }
      await dynamicIntentRoutes.saveToFile(config.intentRouterChatRoutesFile);
      await ctx.reply(
        [
          "Curación aplicada en rutas dinámicas del chat.",
          `chat: ${ctx.chat.id}`,
          `utterances agregadas: ${addedTotal}`,
          `file: ${toProjectRelativePath(config.intentRouterChatRoutesFile)}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "intent.router.curation.apply",
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        details: {
          limit,
          suggestions: suggestions.length,
          addedTotal,
        },
      });
      return;
    }

    const lines = suggestions.slice(0, 10).flatMap((item) => [
      `- ${item.route} | evidencia=${item.evidence}`,
      ...item.utterances.map((utterance) => `  - ${utterance}`),
    ]);
    await replyLong(
      ctx,
      [
        "Sugerencias de curación (human-in-the-loop)",
        `muestras analizadas: ${rows.length}`,
        "Para aplicar al chat actual: /intentcurate 4000 apply",
        "",
        ...lines,
      ].join("\n"),
    );
    await safeAudit({
      type: "intent.router.curation.suggest",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        limit,
        suggestions: suggestions.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude generar curación: ${message}`);
  }
});

bot.command("intentab", async (ctx) => {
  const variant = resolveIntentRouterAbVariant(ctx.chat.id, {
    enabled: config.intentRouterAbEnabled,
    splitPercent: config.intentRouterAbSplitPercent,
    variantBAlpha: config.intentRouterAbVariantBAlpha,
    variantBMinGap: config.intentRouterAbVariantBMinGap,
    variantBThresholdShift: config.intentRouterAbVariantBThresholdShift,
  });
  await ctx.reply(
    [
      "Intent router A/B",
      `enabled: ${config.intentRouterAbEnabled ? "sí" : "no"}`,
      `chat_id: ${ctx.chat.id}`,
      `assigned_variant: ${variant}`,
      `split_percent(B): ${config.intentRouterAbSplitPercent}%`,
      `variant_B_alpha: ${config.intentRouterAbVariantBAlpha.toFixed(3)}`,
      `variant_B_min_gap: ${config.intentRouterAbVariantBMinGap.toFixed(3)}`,
      `variant_B_threshold_shift: ${config.intentRouterAbVariantBThresholdShift.toFixed(3)}`,
    ].join("\n"),
  );
});

bot.command("intentversion", async (ctx) => {
  const raw = String(ctx.match ?? "").trim();
  const [subRaw, ...rest] = raw.split(/\s+/).filter(Boolean);
  const sub = (subRaw ?? "list").toLowerCase();

  if (!raw || sub === "list" || sub === "status") {
    const snapshots = routerVersionStore.listSnapshots().slice(0, 12);
    const active = routerVersionStore.getActiveSnapshot()?.id ?? "n/a";
    const canary = routerVersionStore.getCanaryStatus();
    const lines = [
      "Intent router versions",
      `file: ${toProjectRelativePath(config.intentRouterVersionsFile)}`,
      `active: ${active}`,
      `canary: ${canary.enabled ? `on (${canary.versionId ?? "n/a"} @ ${canary.splitPercent}%)` : "off"}`,
      `snapshots: ${snapshots.length}`,
      "",
      ...snapshots.map((item) => `- ${item.id} | ${item.createdAt} | ${item.label} | routes=${item.routes.length}`),
    ];
    await replyLong(ctx, lines.join("\n"));
    return;
  }

  if (sub === "save") {
    const label = rest.join(" ").trim() || `manual-${new Date().toISOString()}`;
    const versionId = await saveCurrentRouterSnapshot(label);
    await ctx.reply(`Snapshot guardado.\nid: ${versionId}\nlabel: ${label}`);
    return;
  }

  if (sub === "rollback") {
    const versionId = rest[0]?.trim() ?? "";
    if (!versionId) {
      await ctx.reply("Uso: /intentversion rollback <version_id>");
      return;
    }
    const ok = await applyRouterSnapshotById(versionId);
    if (!ok) {
      await ctx.reply(`No encontré versión: ${versionId}`);
      return;
    }
    await ctx.reply(`Rollback aplicado a ${versionId}.`);
    await safeAudit({
      type: "intent.router.rollback",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: { versionId },
    });
    return;
  }

  await ctx.reply("Uso: /intentversion [list|save [label]|rollback <id>]");
});

bot.command("intentcanary", async (ctx) => {
  const raw = String(ctx.match ?? "").trim();
  const [subRaw, vRaw, pctRaw] = raw.split(/\s+/).filter(Boolean);
  const sub = (subRaw ?? "status").toLowerCase();

  if (!raw || sub === "status") {
    const canary = routerVersionStore.getCanaryStatus();
    await ctx.reply(
      [
        "Intent router canary",
        `enabled: ${canary.enabled ? "sí" : "no"}`,
        `version: ${canary.versionId ?? "n/a"}`,
        `split: ${canary.splitPercent}%`,
      ].join("\n"),
    );
    return;
  }

  if (sub === "off" || sub === "disable") {
    routerVersionStore.disableCanary();
    await routerVersionStore.save(config.intentRouterVersionsFile);
    await ctx.reply("Canary desactivado.");
    return;
  }

  if (sub === "set") {
    const versionId = (vRaw ?? "").trim();
    const parsedPct = Number.parseInt(pctRaw ?? "", 10);
    const splitPercent = Number.isFinite(parsedPct) ? Math.max(1, Math.min(100, parsedPct)) : NaN;
    if (!versionId || !Number.isFinite(splitPercent)) {
      await ctx.reply("Uso: /intentcanary set <version_id> <split_percent>");
      return;
    }
    const ok = routerVersionStore.setCanary(versionId, splitPercent);
    if (!ok) {
      await ctx.reply(`No encontré versión: ${versionId}`);
      return;
    }
    await routerVersionStore.save(config.intentRouterVersionsFile);
    await ctx.reply(`Canary activado.\nversion: ${versionId}\nsplit: ${splitPercent}%`);
    await safeAudit({
      type: "intent.router.canary",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        versionId,
        splitPercent,
      },
    });
    return;
  }

  await ctx.reply("Uso: /intentcanary [status|set <id> <pct>|off]");
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

bot.command("agenda", async (ctx) => {
  const input = String(ctx.match ?? "").trim();

  const listPendingTasks = async () => {
    const pending = scheduledTasks.listPending(ctx.chat.id);
    if (pending.length === 0) {
      await ctx.reply("No hay tareas programadas pendientes.");
      return;
    }
    await replyLong(
      ctx,
      [
        `Tareas pendientes (${pending.length}):`,
        ...formatScheduleTaskLines(pending),
      ].join("\n\n"),
    );
  };

  if (!input || input.toLowerCase() === "list" || input.toLowerCase() === "status") {
    await listPendingTasks();
    return;
  }

  const [subRaw, ...restTokens] = input.split(/\s+/);
  const sub = (subRaw ?? "").trim().toLowerCase();
  const restRaw = restTokens.join(" ").trim();

  const usage = [
    "Uso:",
    "/agenda",
    "/agenda list",
    "/agenda add <cuando> | <detalle>",
    "/agenda del <n|id|last>",
    "/agenda edit <n|id> | <nuevo cuando> | <nuevo detalle opcional>",
  ].join("\n");

  if (sub === "add") {
    const [whenRaw = "", detailRaw = ""] = restRaw.split("|", 2).map((part) => part.trim());
    const parseTarget = whenRaw || restRaw;
    const parsed = parseNaturalScheduleDateTime(parseTarget, new Date());
    const dueAt = parsed.dueAt;
    const detail = sanitizeScheduleTitle(detailRaw || extractTaskTitleForCreate(restRaw));

    if (!dueAt) {
      await ctx.reply(`No pude inferir fecha/hora.\n\n${usage}`);
      return;
    }
    if (dueAt.getTime() <= Date.now() + 10_000) {
      await ctx.reply("La fecha/hora debe ser futura.");
      return;
    }
    if (!detail) {
      await ctx.reply("Falta detalle de la tarea. Ejemplo: /agenda add mañana 10:30 | llamar a Juan");
      return;
    }

    const created = await scheduledTasks.createTask({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      title: detail,
      dueAt,
    });
    await ctx.reply(
      [
        "Tarea programada.",
        `id: ${created.id}`,
        `cuando: ${formatScheduleDateTime(new Date(created.dueAt))}`,
        `detalle: ${created.title}`,
      ].join("\n"),
    );
    return;
  }

  if (["del", "delete", "remove", "rm", "cancel"].includes(sub)) {
    const ref = restRaw.trim();
    if (!ref) {
      await ctx.reply(`Falta referencia de tarea.\n\n${usage}`);
      return;
    }
    const task = scheduledTasks.resolveTaskByRef(ctx.chat.id, ref);
    if (!task) {
      await ctx.reply("No encontré esa tarea pendiente.");
      return;
    }
    const canceled = await scheduledTasks.cancelTask(task.id);
    await ctx.reply([`Tarea eliminada.`, `id: ${canceled.id}`, `detalle: ${canceled.title}`].join("\n"));
    return;
  }

  if (sub === "edit") {
    const ref = restTokens[0]?.trim() ?? "";
    if (!ref) {
      await ctx.reply(`Falta referencia de tarea.\n\n${usage}`);
      return;
    }

    const target = scheduledTasks.resolveTaskByRef(ctx.chat.id, ref);
    if (!target) {
      await ctx.reply("No encontré esa tarea pendiente.");
      return;
    }

    const afterRef = restRaw.slice(ref.length).trim();
    const segments = afterRef.split("|").map((part) => part.trim()).filter(Boolean);
    let dueAt: Date | undefined;
    let detail = "";

    if (segments.length > 0) {
      const parsed = parseNaturalScheduleDateTime(segments[0] ?? "", new Date());
      if (parsed.dueAt) {
        dueAt = parsed.dueAt;
      } else {
        detail = sanitizeScheduleTitle(segments[0] ?? "");
      }
      if (segments[1]) {
        detail = sanitizeScheduleTitle(segments[1]);
      }
    } else if (afterRef) {
      const parsed = parseNaturalScheduleDateTime(afterRef, new Date());
      if (parsed.dueAt) {
        dueAt = parsed.dueAt;
      }
      const extracted = sanitizeScheduleTitle(extractTaskTitleForEdit(afterRef));
      if (extracted) {
        detail = extracted;
      }
    }

    const changes: { dueAt?: Date; title?: string } = {};
    if (dueAt) {
      if (dueAt.getTime() <= Date.now() + 10_000) {
        await ctx.reply("La nueva fecha/hora debe ser futura.");
        return;
      }
      changes.dueAt = dueAt;
    }
    if (detail) {
      changes.title = detail;
    }

    if (!changes.dueAt && !changes.title) {
      await ctx.reply(`No detecté cambios.\n\n${usage}`);
      return;
    }

    const updated = await scheduledTasks.updateTask(target.id, changes);
    await ctx.reply(
      [
        "Tarea actualizada.",
        `id: ${updated.id}`,
        `cuando: ${formatScheduleDateTime(new Date(updated.dueAt))}`,
        `detalle: ${updated.title}`,
      ].join("\n"),
    );
    return;
  }

  await ctx.reply(usage);
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
  const capability = "exec" as const;
  const blockReason = getPolicyCapabilityBlockReason(ctx.chat.id, capability);
  if (blockReason) {
    await ctx.reply(blockReason);
    return;
  }

  const profile = agentRegistry.require(getActiveAgent(ctx.chat.id));

  if (
    await maybeRequirePlannedConfirmation({
      ctx,
      kind: "exec",
      capability,
      summary: [`Comando: ${input}`, `Agente: ${profile.name}`].join("\n"),
      payload: {
        commandLine: input,
        profileName: profile.name,
      },
      source: "telegram:/exec",
      userId: ctx.from?.id,
    })
  ) {
    return;
  }

  if (policyEngine.isApprovalRequired(capability) || isAdminApprovalRequired(ctx.chat.id)) {
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
  const blockReason = getPolicyCapabilityBlockReason(ctx.chat.id, "reboot");
  if (blockReason) {
    await ctx.reply(blockReason);
    return;
  }
  const raw = String(ctx.match ?? "").trim().toLowerCase();

  if (raw === "status") {
    await ctx.reply(
      [
        `Reboot command: ${config.enableRebootCommand ? "habilitado" : "deshabilitado"}`,
        `Comando configurado: ${config.rebootCommand}`,
        `Admin mode (chat): ${isAdminApprovalRequired(ctx.chat.id) ? "on" : "off"}`,
        `Perfil seguridad: ${config.securityProfile.name}`,
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
  if (!config.securityProfile.allowReboot) {
    await ctx.reply(
      `El perfil de seguridad actual (${config.securityProfile.name}) bloquea reboot. Usa HOUDI_SECURITY_PROFILE=full-control para habilitarlo.`,
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

  const handledAsNaturalIntent = await maybeHandleNaturalIntentPipeline({
    ctx,
    text: question,
    source: "telegram:/ask",
    userId: ctx.from?.id,
    persistUserTurn: true,
  });
  if (handledAsNaturalIntent) {
    return;
  }

  if (!openAi.isConfigured()) {
    await ctx.reply(
      "OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.",
    );
    return;
  }

  await replyProgress(ctx, `Consultando OpenAI (${getOpenAiModelForChat(ctx.chat.id)})...`);

  try {
    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: question,
      source: "telegram:/ask",
    });
    const promptContext = await buildPromptContextForQuery(question, {
      chatId: ctx.chat.id,
    });
    const answer = await askOpenAiForChat({ chatId: ctx.chat.id, prompt: question, context: promptContext });
    await replyLong(ctx, answer);
    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "assistant",
      text: answer,
      source: "telegram:/ask",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Error al consultar OpenAI: ${message}`);
  }
});

bot.command("readfile", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  const parsed = parsePathArgument(input);
  if (!parsed || !parsed.path) {
    await ctx.reply(
      'Uso: /readfile <ruta> [previewChars]\nSi la ruta tiene espacios: /readfile "Mi Archivo.pdf"',
    );
    return;
  }

  let previewChars = 3500;
  if (parsed.rest) {
    const parsedPreview = Number.parseInt(parsed.rest, 10);
    if (!Number.isFinite(parsedPreview) || parsedPreview <= 0) {
      await ctx.reply(
        'Uso: /readfile <ruta> [previewChars]\nEjemplo: /readfile "reporte mensual.xlsx" 2500',
      );
      return;
    }
    previewChars = Math.min(12000, Math.max(500, Math.floor(parsedPreview)));
  }

  await replyProgress(ctx, `Leyendo archivo: ${parsed.path}`);

  try {
    const result = await documentReader.readDocument(parsed.path);
    rememberLastDocumentSnapshot(ctx.chat.id, result.path, result.text);
    const preview = truncateInline(result.text, previewChars);
    await replyLong(
      ctx,
      [
        `Archivo: ${result.path}`,
        `Formato: ${result.format}`,
        `Extractor: ${result.extractor}`,
        `Tamaño: ${formatBytes(result.fileSize)}`,
        `Texto extraído: ${result.extractedChars} chars${result.truncated ? " (truncado por límite)" : ""}`,
        "",
        preview || "(No se pudo extraer texto útil del archivo)",
      ].join("\n"),
    );

    await safeAudit({
      type: "doc.read",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: result.path,
        format: result.format,
        extractor: result.extractor,
        fileSize: result.fileSize,
        extractedChars: result.extractedChars,
        truncated: result.truncated,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude leer el archivo: ${message}`);
    await safeAudit({
      type: "doc.read_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: parsed.path,
        error: message,
      },
    });
  }
});

bot.command("workspace", async (ctx) => {
  const usage = [
    "Uso:",
    "/workspace",
    "/workspace list [ruta]",
    "/workspace mkdir <ruta>",
    "/workspace touch <ruta> [contenido]",
    "/workspace write <ruta> <contenido>",
    "/workspace mv <origen> <destino>",
    "/workspace rename <origen> <destino>",
    "/workspace copy <origen> [destino]",
    "/workspace paste <destino>",
    "/workspace rm <ruta>",
    "/workspace send <ruta|n>",
  ].join("\n");

  const actor = getActor(ctx);
  const input = String(ctx.match ?? "").trim();
  let tokens: string[] = [];
  try {
    tokens = parseQuotedArgs(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`${message}\n\n${usage}`);
    return;
  }

  const listAndReply = async (targetPath?: string) => {
    const listed = await listWorkspaceDirectory(targetPath);
    rememberWorkspaceListContext({
      chatId: actor.chatId,
      relPath: listed.relPath,
      entries: listed.entries,
      source: "telegram:/workspace",
    });
    const responseText =
      listed.entries.length === 0
        ? `Carpeta vacia: ${listed.relPath}`
        : [
            `Contenido de ${listed.relPath} (${listed.entries.length}):`,
            ...formatWorkspaceEntries(listed.entries),
          ].join("\n");
    await replyLong(ctx, responseText);
    await safeAudit({
      type: "workspace.command_list",
      chatId: actor.chatId,
      userId: actor.userId,
      details: {
        path: listed.relPath,
        count: listed.entries.length,
      },
    });
  };

  if (tokens.length === 0) {
    try {
      await listAndReply();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude listar workspace: ${message}`);
    }
    return;
  }

  const subcommand = (tokens.shift() ?? "").toLowerCase();

  try {
    if (["list", "ls", "status"].includes(subcommand)) {
      const targetPath = tokens.join(" ").trim();
      await listAndReply(targetPath || undefined);
      return;
    }

    if (["mkdir", "mk", "md", "dir"].includes(subcommand)) {
      const targetPath = tokens.join(" ").trim();
      if (!targetPath) {
        await ctx.reply(`${usage}\n\nSi la ruta tiene espacios, usa comillas.`);
        return;
      }
      const created = await createWorkspaceDirectory(targetPath);
      await ctx.reply(`Carpeta creada: ${created.relPath}`);
      await safeAudit({
        type: "workspace.command_mkdir",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          path: created.relPath,
        },
      });
      return;
    }

    if (["touch", "mkfile", "newfile", "create-file", "write"].includes(subcommand)) {
      if (tokens.length < 1) {
        await ctx.reply(`${usage}\n\nIndica la ruta de archivo a crear en workspace.`);
        return;
      }
      const targetPath = tokens.shift()?.trim() ?? "";
      const content = decodeEscapedInlineText(tokens.join(" "));
      const written = await writeWorkspaceTextFile({
        relativePath: targetPath,
        ...(content ? { content } : {}),
        ...(subcommand === "write" ? { overwrite: true } : {}),
      });
      await ctx.reply(
        [
          written.created ? "Archivo creado en workspace." : "Archivo actualizado en workspace.",
          `ruta: ${written.relPath}`,
          `tamano: ${formatBytes(written.size)}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "workspace.command_write",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          action: subcommand,
          path: written.relPath,
          size: written.size,
          created: written.created,
          contentChars: content.length,
        },
      });
      return;
    }

    if (["mv", "move", "rename", "ren"].includes(subcommand)) {
      if (tokens.length < 2) {
        await ctx.reply(`${usage}\n\nSi una ruta tiene espacios, usa comillas.`);
        return;
      }
      if (tokens.length > 2) {
        await ctx.reply("Demasiados argumentos para mv/rename. Usa comillas para rutas con espacios.");
        return;
      }
      const sourcePath = tokens[0] ?? "";
      const targetPath = tokens[1] ?? "";
      const moved = await moveWorkspacePath(sourcePath, targetPath);
      const isRename = ["rename", "ren"].includes(subcommand);
      await ctx.reply(
        [
          isRename ? "Renombrado." : "Movido.",
          `origen: ${moved.from}`,
          `destino: ${moved.to}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "workspace.command_move",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          action: isRename ? "rename" : "move",
          from: moved.from,
          to: moved.to,
        },
      });
      return;
    }

    if (["cp", "copy"].includes(subcommand)) {
      if (tokens.length < 1) {
        await ctx.reply(`${usage}\n\nIndica origen y opcionalmente destino.`);
        return;
      }
      if (tokens.length > 2) {
        await ctx.reply("Demasiados argumentos para copy. Usa comillas para rutas con espacios.");
        return;
      }
      const sourcePath = tokens[0] ?? "";
      const targetPath = tokens[1]?.trim() ?? "";
      if (!targetPath) {
        workspaceClipboardByChat.set(actor.chatId, {
          paths: [sourcePath],
          copiedAtMs: Date.now(),
          source: "workspace.command",
        });
        await ctx.reply(
          [
            "Archivo copiado al portapapeles.",
            `origen: ${resolveWorkspacePath(sourcePath).relPath}`,
            'Usa "/workspace paste <destino>" para pegar.',
          ].join("\n"),
        );
        return;
      }
      const copied = await copyWorkspacePath(sourcePath, targetPath);
      await ctx.reply(
        [
          "Copiado.",
          `origen: ${copied.from}`,
          `destino: ${copied.to}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "workspace.command_copy",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          from: copied.from,
          to: copied.to,
        },
      });
      return;
    }

    if (["paste"].includes(subcommand)) {
      const targetPath = tokens.join(" ").trim();
      if (!targetPath) {
        await ctx.reply(`${usage}\n\nIndica destino para pegar.`);
        return;
      }
      const clipboard = workspaceClipboardByChat.get(actor.chatId);
      if (!clipboard || clipboard.paths.length === 0) {
        await ctx.reply('No hay portapapeles. Usa "/workspace copy <origen>" primero.');
        return;
      }
      const copied = await copyWorkspacePathsToDirectory(clipboard.paths, targetPath);
      await replyLong(
        ctx,
        [
          `Pegados ${copied.length} archivo(s).`,
          `destino: ${resolveWorkspacePath(targetPath).relPath}`,
          ...formatWorkspacePathPreview(copied.map((item) => normalizeWorkspaceRelativePath(item.to)), 8),
        ].join("\n"),
      );
      await safeAudit({
        type: "workspace.command_paste",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          count: copied.length,
          targetPath: resolveWorkspacePath(targetPath).relPath,
          clipboardSource: clipboard.source,
        },
      });
      return;
    }

    if (["rm", "del", "delete", "remove"].includes(subcommand)) {
      const blockReason = getPolicyCapabilityBlockReason(actor.chatId, "workspace.delete");
      if (blockReason) {
        await ctx.reply(blockReason);
        return;
      }
      const targetPath = tokens.join(" ").trim();
      if (!targetPath) {
        const pendingPath = queueWorkspaceDeletePathRequest({
          chatId: actor.chatId,
          source: "workspace.command",
          userId: actor.userId,
        });
        await ctx.reply(
          [
            `${usage}`,
            "Indica la ruta a eliminar dentro de workspace.",
            'Puedes responder solo con la ruta (ej: "vrand" o "/vrand").',
            `expira en: ${pendingWorkspaceDeletePathRemainingSeconds(pendingPath)}s`,
          ].join("\n\n"),
        );
        return;
      }
      pendingWorkspaceDeletePathByChat.delete(actor.chatId);
      if (
        await maybeRequirePlannedConfirmation({
          ctx,
          kind: "workspace-delete",
          capability: "workspace.delete",
          summary: `Eliminar en workspace: ${normalizeWorkspaceRelativePath(targetPath)}`,
          payload: {
            path: targetPath,
          },
          source: "telegram:/workspace-rm",
          userId: actor.userId,
        })
      ) {
        return;
      }
      const pending = queueWorkspaceDeleteConfirmation({
        chatId: actor.chatId,
        paths: [targetPath],
        source: "workspace.command",
        userId: actor.userId,
      });
      await ctx.reply(
        [
          "Confirmación requerida para eliminar en workspace.",
          `ruta: workspace/${pending.paths[0]}`,
          `expira en: ${pendingWorkspaceDeleteRemainingSeconds(pending)}s`,
          'Responde "si" para confirmar o "no" para cancelar.',
        ].join("\n"),
      );
      await safeAudit({
        type: "workspace.command_delete_pending",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          path: `workspace/${pending.paths[0]}`,
          count: pending.paths.length,
          ttlSeconds: pendingWorkspaceDeleteRemainingSeconds(pending),
        },
      });
      return;
    }

    if (["send", "get", "download"].includes(subcommand)) {
      const target = tokens.join(" ").trim();
      if (!target) {
        await ctx.reply(`${usage}\n\nIndica la ruta (o número de /files) a enviar.`);
        return;
      }
      const parsedIndex = Number.parseInt(target, 10);
      const responseText = await sendWorkspaceFileToChat({
        ctx,
        source: "workspace.command_send",
        userId: actor.userId,
        ...(Number.isFinite(parsedIndex) && String(parsedIndex) === target.trim() && parsedIndex > 0
          ? { index: parsedIndex }
          : { reference: target }),
      });
      await ctx.reply(responseText);
      return;
    }

    const fallbackPath = [subcommand, ...tokens].join(" ").trim();
    if (fallbackPath) {
      await listAndReply(fallbackPath);
      return;
    }

    await ctx.reply(usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude operar workspace: ${message}`);
    await safeAudit({
      type: "workspace.command_failed",
      chatId: actor.chatId,
      userId: actor.userId,
      details: {
        subcommand,
        error: message,
      },
    });
  }
});

bot.command("mkfile", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  const parsed = parsePathArgument(input);
  if (!parsed?.path) {
    await ctx.reply(
      [
        "Uso: /mkfile <ruta> [contenido]",
        'Ejemplo: /mkfile "notas.txt" "hola mundo"',
        'Ejemplo: /mkfile datos.csv "id,nombre\\n1,Ana"',
      ].join("\n"),
    );
    return;
  }

  const content = decodeEscapedInlineText(parsed.rest.trim());
  try {
    const written = await writeWorkspaceTextFile({
      relativePath: parsed.path,
      ...(content ? { content } : {}),
    });
    if (content.trim()) {
      rememberLastDocumentSnapshot(ctx.chat.id, written.relPath, content);
    }
    await ctx.reply(
      [
        "Archivo creado en workspace.",
        `ruta: ${written.relPath}`,
        `tamano: ${formatBytes(written.size)}`,
      ].join("\n"),
    );
    await safeAudit({
      type: "workspace.mkfile",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: written.relPath,
        size: written.size,
        contentChars: content.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude crear archivo: ${message}`);
    await safeAudit({
      type: "workspace.mkfile_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: parsed.path,
        error: message,
      },
    });
  }
});

bot.command("files", async (ctx) => {
  const raw = String(ctx.match ?? "").trim();
  let limit = 30;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      await ctx.reply("Uso: /files [limit]");
      return;
    }
    limit = Math.max(1, Math.min(150, Math.floor(parsed)));
  }

  const merged = await listRecentStoredFilesForChat(ctx.chat.id, limit);
  lastListedFilesByChat.set(ctx.chat.id, merged);
  rememberStoredFilesListContext({
    chatId: ctx.chat.id,
    title: "Archivos disponibles",
    items: merged,
    source: "telegram:/files",
  });

  if (merged.length === 0) {
    await ctx.reply("No hay archivos guardados para este chat.");
    return;
  }

  await replyLong(
    ctx,
    [
      `Archivos disponibles (${merged.length}):`,
      ...merged.map(
        (item, index) =>
          `${index + 1}. ${item.relPath}\n   ${formatBytes(item.size)} | ${new Date(item.modifiedAt).toLocaleString("es-AR", { hour12: false })}`,
      ),
    ].join("\n\n"),
  );
});

bot.command("getfile", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  if (!input) {
    await ctx.reply(
      [
        "Uso: /getfile <ruta|n>",
        'Ejemplos: /getfile "files/chat-123/2026-02-19/reporte.pdf"',
        "          /getfile 2",
      ].join("\n"),
    );
    return;
  }

  const parsedIndex = Number.parseInt(input, 10);
  try {
    const responseText = await sendWorkspaceFileToChat({
      ctx,
      source: "telegram:/getfile",
      userId: ctx.from?.id,
      ...(Number.isFinite(parsedIndex) && String(parsedIndex) === input && parsedIndex > 0
        ? { index: parsedIndex }
        : { reference: parsePathArgument(input)?.path ?? input }),
    });
    await ctx.reply(responseText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude enviar archivo: ${message}`);
    await safeAudit({
      type: "workspace.getfile_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        input,
        error: message,
      },
    });
  }
});

bot.command("images", async (ctx) => {
  const raw = String(ctx.match ?? "").trim();
  let limit = 20;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      await ctx.reply("Uso: /images [limit]");
      return;
    }
    limit = Math.max(1, Math.min(100, Math.floor(parsed)));
  }

  const items = await listSavedImages(ctx.chat.id, limit);
  if (items.length === 0) {
    await ctx.reply("No hay imágenes guardadas para este chat.");
    return;
  }
  rememberStoredFilesListContext({
    chatId: ctx.chat.id,
    title: "Imagenes guardadas",
    items,
    source: "telegram:/images",
  });

  await replyLong(
    ctx,
    [
      `Imágenes guardadas (${items.length}):`,
      ...items.map(
        (item, index) =>
          `${index + 1}. ${item.relPath}\n   ${formatBytes(item.size)} | ${new Date(item.modifiedAt).toLocaleString("es-AR", { hour12: false })}`,
      ),
    ].join("\n\n"),
  );
});

bot.command("askfile", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  const parsed = parsePathArgument(input);
  if (!parsed || !parsed.path || !parsed.rest) {
    await ctx.reply(
      'Uso: /askfile <ruta> <pregunta>\nEjemplo: /askfile "propuesta.docx" resumime los riesgos',
    );
    return;
  }

  if (!openAi.isConfigured()) {
    await ctx.reply(
      "OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.",
    );
    return;
  }

  await replyProgress(ctx, `Leyendo archivo para consulta: ${parsed.path}`);

  let documentText: string;
  let documentPath = parsed.path;
  let documentFormat = "unknown";
  let documentTruncated = false;

  try {
    const read = await documentReader.readDocument(parsed.path);
    rememberLastDocumentSnapshot(ctx.chat.id, read.path, read.text);
    documentText = read.text;
    documentPath = read.path;
    documentFormat = read.format;
    documentTruncated = read.truncated;

    if (!documentText.trim()) {
      await ctx.reply("No encontré texto útil en ese archivo para consultarlo.");
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude leer el archivo: ${message}`);
    return;
  }

  const question = parsed.rest.trim();
  const prompt = [
    "Analiza el siguiente archivo local y responde la pregunta del usuario.",
    `Archivo: ${documentPath}`,
    `Formato detectado: ${documentFormat}`,
    `Texto truncado por límite: ${documentTruncated ? "sí" : "no"}`,
    "",
    "Contenido extraído:",
    documentText,
    "",
    `Pregunta del usuario: ${question}`,
  ].join("\n");

  await replyProgress(ctx, `Consultando OpenAI (${getOpenAiModelForChat(ctx.chat.id)})...`);

  try {
    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: `[ASKFILE path=${documentPath}] ${question}`,
      source: "telegram:/askfile",
    });

    const promptContext = await buildPromptContextForQuery(`${documentPath}\n${question}`, {
      chatId: ctx.chat.id,
    });
    const answer = await askOpenAiForChat({ chatId: ctx.chat.id, prompt, context: promptContext });
    await replyLong(ctx, answer);

    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "assistant",
      text: answer,
      source: "telegram:/askfile",
    });

    await safeAudit({
      type: "doc.ask",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: documentPath,
        format: documentFormat,
        truncated: documentTruncated,
        questionLength: question.length,
        answerLength: answer.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Error al consultar OpenAI sobre el archivo: ${message}`);
    await safeAudit({
      type: "doc.ask_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: documentPath,
        error: message,
      },
    });
  }
});

bot.command("web", async (ctx) => {
  if (!config.enableWebBrowse) {
    await ctx.reply("Navegación web deshabilitada por configuración (ENABLE_WEB_BROWSE=false).");
    return;
  }

  const rawQuery = String(ctx.match ?? "").trim();
  if (!rawQuery) {
    await ctx.reply("Uso: /web <consulta>");
    return;
  }

  const newsRequested = isLikelyNewsQuery(rawQuery);
  const searchQuery = newsRequested ? buildFreshNewsSearchQuery(rawQuery) : rawQuery;
  await replyProgress(
    ctx,
    newsRequested
      ? `Buscando noticias recientes (máx ${NEWS_MAX_REDDIT_RESULTS} Reddit): ${searchQuery}`
      : `Buscando en web: ${searchQuery}`,
  );
  try {
    const searchResult = await runWebSearchQuery({
      rawQuery,
      newsRequested,
    });
    const hits = searchResult.hits;
    const usedFallbackQuery = searchResult.usedFallbackQuery;
    if (hits.length === 0) {
      await ctx.reply(newsRequested ? "No encontré noticias recientes relevantes sobre ese tema." : "Sin resultados relevantes.");
      return;
    }

    lastWebResultsByChat.set(ctx.chat.id, hits);
    rememberWebResultsListContext({
      chatId: ctx.chat.id,
      title: `Resultados web: ${rawQuery}`,
      hits,
      source: "telegram:/web",
    });
    const responseText = [
      buildWebResultsListText({
        query: rawQuery,
        hits,
        newsRequested,
      }),
      "Tip: usa /webopen <n> para abrir uno (ej: /webopen 1).",
    ].join("\n\n");
    await replyLong(
      ctx,
      responseText,
    );

    await safeAudit({
      type: "web.search",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: searchResult.query,
        rawQuery,
        usedFallbackQuery,
        newsRequested,
        redditPriority: newsRequested,
        redditCap: NEWS_MAX_REDDIT_RESULTS,
        results: hits.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude buscar en web: ${message}`);
    await safeAudit({
      type: "web.search_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: { query: rawQuery, error: message },
    });
  }
});

bot.command("lim", async (ctx) => {
  if (!config.enableLimControl) {
    await ctx.reply("LIM está deshabilitado por configuración (ENABLE_LIM_CONTROL=false).");
    return;
  }

  const input = String(ctx.match ?? "").trim();
  if (!input) {
    await ctx.reply('Uso: /lim first_name:<nombre> last_name:<apellido> fuente:<origen> [count:3]');
    return;
  }

  const extractLimTaggedValue = (fieldPattern: string): string => {
    const match = input.match(
      new RegExp(
        `\\b${fieldPattern}\\s*[:=]\\s*([\\s\\S]*?)(?=\\s+(?:first[_\\s-]?name|last[_\\s-]?name|fuente|source|count)\\s*[:=]|$)`,
        "i",
      ),
    );
    return (match?.[1] ?? "").trim();
  };
  const firstName = extractLimTaggedValue("first[_\\s-]?name");
  const lastName = extractLimTaggedValue("last[_\\s-]?name");
  const sourceName = extractLimTaggedValue("(?:fuente|source)");
  const countRaw = Number.parseInt(input.match(/\bcount\s*[:=]\s*(\d{1,2})\b/i)?.[1] ?? "", 10);
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(10, countRaw)) : 3;

  if (!firstName || !lastName || !sourceName) {
    await ctx.reply('Faltan parámetros. Uso: /lim first_name:Juan last_name:Perez fuente:account_demo_c_jack [count:3]');
    return;
  }

  await replyProgress(ctx, `Consultando LIM: ${firstName} ${lastName}...`);
  const result = await queryLimMessages({
    firstName,
    lastName,
    sourceName,
    count,
    prospectOnly: false,
  });

  if (!result.ok) {
    await ctx.reply(
      [
        "No pude consultar LIM.",
        `Detalle: ${truncateInline(result.detail || result.error || "error desconocido", 260)}`,
      ].join("\n"),
    );
    await safeAudit({
      type: "connector.command_query_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        firstName,
        lastName,
        sourceName,
        count,
        error: result.error || "",
        detail: result.detail || "",
      },
    });
    return;
  }

  const lines: string[] = [];
  lines.push(`LIM | ${result.contact || `${firstName} ${lastName}`}`);
  lines.push(`Cuenta: ${result.account || "-"}`);
  lines.push(`Encontrado: ${result.found ? "sí" : "no"} | Total: ${result.totalMessages ?? 0} | Devueltos: ${result.returnedMessages ?? 0}`);
  if (result.queryUsed) {
    lines.push(`Query usada: ${result.queryUsed}`);
  }
  if ((result.messages?.length ?? 0) > 0) {
    lines.push("");
    lines.push("Mensajes:");
    for (const [index, message] of (result.messages ?? []).entries()) {
      lines.push(
        [
          `${index + 1}. ${truncateInline(message.text || "(sin texto)", 280)}`,
          `dir: ${message.direction || "-"} | hora: ${message.time || "-"} | idx: ${message.index ?? "-"}`,
        ].join("\n"),
      );
    }
  }
  const responseText = lines.join("\n");
  await replyLong(ctx, responseText);
  await safeAudit({
    type: "connector.command_query",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      firstName,
      lastName,
      sourceName,
      count,
      account: result.account || "",
      found: result.found ?? false,
      returnedMessages: result.returnedMessages ?? 0,
    },
  });
});

bot.command("crypto", async (ctx) => {
  const rawInput = String(ctx.match ?? "").trim();
  const tokens = rawInput.split(/\s+/).filter(Boolean);
  const maybeLimit = Number.parseInt(tokens[tokens.length - 1] ?? "", 10);
  const limit = Number.isFinite(maybeLimit) && maybeLimit > 0 ? Math.min(10, maybeLimit) : 5;
  const query =
    Number.isFinite(maybeLimit) && maybeLimit > 0 ? tokens.slice(0, -1).join(" ").trim() : rawInput;

  await replyProgress(
    ctx,
    query ? `Consultando CoinGecko: ${query}` : "Consultando CoinGecko (top mercado)...",
  );
  try {
    const markets = query
      ? await coinGeckoApi.searchMarkets(query, limit)
      : await coinGeckoApi.getTopMarkets(limit);
    if (markets.length === 0) {
      await ctx.reply("No encontré monedas para esa búsqueda.");
      return;
    }

    const lines = markets.map((coin, index) =>
      [
        `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()})`,
        `Precio: ${formatUsd(coin.currentPriceUsd)} | 24h: ${formatSignedPercent(coin.priceChange24hPct)} | Rank: ${coin.marketCapRank ?? "n/d"}`,
        `Actualizado: ${formatIsoDateCompact(coin.lastUpdated)}`,
      ].join("\n"),
    );

    await replyLong(
      ctx,
      [
        query ? `Crypto para: ${query}` : `Top crypto por market cap (${markets.length})`,
        ...lines,
      ].join("\n\n"),
    );
    await safeAudit({
      type: "crypto.search",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: query || null,
        limit,
        results: markets.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude consultar CoinGecko: ${message}`);
    await safeAudit({
      type: "crypto.search_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: query || null,
        limit,
        error: message,
      },
    });
  }
});

bot.command("weather", async (ctx) => {
  const rawLocation = String(ctx.match ?? "").trim();
  const location = rawLocation || "Buenos Aires";
  await replyProgress(ctx, `Consultando clima en ${location}...`);

  try {
    const weather = await openMeteoApi.getWeather(location);
    const currentLine = [
      `Ahora: ${weather.current.weatherText}`,
      `${weather.current.temperatureC.toFixed(1)}°C`,
      `viento ${weather.current.windKmh.toFixed(1)} km/h`,
      weather.current.humidityPct !== null ? `humedad ${Math.round(weather.current.humidityPct)}%` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    const nextDays = weather.nextDays
      .slice(0, 3)
      .map(
        (day, index) =>
          `${index + 1}. ${day.date} | ${day.weatherText} | min ${day.minC.toFixed(1)}°C / max ${day.maxC.toFixed(1)}°C`,
      );

    await replyLong(
      ctx,
      [
        `Clima en ${weather.locationName} (${weather.timezone})`,
        currentLine,
        ...(nextDays.length > 0 ? ["", "Próximos días:", ...nextDays] : []),
      ].join("\n"),
    );
    await safeAudit({
      type: "weather.lookup",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        location,
        resolved: weather.locationName,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude consultar Open-Meteo: ${message}`);
    await safeAudit({
      type: "weather.lookup_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        location,
        error: message,
      },
    });
  }
});

bot.command("reddit", async (ctx) => {
  const rawInput = String(ctx.match ?? "").trim();
  if (!rawInput) {
    await ctx.reply("Uso: /reddit <consulta> [limit]");
    return;
  }

  const tokens = rawInput.split(/\s+/).filter(Boolean);
  const maybeLimit = Number.parseInt(tokens[tokens.length - 1] ?? "", 10);
  const limit = Number.isFinite(maybeLimit) && maybeLimit > 0 ? Math.min(10, maybeLimit) : 5;
  const queryText =
    Number.isFinite(maybeLimit) && maybeLimit > 0 ? tokens.slice(0, -1).join(" ").trim() : rawInput;
  if (!queryText) {
    await ctx.reply("Uso: /reddit <consulta> [limit]");
    return;
  }

  const subredditMatch = queryText.match(/^\s*r\/([a-z0-9_]+)\s+(.+)$/i);
  const subreddit = subredditMatch?.[1]?.trim();
  const query = (subredditMatch?.[2] ?? queryText).trim();
  if (!query) {
    await ctx.reply("Consulta vacía para Reddit.");
    return;
  }

  await replyProgress(ctx, `Buscando en Reddit API: ${subreddit ? `r/${subreddit} | ` : ""}${query}`);
  try {
    const posts = await redditApi.searchPosts({
      query,
      ...(subreddit ? { subreddit } : {}),
      sort: "new",
      time: "week",
      limit,
    });
    if (posts.length === 0) {
      await ctx.reply("No encontré resultados en Reddit para esa consulta.");
      return;
    }

    const hits = redditPostsToWebSearchResults(posts);
    lastWebResultsByChat.set(ctx.chat.id, hits);
    rememberWebResultsListContext({
      chatId: ctx.chat.id,
      title: `Reddit: ${subreddit ? `r/${subreddit} | ` : ""}${query}`,
      hits,
      source: "telegram:/reddit",
    });

    const lines = posts.map((post, index) =>
      [
        `${index + 1}. ${post.title}`,
        `Subreddit: r/${post.subreddit} | Fecha: ${formatRedditPostDate(post.createdUtc)} | Score: ${post.score} | Comentarios: ${post.numComments}`,
        `Link: ${post.url}`,
      ].join("\n"),
    );
    await replyLong(
      ctx,
      [
        `Resultados Reddit (${posts.length}) para: ${query}${subreddit ? ` en r/${subreddit}` : ""}`,
        ...lines,
        "Tip: usa /webopen <n> para abrir y analizar un resultado.",
      ].join("\n\n"),
    );
    await safeAudit({
      type: "reddit.search",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query,
        subreddit: subreddit ?? null,
        limit,
        results: posts.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude consultar Reddit API: ${message}`);
    await safeAudit({
      type: "reddit.search_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query,
        subreddit: subreddit ?? null,
        limit,
        error: message,
      },
    });
  }
});

bot.command("webopen", async (ctx) => {
  if (!config.enableWebBrowse) {
    await ctx.reply("Navegación web deshabilitada por configuración (ENABLE_WEB_BROWSE=false).");
    return;
  }

  const input = String(ctx.match ?? "").trim();
  let parsed;
  try {
    parsed = parseWebOpenTarget(input, lastWebResultsByChat.get(ctx.chat.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(message);
    return;
  }

  await replyProgress(ctx, `Abriendo ${parsed.url}...`);
  try {
    const page = await webBrowser.open(parsed.url);
    const header = [
      `URL: ${page.finalUrl}`,
      `Título: ${page.title}`,
      `Tipo: ${page.contentType || "desconocido"}`,
      `Truncado: ${page.truncated ? "sí" : "no"}`,
    ].join("\n");

    if (!parsed.question) {
      const preview = truncateInline(page.text, 3500);
      await replyLong(
        ctx,
        [
          header,
          "",
          preview || "(sin contenido textual útil)",
          "",
          "Tip: /webopen <n|url> <pregunta> para analizar con IA.",
        ].join("\n"),
      );
      return;
    }

    if (!openAi.isConfigured()) {
      await replyLong(
        ctx,
        [header, "", "OpenAI no está configurado para análisis. Usa /webopen sin pregunta para ver contenido."].join(
          "\n",
        ),
      );
      return;
    }

    const ecoEnabled = isEcoModeEnabled(ctx.chat.id);
    const prompt = [
      "Analiza este contenido web y responde la pregunta del usuario.",
      `URL: ${page.finalUrl}`,
      `Título: ${page.title}`,
      `Tipo: ${page.contentType}`,
      "",
      "Contenido:",
      page.text,
      "",
      `Pregunta: ${parsed.question}`,
      "",
      ...(ecoEnabled
        ? [
            "MODO ECO: respuesta ultra-concisa.",
            "Usa 3 bullets máximos + 1 acción recomendada.",
          ]
        : ["Al final, incluye una línea de fuente con la URL usada."]),
    ].join("\n");

    const promptContext = await buildPromptContextForQuery(`${parsed.question}\n${page.title}`, {
      chatId: ctx.chat.id,
    });
    const answerRaw = await askOpenAiForChat({ chatId: ctx.chat.id, prompt, context: promptContext });
    const answer = ecoEnabled ? truncateInline(answerRaw, 900) : answerRaw;
    await replyLong(ctx, answer);
    await ctx.reply(`Fuente: ${page.finalUrl}`);

    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: `[WEBOPEN] ${parsed.url} | ${parsed.question}`,
      source: "telegram:/webopen",
    });
    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "assistant",
      text: `${answer}\nFuente: ${page.finalUrl}`,
      source: "telegram:/webopen",
    });

    await safeAudit({
      type: "web.open",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        url: parsed.url,
        finalUrl: page.finalUrl,
        withQuestion: true,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude abrir esa URL: ${message}`);
    await safeAudit({
      type: "web.open_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: { url: parsed.url, error: message },
    });
  }
});

bot.command("webask", async (ctx) => {
  if (!config.enableWebBrowse) {
    await ctx.reply("Navegación web deshabilitada por configuración (ENABLE_WEB_BROWSE=false).");
    return;
  }

  const rawQuery = String(ctx.match ?? "").trim();
  if (!rawQuery) {
    await ctx.reply("Uso: /webask <consulta>");
    return;
  }
  if (!openAi.isConfigured()) {
    await ctx.reply("OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.");
    return;
  }

  const newsRequested = isLikelyNewsQuery(rawQuery);
  const searchQuery = newsRequested ? buildFreshNewsSearchQuery(rawQuery) : rawQuery;
  await replyProgress(
    ctx,
    newsRequested
      ? `Buscando y sintetizando noticias recientes: ${searchQuery}`
      : `Buscando y sintetizando en web: ${searchQuery}`,
  );
  try {
    const searchResult = await runWebSearchQuery({
      rawQuery,
      newsRequested,
    });
    const hits = searchResult.hits;
    const usedFallbackQuery = searchResult.usedFallbackQuery;
    if (hits.length === 0) {
      await ctx.reply(
        newsRequested ? "No encontré noticias recientes relevantes para sintetizar." : "Sin resultados relevantes para sintetizar.",
      );
      return;
    }
    lastWebResultsByChat.set(ctx.chat.id, hits);
    rememberWebResultsListContext({
      chatId: ctx.chat.id,
      title: `Resultados web: ${rawQuery}`,
      hits,
      source: "telegram:/webask",
    });

    const top = hits.slice(0, newsRequested ? 5 : 3);
    const pages = await Promise.allSettled(top.map(async (hit) => ({ hit, page: await webBrowser.open(hit.url) })));
    const sources: Array<{ title: string; url: string; text: string }> = [];

    for (const item of pages) {
      if (item.status !== "fulfilled") {
        continue;
      }
      const excerpt = truncateInline(item.value.page.text, 5000);
      if (!excerpt) {
        continue;
      }
      sources.push({
        title: item.value.page.title || item.value.hit.title,
        url: item.value.page.finalUrl || item.value.hit.url,
        text: excerpt,
      });
    }

    if (sources.length === 0) {
      await ctx.reply("Encontré resultados, pero no pude extraer contenido utilizable.");
      return;
    }

    const sourceBlocks = sources
      .map(
        (source, index) =>
          [
            `Fuente ${index + 1}: ${source.title}`,
            `URL: ${source.url}`,
            source.text,
          ].join("\n"),
      )
      .join("\n\n---\n\n");

    const ecoEnabled = isEcoModeEnabled(ctx.chat.id);
    const prompt = [
      "Responde la consulta del usuario usando SOLO la evidencia de las fuentes provistas.",
      newsRequested
        ? `El pedido es de noticias: prioriza hechos de los ultimos ${NEWS_MAX_AGE_DAYS} dias y menciona fechas concretas (dia/mes/ano) cuando esten disponibles.`
        : "Si la evidencia no alcanza, dilo explicitamente.",
      newsRequested
        ? `Usa como maximo ${NEWS_MAX_REDDIT_RESULTS} fuentes de Reddit y completa con otros sitios relevantes; marca que puntos requieren validacion adicional.`
        : "Se claro y breve.",
      newsRequested
        ? `No uses como base noticias de mas de ${NEWS_MAX_AGE_DAYS} dias; si no hay suficiente evidencia reciente, dilo explicitamente.`
        : "Evita suposiciones.",
      "No devuelvas JSON, YAML ni bloques de codigo.",
      ...(ecoEnabled
        ? [
            "MODO ECO: salida mínima en español.",
            "Formato exacto y único:",
            "1) 3 bullets máximos con lo más reciente/relevante.",
            "2) 1 acción recomendada.",
            "3) Fuentes usadas: máximo 3 links.",
            "No agregues texto extra.",
          ]
        : [
            "Entrega una respuesta natural en espanol con este formato:",
            "1) Resumen breve (3-5 viñetas).",
            "2) Lecturas recomendadas: hasta 5 items con titulo, mini-resumen y link.",
            "Si no tienes evidencia suficiente, dilo explicitamente.",
          ]),
      `Consulta del usuario: ${rawQuery}`,
      `Consulta web ejecutada: ${usedFallbackQuery ? `${searchResult.query} (fallback: ${rawQuery})` : searchResult.query}`,
      "",
      "Fuentes:",
      sourceBlocks,
      "",
      ...(ecoEnabled ? [] : ["Incluye al final una sección 'Fuentes usadas:' con las URLs en viñetas."]),
    ].join("\n");

    const promptContext = await buildPromptContextForQuery(rawQuery, {
      chatId: ctx.chat.id,
    });
    const answerRaw = await askOpenAiForChat({ chatId: ctx.chat.id, prompt, context: promptContext });
    const answer = ecoEnabled ? truncateInline(answerRaw, 1200) : answerRaw;
    await replyLong(ctx, answer);

    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: `[WEBASK] ${rawQuery}`,
      source: "telegram:/webask",
    });
    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "assistant",
      text: answer,
      source: "telegram:/webask",
    });

    await safeAudit({
      type: "web.ask",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: searchResult.query,
        rawQuery,
        usedFallbackQuery,
        newsRequested,
        redditPriority: newsRequested,
        redditCap: NEWS_MAX_REDDIT_RESULTS,
        sources: sources.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude completar /webask: ${message}`);
    await safeAudit({
      type: "web.ask_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: rawQuery,
        error: message,
      },
    });
  }
});

bot.command("gmail", async (ctx) => {
  const usage = [
    "Uso:",
    "/gmail status",
    "/gmail profile",
    "/gmail list [query ...] [limit=10]",
    "/gmail read <messageId>",
    '/gmail send <to> "<subject>" "<body>" [cc=a@x.com,b@y.com] [bcc=z@x.com]',
    "/gmail markread <messageId>",
    "/gmail markunread <messageId>",
    "/gmail trash <messageId>",
    "/gmail untrash <messageId>",
    "/gmail star <messageId>",
    "/gmail unstar <messageId>",
    "/gmail recipients list",
    '/gmail recipients add "<nombre>" <email>',
    '/gmail recipients edit <nombre|n> [name="<nuevo nombre>"] [email=<nuevo@email>]',
    "/gmail recipients del <nombre|n>",
    "/gmail recipients clear",
  ].join("\n");
  const recipientsUsage = [
    "Uso destinatarios:",
    "/gmail recipients list",
    '/gmail recipients add "<nombre>" <email>',
    '/gmail recipients edit <nombre|n> [name="<nuevo nombre>"] [email=<nuevo@email>]',
    "/gmail recipients del <nombre|n>",
    "/gmail recipients clear",
  ].join("\n");

  const input = String(ctx.match ?? "").trim();
  let tokens: string[] = [];
  try {
    tokens = parseQuotedArgs(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`${message}\n\n${usage}`);
    return;
  }

  if (tokens.length === 0) {
    await ctx.reply(usage);
    return;
  }

  const subcommand = (tokens.shift() ?? "").toLowerCase();
  const actor = getActor(ctx);

  if (subcommand === "status") {
    const status = gmailAccount.getStatus();
    await ctx.reply(
      [
        `Habilitado: ${status.enabled ? "sí" : "no"}`,
        `Configurado: ${status.configured ? "sí" : "no"}`,
        `Cuenta: ${status.accountEmail || "n/d"}`,
        `Max resultados: ${status.maxResults}`,
        status.missing.length > 0 ? `Faltan: ${status.missing.join(", ")}` : "Faltan: ninguno",
      ].join("\n"),
    );
    return;
  }

  if (subcommand === "recipients" || subcommand === "recipient" || subcommand === "destinatarios") {
    const sub = (tokens.shift() ?? "list").toLowerCase();
    const parsed = parseKeyValueOptions(tokens);

    try {
      if (["list", "ls", "status"].includes(sub)) {
        const list = listEmailRecipients(actor.chatId);
        if (list.length === 0) {
          await ctx.reply("No hay destinatarios guardados.");
          return;
        }
        const lines = list.map((item, idx) => `${idx + 1}. ${item.name} <${item.email}>`);
        await replyLong(ctx, [`Destinatarios guardados (${list.length}):`, ...lines].join("\n"));
        return;
      }

      if (["add", "new", "create", "alta"].includes(sub)) {
        const optionEmail = parsed.options.email?.trim() ?? "";
        const email = normalizeRecipientEmail(optionEmail || (parsed.args[parsed.args.length - 1] ?? ""));
        const nameRaw = parsed.options.name?.trim() || parsed.args.slice(0, optionEmail ? parsed.args.length : -1).join(" ");
        const name = normalizeRecipientName(nameRaw);
        if (!name || !email) {
          await ctx.reply(`Faltan datos.\n\n${recipientsUsage}`);
          return;
        }
        const result = await upsertEmailRecipient({
          chatId: actor.chatId,
          name,
          email,
        });
        await ctx.reply(
          result.created
            ? `Destinatario agregado: ${result.row.name} <${result.row.email}>`
            : `Destinatario actualizado: ${result.row.name} <${result.row.email}>`,
        );
        await safeAudit({
          type: "gmail.recipients_upsert",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            created: result.created,
            name: result.row.name,
            email: result.row.email,
          },
        });
        return;
      }

      if (["edit", "set", "update", "mod", "modificar"].includes(sub)) {
        const selector = parsed.args[0]?.trim() || parsed.options.id?.trim() || parsed.options.selector?.trim() || "";
        const tailArgs = parsed.args.slice(1);
        let nextName = parsed.options.name?.trim() || "";
        let nextEmail = parsed.options.email?.trim() || "";
        if (!nextName && !nextEmail && tailArgs.length > 0) {
          if (tailArgs.length === 1) {
            if (isValidEmailAddress(tailArgs[0] ?? "")) {
              nextEmail = tailArgs[0] ?? "";
            } else {
              nextName = tailArgs[0] ?? "";
            }
          } else {
            const last = tailArgs[tailArgs.length - 1] ?? "";
            if (isValidEmailAddress(last)) {
              nextEmail = last;
              nextName = tailArgs.slice(0, -1).join(" ");
            } else {
              nextName = tailArgs.join(" ");
            }
          }
        }
        if (!selector || (!nextName && !nextEmail)) {
          await ctx.reply(`Faltan datos para editar.\n\n${recipientsUsage}`);
          return;
        }
        const updated = await updateEmailRecipientBySelector({
          chatId: actor.chatId,
          selector,
          ...(nextName ? { nextName } : {}),
          ...(nextEmail ? { nextEmail } : {}),
        });
        if (!updated) {
          await ctx.reply(`No encontré destinatario "${selector}".`);
          return;
        }
        await ctx.reply(
          [
            "Destinatario modificado:",
            `antes: ${updated.previous.name} <${updated.previous.email}>`,
            `ahora: ${updated.row.name} <${updated.row.email}>`,
          ].join("\n"),
        );
        await safeAudit({
          type: "gmail.recipients_update",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            selector,
            previousName: updated.previous.name,
            previousEmail: updated.previous.email,
            currentName: updated.row.name,
            currentEmail: updated.row.email,
          },
        });
        return;
      }

      if (["del", "delete", "rm", "remove", "baja", "eliminar", "borra"].includes(sub)) {
        const selector =
          parsed.args.join(" ").trim() ||
          parsed.options.id?.trim() ||
          parsed.options.selector?.trim() ||
          parsed.options.name?.trim() ||
          "";
        if (!selector) {
          await ctx.reply(`Indica el destinatario a eliminar.\n\n${recipientsUsage}`);
          return;
        }
        const removed = await deleteEmailRecipientBySelector(actor.chatId, selector);
        if (!removed) {
          await ctx.reply(`No encontré destinatario "${selector}".`);
          return;
        }
        await ctx.reply(`Destinatario eliminado: ${removed.name} <${removed.email}>`);
        await safeAudit({
          type: "gmail.recipients_delete",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            selector,
            name: removed.name,
            email: removed.email,
          },
        });
        return;
      }

      if (["clear", "wipe", "reset"].includes(sub)) {
        const removedCount = await clearEmailRecipients(actor.chatId);
        await ctx.reply(`Destinatarios eliminados: ${removedCount}`);
        await safeAudit({
          type: "gmail.recipients_clear",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            removedCount,
          },
        });
        return;
      }

      await ctx.reply(`Subcomando recipients no reconocido: ${sub}\n\n${recipientsUsage}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude operar destinatarios: ${message}`);
      await safeAudit({
        type: "gmail.recipients_failed",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          sub,
          error: message,
        },
      });
      return;
    }
  }

  const accessIssue = getGmailAccessIssue(ctx);
  if (accessIssue) {
    await ctx.reply(accessIssue);
    return;
  }

  try {
    if (subcommand === "profile") {
      const profile = await gmailAccount.getProfile();
      await ctx.reply(
        [
          `Email: ${profile.emailAddress || "n/d"}`,
          `Mensajes: ${profile.messagesTotal}`,
          `Threads: ${profile.threadsTotal}`,
          `HistoryId: ${profile.historyId || "n/d"}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "gmail.profile",
        chatId: actor.chatId,
        userId: actor.userId,
      });
      return;
    }

    if (subcommand === "list") {
      const parsed = parseKeyValueOptions(tokens);
      let limit: number | undefined;
      if (parsed.options.limit) {
        const candidate = Number.parseInt(parsed.options.limit, 10);
        if (!Number.isFinite(candidate) || candidate <= 0) {
          await ctx.reply("limit inválido. Usa por ejemplo: limit=10");
          return;
        }
        limit = candidate;
      }
      const query = parsed.args.join(" ").trim() || undefined;
      await replyProgress(ctx, `Consultando Gmail${query ? ` (query: ${query})` : ""}...`);
      const messages = await gmailAccount.listMessages(query, limit);
      if (messages.length === 0) {
        await ctx.reply("Sin mensajes para ese filtro.");
        return;
      }
      rememberGmailListResults(ctx.chat.id, messages);
      rememberGmailListContext({
        chatId: ctx.chat.id,
        title: `Gmail: ${query || "inbox"}`,
        messages,
        source: "telegram:/gmail",
      });
      const lines = messages.map((message, index) =>
        [
          `${index + 1}. ${message.subject || "(sin asunto)"}`,
          `id: ${message.id}`,
          `from: ${message.from || "-"}`,
          `date: ${message.date || "-"}`,
          message.snippet ? `snippet: ${truncateInline(message.snippet, 220)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      await replyLong(ctx, [`Mensajes (${messages.length}):`, ...lines].join("\n\n"));
      await safeAudit({
        type: "gmail.list",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          count: messages.length,
          query: query ?? "",
        },
      });
      return;
    }

    if (subcommand === "read") {
      const messageId = tokens[0]?.trim();
      if (!messageId) {
        await ctx.reply(`Falta messageId.\n\n${usage}`);
        return;
      }
      const detail = await gmailAccount.readMessage(messageId);
      rememberGmailMessage(ctx.chat.id, detail.id);
      await replyLong(
        ctx,
        [
          `Subject: ${detail.subject || "(sin asunto)"}`,
          `From: ${detail.from || "-"}`,
          `To: ${detail.to || "-"}`,
          `Date: ${detail.date || "-"}`,
          `Labels: ${detail.labelIds.join(", ") || "-"}`,
          `MessageId: ${detail.id}`,
          "",
          detail.bodyText || detail.snippet || "(sin cuerpo legible)",
        ].join("\n"),
      );
      await safeAudit({
        type: "gmail.read",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          messageId,
        },
      });
      return;
    }

    if (subcommand === "send") {
      const blockReason = getPolicyCapabilityBlockReason(actor.chatId, "gmail.send");
      if (blockReason) {
        await ctx.reply(blockReason);
        return;
      }
      const parsed = parseKeyValueOptions(tokens);
      if (parsed.args.length < 3) {
        await ctx.reply(`Faltan argumentos para send.\n\n${usage}`);
        return;
      }
      const to = parsed.args[0] ?? "";
      const subject = parsed.args[1] ?? "";
      const body = parsed.args.slice(2).join(" ").trim();
      if (!body) {
        await ctx.reply(`Falta body para send.\n\n${usage}`);
        return;
      }
      if (
        await maybeRequirePlannedConfirmation({
          ctx,
          kind: "gmail-send",
          capability: "gmail.send",
          summary: [`to: ${to}`, `subject: ${subject}`, `body_chars: ${body.length}`].join("\n"),
          payload: {
            to,
            subject,
            body,
            cc: parsed.options.cc ?? "",
            bcc: parsed.options.bcc ?? "",
          },
          source: "telegram:/gmail-send",
          userId: actor.userId,
        })
      ) {
        return;
      }
      const sent = await gmailAccount.sendMessage({
        to,
        subject,
        body,
        cc: parsed.options.cc,
        bcc: parsed.options.bcc,
      });
      rememberGmailMessage(ctx.chat.id, sent.id);
      await ctx.reply(`Email enviado.\nmessageId=${sent.id}\nthreadId=${sent.threadId}`);
      await safeAudit({
        type: "gmail.send",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          to,
          subjectLength: subject.length,
          bodyLength: body.length,
          cc: parsed.options.cc ?? "",
          bcc: parsed.options.bcc ? "[set]" : "",
          messageId: sent.id,
          threadId: sent.threadId,
        },
      });
      return;
    }

    const messageId = tokens[0]?.trim();
    if (
      subcommand === "markread" ||
      subcommand === "markunread" ||
      subcommand === "trash" ||
      subcommand === "untrash" ||
      subcommand === "star" ||
      subcommand === "unstar"
    ) {
      if (!messageId) {
        await ctx.reply(`Falta messageId.\n\n${usage}`);
        return;
      }

      if (subcommand === "markread") {
        await gmailAccount.markRead(messageId);
      } else if (subcommand === "markunread") {
        await gmailAccount.markUnread(messageId);
      } else if (subcommand === "trash") {
        await gmailAccount.trashMessage(messageId);
      } else if (subcommand === "untrash") {
        await gmailAccount.untrashMessage(messageId);
      } else if (subcommand === "star") {
        await gmailAccount.star(messageId);
      } else if (subcommand === "unstar") {
        await gmailAccount.unstar(messageId);
      }

      rememberGmailMessage(ctx.chat.id, messageId);
      await ctx.reply(`OK: ${subcommand} aplicado a ${messageId}`);
      await safeAudit({
        type: "gmail.modify",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          action: subcommand,
          messageId,
        },
      });
      return;
    }

    await ctx.reply(`Subcomando no reconocido: ${subcommand}\n\n${usage}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Error Gmail: ${message}`);
    await safeAudit({
      type: "gmail.failed",
      chatId: actor.chatId,
      userId: actor.userId,
      details: {
        subcommand,
        error: message,
      },
    });
  }
});

bot.command("remember", async (ctx) => {
  const note = String(ctx.match ?? "").trim();
  if (!note) {
    await ctx.reply("Uso: /remember <nota>");
    return;
  }

  try {
    const result = await contextMemory.appendDailyNote(note, {
      source: "telegram:/remember",
      chatId: ctx.chat.id,
      userId: ctx.from?.id ?? 0,
    });
    await ctx.reply(`Nota guardada en ${result.relPath}`);
    await safeAudit({
      type: "memory.append",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        relPath: result.relPath,
        length: note.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude guardar la nota: ${message}`);
  }
});

bot.command("memory", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  if (!input || input.toLowerCase() === "status") {
    try {
      const status = await contextMemory.getStatus();
      await ctx.reply(
        [
          `Workspace: ${status.workspaceDir}`,
          `MEMORY.md: ${status.longTermMemoryExists ? "presente" : "ausente"}`,
          `Archivos diarios: ${status.memoryFilesCount}`,
          `Archivo de hoy: ${status.todayMemoryFile}`,
          `Backend: ${status.backendLastUsed} (preferido: ${status.backendPreferred})`,
          `Fallbacks acumulados: ${status.backendFallbackCount}`,
          ...(status.backendLastFallbackError ? [`Último fallback: ${status.backendLastFallbackError}`] : []),
          "Uso: /memory search <texto> | /memory view <path> [from] [lines]",
        ].join("\n"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude leer estado de memoria: ${message}`);
    }
    return;
  }

  const [subcommandRaw, ...rest] = input.split(/\s+/);
  const subcommand = subcommandRaw?.toLowerCase() ?? "";

  if (subcommand === "search") {
    const query = rest.join(" ").trim();
    if (!query) {
      await ctx.reply("Uso: /memory search <texto>");
      return;
    }
    try {
      const hits = await contextMemory.searchMemoryWithContext(query, {
        limit: config.memoryMaxResults,
        chatId: ctx.chat.id,
      });
      if (hits.length === 0) {
        await ctx.reply("Sin resultados en memoria.");
        return;
      }
      const responseText = formatMemoryHitsNaturalText({
        query,
        hits,
        intro: `Recuerdos encontrados para "${query}":`,
        followUpHint: "Tip: usa /memory view <path> <linea> [lineas] para abrir mas contexto.",
      });
      await replyLong(ctx, responseText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude buscar memoria: ${message}`);
    }
    return;
  }

  if (subcommand === "view") {
    const relPath = rest[0]?.trim();
    if (!relPath) {
      await ctx.reply("Uso: /memory view <path> [from] [lines]");
      return;
    }

    const from = rest[1] ? Number.parseInt(rest[1], 10) : undefined;
    const lines = rest[2] ? Number.parseInt(rest[2], 10) : undefined;

    try {
      const result = await contextMemory.readMemoryFile(relPath, from, lines);
      await replyLong(
        ctx,
        [
          `Archivo: ${result.path}`,
          `Rango: ${result.from}-${result.to}`,
          "",
          result.text || "(sin contenido en rango)",
        ].join("\n"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude leer memoria: ${message}`);
    }
    return;
  }

  await ctx.reply("Uso: /memory | /memory search <texto> | /memory view <path> [from] [lines]");
});

bot.command("interests", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  const [subRaw, ...rest] = input.split(/\s+/).filter(Boolean);
  const sub = (subRaw || "status").toLowerCase();
  const value = rest.join(" ").trim();

  if (sub === "add") {
    if (!value) {
      await ctx.reply("Uso: /interests add <tema>");
      return;
    }
    await interestLearning.addManualInterest({
      chatId: ctx.chat.id,
      topic: value,
    });
    await ctx.reply(`Interes agregado para noticias: ${value}`);
    return;
  }

  if (sub === "del" || sub === "rm" || sub === "remove") {
    if (!value) {
      await ctx.reply("Uso: /interests del <keyword>");
      return;
    }
    const removed = await interestLearning.removeInterestKeyword(ctx.chat.id, value);
    await ctx.reply(removed ? `Interes eliminado: ${value}` : `No encontre ese interes: ${value}`);
    return;
  }

  if (sub === "clear" || sub === "reset") {
    const cleared = await interestLearning.clearChat(ctx.chat.id);
    await ctx.reply(cleared ? "Perfil de intereses borrado para este chat." : "No habia perfil de intereses para borrar.");
    return;
  }

  if (sub === "suggest") {
    const candidate = await buildSpontaneousSuggestion(ctx.chat.id);
    if (!candidate) {
      await ctx.reply("Aun no hay senal suficiente de intereses de noticias.");
      return;
    }
    await ctx.reply(candidate.text);
    await interestLearning.markSuggestionSent(ctx.chat.id, candidate.type, new Date());
    return;
  }

  const summary = interestLearning.getSummary(ctx.chat.id, config.suggestionsMaxPerDay);
  if (!summary) {
    await ctx.reply(
      [
        "Aun no hay perfil de intereses para este chat.",
        "Usa: /interests add <tema> para cargar temas de noticias.",
      ].join("\n"),
    );
    return;
  }

  const topCategories =
    summary.topCategories.length > 0
      ? summary.topCategories
          .slice(0, 5)
          .map((item) => `${interestCategoryLabel(item.category)}:${item.score}`)
          .join(" | ")
      : "n/d";
  const topKeywords =
    summary.topKeywords.length > 0
      ? summary.topKeywords
          .slice(0, 8)
          .map((item) => `${item.keyword}:${item.score}`)
          .join(" | ")
      : "n/d";

  await ctx.reply(
    [
      "Perfil de intereses (noticias web):",
      `Observaciones: ${summary.observations}`,
      `Categorias top: ${topCategories}`,
      `Keywords top: ${topKeywords}`,
      `Sugerencias hoy: ${summary.suggestionsToday}/${summary.suggestionsMaxPerDay}`,
      `Ultima sugerencia: ${summary.lastSuggestedAt ?? "nunca"}`,
      "Uso: /interests add <tema> | /interests del <keyword> | /interests clear | /interests suggest",
    ].join("\n"),
  );
});

bot.command("suggest", async (ctx) => {
  const input = String(ctx.match ?? "").trim().toLowerCase();
  if (!input || input === "status") {
    const summary = interestLearning.getSummary(ctx.chat.id, config.suggestionsMaxPerDay);
    const used = summary?.suggestionsToday ?? 0;
    await ctx.reply(
      [
        `Sugerencias espontaneas: ${config.suggestionsEnabled ? "on" : "off"}`,
        `Cuota diaria: ${used}/${config.suggestionsMaxPerDay}`,
        `Min intervalo: ${config.suggestionsMinIntervalMinutes} min`,
        `Min observaciones: ${config.suggestionsMinObservations}`,
        `Poll: ${config.suggestionsPollMs} ms`,
        "Uso: /suggest now | /suggest status | /interests suggest",
      ].join("\n"),
    );
    return;
  }

  if (input !== "now") {
    await ctx.reply("Uso: /suggest now | /suggest status");
    return;
  }

  const candidate = await buildSpontaneousSuggestion(ctx.chat.id);
  if (!candidate) {
    await ctx.reply("Aun no hay senal suficiente para sugerir contenido.");
    return;
  }

  await ctx.reply(candidate.text);
  await interestLearning.markSuggestionSent(ctx.chat.id, candidate.type, new Date());
  await safeAudit({
    type: "interest.suggestion_manual",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      suggestionType: candidate.type,
    },
  });
});

bot.command("selfskill", async (ctx) => {
  const input = String(ctx.match ?? "").trim();
  if (!input) {
    await ctx.reply(
      "Uso: /selfskill <instrucción> | /selfskill list | /selfskill del <n|last> | /selfskill draft <start|add|show|apply|cancel>",
    );
    return;
  }

  const draftMatch = input.match(/^draft(?:\s+(.+))?$/i);
  if (draftMatch) {
    const draftArg = (draftMatch[1] ?? "").trim();
    const [subRaw, ...rest] = draftArg.split(/\s+/);
    const sub = (subRaw || "show").trim().toLowerCase();
    const restText = rest.join(" ").trim();

    const commitDraft = async () => {
      const instruction = sanitizeSelfSkillText(selfSkillDrafts.buildInstruction(ctx.chat.id));
      if (!instruction) {
        await ctx.reply("El borrador esta vacio. Usa /selfskill draft add <texto>.");
        return;
      }
      const saved = await appendDynamicSkillInstruction(instruction);
      await selfSkillDrafts.clearDraft(ctx.chat.id);
      await ctx.reply(
        [
          `Habilidad agregada en ${saved.relPath}:`,
          saved.entry,
          "",
          "Borrador aplicado y cerrado.",
        ].join("\n"),
      );
      await safeAudit({
        type: "selfskill.draft_commit",
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        details: {
          source: "telegram:/selfskill",
          relPath: saved.relPath,
          length: instruction.length,
        },
      });
    };

    try {
      if (sub === "start") {
        const started = await selfSkillDrafts.startDraft({
          chatId: ctx.chat.id,
          userId: ctx.from?.id,
          ...(restText ? { seedLine: restText } : {}),
        });
        await ctx.reply(
          [
            "Borrador de habilidad iniciado.",
            `Lineas: ${started.lines.length}`,
            "Usa /selfskill draft add <texto> para sumar mas lineas.",
            "Usa /selfskill draft apply para guardarlo en AGENTS.md.",
          ].join("\n"),
        );
        return;
      }

      if (sub === "add") {
        if (!restText) {
          await ctx.reply("Uso: /selfskill draft add <texto>");
          return;
        }
        const updated = await selfSkillDrafts.appendLine(ctx.chat.id, restText);
        await ctx.reply(`Linea agregada al borrador. Total: ${updated.lines.length}`);
        return;
      }

      if (sub === "show" || sub === "status" || sub === "list") {
        const draft = selfSkillDrafts.getDraft(ctx.chat.id);
        if (!draft) {
          await ctx.reply("No hay borrador activo.");
          return;
        }
        await ctx.reply(
          [
            `Borrador activo (${draft.lines.length} lineas):`,
            formatSelfSkillDraftLines(draft.lines),
          ].join("\n"),
        );
        return;
      }

      if (sub === "apply" || sub === "commit") {
        await commitDraft();
        return;
      }

      if (sub === "cancel" || sub === "clear") {
        const deleted = await selfSkillDrafts.clearDraft(ctx.chat.id);
        await ctx.reply(deleted ? "Borrador descartado." : "No habia borrador activo.");
        return;
      }

      await ctx.reply("Uso: /selfskill draft <start|add|show|apply|cancel>");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude operar el borrador de skill: ${message}`);
    }
    return;
  }

  const deleteMatch = input.match(/^(?:del|delete|remove|rm|elimina|borra|quita)\s+(.+)$/i);
  if (deleteMatch) {
    const target = deleteMatch[1]?.trim() ?? "";
    const isLast = /\b(last|ultimo|ultima)\b/i.test(target);
    const index = isLast ? -1 : Number.parseInt(target.replace(/[^0-9]/g, ""), 10);
    if (!isLast && (!Number.isFinite(index) || index <= 0)) {
      await ctx.reply("Uso: /selfskill del <n|last>");
      return;
    }

    try {
      const result = await removeDynamicSkillInstruction(isLast ? -1 : index);
      await ctx.reply(
        [
          `Habilidad eliminada (${result.removedIndex}) en ${result.relPath}:`,
          result.removedEntry,
          `Restantes: ${result.remaining}`,
        ].join("\n"),
      );
      await safeAudit({
        type: "selfskill.delete",
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        details: {
          removedIndex: result.removedIndex,
          remaining: result.remaining,
          relPath: result.relPath,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude eliminar la habilidad: ${message}`);
    }
    return;
  }

  const mode = input.toLowerCase();
  if (mode === "list" || mode === "status") {
    try {
      const result = await listDynamicSkillInstructions();
      if (result.entries.length === 0) {
        await ctx.reply(
          [
            `No hay habilidades dinámicas en ${result.relPath}.`,
            "Usa /selfskill <instrucción> para agregar una.",
          ].join("\n"),
        );
        return;
      }

      await replyLong(
        ctx,
        [
          `Habilidades dinámicas en ${result.relPath}:`,
          ...result.entries.map((entry, index) => `${index + 1}. ${entry}`),
        ].join("\n"),
      );
      await safeAudit({
        type: "selfskill.list",
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        details: {
          count: result.entries.length,
          relPath: result.relPath,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude listar habilidades dinámicas: ${message}`);
    }
    return;
  }

  try {
    const result = await appendDynamicSkillInstruction(input);
    await ctx.reply(
      [
        `Habilidad agregada en ${result.relPath}:`,
        result.entry,
        "",
        "Se aplicará en próximas respuestas de IA.",
        "Si quieres reiniciar el servicio ahora: /selfrestart",
        "Para borrar una habilidad: /selfskill del <n>",
        "Si quieres armarla en varios mensajes: /selfskill draft start",
      ].join("\n"),
    );
    await safeAudit({
      type: "selfskill.add",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        relPath: result.relPath,
        length: input.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude agregar la habilidad: ${message}`);
  }
});

bot.command("selfrestart", async (ctx) => {
  await requestAgentServiceRestart({
    ctx,
    source: "selfrestart",
    note: "requested via /selfrestart",
  });
});

bot.command("selfupdate", async (ctx) => {
  const blockReason = getPolicyCapabilityBlockReason(ctx.chat.id, "selfupdate");
  if (blockReason) {
    await ctx.reply(blockReason);
    return;
  }
  const input = String(ctx.match ?? "").trim().toLowerCase();
  const checkOnly = input === "check" || input === "status";
  if (input && !checkOnly && input !== "apply" && input !== "run" && input !== "now") {
    await ctx.reply("Uso: /selfupdate [check]");
    return;
  }

  await requestAgentSelfUpdate({
    ctx,
    source: "selfupdate",
    note: checkOnly ? "requested via /selfupdate check" : "requested via /selfupdate",
    userId: ctx.from?.id,
    checkOnly,
  });
});

bot.command("eco", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();

  if (!raw || raw === "status") {
    await ctx.reply(
      [
        `ECO mode está ${isEcoModeEnabled(ctx.chat.id) ? "on" : "off"}.`,
        `max output tokens ECO: ${config.openAiEcoMaxOutputTokens}`,
      ].join("\n"),
    );
    return;
  }

  if (raw !== "on" && raw !== "off") {
    await ctx.reply("Uso: /eco on|off|status");
    return;
  }

  const enabled = raw === "on";
  setEcoMode(ctx.chat.id, enabled);
  await ctx.reply(
    [
      `ECO mode ahora está ${enabled ? "on" : "off"}.`,
      enabled
        ? `Respuestas IA más compactas y ahorro de tokens (tope ${config.openAiEcoMaxOutputTokens}).`
        : `Se vuelve al tope normal (${config.openAiMaxOutputTokens}) y respuesta estándar.`,
    ].join("\n"),
  );

  await safeAudit({
    type: "eco.toggle",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      enabled,
      maxOutputTokens: enabled ? config.openAiEcoMaxOutputTokens : config.openAiMaxOutputTokens,
    },
  });
});

bot.command("safe", async (ctx) => {
  const input = String(ctx.match ?? "").trim().toLowerCase();
  if (!input || ["status", "show"].includes(input)) {
    await ctx.reply(`SAFE mode está ${isSafeModeEnabled(ctx.chat.id) ? "on" : "off"}.`);
    return;
  }

  if (!["on", "off"].includes(input)) {
    await ctx.reply("Uso: /safe on|off|status");
    return;
  }

  const enabled = input === "on";
  setSafeMode(ctx.chat.id, enabled);
  await ctx.reply(
    enabled
      ? "SAFE mode activado: interpretaré tus mensajes como órdenes precisas y deterministas."
      : "SAFE mode desactivado.",
  );
  await safeAudit({
    type: "safe.toggle",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      enabled,
    },
  });
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
  const blockReason = getPolicyCapabilityBlockReason(ctx.chat.id, "ai-shell");
  if (blockReason) {
    await ctx.reply(blockReason);
    return;
  }
  if (!config.securityProfile.allowAiShell) {
    await ctx.reply(
      `El perfil de seguridad actual (${config.securityProfile.name}) bloquea /shell. Usa HOUDI_SECURITY_PROFILE=full-control para habilitarlo.`,
    );
    return;
  }
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
    await ctx.reply(
      `Admin mode está ${isAdminApprovalRequired(ctx.chat.id) ? "on" : "off"} (perfil: ${config.securityProfile.name}).`,
    );
    return;
  }

  if (raw !== "on" && raw !== "off") {
    await ctx.reply("Uso: /adminmode on|off");
    return;
  }

  const enabled = raw === "on";
  adminSecurity.setAdminMode(ctx.chat.id, enabled);
  persistRuntimeStateSnapshot("runtime:setAdminMode");
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
      `- ${approval.id} | ${approval.kind} | ${formatApprovalCommandLabel(approval.commandLine)} | expira ${approvalRemainingSeconds(approval)}s`,
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
  persistRuntimeStateSnapshot("approval-consume");

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

  if (approval.commandLine === SELF_UPDATE_APPROVAL_COMMAND) {
    await executeAgentSelfUpdate({
      ctx,
      source: `approval:${approval.kind}`,
      note: approval.note,
      userId: ctx.from?.id,
      checkOnly: false,
    });
    return;
  }

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
  persistRuntimeStateSnapshot("approval-deny");

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

bot.command("confirm", async (ctx) => {
  const id = String(ctx.match ?? "").trim();
  if (!id) {
    await ctx.reply("Uso: /confirm <plan_id>");
    return;
  }
  const planned = consumePlannedAction(id, ctx.chat.id);
  if (!planned) {
    await ctx.reply(`No encontré plan pendiente con id ${id} en este chat.`);
    return;
  }
  const trace = startRunTrace({
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    action: `confirm:${planned.kind}`,
    source: "telegram:/confirm",
  });
  await ctx.reply(`Plan ${planned.id} confirmado. Ejecutando...\nrun_id: ${trace.id}`);
  try {
    await executePlannedAction({ ctx, planned });
    await safeAudit({
      type: "plan.confirmed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        ...finishRunTrace({ trace, status: "ok" }),
        planId: planned.id,
        kind: planned.kind,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await safeAudit({
      type: "plan.confirmed.failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        ...finishRunTrace({ trace, status: "error", error: message }),
        planId: planned.id,
        kind: planned.kind,
      },
    });
    await ctx.reply(`Falló la ejecución del plan ${planned.id}: ${message}`);
  }
});

bot.command("cancelplan", async (ctx) => {
  const id = String(ctx.match ?? "").trim();
  if (!id) {
    await ctx.reply("Uso: /cancelplan <plan_id>");
    return;
  }
  const planned = denyPlannedAction(id, ctx.chat.id);
  if (!planned) {
    await ctx.reply(`No encontré plan pendiente con id ${id} en este chat.`);
    return;
  }
  await ctx.reply(`Plan ${planned.id} cancelado.`);
  await safeAudit({
    type: "plan.canceled",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      planId: planned.id,
      kind: planned.kind,
    },
  });
});

bot.command("outbox", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();
  if (!raw || raw === "status") {
    const pending = sqliteState.listOutboxMessages(ctx.chat.id, 200).length;
    const dueNow = sqliteState.listDueOutboxMessages({ chatId: ctx.chat.id, limit: 200 }).length;
    const deadLetterRecent = sqliteState.listOutboxDeadLetter(ctx.chat.id, 200).length;
    await ctx.reply(
      [
        `Outbox pending (chat): ${pending}`,
        `Outbox due now (chat): ${dueNow}`,
        `Outbox dead-letter recientes (chat): ${deadLetterRecent}`,
      ].join("\n"),
    );
    return;
  }
  if (raw === "flush") {
    const result = await flushOutboxForChat(ctx, 30);
    await ctx.reply(`Outbox flush: delivered=${result.delivered} pending=${result.pending}`);
    return;
  }
  if (raw === "recover") {
    await runOutboxRecoveryTick("timer");
    const pending = sqliteState.listOutboxMessages(ctx.chat.id, 200).length;
    await ctx.reply(`Outbox recover ejecutado. pending(chat)=${pending}`);
    return;
  }
  await ctx.reply("Uso: /outbox status|flush|recover");
});

bot.command("policy", async (ctx) => {
  const policy = policyEngine.getPolicy();
  await replyLong(
    ctx,
    [
      `Policy file: ${toProjectRelativePath(policyEngine.getPath())}`,
      `version: ${policy.version}`,
      `previewRequired: ${policy.previewRequired.join(", ")}`,
      `approvalRequired: ${policy.approvalRequired.join(", ")}`,
      `blockInSafeMode: ${policy.blockInSafeMode.join(", ")}`,
    ].join("\n"),
  );
});

bot.command("agenticcanary", async (ctx) => {
  const raw = String(ctx.match ?? "").trim().toLowerCase();
  if (!raw || raw === "status") {
    await ctx.reply(
      `Agentic canary: ${agenticCanary.getRolloutPercent()}% | enabled_chat=${isAgenticCanaryEnabled(ctx.chat.id) ? "sí" : "no"}`,
    );
    return;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    await ctx.reply("Uso: /agenticcanary <0-100> | /agenticcanary status");
    return;
  }
  const next = agenticCanary.setRolloutPercent(parsed);
  await ctx.reply(`Agentic canary actualizado a ${next}% (runtime).`);
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
  persistRuntimeStateSnapshot("runtime:setPanicMode");

  if (enable) {
    const killed = taskRunner.killAll();
    const cleared = adminSecurity.clearAllApprovals();
    persistRuntimeStateSnapshot("panic-clear-approvals");
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

bot.on(["message:photo", "message:document"], async (ctx, next) => {
  const incoming = extractIncomingImage(ctx.message);
  if (!incoming) {
    await next();
    return;
  }

  if (incoming.fileSize && incoming.fileSize > config.imageMaxFileBytes) {
    const limitMb = Math.round(config.imageMaxFileBytes / (1024 * 1024));
    await ctx.reply(`La imagen supera el límite permitido (${limitMb}MB).`);
    return;
  }

  await safeAudit({
    type: "image.received",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      kind: incoming.kind,
      mimeType: incoming.mimeType,
      fileName: incoming.fileName,
      fileSize: incoming.fileSize,
      hasCaption: Boolean(incoming.caption?.trim()),
    },
  });

  try {
    const downloaded = await downloadTelegramFile(incoming.fileId, "imagen");
    if (downloaded.buffer.length > config.imageMaxFileBytes) {
      const limitMb = Math.round(config.imageMaxFileBytes / (1024 * 1024));
      throw new Error(`imagen descargada excede el límite de ${limitMb}MB`);
    }

    const saved = await saveIncomingImage({
      incoming,
      imageBuffer: downloaded.buffer,
      telegramFilePath: downloaded.filePath,
      chatId: ctx.chat.id,
    });
    const resolvedMimeType = resolveIncomingImageMimeType({
      fileName: incoming.fileName,
      mimeType: incoming.mimeType,
      telegramFilePath: downloaded.filePath,
    });

    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: incoming.caption
        ? `[IMAGEN path=${saved.relPath}] ${incoming.caption}`
        : `[IMAGEN path=${saved.relPath}]`,
      source: "telegram:image",
    });

    const summaryHeader = [
      "Imagen guardada.",
      `ruta: ${saved.relPath}`,
      `tamano: ${formatBytes(downloaded.buffer.length)}`,
      `mime: ${resolvedMimeType}`,
    ].join("\n");

    if (!openAi.isConfigured()) {
      await ctx.reply(
        [
          summaryHeader,
          "",
          "OpenAI no está configurado para analizar la imagen (falta OPENAI_API_KEY).",
        ].join("\n"),
      );
      await safeAudit({
        type: "image.saved_no_ai",
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        details: {
          path: saved.relPath,
          bytes: downloaded.buffer.length,
        },
      });
      return;
    }

    const ecoEnabled = isEcoModeEnabled(ctx.chat.id);
    const prompt = incoming.caption?.trim()
      ? [
          "Analiza la imagen adjunta y responde la instrucción del usuario.",
          `Instrucción: ${incoming.caption.trim()}`,
          "Si hay texto visible relevante, inclúyelo en la respuesta.",
          ...(ecoEnabled
            ? [
                "MODO ECO: respuesta ultra-concisa.",
                "Formato exacto: 1) 3 bullets máximos 2) 1 acción sugerida.",
                "Máximo 420 caracteres.",
              ]
            : []),
        ].join("\n")
      : [
          "Describe la imagen en español de forma clara y breve, incluyendo texto visible relevante.",
          ...(ecoEnabled
            ? [
                "MODO ECO: usa 3 bullets máximos y 1 acción sugerida.",
                "Máximo 420 caracteres.",
              ]
            : []),
        ].join("\n");
    const promptContext = await buildPromptContextForQuery(
      incoming.caption?.trim() || `analizar imagen ${path.basename(saved.relPath)}`,
      {
        chatId: ctx.chat.id,
      },
    );
    const analysisRaw = await openAi.analyzeImage({
      image: downloaded.buffer,
      mimeType: resolvedMimeType,
      prompt,
      context: promptContext,
      concise: ecoEnabled,
      maxOutputTokens: ecoEnabled ? Math.min(config.openAiEcoMaxOutputTokens, 180) : undefined,
      model: getOpenAiModelForChat(ctx.chat.id),
    });
    const analysis = ecoEnabled ? truncateInline(analysisRaw, 700) : analysisRaw;

    const response = `${summaryHeader}\n\nAnalisis:\n${analysis}`;
    await replyLong(ctx, response);
    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "assistant",
      text: response,
      source: "telegram:image",
    });
    await safeAudit({
      type: "image.analyzed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: saved.relPath,
        bytes: downloaded.buffer.length,
        mimeType: resolvedMimeType,
        answerChars: analysis.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await safeAudit({
      type: "image.failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        kind: incoming.kind,
        error: message,
      },
    });
    await ctx.reply(`No pude procesar la imagen: ${message}`);
  }
});

bot.on("message:document", async (ctx, next) => {
  const incoming = extractIncomingWorkspaceFile(ctx.message);
  if (!incoming) {
    await next();
    return;
  }

  if (incoming.fileSize && incoming.fileSize > config.fileMaxFileBytes) {
    const limitMb = Math.round(config.fileMaxFileBytes / (1024 * 1024));
    await ctx.reply(`El archivo supera el límite permitido (${limitMb}MB).`);
    return;
  }

  await safeAudit({
    type: "file.received",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      mimeType: incoming.mimeType,
      fileName: incoming.fileName,
      fileSize: incoming.fileSize,
      hasCaption: Boolean(incoming.caption?.trim()),
    },
  });

  try {
    const downloaded = await downloadTelegramFile(incoming.fileId, "archivo");
    if (downloaded.buffer.length > config.fileMaxFileBytes) {
      const limitMb = Math.round(config.fileMaxFileBytes / (1024 * 1024));
      throw new Error(`archivo descargado excede el límite de ${limitMb}MB`);
    }

    const saved = await saveIncomingWorkspaceFile({
      incoming,
      fileBuffer: downloaded.buffer,
      telegramFilePath: downloaded.filePath,
      chatId: ctx.chat.id,
    });

    await appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: incoming.caption
        ? `[ARCHIVO path=${saved.relPath}] ${incoming.caption}`
        : `[ARCHIVO path=${saved.relPath}]`,
      source: "telegram:file",
    });

    await ctx.reply(
      [
        "Archivo guardado en workspace.",
        `ruta: ${saved.relPath}`,
        `tamano: ${formatBytes(downloaded.buffer.length)}`,
        `mime: ${incoming.mimeType || "desconocido"}`,
        "Para listar archivos: /files",
      ].join("\n"),
    );

    await safeAudit({
      type: "file.saved",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        path: saved.relPath,
        bytes: downloaded.buffer.length,
        mimeType: incoming.mimeType,
      },
    });

    const captionTask = incoming.caption?.trim();
    if (captionTask) {
      const instructionText = [
        captionTask,
        "",
        `Archivo adjunto: ${saved.relPath}`,
        "Usa ese archivo como contexto principal para resolver la tarea.",
      ].join("\n");
      await ctx.reply("Ejecutando instrucción del archivo adjunto...");
      await safeAudit({
        type: "file.caption_task_dispatched",
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        details: {
          source: "telegram:file",
          path: saved.relPath,
          captionChars: captionTask.length,
        },
      });
      await runInIncomingQueue({
        chatId: ctx.chat.id,
        source: "telegram:file:caption-task",
        executor: async () =>
          handleIncomingTextMessage({
            ctx,
            text: instructionText,
            source: "telegram:file:caption-task",
            userId: ctx.from?.id,
            persistUserTurn: false,
            allowSlashPrefix: false,
          }),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await safeAudit({
      type: "file.failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        error: message,
        fileName: incoming.fileName,
      },
    });
    await ctx.reply(`No pude guardar el archivo: ${message}`);
  }
});

bot.on(["message:voice", "message:audio", "message:document"], async (ctx, next) => {
  const incoming = extractIncomingAudio(ctx.message);
  if (!incoming) {
    await next();
    return;
  }

  if (!openAi.isConfigured()) {
    await ctx.reply(
      "OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.",
    );
    return;
  }

  if (incoming.fileSize && incoming.fileSize > config.openAiAudioMaxFileBytes) {
    const limitMb = Math.round(config.openAiAudioMaxFileBytes / (1024 * 1024));
    await ctx.reply(`El audio supera el límite permitido (${limitMb}MB).`);
    return;
  }

  await safeAudit({
    type: "audio.received",
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    details: {
      kind: incoming.kind,
      mimeType: incoming.mimeType,
      fileName: incoming.fileName,
      fileSize: incoming.fileSize,
    },
  });

  await replyProgress(ctx, `Audio recibido (${incoming.kind}). Transcribiendo...`);

  try {
    const audioBuffer = await downloadTelegramFileBuffer(incoming.fileId);
    if (audioBuffer.length > config.openAiAudioMaxFileBytes) {
      const limitMb = Math.round(config.openAiAudioMaxFileBytes / (1024 * 1024));
      throw new Error(`audio descargado excede el límite de ${limitMb}MB`);
    }

    const transcript = await openAi.transcribeAudio({
      audio: audioBuffer,
      fileName: incoming.fileName,
      mimeType: incoming.mimeType,
    });
    const transcriptPreview = truncateInline(transcript, 1800);
    const previewTail =
      transcriptPreview.length < transcript.length ? "\n\n[Vista recortada en chat]" : "";

    await replyLong(ctx, `Transcripción:\n${transcriptPreview}${previewTail}`);

    const textForExecution = incoming.caption ? `${transcript}\n\n${incoming.caption}` : transcript;

    await replyProgress(ctx, "Interpretando pedido de audio...");
    await runInIncomingQueue({
      chatId: ctx.chat.id,
      source: "telegram:audio",
      executor: async () =>
        handleIncomingTextMessage({
          ctx,
          text: textForExecution,
          source: "telegram:audio",
          userId: ctx.from?.id,
          persistUserTurn: true,
          allowSlashPrefix: false,
        }),
    });

    await safeAudit({
      type: "audio.transcribed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        kind: incoming.kind,
        transcriptChars: transcript.length,
        captionChars: incoming.caption?.length ?? 0,
        dispatchedTo: "handleIncomingTextMessage",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await safeAudit({
      type: "audio.failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        kind: incoming.kind,
        error: message,
      },
    });
    await ctx.reply(`No pude procesar el audio: ${message}`);
  }
});

async function handleIncomingTextMessage(params: {
  ctx: ChatReplyContext;
  text: string;
  source: string;
  userId?: number;
  persistUserTurn?: boolean;
  allowSlashPrefix?: boolean;
  replyReference?: {
    messageId?: number;
    fromName?: string;
    text: string;
  };
}): Promise<void> {
  const text = params.text.trim();
  if (!text) {
    return;
  }

  const userId = params.userId ?? params.ctx.from?.id;
  const source = params.source;
  const persistUserTurn = params.persistUserTurn ?? true;
  const allowSlashPrefix = params.allowSlashPrefix ?? false;
  const replyReferenceText = params.replyReference?.text?.trim() ?? "";
  const hasReplyReference = replyReferenceText.length > 0;
  const textWithReplyReference = hasReplyReference
    ? [
        text,
        "",
        "[REPLY_REFERENCE]",
        `message_id=${params.replyReference?.messageId ?? "n/a"}`,
        `from=${truncateInline(params.replyReference?.fromName?.trim() || "desconocido", 120)}`,
        `text=${truncateInline(replyReferenceText, 3000)}`,
      ].join("\n")
    : text;

  // Never intercept Telegram slash commands from the free-text pipeline.
  if (!allowSlashPrefix && text.startsWith("/")) {
    return;
  }

  const loopDetection = conversationLoopDetector.record(params.ctx.chat.id, text);
  if (loopDetection.stuck) {
    observability.increment("loop.detected", 1, {
      level: loopDetection.level,
      detector: loopDetection.detector,
      chatId: params.ctx.chat.id,
      source,
    });
    await safeAudit({
      type: "loop.detected",
      chatId: params.ctx.chat.id,
      userId,
      details: {
        level: loopDetection.level,
        detector: loopDetection.detector,
        count: loopDetection.count,
        source,
      },
    });
    if (loopDetection.level === "critical") {
      await reliableReply(
        params.ctx,
        `${loopDetection.message}\nSi quieres, reescribo la acción en un plan paso a paso para ejecutarla una sola vez.`,
        { source: "loop:critical", allowOutbox: true },
      );
      return;
    }
  }

  const handledPendingWorkspaceDelete = await maybeHandlePendingWorkspaceDeleteConfirmation({
    ctx: params.ctx,
    text,
    source,
    userId,
  });
  if (handledPendingWorkspaceDelete) {
    return;
  }

  const handledPendingWorkspaceDeletePath = await maybeHandlePendingWorkspaceDeletePathInput({
    ctx: params.ctx,
    text,
    source,
    userId,
  });
  if (handledPendingWorkspaceDeletePath) {
    return;
  }

  if (detectAgentVersionIntent(text)) {
    const versionReply = buildAgentVersionText();
    if (persistUserTurn) {
      await appendConversationTurn({
        chatId: params.ctx.chat.id,
        userId,
        role: "user",
        text: textWithReplyReference,
        source,
      });
    }
    await params.ctx.reply(versionReply);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId,
      role: "assistant",
      text: versionReply,
      source: `${source}:version-intent`,
    });
    return;
  }

  const handledAsNaturalIntent = await maybeHandleNaturalIntentPipeline({
    ctx: params.ctx,
    text,
    source,
    userId,
    persistUserTurn,
  });
  if (handledAsNaturalIntent) {
    return;
  }

  if (persistUserTurn) {
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId,
      role: "user",
      text: textWithReplyReference,
      source,
    });
  }

  if (isAiShellModeEnabled(params.ctx.chat.id)) {
    try {
      await executeAiShellInstruction(params.ctx, textWithReplyReference);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await params.ctx.reply(`Error en shell IA: ${message}`);
    }
    return;
  }

  if (!openAi.isConfigured()) {
    await params.ctx.reply(
      "OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.",
    );
    return;
  }

  await replyProgress(params.ctx, "Pensando con OpenAI...");

  try {
    const promptContext = await buildPromptContextForQuery(textWithReplyReference, {
      chatId: params.ctx.chat.id,
    });
    const answerRaw = await askOpenAiForChat({
      chatId: params.ctx.chat.id,
      prompt: textWithReplyReference,
      context: promptContext,
    });
    const ecoEnabled = isEcoModeEnabled(params.ctx.chat.id);
    const answer =
      ecoEnabled && !isDetailedAnswerRequested(textWithReplyReference)
        ? compactEcoFreeChatAnswer(answerRaw)
        : answerRaw;
    await replyLong(params.ctx, answer);
    await appendConversationTurn({
      chatId: params.ctx.chat.id,
      userId,
      role: "assistant",
      text: answer,
      source,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.ctx.reply(`Error al consultar OpenAI: ${message}`);
  }
}

async function handleLocalBridgeHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestStartedAt = Date.now();
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = (req.url?.split("?", 1)[0] ?? "/").trim() || "/";
  observability.increment("bridge.http.request", 1, { method, pathname });

  if (method === "GET" && pathname === LOCAL_BRIDGE_HEALTH_PATH) {
    const metrics = observability.snapshot();
    writeJsonResponse(res, 200, {
      ok: true,
      service: "houdi-local-bridge",
      version: config.agentVersion,
      messagePath: LOCAL_BRIDGE_MESSAGE_PATH,
      securityProfile: config.securityProfile.name,
      metrics: {
        counters: metrics.counters.slice(-40),
        timings: metrics.timings,
      },
    });
    observability.timing("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
    return;
  }

  if (method !== "POST" || pathname !== LOCAL_BRIDGE_MESSAGE_PATH) {
    writeJsonResponse(res, 404, {
      ok: false,
      error: "not_found",
    });
    return;
  }

  if (!isLocalBridgeAuthorized(req, config.localApiToken)) {
    writeJsonResponse(res, 401, {
      ok: false,
      error: "unauthorized",
    });
    return;
  }

  let bodyRaw = "";
  try {
    bodyRaw = await readHttpRequestBody(req, LOCAL_BRIDGE_MAX_BODY_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJsonResponse(res, 400, {
      ok: false,
      error: `request_body_invalid: ${message}`,
    });
    return;
  }

  let payload: unknown;
  try {
    payload = bodyRaw ? (JSON.parse(bodyRaw) as unknown) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJsonResponse(res, 400, {
      ok: false,
      error: `json_invalid: ${message}`,
    });
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    writeJsonResponse(res, 400, {
      ok: false,
      error: "payload must be a JSON object",
    });
    return;
  }

  const record = payload as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    writeJsonResponse(res, 400, {
      ok: false,
      error: "text is required",
    });
    return;
  }

  const chatId = parsePositiveInteger(record.chatId) ?? 1;
  const requestId = idempotency.normalizeRequestId(record.requestId);
  if (requestId) {
    const cached = idempotency.read(chatId, requestId);
    if (cached) {
      writeJsonResponse(res, cached.statusCode, {
        ...cached.body,
        idempotent: true,
        requestId,
      });
      observability.increment("bridge.http.idempotency.hit");
      observability.timing("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
      return;
    }
    if (!idempotency.tryAcquire(chatId, requestId)) {
      writeJsonResponse(res, 409, {
        ok: false,
        error: "duplicate_in_flight",
        requestId,
      });
      observability.increment("bridge.http.idempotency.in_flight_reject");
      observability.timing("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
      return;
    }
  }
  const defaultAllowedUserId = config.allowedUserIds.values().next().value as number | undefined;
  const userId = parsePositiveInteger(record.userId) ?? defaultAllowedUserId;

  if (typeof userId !== "number" || !config.allowedUserIds.has(userId)) {
    writeJsonResponse(res, 403, {
      ok: false,
      error: "userId is not authorized",
    });
    return;
  }

  const sourceCandidate = typeof record.source === "string" ? record.source.trim() : "";
  const source = sourceCandidate ? truncateInline(sourceCandidate, 80) : "cli:bridge";
  const replies: string[] = [];
  const ctx: ChatReplyContext = {
    chat: { id: chatId },
    from: { id: userId },
    reply: async (textReply: string) => {
      replies.push(textReply);
      return undefined;
    },
    replyWithDocument: async (_document, options) => {
      const caption = options?.caption?.trim();
      replies.push(
        caption
          ? `${caption}\n[Adjunto no disponible por CLI. Pedímelo por Telegram.]`
          : "Adjunto no disponible por CLI. Pedímelo por Telegram.",
      );
      return undefined;
    },
  };

  try {
    await runInIncomingQueue({
      chatId,
      source,
      executor: async () =>
        handleIncomingTextMessage({
          ctx,
          text,
          source,
          userId,
          persistUserTurn: true,
          allowSlashPrefix: true,
        }),
    });
    writeJsonResponse(res, 200, {
      ok: true,
      chatId,
      userId,
      replies,
      ...(requestId ? { requestId } : {}),
    });
    observability.increment("bridge.http.message.ok");
    if (requestId) {
      idempotency.save(chatId, requestId, {
        statusCode: 200,
        body: {
          ok: true,
          chatId,
          userId,
          replies,
          requestId,
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Local bridge error: ${message}`);
    const payloadError = {
      ok: false,
      error: message,
      ...(requestId ? { requestId } : {}),
    };
    writeJsonResponse(res, 500, payloadError);
    observability.increment("bridge.http.message.error");
    if (requestId) {
      idempotency.save(chatId, requestId, {
        statusCode: 500,
        body: payloadError,
      });
    }
  } finally {
    if (requestId) {
      idempotency.release(chatId, requestId);
    }
    observability.timing("bridge.http.request.latency_ms", Date.now() - requestStartedAt);
  }
}

async function startLocalBridgeServer(): Promise<void> {
  if (!config.localApiEnabled) {
    logInfo("Local CLI bridge API deshabilitada (HOUDI_LOCAL_API_ENABLED=false).");
    return;
  }
  if (localBridgeServer) {
    return;
  }

  const server = createServer((req, res) => {
    void handleLocalBridgeHttpRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.localApiPort, config.localApiHost);
  });

  localBridgeServer = server;
  logInfo(`Local CLI bridge API escuchando en http://${config.localApiHost}:${config.localApiPort}`);
}

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.trim().startsWith("/")) {
    return;
  }
  const replied = (ctx.message as { reply_to_message?: Record<string, unknown> }).reply_to_message;
  const repliedTextRaw =
    replied && typeof replied === "object"
      ? (typeof replied.text === "string"
          ? replied.text
          : typeof replied.caption === "string"
            ? replied.caption
            : "")
      : "";
  const repliedMessageId =
    replied && typeof replied === "object" && typeof replied.message_id === "number" ? replied.message_id : undefined;
  const repliedFromName = (() => {
    if (!replied || typeof replied !== "object") {
      return "";
    }
    const from = (replied as { from?: unknown }).from;
    if (!from || typeof from !== "object") {
      return "";
    }
    const firstName = (from as { first_name?: unknown }).first_name;
    return typeof firstName === "string" ? firstName : "";
  })();

  await runInIncomingQueue({
    chatId: ctx.chat.id,
    source: "telegram:message",
    executor: async () =>
      handleIncomingTextMessage({
        ctx,
        text: ctx.message.text,
        source: "telegram:message",
        userId: ctx.from?.id,
        persistUserTurn: true,
        allowSlashPrefix: false,
        ...(repliedTextRaw.trim()
          ? {
              replyReference: {
                ...(typeof repliedMessageId === "number" ? { messageId: repliedMessageId } : {}),
                ...(repliedFromName.trim() ? { fromName: repliedFromName.trim() } : {}),
                text: repliedTextRaw.trim(),
              },
            }
          : {}),
      }),
  });
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

try {
  await startLocalBridgeServer();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logWarn(`No pude iniciar Local CLI bridge API: ${message}`);
}

startOutboxRecoveryWorker();

logInfo("Starting Telegram bot...");
await bot.start();
