import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeSelfSkillText } from "./natural.js";

export type SelfSkillStoreOptions = {
  workspaceDir: string;
  relPath?: string;
  sectionTitle?: string;
};

type ParsedEntryRef = {
  id: string | null;
  line: string;
};

export class SelfSkillStore {
  private readonly workspaceDir: string;
  private readonly relPath: string;
  private readonly sectionTitle: string;

  constructor(options: SelfSkillStoreOptions) {
    this.workspaceDir = options.workspaceDir;
    this.relPath = options.relPath ?? "AGENTS.md";
    this.sectionTitle = options.sectionTitle ?? "## Dynamic Skills";
  }

  private get fullPath(): string {
    return path.join(this.workspaceDir, this.relPath);
  }

  private normalizeRelPath(): string {
    return this.relPath.replace(/\\/g, "/");
  }

  private buildEntryId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `sk-${ts}${rand}`;
  }

  private parseEntryRef(line: string): ParsedEntryRef {
    const id = line.match(/\[#([a-z0-9][a-z0-9_-]{2,40})\]/i)?.[1] ?? null;
    return {
      id: id ? id.toLowerCase() : null,
      line,
    };
  }

  parseEntries(content: string): string[] {
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === this.sectionTitle);
    if (start === -1) {
      return [];
    }

    const entries: string[] = [];
    for (let idx = start + 1; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (/^##\s+/.test(line.trim())) {
        break;
      }
      const cleaned = line.trim();
      if (cleaned) {
        entries.push(cleaned);
      }
    }
    return entries;
  }

  async appendInstruction(instruction: string): Promise<{ relPath: string; entry: string }> {
    const cleaned = sanitizeSelfSkillText(instruction);
    if (!cleaned) {
      throw new Error("Instrucción vacía");
    }

    await fs.mkdir(this.workspaceDir, { recursive: true });

    let current = "";
    try {
      current = await fs.readFile(this.fullPath, "utf8");
    } catch {
      current = "# AGENTS.md\n";
    }

    const timestamp = new Date().toISOString().slice(0, 19);
    const entryId = this.buildEntryId();
    const entry = `- [${timestamp}] [#${entryId}] ${cleaned}`;
    const entries = this.parseEntries(current);

    if (entries.length === 0) {
      const next = `${current.trimEnd()}\n\n${this.sectionTitle}\n${entry}\n`;
      await fs.writeFile(this.fullPath, next, "utf8");
    } else {
      const lines = current.split(/\r?\n/);
      const start = lines.findIndex((line) => line.trim() === this.sectionTitle);
      let end = lines.length;
      for (let idx = start + 1; idx < lines.length; idx += 1) {
        if (/^##\s+/.test((lines[idx] ?? "").trim())) {
          end = idx;
          break;
        }
      }
      const nextLines = [...lines.slice(0, end), entry, ...lines.slice(end)];
      await fs.writeFile(this.fullPath, `${nextLines.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
    }

    return { relPath: this.normalizeRelPath(), entry };
  }

  async listInstructions(): Promise<{ relPath: string; entries: string[] }> {
    let content = "";
    try {
      content = await fs.readFile(this.fullPath, "utf8");
    } catch {
      return { relPath: this.normalizeRelPath(), entries: [] };
    }

    return {
      relPath: this.normalizeRelPath(),
      entries: this.parseEntries(content),
    };
  }

  async removeInstruction(inputRef: number | string): Promise<{
    relPath: string;
    removedEntry: string;
    removedIndex: number;
    remaining: number;
  }> {
    if (typeof inputRef !== "number" && typeof inputRef !== "string") {
      throw new Error("Referencia inválida");
    }

    let content = "";
    try {
      content = await fs.readFile(this.fullPath, "utf8");
    } catch {
      throw new Error("No existe AGENTS.md para editar");
    }

    const lines = content.split(/\r?\n/);
    const sectionStart = lines.findIndex((line) => line.trim() === this.sectionTitle);
    if (sectionStart < 0) {
      throw new Error("No hay sección Dynamic Skills");
    }

    let sectionEnd = lines.length;
    for (let idx = sectionStart + 1; idx < lines.length; idx += 1) {
      if (/^##\s+/.test((lines[idx] ?? "").trim())) {
        sectionEnd = idx;
        break;
      }
    }

    const entryLineIndexes: number[] = [];
    const entryLines: string[] = [];
    for (let idx = sectionStart + 1; idx < sectionEnd; idx += 1) {
      const cleaned = (lines[idx] ?? "").trim();
      if (cleaned) {
        entryLineIndexes.push(idx);
        entryLines.push(cleaned);
      }
    }

    if (entryLineIndexes.length === 0) {
      throw new Error("No hay habilidades dinámicas para eliminar");
    }

    let targetPosition = -1;
    if (typeof inputRef === "number") {
      if (!Number.isFinite(inputRef) || inputRef === 0) {
        throw new Error("Índice inválido");
      }
      targetPosition = inputRef === -1 ? entryLineIndexes.length - 1 : inputRef - 1;
    } else {
      const normalizedRef = inputRef.trim().replace(/^#/, "").toLowerCase();
      if (!normalizedRef) {
        throw new Error("Referencia inválida");
      }
      targetPosition = entryLines.findIndex((line) => this.parseEntryRef(line).id === normalizedRef);
      if (targetPosition < 0) {
        throw new Error(`No existe habilidad con id #${normalizedRef}`);
      }
    }

    if (targetPosition < 0 || targetPosition >= entryLineIndexes.length) {
      throw new Error(`Índice fuera de rango (1..${entryLineIndexes.length})`);
    }

    const removedIndex = targetPosition + 1;
    const removedEntry = entryLines[targetPosition] ?? "";
    const removeLineAt = entryLineIndexes[targetPosition]!;

    lines.splice(removeLineAt, 1);
    const nextContent = `${lines.join("\n").replace(/\n+$/g, "")}\n`;
    await fs.writeFile(this.fullPath, nextContent, "utf8");

    return {
      relPath: this.normalizeRelPath(),
      removedEntry,
      removedIndex,
      remaining: entryLineIndexes.length - 1,
    };
  }
}
