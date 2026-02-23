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

test("workspace files service resolves ellipsis placeholder when match is unique", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-workspace-service-ellipsis-test-"));
  const service = new WorkspaceFilesService(
    tempDir,
    normalizeWorkspaceRelativePath,
    isSimpleTextFilePath,
    (bytes) => `${bytes}b`,
    safePathExists,
    new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log"]),
  );

  await service.createWorkspaceDirectory("images");
  await service.createWorkspaceDirectory("images/events");
  await service.writeWorkspaceTextFile({
    relativePath: "images/events/reporte.txt",
    content: "hola",
  });

  const resolvedDir = await service.resolveEllipsisPathPlaceholder("imag...");
  assert.equal(resolvedDir.resolvedPath, "images");
  assert.equal(resolvedDir.expanded, true);

  const resolvedNested = await service.resolveEllipsisPathPlaceholder("imag.../eve.../repo...");
  assert.equal(resolvedNested.resolvedPath, "images/events/reporte.txt");
  assert.equal(resolvedNested.expanded, true);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("workspace files service reports ambiguity for ellipsis placeholder", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-workspace-service-ellipsis-ambiguous-test-"));
  const service = new WorkspaceFilesService(
    tempDir,
    normalizeWorkspaceRelativePath,
    isSimpleTextFilePath,
    (bytes) => `${bytes}b`,
    safePathExists,
    new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log"]),
  );

  await service.createWorkspaceDirectory("images");
  await service.createWorkspaceDirectory("imagenes");

  await assert.rejects(
    async () => service.resolveEllipsisPathPlaceholder("imag..."),
    /Ruta ambigua/,
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("workspace files service resolves two-dot placeholder when match is unique", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-workspace-service-twodot-test-"));
  const service = new WorkspaceFilesService(
    tempDir,
    normalizeWorkspaceRelativePath,
    isSimpleTextFilePath,
    (bytes) => `${bytes}b`,
    safePathExists,
    new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log"]),
  );

  await service.createWorkspaceDirectory("images");
  await service.createWorkspaceDirectory("images/events");
  await service.writeWorkspaceTextFile({
    relativePath: "images/events/reporte.txt",
    content: "hola",
  });

  const resolvedNested = await service.resolveEllipsisPathPlaceholder("imag../eve../repo..");
  assert.equal(resolvedNested.resolvedPath, "images/events/reporte.txt");
  assert.equal(resolvedNested.expanded, true);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("workspace files service resolves existing exact candidate", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-workspace-service-exact-"));
  const service = new WorkspaceFilesService(
    tempDir,
    normalizeWorkspaceRelativePath,
    isSimpleTextFilePath,
    (bytes) => `${bytes}b`,
    safePathExists,
    new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log"]),
  );
  await service.createWorkspaceDirectory("docs");
  await service.writeWorkspaceTextFile({ relativePath: "docs/maggie-simpson.txt", content: "hola" });

  const resolved = await service.resolveExistingPathCandidate("docs/maggie-simpson.txt");
  assert.equal(resolved.ambiguous, false);
  assert.equal(resolved.expanded, false);
  assert.equal(resolved.resolvedPath, "docs/maggie-simpson.txt");
  assert.deepEqual(resolved.matches, ["docs/maggie-simpson.txt"]);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("workspace files service keeps unresolved for non-exact candidate", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-workspace-service-nonexact-"));
  const service = new WorkspaceFilesService(
    tempDir,
    normalizeWorkspaceRelativePath,
    isSimpleTextFilePath,
    (bytes) => `${bytes}b`,
    safePathExists,
    new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log"]),
  );
  await service.createWorkspaceDirectory("docs");
  await service.writeWorkspaceTextFile({ relativePath: "docs/maggie.txt", content: "a" });
  await service.writeWorkspaceTextFile({ relativePath: "docs/magento.txt", content: "b" });

  const resolved = await service.resolveExistingPathCandidate("docs/mag");
  assert.equal(resolved.ambiguous, false);
  assert.equal(resolved.expanded, false);
  assert.equal(resolved.resolvedPath, "docs/mag");
  assert.deepEqual(resolved.matches, []);

  await fs.rm(tempDir, { recursive: true, force: true });
});
