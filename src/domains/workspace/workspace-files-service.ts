import fs from "node:fs/promises";
import path from "node:path";

type WorkspaceEntryKind = "dir" | "file" | "link" | "other";

type WorkspaceEntry = {
  name: string;
  kind: WorkspaceEntryKind;
  size?: number;
};

type ExistingPathResolution = {
  inputPath: string;
  resolvedPath: string;
  expanded: boolean;
  ambiguous: boolean;
  matches: string[];
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

  hasEllipsisPathPlaceholder(relativeInput?: string): boolean {
    const normalized = this.normalizeWorkspaceRelativePath(relativeInput ?? "");
    if (!normalized) {
      return false;
    }
    return normalized
      .split("/")
      .some((segment) => Boolean(segment) && /\.{2,}$/.test(segment));
  }

  async resolveEllipsisPathPlaceholder(
    relativeInput: string,
  ): Promise<{ inputPath: string; resolvedPath: string; expanded: boolean }> {
    const inputPath = this.normalizeWorkspaceRelativePath(relativeInput);
    if (!inputPath) {
      return { inputPath: "", resolvedPath: "", expanded: false };
    }
    if (!this.hasEllipsisPathPlaceholder(inputPath)) {
      return { inputPath, resolvedPath: inputPath, expanded: false };
    }

    const sourceSegments = inputPath.split("/").filter(Boolean);
    const resolvedSegments: string[] = [];
    for (let index = 0; index < sourceSegments.length; index += 1) {
      const segment = sourceSegments[index] ?? "";
      if (!segment || !/\.{2,}$/.test(segment)) {
        resolvedSegments.push(segment);
        continue;
      }
      const trailingDots = segment.match(/\.{2,}$/)?.[0].length ?? 0;
      const prefix = trailingDots > 0 ? segment.slice(0, -trailingDots) : segment;
      const baseDirRel = resolvedSegments.join("/");
      const baseDirResolved = this.resolveWorkspacePath(baseDirRel);
      let baseDirEntries;
      try {
        baseDirEntries = await fs.readdir(baseDirResolved.fullPath, { withFileTypes: true });
      } catch {
        throw new Error(`No existe la carpeta base para autocompletar: ${baseDirResolved.relPath}`);
      }

      const normalizedPrefix = normalizeForPathMatch(prefix);
      let matches = baseDirEntries
        .map((entry) => entry.name)
        .filter((entryName) => {
          if (!normalizedPrefix) {
            return true;
          }
          return normalizeForPathMatch(entryName).startsWith(normalizedPrefix);
        })
        .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

      // Fallback for compact prefixes (e.g. "img..." -> "images") where users
      // omit letters but preserve order.
      if (matches.length === 0 && normalizedPrefix) {
        matches = baseDirEntries
          .map((entry) => entry.name)
          .filter((entryName) => isOrderedSubsequence(normalizedPrefix, normalizeForPathMatch(entryName)))
          .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
      }

      if (matches.length === 0) {
        throw new Error(`No encontré coincidencias para "${segment}" en ${baseDirResolved.relPath}.`);
      }

      let selected = "";
      if (matches.length === 1) {
        selected = matches[0] ?? "";
      } else {
        const exactMatches = normalizedPrefix
          ? matches.filter((entryName) => normalizeForPathMatch(entryName) === normalizedPrefix)
          : [];
        if (exactMatches.length === 1) {
          selected = exactMatches[0] ?? "";
        } else {
          const optionsPreview = matches.slice(0, 8).join(", ");
          const suffix = matches.length > 8 ? "..." : "";
          throw new Error(
            `Ruta ambigua para "${segment}" en ${baseDirResolved.relPath}. Coincidencias: ${optionsPreview}${suffix}`,
          );
        }
      }

      resolvedSegments.push(selected);
      const isLastSegment = index === sourceSegments.length - 1;
      if (!isLastSegment) {
        const selectedPath = this.resolveWorkspacePath(resolvedSegments.join("/"));
        let stat;
        try {
          stat = await fs.stat(selectedPath.fullPath);
        } catch {
          throw new Error(`No existe la ruta autocompletada: ${selectedPath.relPath}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`"${selectedPath.relPath}" es un archivo, no carpeta.`);
        }
      }
    }

    const resolvedPath = this.normalizeWorkspaceRelativePath(resolvedSegments.join("/"));
    return {
      inputPath,
      resolvedPath,
      expanded: resolvedPath !== inputPath,
    };
  }

  async resolveExistingPathCandidate(relativeInput: string): Promise<ExistingPathResolution> {
    const inputPath = this.normalizeWorkspaceRelativePath(relativeInput);
    if (!inputPath) {
      return { inputPath: "", resolvedPath: "", expanded: false, ambiguous: false, matches: [] };
    }

    const direct = this.resolveWorkspacePath(inputPath);
    try {
      await fs.access(direct.fullPath);
      return {
        inputPath,
        resolvedPath: inputPath,
        expanded: false,
        ambiguous: false,
        matches: [inputPath],
      };
    } catch {
      return { inputPath, resolvedPath: inputPath, expanded: false, ambiguous: false, matches: [] };
    }
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

  formatWorkspaceEntries(
    entries: WorkspaceEntry[],
    options?: { parentRelPath?: string },
  ): string[] {
    const parentRaw = options?.parentRelPath?.trim() ?? "";
    const parentNormalized = parentRaw
      .replace(/^\/+/, "")
      .replace(/^workspace(?:\/|$)/i, "")
      .replace(/\/+$/, "");

    return entries.map((entry, index) => {
      const prefix = entry.kind === "dir" ? "[DIR]" : entry.kind === "file" ? "[FILE]" : `[${entry.kind.toUpperCase()}]`;
      const sizeText = typeof entry.size === "number" ? ` (${this.formatBytes(entry.size)})` : "";
      const relPath = parentNormalized ? `${parentNormalized}/${entry.name}` : entry.name;
      const touchRef = `workspace/${relPath}`;
      return `${index + 1}. ${prefix} ${entry.name}${sizeText} | ref: #${touchRef}`;
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

function normalizeForPathMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function isOrderedSubsequence(needle: string, haystack: string): boolean {
  if (!needle) {
    return true;
  }
  let index = 0;
  for (const ch of haystack) {
    if (ch === needle[index]) {
      index += 1;
      if (index >= needle.length) {
        return true;
      }
    }
  }
  return false;
}
