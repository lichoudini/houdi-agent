import fs from "node:fs/promises";
import path from "node:path";

const outPath = path.resolve(process.cwd(), process.argv[2] || "datasets/intent-latam.extended.jsonl");
const perHandler = Math.max(60, Math.min(250, Number.parseInt(process.argv[3] || "120", 10) || 120));

const handlers = [
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

const slangPrefix = ["che", "dale", "fijate", "porfa", "sale", "ya po", "oye", ""];
const slangSuffix = ["", "porfa", "gracias", "cuando puedas", "ahora", "de una"];

const topics = ["ia", "crypto", "openai", "boca juniors", "marketing", "cloudflare", "n8n", "ventas b2b"];
const names = ["naza", "carla", "juan", "sofia", "gaston", "maria", "pedro", "vale"];
const emails = [
  "nazareno.tomaselli@vrand.biz",
  "ops@houdiagent.com",
  "ventas@empresa.com",
  "finanzas@empresa.com",
  "soporte@empresa.com",
];
const files = ["reporte.txt", "clientes.csv", "resumen.md", "pino.txt", "cabeza.txt", "maggie-simpson.txt"];
const docs = ["contrato.pdf", "brief.docx", "plan-q1.pdf", "anexo-legal.pdf"];
const times = ["9am", "10:30", "18:45", "manana 9am", "hoy 17", "viernes 11"];
const taskIds = ["tsk-mlz4df9a", "tsk_mlz9k2a", "id_tsk-mlz77", "tsk-abc123"];

const templatesByHandler = {
  "self-maintenance": [
    "reinicia el agente",
    "actualiza el repositorio del bot",
    "estado del servicio houdi-agent",
    "crear skill para intents rioplatenses",
    "eliminar skill de pruebas",
    "hacer pull y rebuild del agente",
  ],
  lim: [
    "inicia lim",
    "detener lim",
    "reinicia el conector lim",
    "estado del conector lim",
    "buscar mensajes en lim del ultimo dia",
    "consulta lim first_name {name}",
  ],
  schedule: [
    "recordame {time} llamar a {name}",
    "agenda tarea para {time} enviar reporte",
    "programa un recordatorio en 20 minutos para revisar mails",
    "eliminar {taskId}",
    "borrar {taskId}",
    "editar {taskId} y moverlo a {time}",
    "listar tareas pendientes",
    "crear tarea diaria 9am lista lim",
  ],
  memory: [
    "te acordas de lo que hablamos de {topic}",
    "busca en memoria lo de {topic}",
    "que recuerdas sobre vrandserver",
    "guardate que tsk siempre refiere tareas",
    "mostrame memoria reciente",
    "recordame que uso html puro",
  ],
  "gmail-recipients": [
    "agrega destinatario {name} {email}",
    "guardar contacto {name} {email} para gmail",
    "listar destinatarios de correo",
    "eliminar destinatario {name}",
    "actualizar destinatario {name} con {email}",
    "agenda de contactos de gmail",
  ],
  gmail: [
    "enviar correo a {email} con asunto {topic}",
    "mandar mail a {name} con resumen de {topic}",
    "responder el ultimo correo de {name}",
    "leer inbox de gmail",
    "reenviar ultimo correo a {email}",
    "escribi un email para {email} con seguimiento",
  ],
  workspace: [
    "crear archivo {file} con un resumen",
    "editar archivo {file} con nueva version",
    "en {file} escribir una linea",
    "mover {file} a archivados/{file}",
    "abrir /img... y listar archivos",
    "eliminar mag... del workspace",
    "enviar {file} por telegram",
  ],
  document: [
    "leer documento {doc} y resumir",
    "analiza este archivo {doc}",
    "extrae texto del {doc}",
    "abrir documento {doc}",
    "resumir el pdf adjunto",
    "interpretar el doc y listar riesgos",
  ],
  web: [
    "buscar en web ultimas noticias de {topic}",
    "revisa reddit sobre {topic} y resumilo",
    "investiga precio actual de dominios .ai",
    "abrir https://cloudflare.com y contar novedades",
    "que paso hoy con {topic} en noticias",
    "buscar informacion oficial sobre dkim dmarc spf",
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
    .replaceAll("{doc}", pick(docs, i))
    .replaceAll("{time}", pick(times, i))
    .replaceAll("{taskId}", pick(taskIds, i));
}

function stylize(base, i) {
  const prefix = pick(slangPrefix, i);
  const suffix = pick(slangSuffix, i + 3);
  const maybeQuestion = i % 7 === 0 ? "?" : "";
  const line = `${prefix} ${base} ${suffix}`.replace(/\s+/g, " ").trim();
  return `${line}${maybeQuestion}`.trim();
}

const out = [];
for (const handler of handlers) {
  const templates = templatesByHandler[handler];
  for (let i = 0; i < perHandler; i += 1) {
    const base = fill(templates[i % templates.length], i);
    out.push({
      text: stylize(base, i),
      finalHandler: handler,
      locale: "es",
      country: i % 3 === 0 ? "AR" : i % 3 === 1 ? "CL" : "MX",
      source: "latam-extended",
    });
  }
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${out.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");
console.log(`dataset generado: ${out.length} muestras -> ${outPath}`);
