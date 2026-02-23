#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const outPath = path.resolve(process.cwd(), process.argv[2] || "datasets/intent-domain-hardcases.es-ar.jsonl");

const labels = ["schedule", "web", "memory", "gmail-recipients"];

const emails = ["carla.ops@empresa.com", "ventas@empresa.com", "richard@vrand.biz"];
const topics = ["marketing", "dkim dmarc spf", "github actions", "chatgpt 5.3", "boca juniors", "cloudflare"];
const taskRefs = ["tsk-abc123", "tsk-mlz4df9a", "tsk_mlz9k2a"];
const hours = ["manana 9", "hoy 17hs", "viernes 11", "10:30", "7am"];
const names = ["Carla", "Nazareno", "Gaston", "Sofia"];
const prefixes = ["", "che", "dale", "porfa", "oye", "sale"];
const suffixes = ["", "ahora", "cuando puedas", "si podes", "si puedes", "sin romper lo que ya anda"];

const templates = {
  schedule: [
    "recordar {hour} actualizar reportes",
    "mandame ver recordatorios",
    "revisa borrar recordatorio pagar expensas",
    "programa para {hour} buscar web sobre {topic}",
    "editar {taskRef} y cambiar titulo a revisar {topic}",
    "programa para {hour} enviar correo a {email}",
    "agendar para {hour} enviar correo a {email}",
    "editar {taskRef} para {hour}",
    "eliminar la ultima tarea",
    "listar tareas pendientes",
  ],
  web: [
    "abrir resultado 2",
    "buscar en google {topic}",
    "dame links de {topic}",
    "buscar en web {topic}",
    "investiga en internet {topic}",
    "abrir resultado numero 2 y resumir",
    "abrir url https://example.com y analizar",
    "buscar fuentes oficiales de {topic}",
  ],
  memory: [
    "sabes de que equipo soy hincha",
    "me habias dicho algo sobre {topic}",
    "trae de memoria lo de {topic}",
    "consulta memoria de {topic}",
    "recordas lo que definimos de {topic}",
    "busca en memoria sobre {topic}",
    "que recuerdas sobre {topic}",
    "memoria status",
  ],
  "gmail-recipients": [
    "sumar contacto {name} {email}",
    "editar destinatario {name} email {email}",
    "agregar destinatario {name} {email}",
    "actualizar destinatario {name} con {email}",
    "eliminar destinatario {name}",
    "borrar contacto {name}",
    "listar destinatarios guardados",
    "agenda de contactos gmail",
  ],
};

function pick(arr, i) {
  return arr[i % arr.length];
}

function fill(template, i) {
  return template
    .replaceAll("{email}", pick(emails, i))
    .replaceAll("{topic}", pick(topics, i))
    .replaceAll("{taskRef}", pick(taskRefs, i))
    .replaceAll("{hour}", pick(hours, i))
    .replaceAll("{name}", pick(names, i));
}

function variants(base, i) {
  const prefix = pick(prefixes, i);
  const suffix = pick(suffixes, i + 1);
  return [
    `${base}`,
    `${prefix} ${base}`.replace(/\s+/g, " ").trim(),
    `${base} ${suffix}`.replace(/\s+/g, " ").trim(),
    `${prefix} ${base} ${suffix}`.replace(/\s+/g, " ").trim(),
    `${base}?`,
  ]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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
for (const label of labels) {
  const domainTemplates = templates[label];
  for (let i = 0; i < domainTemplates.length; i += 1) {
    const base = fill(domainTemplates[i], i);
    for (const text of variants(base, i)) {
      rows.push({
        text,
        finalHandler: label,
        locale: "es",
        country: i % 2 === 0 ? "AR" : "MX",
        source: "domain-hardcases-v1",
      });
    }
  }
}

const dedup = new Map();
for (const row of rows) {
  const key = `${row.finalHandler}::${normalize(row.text)}`;
  if (!dedup.has(key)) {
    dedup.set(key, row);
  }
}

const out = [...dedup.values()];
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${out.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

console.log(`dataset hardcases generado: ${out.length} muestras -> ${outPath}`);
