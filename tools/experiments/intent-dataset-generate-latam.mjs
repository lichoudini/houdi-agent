import fs from "node:fs/promises";
import path from "node:path";

const outPath = path.resolve(process.cwd(), process.argv[2] || "datasets/intent-latam.seed.jsonl");

const countries = [
  { code: "AR", variants: ["vos", "arg"], slang: ["che", "dale", "mandame", "fijate"] },
  { code: "CL", variants: ["tu", "cl"], slang: ["oye", "ya po", "mandame", "revisa"] },
  { code: "MX", variants: ["tu", "mx"], slang: ["oye", "sale", "mandame", "revisa"] },
];

const templates = [
  {
    handler: "gmail",
    utterances: [
      "enviar correo a {email} con asunto {topic}",
      "mandar mail a {email} sobre {topic}",
      "escribi un email para {email} con {topic}",
      "responder el ultimo correo de {name}",
    ],
  },
  {
    handler: "gmail-recipients",
    utterances: [
      "agrega destinatario {name} {email}",
      "guarda contacto {name} {email} para gmail",
      "listar destinatarios de correo",
      "elimina destinatario {name}",
    ],
  },
  {
    handler: "workspace",
    utterances: [
      "crear archivo {file} con un resumen",
      "guardar en el archivo {fileStub}.. este texto",
      "ver archivos de workspace",
      "mover {file} a archivados/{file}",
      "editar archivo {fileStub}.. con nueva version",
    ],
  },
  {
    handler: "schedule",
    utterances: [
      "recordame manana {time} {task}",
      "agenda una tarea para {time} {task}",
      "ver recordatorios",
      "borrar recordatorio {task}",
    ],
  },
  {
    handler: "memory",
    utterances: [
      "te acordas de lo que hablamos de {topic}",
      "busca en memoria sobre {topic}",
      "recordas lo de {topic}",
    ],
  },
  {
    handler: "web",
    utterances: [
      "buscar noticias de {topic}",
      "dame las ultimas noticias sobre {topic}",
      "que paso hoy con {topic}",
    ],
  },
  {
    handler: "document",
    utterances: [
      "lee el documento {doc}",
      "resumi el pdf {doc}",
      "analiza el archivo {doc}",
    ],
  },
  {
    handler: "lim",
    utterances: [
      "listar lim",
      "estado lim",
      "reinicia lim",
      "buscar mensajes en lim de {name}",
    ],
  },
  {
    handler: "self-maintenance",
    utterances: [
      "actualiza el agente",
      "reinicia el bot",
      "version del agente",
      "estado del servicio",
    ],
  },
];

const topics = [
  "ia",
  "crypto",
  "ventas b2b",
  "openclaw",
  "gmail",
  "boca juniors",
  "automatizacion",
];
const names = ["naza", "martin", "carla", "gaston", "sofia", "juan"];
const emails = ["nazareno.tomaselli@vrand.biz", "houdi@vrand.biz", "ops@houdiagent.com"];
const files = ["reporte.txt", "resumen.md", "clientes.csv", "pipeline.json"];
const fileStubs = ["report", "resumen", "cliente", "leo", "mag"];
const docs = ["contrato.pdf", "brief.docx", "resumen-q1.pdf"];
const tasks = ["comprar leche", "pagar expensas", "enviar reporte", "llamar cliente"];
const times = ["7am", "9am", "18:30", "manana a la tarde"];

function pick(arr, i) {
  return arr[i % arr.length];
}

function fill(template, i) {
  return template
    .replaceAll("{topic}", pick(topics, i))
    .replaceAll("{name}", pick(names, i))
    .replaceAll("{email}", pick(emails, i))
    .replaceAll("{file}", pick(files, i))
    .replaceAll("{fileStub}", pick(fileStubs, i))
    .replaceAll("{doc}", pick(docs, i))
    .replaceAll("{task}", pick(tasks, i))
    .replaceAll("{time}", pick(times, i));
}

const out = [];
let n = 0;
for (const country of countries) {
  for (const t of templates) {
    for (let i = 0; i < t.utterances.length; i += 1) {
      const base = fill(t.utterances[i], i + n);
      out.push({
        text: base,
        finalHandler: t.handler,
        locale: "es",
        country: country.code,
        source: "latam-seed",
      });
      out.push({
        text: `${pick(country.slang, i)} ${base}`,
        finalHandler: t.handler,
        locale: "es",
        country: country.code,
        source: "latam-seed",
      });
      out.push({
        text: `${base} porfa`,
        finalHandler: t.handler,
        locale: "es",
        country: country.code,
        source: "latam-seed",
      });
      n += 1;
    }
  }
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${out.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");
console.log(`Seed LATAM generado: ${out.length} muestras -> ${outPath}`);
