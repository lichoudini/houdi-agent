import fs from "node:fs/promises";
import path from "node:path";

type WorkspaceEntryKind = "dir" | "file" | "link" | "other";

type WorkspaceEntry = {
  name: string;
  kind: WorkspaceEntryKind;
  size?: number;
};

export class WorkspaceFilesService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly normalizeWorkspaceRelativePath: (raw: string) => string,
    private readonly isSimpleTextFilePath: (relativePath: string) => boolean,
    private readonly formatBytes: (bytes: number) => string,
    private readonly safePathExists: (filePath: string) => Promise<boolean>,
    private readonly simpleTextExtensions: Set<string>,
  ) {}

  resolveWorkspacePath(relativeInput?: string): { fullPath: string; relPath: string } {
    const normalized = this.normalizeWorkspaceRelativePath(relativeInput ?? "");
    const fullPath = path.resolve(this.workspaceRoot, normalized || ".");
    const relativeToRoot = path.relative(this.workspaceRoot, fullPath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error("Ruta fuera de workspace");
    }
    const relPath = normalized ? `workspace/${normalized}` : "workspace";
    return { fullPath, relPath };
  }

  async listWorkspaceDirectory(relativeInput?: string): Promise<{ relPath: string; entries: WorkspaceEntry[]; truncated: boolean }> {
    const resolved = this.resolveWorkspacePath(relativeInput ?? "");
    const dirents = await fs.readdir(resolved.fullPath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (entry): Promise<WorkspaceEntry> => {
        const full = path.join(resolved.fullPath, entry.name);
        if (entry.isDirectory()) {
          return { name: entry.name, kind: "dir" };
        }
        if (entry.isFile()) {
          const stat = await fs.stat(full);
          return { name: entry.name, kind: "file", size: stat.size };
        }
        if (entry.isSymbolicLink()) {
          return { name: entry.name, kind: "link" };
        }
        return { name: entry.name, kind: "other" };
      }),
    );

    const sorted = entries.sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") {
        return -1;
      }
      if (a.kind !== "dir" && b.kind === "dir") {
        return 1;
      }
      return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
    });

    const MAX = 300;
    return {
      relPath: resolved.relPath,
      entries: sorted.slice(0, MAX),
      truncated: sorted.length > MAX,
    };
  }

  formatWorkspaceEntries(entries: WorkspaceEntry[]): string[] {
    return entries.map((entry, index) => {
      const prefix = entry.kind === "dir" ? "[DIR]" : entry.kind === "file" ? "[FILE]" : `[${entry.kind.toUpperCase()}]`;
      const sizeText = typeof entry.size === "number" ? ` (${this.formatBytes(entry.size)})` : "";
      return `${index + 1}. ${prefix} ${entry.name}${sizeText}`;
    });
  }

  async createWorkspaceDirectory(relativeInput: string): Promise<{ relPath: string }> {
    const resolved = this.resolveWorkspacePath(relativeInput);
    await fs.mkdir(resolved.fullPath, { recursive: true });
    return { relPath: resolved.relPath };
  }

  async writeWorkspaceTextFile(params: {
    relativePath: string;
    content?: string;
    overwrite?: boolean;
    append?: boolean;
  }): Promise<{ relPath: string; size: number; created: boolean }> {
    const resolved = this.resolveWorkspacePath(params.relativePath);
    const normalized = this.normalizeWorkspaceRelativePath(params.relativePath);
    if (!normalized || normalized.endsWith("/")) {
      throw new Error("Ruta de archivo invalida");
    }

    const ext = path.extname(normalized).toLowerCase();
    if (!this.isSimpleTextFilePath(normalized) && !this.simpleTextExtensions.has(ext)) {
      throw new Error("Solo se permite crear/editar archivos de texto simples");
    }

    await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
    const existedBefore = await this.safePathExists(resolved.fullPath);
    if (existedBefore && !params.overwrite && !params.append) {
      throw new Error("El archivo ya existe (usa overwrite o append)");
    }

    const content = params.content ?? "";
    if (params.append) {
      await fs.appendFile(resolved.fullPath, content, "utf8");
    } else {
      await fs.writeFile(resolved.fullPath, content, "utf8");
    }

    const stat = await fs.stat(resolved.fullPath);
    return {
      relPath: resolved.relPath,
      size: stat.size,
      created: !existedBefore,
    };
  }

  async moveWorkspacePath(sourceInput: string, targetInput: string): Promise<{ from: string; to: string }> {
    const from = this.resolveWorkspacePath(sourceInput);
    const to = this.resolveWorkspacePath(targetInput);
    await fs.mkdir(path.dirname(to.fullPath), { recursive: true });
    await fs.rename(from.fullPath, to.fullPath);
    return { from: from.relPath, to: to.relPath };
  }

  async deleteWorkspacePath(relativeInput: string): Promise<{ relPath: string; kind: "dir" | "file" | "other" }> {
    const resolved = this.resolveWorkspacePath(relativeInput);
    if (resolved.relPath === "workspace") {
      throw new Error("No se permite eliminar la carpeta raíz workspace");
    }

    const stat = await fs.lstat(resolved.fullPath);
    let kind: "dir" | "file" | "other" = "other";
    if (stat.isDirectory()) {
      kind = "dir";
      await fs.rm(resolved.fullPath, { recursive: true, force: true });
    } else if (stat.isFile()) {
      kind = "file";
      await fs.rm(resolved.fullPath, { force: true });
    } else {
      await fs.rm(resolved.fullPath, { force: true });
    }

    return { relPath: resolved.relPath, kind };
  }
}
