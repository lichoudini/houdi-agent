import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import { DocumentReader, SUPPORTED_DOCUMENT_FORMATS } from "./document-reader.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-doc-reader-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createWorkbookBuffer(bookType: "xlsx" | "biff8"): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["name", "value"],
    ["alpha", 1],
    ["beta", 2],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Data");
  return XLSX.write(workbook, {
    bookType,
    type: "buffer",
  }) as Buffer;
}

test("supported formats include csv, xlsx and xls", () => {
  assert.ok(SUPPORTED_DOCUMENT_FORMATS.includes(".csv"));
  assert.ok(SUPPORTED_DOCUMENT_FORMATS.includes(".xlsx"));
  assert.ok(SUPPORTED_DOCUMENT_FORMATS.includes(".xls"));
});

test("reads csv files as text", async () => {
  await withTempDir(async (dir) => {
    const reader = new DocumentReader({
      baseDir: dir,
      maxFileBytes: 5_000_000,
      maxTextChars: 200_000,
    });
    const relPath = "sample.csv";
    await fs.writeFile(path.join(dir, relPath), "name,value\nalpha,1\nbeta,2\n", "utf8");

    const result = await reader.readDocument(relPath);
    assert.equal(result.format, ".csv");
    assert.match(result.text, /name,value/);
    assert.match(result.text, /alpha,1/);
  });
});

test("reads xlsx files and extracts sheet rows", async () => {
  await withTempDir(async (dir) => {
    const reader = new DocumentReader({
      baseDir: dir,
      maxFileBytes: 5_000_000,
      maxTextChars: 200_000,
    });
    const relPath = "sample.xlsx";
    await fs.writeFile(path.join(dir, relPath), createWorkbookBuffer("xlsx"));

    const result = await reader.readDocument(relPath);
    assert.equal(result.format, "office:xlsx");
    assert.equal(result.extractor, "zip-xml");
    assert.match(result.text, /## Sheet: Data/);
    assert.match(result.text, /name\tvalue/);
    assert.match(result.text, /alpha\t1/);
  });
});

test("reads xls files and extracts sheet rows", async () => {
  await withTempDir(async (dir) => {
    const reader = new DocumentReader({
      baseDir: dir,
      maxFileBytes: 5_000_000,
      maxTextChars: 200_000,
    });
    const relPath = "sample.xls";
    await fs.writeFile(path.join(dir, relPath), createWorkbookBuffer("biff8"));

    const result = await reader.readDocument(relPath);
    assert.equal(result.format, "office:xls");
    assert.equal(result.extractor, "xlsx");
    assert.match(result.text, /## Sheet: Data/);
    assert.match(result.text, /name\tvalue/);
    assert.match(result.text, /beta\t2/);
  });
});
