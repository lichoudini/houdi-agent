import fs from "node:fs/promises";
import path from "node:path";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.split("=");
    return [k, v ?? ""];
  }),
);

const inPath = path.resolve(process.cwd(), args.get("--in") || "houdi-audit.log");
const outPath = path.resolve(process.cwd(), args.get("--out") || "datasets/intent-from-audit.jsonl");
const limit = Math.max(50, Math.min(20000, Number.parseInt(args.get("--limit") || "5000", 10) || 5000));
const sourcePrefix = String(args.get("--source-prefix") || "telegram:").trim();

const allowedHandlers = new Set([
  "self-maintenance",
  "lim",
  "schedule",
  "memory",
  "gmail-recipients",
  "gmail",
  "workspace",
  "document",
  "web",
]);

function normalizeText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKey(text, handler) {
  return `${handler}::${text.toLowerCase()}`;
}

let raw = "";
try {
  raw = await fs.readFile(inPath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, "", "utf8");
    console.log(`audit no encontrado (${inPath}), salida vacia: ${outPath}`);
    process.exit(0);
  }
  throw error;
}

const parsed = raw
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
const seen = new Set();
for (let i = parsed.length - 1; i >= 0 && out.length < limit; i -= 1) {
  const row = parsed[i];
  if (row?.type !== "intent.route") continue;
  const handler = String(row?.details?.handler || "").trim();
  if (!allowedHandlers.has(handler)) continue;
  const source = String(row?.details?.source || "");
  if (sourcePrefix && !source.startsWith(sourcePrefix)) continue;
  const text = normalizeText(row?.details?.textPreview || "");
  if (!text) continue;
  const key = dedupeKey(text, handler);
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({
    text,
    finalHandler: handler,
    source: "audit-derived",
    locale: "es",
    country: null,
  });
}

out.reverse();
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${out.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");
console.log(`extraidos: ${out.length} -> ${outPath} (source-prefix=${sourcePrefix || "none"})`);
