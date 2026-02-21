import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceFilesService } from "./domains/workspace/workspace-files-service.js";

function normalizeWorkspaceRelativePath(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!value || value === ".") {
    return "";
  }
  return value;
}

function isSimpleTextFilePath(relativePath: string): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  return new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log"]).has(ext);
}

async function safePathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("workspace files service basic operations", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-workspace-service-test-"));
  const service = new WorkspaceFilesService(
    tempDir,
    normalizeWorkspaceRelativePath,
    isSimpleTextFilePath,
    (bytes) => `${bytes}b`,
    safePathExists,
    new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log"]),
  );

  const dir = await service.createWorkspaceDirectory("docs");
  assert.equal(dir.relPath, "workspace/docs");

  const written = await service.writeWorkspaceTextFile({
    relativePath: "docs/note.txt",
    content: "hola",
  });
  assert.equal(written.created, true);

  const listed = await service.listWorkspaceDirectory("docs");
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0]?.name, "note.txt");

  const moved = await service.moveWorkspacePath("docs/note.txt", "docs/note-renamed.txt");
  assert.equal(moved.to, "workspace/docs/note-renamed.txt");

  const deleted = await service.deleteWorkspacePath("docs/note-renamed.txt");
  assert.equal(deleted.kind, "file");

  await fs.rm(tempDir, { recursive: true, force: true });
});
