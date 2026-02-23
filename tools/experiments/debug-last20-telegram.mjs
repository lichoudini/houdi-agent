import fs from "node:fs/promises";
import path from "node:path";

const filePath = path.resolve(process.cwd(), "runtime", "telegram-last20.jsonl");

function printLine(line = "") {
  process.stdout.write(`${line}\n`);
}

try {
  const raw = await fs.readFile(filePath, "utf8");
  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  if (rows.length === 0) {
    printLine(`Sin eventos en ${filePath}`);
    process.exit(0);
  }

  printLine(`Archivo: ${filePath}`);
  printLine(`Eventos: ${rows.length}`);
  printLine("");

  rows.forEach((row, index) => {
    const head = `[${index + 1}] ${row.at ?? "-"} role=${row.role ?? "-"} chat=${row.chatId ?? "-"} source=${row.source ?? "-"}`;
    printLine(head);
    printLine(`  ${String(row.text ?? "").replace(/\s+/g, " ").trim()}`);
  });
} catch (error) {
  const code = error?.code;
  if (code === "ENOENT") {
    printLine(`No existe todavía: ${filePath}`);
    process.exit(0);
  }
  throw error;
}
