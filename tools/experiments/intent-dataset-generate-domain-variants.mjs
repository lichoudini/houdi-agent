#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const outPath = path.resolve(process.cwd(), process.argv[2] || "datasets/intent-domain-variants.es-ar.jsonl");
const perDomainRaw = Number.parseInt(process.argv[3] || "220", 10);
const perDomain = Number.isFinite(perDomainRaw) ? Math.max(60, Math.min(1200, perDomainRaw)) : 220;

const domains = [
  "self-maintenance",
  "lim",
  "schedule",
  "memory",
  "gmail-recipients",
  "gmail",
  "workspace",
  "document",
  "web",
];

const countries = ["AR", "CL", "MX"];
const localeByCountry = {
  AR: {
    prefixes: ["che", "dale", "porfa", ""],
    suffixes: ["", "gracias", "cuando puedas", "ahora"],
    politeness: ["", "por favor", "si podes", "si podés"],
  },
  CL: {
    prefixes: ["oye", "ya po", "porfa", ""],
    suffixes: ["", "gracias", "cuando puedas", "ahora"],
    politeness: ["", "por favor", "si puedes", "cuando puedas"],
  },
  MX: {
    prefixes: ["oye", "sale", "porfa", ""],
    suffixes: ["", "gracias", "cuando puedas", "ahorita"],
    politeness: ["", "por favor", "si puedes", "cuando puedas"],
  },
};

const topics = [
  "openclaw",
  "semantic router",
  "marketing",
  "cloudflare",
  "dkim dmarc spf",
  "boca juniors",
  "docker",
  "github actions",
  "chatgpt 5.3",
];
const names = ["Nazareno", "Carla", "Juan", "Sofia", "Gaston", "Mica", "Pedro", "Vale"];
const emails = [
  "nazareno.tomaselli@vrand.biz",
  "houdi@houdiagent.com",
  "carla.ops@empresa.com",
  "ventas@empresa.com",
  "soporte@empresa.com",
  "richard@vrand.biz",
];
const files = [
  "maggie-simpson.txt",
  "leo-poema.txt",
  "reporte-q1.md",
  "clientes.csv",
  "infra-notes.txt",
  "pino.txt",
  "cabeza.txt",
];
const filePrefixes = ["mag...", "leo...", "repo...", "clie...", "pino...", "cabe..."];
const docs = ["contrato.pdf", "anexo-legal.pdf", "brief.docx", "roadmap-2026.pdf"];
const taskRefs = ["tsk-mlz4df9a", "tsk_mlz9k2a", "tsk-abc123", "tsk_mlz-plan-01"];
const hours = ["09:00", "10:30", "18:45", "7am", "manana 9am", "hoy 17hs", "viernes 11"];
const limSources = ["account_demo_b_marylin", "crm_main", "drip_leads", "vrand_source"];
const extras = [
  "sin vueltas",
  "modo operativo",
  "en esta pc",
  "en este chat",
  "con prioridad alta",
  "paso a paso",
  "ahora mismo",
  "si se puede",
  "sin romper lo que ya anda",
];

const templatesByDomain = {
  "self-maintenance": [
    "reinicia el agente",
    "actualiza el bot desde github",
    "estado del servicio houdi-agent",
    "crear skill para entender mejor rioplatense",
    "eliminar habilidad 2",
    "eliminar la habilidad #sk_abc123",
    "lista las habilidades dinamicas",
    "version del agente",
    "publicar cambios del agente",
    "hacer pull y rebuild del bot",
    "eliminar skill por id #sk_abc123",
    "mostrar estado del bot y puentes",
  ],
  lim: [
    "inicia lim",
    "detener lim",
    "reinicia lim",
    "estado lim",
    "consulta lim de {name} Perez en {limSource}",
    "buscar en lim first_name {name} last_name Perez source {limSource}",
    "listar lim",
    "revisar lim de {name} perez fuente {limSource}",
    "lim status detallado",
    "reinicia lim y verifica el tunel",
    "buscar en lim prospectos de {name}",
    "consulta lim con source {limSource}",
  ],
  schedule: [
    "recordame {hour} comprar pan",
    "agenda tarea para {hour} enviar reporte semanal",
    "programa para manana a las 9 enviar correo a {email}",
    "editar {taskRef} para {hour}",
    "borrar {taskRef}",
    "eliminar la ultima tarea",
    "listar tareas pendientes",
    "crear tarea diaria 9am ejecutar lista lim",
    "programa para {hour} buscar web sobre {topic}",
    "agendar para {hour} enviar correo a {email}",
    "editar {taskRef} y cambiar titulo a revisar {topic}",
    "mostrar tareas de hoy",
  ],
  memory: [
    "te acordas de lo que hablamos de {topic}",
    "busca en memoria sobre {topic}",
    "recordas lo de {topic}",
    "memoria status",
    "consulta memoria de {topic}",
    "me habias dicho algo sobre {topic}",
    "mostrar memoria reciente",
    "busca en memoria",
    "consulta memoria de conversaciones sobre {topic}",
    "trae de memoria lo de {topic}",
    "recordas lo que definimos de {topic}",
    "buscar memoria por tema {topic}",
  ],
  "gmail-recipients": [
    "agrega destinatario {name} {email}",
    "actualiza destinatario {name} con {email}",
    "elimina destinatario {name}",
    "listar destinatarios guardados",
    "guardar contacto {name} {email}",
    "actualizar contacto {name}",
    "borrar destinatario",
    "agenda de contactos gmail",
    "sumar contacto {name} {email}",
    "editar destinatario {name} email {email}",
    "quitar contacto {name}",
    "ver lista de contactos de correo",
  ],
  gmail: [
    "enviar correo a {email} con un chiste sobre marketing",
    "mandar mail a {email} con novedades de {topic}",
    "leer correos no leidos",
    "mostrar inbox",
    "responder el ultimo correo",
    "marcar como leido el correo 2",
    "enviar correo",
    "enviar correo a {name}",
    "enviar un mail a {email} con asunto {topic}",
    "leer el ultimo correo",
    "buscar correos sobre {topic}",
    "enviar correo a {email}",
  ],
  workspace: [
    "crear archivo {file} con un resumen",
    "editar {filePrefix} con otro poema",
    "en archivo {filePrefix} escribir otro poema",
    "en {filePrefix} escribir otro poema",
    "ver archivos",
    "abrir /img...",
    "eliminar {filePrefix}",
    "mover {file} a archivados/{file}",
    "listar /workspace/img...",
    "enviar {filePrefix}",
    "renombrar {file} a backup-{file}",
    "leer archivo {filePrefix}",
  ],
  document: [
    "leer documento {doc}",
    "analiza {doc}",
    "resumir pdf {doc}",
    "abrir documento {doc}",
    "interpretar el archivo {doc}",
    "analiza documento",
    "resumi este pdf",
    "leer documento",
    "extraer texto de {doc}",
    "documento {doc} resumen ejecutivo",
    "analizar documento legal {doc}",
    "abrir archivo {doc} y explicar",
  ],
  web: [
    "buscar en web ultimas noticias de {topic}",
    "investiga {topic} en internet",
    "abrir https://cloudflare.com y resumir",
    "buscar informacion oficial sobre {topic}",
    "que paso hoy con {topic}",
    "buscar en google {topic}",
    "abrir resultado 2",
    "busca en web",
    "buscar fuentes oficiales de {topic}",
    "investigar en web sobre {topic}",
    "dame links de {topic}",
    "abrir url y analizar: https://example.com",
  ],
};

function pick(arr, i) {
  return arr[i % arr.length];
}

function fill(template, i) {
  return template
    .replaceAll("{topic}", pick(topics, i))
    .replaceAll("{name}", pick(names, i))
    .replaceAll("{email}", pick(emails, i))
    .replaceAll("{file}", pick(files, i))
    .replaceAll("{filePrefix}", pick(filePrefixes, i))
    .replaceAll("{doc}", pick(docs, i))
    .replaceAll("{taskRef}", pick(taskRefs, i))
    .replaceAll("{hour}", pick(hours, i))
    .replaceAll("{limSource}", pick(limSources, i));
}

function stylize(base, idx, localeProfile) {
  const style = idx % 7;
  const prefix = pick(localeProfile.prefixes, idx);
  const suffix = pick(localeProfile.suffixes, idx + 2);
  const polite = pick(localeProfile.politeness, idx + 4);
  const extra = pick(extras, idx + 1);
  const compact = base.replace(/\s+/g, " ").trim();

  if (style === 0) {
    return `${prefix} ${compact} ${suffix}`.replace(/\s+/g, " ").trim();
  }
  if (style === 1) {
    return `${compact} ${polite} ${extra}`.replace(/\s+/g, " ").trim();
  }
  if (style === 2) {
    return `${prefix} ${compact} ${polite} ${extra}`.replace(/\s+/g, " ").trim();
  }
  if (style === 3) {
    return `${compact} ${extra}?`.replace(/\s+/g, " ").trim();
  }
  if (style === 4) {
    return `${prefix} ${compact} ahora ${extra}`.replace(/\s+/g, " ").trim();
  }
  if (style === 5) {
    return `${compact}, ${suffix}, ${extra}`.replace(/\s+/g, " ").trim();
  }
  return `${compact} ${extra}`.replace(/\s+/g, " ").trim();
}

function normalizeText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_:-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const rows = [];
for (const domain of domains) {
  const templates = templatesByDomain[domain];
  for (let i = 0; i < perDomain; i += 1) {
    const country = pick(countries, i);
    const localeProfile = localeByCountry[country];
    const base = fill(pick(templates, i), i);
    const text = stylize(base, i, localeProfile);
    rows.push({
      text,
      finalHandler: domain,
      locale: "es",
      country,
      source: "domain-variants-v1",
    });
  }
}

const dedup = new Map();
for (const row of rows) {
  const key = `${row.finalHandler}::${normalizeText(row.text)}`;
  if (!dedup.has(key)) {
    dedup.set(key, row);
  }
}
const out = [...dedup.values()];

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${out.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

console.log(`dataset generado: ${out.length} muestras -> ${outPath}`);
console.log(`domains: ${domains.length} | perDomain objetivo: ${perDomain}`);
