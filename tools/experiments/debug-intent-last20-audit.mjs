import fs from "node:fs/promises";
import path from "node:path";

const filePath = path.resolve(process.cwd(), "houdi-audit.log");
const limit = Math.max(1, Math.min(200, Number.parseInt(process.argv[2] || "20", 10) || 20));

function printLine(line = "") {
  process.stdout.write(`${line}\n`);
}

try {
  const raw = await fs.readFile(filePath, "utf8");
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
    })
    .filter((row) => row?.type === "intent.route")
    .slice(-limit);

  if (rows.length === 0) {
    printLine(`Sin intent.route en ${filePath}`);
    process.exit(0);
  }

  printLine(`Archivo: ${filePath}`);
  printLine(`Eventos intent.route: ${rows.length} (ultimos)`);
  printLine("");

  rows.forEach((row, index) => {
    const details = row?.details ?? {};
    const ts = row?.ts ?? "-";
    const src = details?.source ?? "-";
    const handler = details?.handler ?? "-";
    const semantic = details?.semanticRouterSelected ?? "-";
    const ai = details?.aiRouterSelected ?? "-";
    const typed = details?.typedRouteSummary ?? "-";
    const text = String(details?.textPreview ?? "").replace(/\s+/g, " ").trim();
    printLine(`[${index + 1}] ${ts} src=${src} handler=${handler} semantic=${semantic} ai=${ai} typed=${typed}`);
    printLine(`  ${text}`);
  });
} catch (error) {
  if (error?.code === "ENOENT") {
    printLine(`No existe: ${filePath}`);
    process.exit(0);
  }
  throw error;
}
