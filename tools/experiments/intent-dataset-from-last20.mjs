import fs from "node:fs/promises";
import path from "node:path";

const inPath = path.resolve(process.cwd(), process.argv[2] || "runtime/telegram-last20.jsonl");
const outPath = path.resolve(process.cwd(), process.argv[3] || "datasets/intent-from-last20.jsonl");

const sourceToHandler = [
  ["workspace-intent", "workspace"],
  ["gmail-intent", "gmail"],
  ["gmail-recipients", "gmail-recipients"],
  ["schedule-intent", "schedule"],
  ["memory-intent", "memory"],
  ["web", "web"],
  ["lim-intent", "lim"],
  ["self-maintenance", "self-maintenance"],
];

function inferHandler(source) {
  const s = String(source || "");
  for (const [token, handler] of sourceToHandler) {
    if (s.includes(token)) return handler;
  }
  return null;
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

let raw = "";
try {
  raw = await fs.readFile(inPath, "utf8");
} catch (error) {
  if (error && error.code === "ENOENT") {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, "", "utf8");
    console.log(`log no encontrado (${inPath}), salida vacia: ${outPath}`);
    process.exit(0);
  }
  throw error;
}
const rows = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

const out = [];
for (let i = 0; i < rows.length - 1; i += 1) {
  const a = rows[i];
  const b = rows[i + 1];
  if (a?.role !== "user" || b?.role !== "assistant") continue;
  if (a?.chatId !== b?.chatId) continue;
  const handler = inferHandler(b?.source);
  if (!handler) continue;
  const text = normalize(a?.text);
  if (!text) continue;
  out.push({
    text,
    finalHandler: handler,
    source: "last20-derived",
    locale: "es",
    country: null,
  });
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${out.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");
console.log(`extraidos: ${out.length} -> ${outPath}`);
