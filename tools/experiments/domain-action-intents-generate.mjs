#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const outPath = path.resolve(process.cwd(), process.argv[2] || "datasets/domain-action-intents.es-ar.jsonl");
const roundsRaw = Number.parseInt(process.argv[3] || "24", 10);
const rounds = Number.isFinite(roundsRaw) ? Math.max(8, Math.min(80, roundsRaw)) : 24;

const emails = ["carla.ops@empresa.com", "ventas@empresa.com", "richard@vrand.biz"];
const names = ["Carla", "Nazareno", "Sofia", "Gaston"];
const files = ["maggie-simpson.txt", "reporte-q1.md", "clientes.csv", "pino.txt"];
const topics = ["marketing", "cloudflare", "openclaw", "dkim dmarc spf"];
const taskIds = ["tsk-abc123", "tsk-mlz4df9a"];
const prefixes = ["", "che", "dale", "porfa", "oye", "sale"];
const suffixes = ["", "ahora", "cuando puedas", "por favor", "de una"];

const templates = {
  gmail: [
    { action: "send", text: "enviar correo a {email} con novedades de {topic}" },
    { action: "send", text: "mandar mail a {email}" },
    { action: "list", text: "mostrar inbox" },
    { action: "list", text: "leer correos no leidos" },
    { action: "read", text: "leer correo 1" },
    { action: "status", text: "estado de gmail" },
    { action: "profile", text: "perfil de gmail" },
  ],
  "gmail-recipients": [
    { action: "add", text: "agregar destinatario {name} {email}" },
    { action: "update", text: "actualizar destinatario {name} con {email}" },
    { action: "delete", text: "eliminar destinatario {name}" },
    { action: "list", text: "listar destinatarios guardados" },
    { action: "add", text: "sumar contacto {name} {email}" },
    { action: "update", text: "editar destinatario {name} email {email}" },
  ],
  workspace: [
    { action: "write", text: "editar {file} con otro poema" },
    { action: "write", text: "en {file} escribir otro poema" },
    { action: "list", text: "ver archivos" },
    { action: "read", text: "leer archivo {file}" },
    { action: "delete", text: "eliminar {file}" },
    { action: "move", text: "mover {file} a archivados/{file}" },
    { action: "rename", text: "renombrar {file} a backup-{file}" },
    { action: "send", text: "enviar {file} por telegram" },
  ],
  "self-maintenance": [
    { action: "restart-service", text: "reinicia el agente" },
    { action: "update-service", text: "actualiza el bot desde github" },
    { action: "list-skills", text: "que habilidades tenes activas" },
    { action: "delete-skill", text: "elimina la habilidad 2" },
    { action: "delete-skill", text: "elimina la habilidad #sk_abc123" },
    { action: "add-skill", text: "crea una skill para interpretar mejor español rioplatense" },
  ],
};

const negatives = [
  { domain: "gmail", text: "agregar destinatario Carla carla.ops@empresa.com" },
  { domain: "gmail-recipients", text: "enviar correo a carla.ops@empresa.com" },
  { domain: "workspace", text: "recordame mañana comprar pan" },
  { domain: "self-maintenance", text: "abrir https://cloudflare.com" },
];

function pick(arr, i) {
  return arr[i % arr.length];
}

function fill(template, i) {
  return template
    .replaceAll("{email}", pick(emails, i))
    .replaceAll("{name}", pick(names, i))
    .replaceAll("{file}", pick(files, i))
    .replaceAll("{topic}", pick(topics, i))
    .replaceAll("{taskId}", pick(taskIds, i));
}

function stylize(text, i) {
  const prefix = pick(prefixes, i);
  const suffix = pick(suffixes, i + 1);
  if (i % 4 === 0) {
    return `${prefix} ${text} ${suffix}`.replace(/\s+/g, " ").trim();
  }
  if (i % 4 === 1) {
    return `${text} ${suffix}`.replace(/\s+/g, " ").trim();
  }
  if (i % 4 === 2) {
    return `${prefix} ${text}`.replace(/\s+/g, " ").trim();
  }
  return `${text}?`;
}

function normalize(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_:-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const rows = [];
for (const [domain, domainTemplates] of Object.entries(templates)) {
  for (let i = 0; i < rounds; i += 1) {
    const tpl = domainTemplates[i % domainTemplates.length];
    rows.push({
      domain,
      text: stylize(fill(tpl.text, i), i),
      expected_should_handle: true,
      expected_action: tpl.action,
      source: "domain-action-intents-v1",
    });
  }
}

for (let i = 0; i < negatives.length; i += 1) {
  const neg = negatives[i];
  rows.push({
    domain: neg.domain,
    text: stylize(neg.text, i + 1000),
    expected_should_handle: false,
    expected_action: null,
    source: "domain-action-intents-v1-negative",
  });
}

const dedup = new Map();
for (const row of rows) {
  const key = `${row.domain}::${normalize(row.text)}::${row.expected_should_handle}::${row.expected_action ?? "-"}`;
  if (!dedup.has(key)) {
    dedup.set(key, row);
  }
}

const out = [...dedup.values()];
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${out.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(`dataset action generado: ${out.length} -> ${outPath}`);
