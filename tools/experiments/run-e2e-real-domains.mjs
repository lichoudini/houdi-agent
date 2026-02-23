#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const targetDomains = [
  "self-maintenance",
  "schedule",
  "memory",
  "gmail-recipients",
  "gmail",
  "workspace",
  "document",
  "web",
];

const TARGET_FULL_ACCURACY = Number.parseFloat(process.env.E2E_TARGET_ACCURACY || "0.95");
const MIN_SAMPLES_PER_DOMAIN = Number.parseInt(process.env.E2E_MIN_SAMPLES || "20", 10);
const FALLBACK_CASES_PER_ROUND = Number.parseInt(process.env.E2E_FALLBACK_CASES_PER_ROUND || "2", 10);

const initialCases = [
  // bootstrap para el dominio document
  { domain: "workspace", text: "crear archivo e2e-doc.txt con contenido hola e2e" },

  { domain: "self-maintenance", text: "listar habilidades activas del bot" },
  { domain: "self-maintenance", text: "mostrar skills dinamicas activas" },
  { domain: "self-maintenance", text: "que capacidades del agente estan activas" },
  { domain: "self-maintenance", text: "ver estado de herramientas del bot" },

  { domain: "schedule", text: "listar tareas pendientes" },
  { domain: "schedule", text: "crear tarea mañana a las 09:00 revisar backup e2e" },
  { domain: "schedule", text: "mostrar recordatorios de hoy" },
  { domain: "schedule", text: "ver tareas programadas" },

  { domain: "memory", text: "estado de memoria" },
  { domain: "memory", text: "buscar en memoria cloudflare" },
  { domain: "memory", text: "recordas cloudflare" },
  { domain: "memory", text: "consultar memoria sobre cloudflare" },

  { domain: "gmail-recipients", text: "listar destinatarios guardados de gmail" },
  { domain: "gmail-recipients", text: "ver contactos guardados para correo" },
  { domain: "gmail-recipients", text: "mostrar destinatarios de correo guardados" },
  { domain: "gmail-recipients", text: "ver destinatarios frecuentes de gmail" },

  { domain: "gmail", text: "mostrar inbox no leidos" },
  { domain: "gmail", text: "listar correos recientes" },
  { domain: "gmail", text: "estado de gmail" },
  { domain: "gmail", text: "leer bandeja de entrada" },

  { domain: "workspace", text: "ver archivos del workspace" },
  { domain: "workspace", text: "listar archivos" },
  { domain: "workspace", text: "crear archivo e2e-ws.txt con contenido prueba e2e" },
  { domain: "workspace", text: "leer archivo e2e-ws.txt" },

  { domain: "document", text: "leer documento e2e-doc.txt" },
  { domain: "document", text: "analizar documento e2e-doc.txt" },
  { domain: "document", text: "resumir documento e2e-doc.txt" },
  { domain: "document", text: "abrir documento e2e-doc.txt" },

  { domain: "web", text: "buscar en web cloudflare tunnel" },
  { domain: "web", text: "investigar en internet cloudflare zero trust" },
  { domain: "web", text: "buscar noticias cloudflare" },
  { domain: "web", text: "dame links de cloudflare" },
];

const fallbackByDomain = {
  "self-maintenance": [
    "listar habilidades activas del bot",
    "mostrar skills activas del bot",
    "listar capacidades activas del agente",
    "ver habilidades dinamicas activas",
    "listar reglas activas del bot",
    "mostrar habilidades configuradas activas",
    "ver skills activas del agente",
    "listar estado de skills activas",
  ],
  schedule: [
    "listar tareas pendientes",
    "listar tareas programadas",
    "ver tareas pendientes",
    "mostrar agenda de tareas",
    "listar recordatorios de tareas",
    "ver agenda programada de tareas",
    "mostrar tareas activas",
    "listar recordatorios pendientes",
  ],
  memory: [
    "estado de memoria",
    "buscar en memoria cloudflare",
    "consultar memoria sobre cloudflare",
    "mostrar estado actual de memoria",
    "consultar registros de memoria cloudflare",
    "buscar memoria de cloudflare zero trust",
    "consultar memoria cloudflare",
    "estado actual de memoria del agente",
  ],
  "gmail-recipients": [
    "listar destinatarios guardados de gmail",
    "mostrar destinatarios guardados de gmail",
    "ver lista de destinatarios gmail",
    "listar destinatarios de correo guardados",
    "mostrar agenda de destinatarios de gmail",
    "ver destinatarios guardados",
    "listar destinatarios frecuentes de gmail",
    "mostrar lista de destinatarios actuales",
  ],
  gmail: [
    "mostrar inbox no leidos",
    "listar correos recientes",
    "estado de gmail",
    "leer bandeja de entrada",
    "ver estado de cuenta gmail",
    "mostrar mails no leidos",
    "listar mensajes del inbox",
    "consultar inbox gmail",
  ],
  workspace: [
    "ver archivos del workspace",
    "listar archivos",
    "mostrar archivos del workspace",
    "listar archivos del workspace",
    "ver listado de archivos del workspace",
    "mostrar estructura de archivos del workspace",
    "listar carpetas y archivos del workspace",
    "ver archivos actuales del workspace",
  ],
  document: [
    "leer documento e2e-doc.txt",
    "analizar documento e2e-doc.txt",
    "resumir documento e2e-doc.txt",
    "abrir documento e2e-doc.txt",
    "leer archivo e2e-doc.txt como documento",
    "hacer resumen de e2e-doc.txt",
    "analiza el contenido de e2e-doc.txt",
    "abrir y leer documento e2e-doc.txt",
  ],
  web: [
    "buscar en web cloudflare",
    "buscar en internet cloudflare",
    "buscar noticias cloudflare",
    "dame links de cloudflare",
    "buscar en internet cloudflare tunnel",
    "buscar cloudflare en web",
    "buscar novedades cloudflare en web",
    "consultar en web sobre cloudflare",
  ],
};

function parseEnv(raw) {
  const env = {};
  const lines = String(raw || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postMessage({ apiUrl, token, source, chatId, userId, text, timeoutMs = 45000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        text,
        source,
        chatId,
        userId,
      }),
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body: json,
      error: null,
      timeout: false,
    };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      body: null,
      error: timeout ? "timeout" : error instanceof Error ? error.message : String(error),
      timeout,
    };
  } finally {
    clearTimeout(timer);
  }
}

function pushCount(mapObj, key) {
  mapObj[key] = (mapObj[key] || 0) + 1;
}

function buildCase({ baseSource, round, index, domain, text }) {
  return {
    id: `${round}:${index}:${domain}`,
    round,
    domain,
    text,
    source: `${baseSource}:r${round}:i${index}`,
  };
}

function resolveTrackedSource(source, sourceSet) {
  if (sourceSet.has(source)) {
    return source;
  }
  const seqIdx = source.indexOf(":seq-step-");
  if (seqIdx > 0) {
    const root = source.slice(0, seqIdx);
    if (sourceSet.has(root)) {
      return root;
    }
  }
  const chainIdx = source.indexOf(":chain-");
  if (chainIdx > 0) {
    const root = source.slice(0, chainIdx);
    if (sourceSet.has(root)) {
      return root;
    }
  }
  return null;
}

async function readAuditBySource({ auditPath, sourceSet }) {
  const raw = await fs.readFile(auditPath, "utf8").catch(() => "");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const buckets = new Map();
  for (const source of sourceSet) {
    buckets.set(source, {
      route: null,
      routeReason: null,
      routeHits: {},
      execByRoute: new Map(),
    });
  }

  for (const line of lines) {
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (!row || !row.details) continue;
    const details = row.details || {};
    const source = String(details.source || "");
    const trackedSource = resolveTrackedSource(source, sourceSet);
    if (!trackedSource) continue;
    const bucket = buckets.get(trackedSource);
    if (!bucket) continue;

    if (row.type === "intent.route") {
      const handler = String(details.handler || "");
      if (handler) {
        bucket.routeHits[handler] = (bucket.routeHits[handler] || 0) + 1;
        if (source === trackedSource) {
          bucket.route = handler;
        } else if (!bucket.route) {
          bucket.route = handler;
        }
      }
      if (!bucket.routeReason) {
        bucket.routeReason = String(details.routeFilterReason || details.routeHierarchyReason || "");
      }
      continue;
    }

    if (row.type === "intent.execution.result") {
      const route = String(details.route || "");
      if (!route) continue;
      const prev = bucket.execByRoute.get(route);
      const actionSuccess = details.actionSuccess === true;
      bucket.execByRoute.set(route, {
        handled: (prev?.handled || false) || details.handled === true,
        actionSuccess: (prev?.actionSuccess || false) || actionSuccess,
        actionError: actionSuccess ? null : details.actionError ? String(details.actionError) : (prev?.actionError ?? null),
      });
    }
  }
  return buckets;
}

function evaluateCases({ cases, deliveredBySource, auditBySource }) {
  const outcomes = [];
  for (const current of cases) {
    const delivery = deliveredBySource.get(current.source) || null;
    const audit = auditBySource.get(current.source) || null;
    const selectedRoute = audit?.route || null;
    const expectedExec = audit?.execByRoute?.get(current.domain) || null;
    const routeHits = audit?.routeHits || {};
    const routeHitCount = Number(routeHits[current.domain] || 0);

    const routePass = routeHitCount > 0 || selectedRoute === current.domain;
    const actionPass = expectedExec?.actionSuccess === true;
    const fullPass = routePass && actionPass;

    let failure = null;
    if (!fullPass) {
      if (!routePass) {
        failure = delivery?.timeout ? "http-timeout" : `route:${selectedRoute || "none"}`;
      } else if (!expectedExec) {
        failure = "no-exec";
      } else if (!actionPass) {
        failure = expectedExec.actionError ? `action:${expectedExec.actionError}` : "action:failed";
      } else if (delivery && !delivery.ok) {
        if (delivery.timeout) {
          failure = "http-timeout";
        } else if (delivery.status > 0) {
          failure = `http-${delivery.status}`;
        } else {
          failure = `http-error:${delivery.error || "unknown"}`;
        }
      }
    }

    outcomes.push({
      ...current,
      routePass,
      actionPass,
      fullPass,
      selectedRoute,
      routeHitCount,
      failure,
      deliveryOk: delivery?.ok === true,
      deliveryStatus: delivery?.status || 0,
    });
  }
  return outcomes;
}

function summarizeOutcomes(outcomes) {
  const rows = new Map();
  for (const domain of targetDomains) {
    rows.set(domain, {
      domain,
      total: 0,
      routeOk: 0,
      actionOk: 0,
      fullOk: 0,
      failures: {},
    });
  }
  for (const row of outcomes) {
    if (!rows.has(row.domain)) continue;
    const slot = rows.get(row.domain);
    if (!slot) continue;
    slot.total += 1;
    if (row.routePass) slot.routeOk += 1;
    if (row.actionPass) slot.actionOk += 1;
    if (row.fullPass) slot.fullOk += 1;
    if (!row.fullPass) {
      pushCount(slot.failures, row.failure || "unknown");
    }
  }
  return Array.from(rows.values());
}

function domainNeedsFallback(row) {
  if (!row) return true;
  if (row.total < MIN_SAMPLES_PER_DOMAIN) return true;
  return row.fullOk / row.total < TARGET_FULL_ACCURACY;
}

function topErrorText(failures) {
  return Object.entries(failures || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
}

async function main() {
  const envRaw = await fs.readFile(path.resolve(process.cwd(), ".env"), "utf8");
  const env = parseEnv(envRaw);
  const host = env.HOUDI_LOCAL_API_HOST || "127.0.0.1";
  const port = env.HOUDI_LOCAL_API_PORT || "3210";
  const token = env.HOUDI_LOCAL_API_TOKEN || "";
  const chatId = Number.parseInt(env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "0", 10) || 8482923834;
  const userId = chatId;
  const apiUrl = `http://${host}:${port}/internal/cli/message`;
  const auditPath = path.resolve(process.cwd(), env.AUDIT_LOG_PATH || "houdi-audit.log");
  const sourceTag = `e2e:real:${new Date().toISOString().replace(/[:.]/g, "-")}`;

  if (!token) {
    console.error("HOUDI_LOCAL_API_TOKEN no configurado.");
    process.exit(1);
  }

  console.log(`sourceTag=${sourceTag}`);
  console.log(`api=${apiUrl}`);
  console.log(`audit=${auditPath}`);

  let sequence = 0;
  const allCases = [];
  const deliveredBySource = new Map();
  const fallbackCursorByDomain = new Map(targetDomains.map((domain) => [domain, 0]));

  function nextFallbackText(domain) {
    const variants = fallbackByDomain[domain] || [];
    if (variants.length === 0) {
      return null;
    }
    const index = fallbackCursorByDomain.get(domain) || 0;
    const text = variants[index % variants.length] || variants[0];
    fallbackCursorByDomain.set(domain, index + 1);
    return text;
  }

  async function runBatch(batchCases, label) {
    console.log(`batch=${label} cases=${batchCases.length}`);
    let idx = 0;
    for (const row of batchCases) {
      const result = await postMessage({
        apiUrl,
        token,
        source: row.source,
        chatId,
        userId,
        text: row.text,
      });
      deliveredBySource.set(row.source, result);
      idx += 1;
      if (!result.ok) {
        console.log(
          `warn source=${row.source} status=${result.status || 0} timeout=${result.timeout ? "yes" : "no"} error=${result.error || "none"}`,
        );
      }
      if (idx === batchCases.length || idx % 5 === 0) {
        console.log(`batch=${label} progress=${idx}/${batchCases.length}`);
      }
      await sleep(450);
    }
    // Allow async audits/replies to settle before evaluating this batch.
    await sleep(15000);
  }

  const seedCases = initialCases.map((entry) =>
    buildCase({
      baseSource: sourceTag,
      round: 0,
      index: ++sequence,
      domain: entry.domain,
      text: entry.text,
    }),
  );
  allCases.push(...seedCases);
  await runBatch(seedCases, "seed");

  let auditBySource = await readAuditBySource({
    auditPath,
    sourceSet: new Set(allCases.map((row) => row.source)),
  });
  let outcomes = evaluateCases({
    cases: allCases,
    deliveredBySource,
    auditBySource,
  });
  let summary = summarizeOutcomes(outcomes);

  const maxRounds = Number.parseInt(process.env.E2E_MAX_ROUNDS || "24", 10);
  for (let round = 1; round <= maxRounds; round += 1) {
    const failing = summary.filter((row) => domainNeedsFallback(row)).map((row) => row.domain);
    if (failing.length === 0) break;

    const batch = [];
    for (const domain of failing) {
      for (let i = 0; i < FALLBACK_CASES_PER_ROUND; i += 1) {
        const text = nextFallbackText(domain);
        if (!text) continue;
        batch.push(
          buildCase({
            baseSource: sourceTag,
            round,
            index: ++sequence,
            domain,
            text,
          }),
        );
      }
    }
    if (batch.length === 0) break;
    allCases.push(...batch);
    await runBatch(batch, `fallback-${round}`);
    auditBySource = await readAuditBySource({
      auditPath,
      sourceSet: new Set(allCases.map((row) => row.source)),
    });
    outcomes = evaluateCases({
      cases: allCases,
      deliveredBySource,
      auditBySource,
    });
    summary = summarizeOutcomes(outcomes);
  }

  // Final grace period for late audit writes from slower domains (e.g. gmail/web).
  await sleep(12000);
  auditBySource = await readAuditBySource({
    auditPath,
    sourceSet: new Set(allCases.map((row) => row.source)),
  });
  outcomes = evaluateCases({
    cases: allCases,
    deliveredBySource,
    auditBySource,
  });
  summary = summarizeOutcomes(outcomes);

  console.log("");
  console.log("E2E Real Domain Accuracy (execution)");
  console.log(
    `target=${(TARGET_FULL_ACCURACY * 100).toFixed(0)}% | min_samples=${MIN_SAMPLES_PER_DOMAIN} | fallback_per_round=${FALLBACK_CASES_PER_ROUND}`,
  );
  for (const row of summary) {
    const fullPct = row.total > 0 ? ((row.fullOk / row.total) * 100).toFixed(2) : "0.00";
    const routePct = row.total > 0 ? ((row.routeOk / row.total) * 100).toFixed(2) : "0.00";
    const actionPct = row.total > 0 ? ((row.actionOk / row.total) * 100).toFixed(2) : "0.00";
    const errors = topErrorText(row.failures);
    console.log(
      `- ${row.domain} | full=${fullPct}% (${row.fullOk}/${row.total}) | route=${routePct}% (${row.routeOk}/${row.total}) | action=${actionPct}% (${row.actionOk}/${row.total})${errors ? ` | errors=${errors}` : ""}`,
    );
  }

  const allGood = summary.every((row) => !domainNeedsFallback(row));
  console.log("");
  console.log(
    `target_met(>=${(TARGET_FULL_ACCURACY * 100).toFixed(0)}% y >=${MIN_SAMPLES_PER_DOMAIN} muestras): ${allGood ? "YES" : "NO"}`,
  );
  console.log(`sent_messages=${allCases.length}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`run-e2e-real-domains error: ${message}`);
  process.exitCode = 1;
});
