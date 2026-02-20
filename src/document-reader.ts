import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import XLSX from "xlsx";

export type DocumentReadResult = {
  path: string;
  fullPath: string;
  format: string;
  fileSize: number;
  text: string;
  extractedChars: number;
  truncated: boolean;
  extractor: string;
};

type DocumentReaderOptions = {
  baseDir: string;
  maxFileBytes: number;
  maxTextChars: number;
};

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yml",
  ".yaml",
  ".xml",
  ".html",
  ".htm",
  ".ini",
  ".conf",
  ".cfg",
]);

const DOCX_EXTENSIONS = new Set([".docx"]);
const SPREADSHEET_EXTENSIONS = new Set([".xls", ".xlsx", ".ods"]);
const PRESENTATION_EXTENSIONS = new Set([".pptx", ".odp"]);
const OPEN_DOCUMENT_TEXT_EXTENSIONS = new Set([".odt"]);
const RTF_EXTENSIONS = new Set([".rtf"]);

export const SUPPORTED_DOCUMENT_FORMATS = [
  ".pdf",
  ...Array.from(DOCX_EXTENSIONS),
  ...Array.from(SPREADSHEET_EXTENSIONS),
  ...Array.from(PRESENTATION_EXTENSIONS),
  ...Array.from(OPEN_DOCUMENT_TEXT_EXTENSIONS),
  ...Array.from(RTF_EXTENSIONS),
  ...Array.from(TEXT_EXTENSIONS),
].sort();

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncateWithMarker(text: string, maxChars: number): { value: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { value: text, truncated: false };
  }
  const marker = "\n\n[...truncated]";
  const usable = Math.max(0, maxChars - marker.length);
  return {
    value: `${text.slice(0, usable)}${marker}`,
    truncated: true,
  };
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function extractTaggedXmlText(
  xml: string,
  options?: {
    paragraphEndTags?: string[];
    lineBreakTags?: string[];
  },
): string {
  const paragraphEndTags = options?.paragraphEndTags ?? [];
  const lineBreakTags = options?.lineBreakTags ?? [];
  let value = xml;

  for (const tag of paragraphEndTags) {
    value = value.replace(new RegExp(`</${tag}>`, "gi"), "\n");
  }
  for (const tag of lineBreakTags) {
    value = value.replace(new RegExp(`<${tag}\\s*/?>`, "gi"), "\n");
  }

  value = value.replace(/<[^>]+>/g, " ");
  value = decodeXmlEntities(value);
  return normalizeText(value);
}

function sanitizeCellValue(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function extractRtfText(raw: string): string {
  const withBreaks = raw.replace(/\\par[d]?/gi, "\n");
  const hexDecoded = withBreaks.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const withoutControls = hexDecoded.replace(/\\[a-zA-Z]+-?\d* ?/g, "");
  const withoutGroups = withoutControls.replace(/[{}]/g, "");
  return normalizeText(withoutGroups);
}

async function extractZipEntryText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) {
    return "";
  }
  return await entry.async("text");
}

export class DocumentReader {
  private readonly baseDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTextChars: number;

  constructor(options: DocumentReaderOptions) {
    this.baseDir = path.resolve(options.baseDir);
    this.maxFileBytes = clampInt(options.maxFileBytes, 1_000_000, 100_000_000);
    this.maxTextChars = clampInt(options.maxTextChars, 1000, 300_000);
  }

  getSupportedFormats(): string[] {
    return [...SUPPORTED_DOCUMENT_FORMATS];
  }

  async readDocument(pathInput: string): Promise<DocumentReadResult> {
    const resolved = this.resolveSafePath(pathInput);
    const fileStat = await fs.stat(resolved.fullPath);
    if (!fileStat.isFile()) {
      throw new Error("La ruta indicada no es un archivo");
    }
    if (fileStat.size > this.maxFileBytes) {
      const limitMb = Math.round(this.maxFileBytes / (1024 * 1024));
      throw new Error(`Archivo demasiado grande (${Math.round(fileStat.size / (1024 * 1024))}MB). Límite: ${limitMb}MB`);
    }

    const ext = path.extname(resolved.fullPath).toLowerCase();
    let rawText = "";
    let format = ext || "(sin extensión)";
    let extractor = "native";

    if (!ext || TEXT_EXTENSIONS.has(ext)) {
      rawText = await fs.readFile(resolved.fullPath, "utf8");
      format = ext || "text/plain";
      extractor = "native";
    } else if (ext === ".pdf") {
      rawText = await this.extractPdfText(resolved.fullPath);
      format = "pdf";
      extractor = "pdf-parse";
    } else if (DOCX_EXTENSIONS.has(ext)) {
      rawText = await this.extractDocxText(resolved.fullPath);
      format = "office:docx";
      extractor = "mammoth";
    } else if (SPREADSHEET_EXTENSIONS.has(ext)) {
      rawText = await this.extractSpreadsheetText(resolved.fullPath);
      format = `office:${ext.slice(1)}`;
      extractor = "xlsx";
    } else if (PRESENTATION_EXTENSIONS.has(ext)) {
      rawText = await this.extractPresentationText(resolved.fullPath, ext);
      format = `office:${ext.slice(1)}`;
      extractor = "jszip";
    } else if (OPEN_DOCUMENT_TEXT_EXTENSIONS.has(ext)) {
      rawText = await this.extractOpenDocumentText(resolved.fullPath);
      format = `office:${ext.slice(1)}`;
      extractor = "jszip";
    } else if (RTF_EXTENSIONS.has(ext)) {
      const rtf = await fs.readFile(resolved.fullPath, "utf8");
      rawText = extractRtfText(rtf);
      format = "office:rtf";
      extractor = "native-rtf";
    } else {
      throw new Error(
        `Formato no soportado: ${ext}. Soportados: ${this.getSupportedFormats().join(", ")}`,
      );
    }

    const normalized = normalizeText(rawText);
    const truncated = truncateWithMarker(normalized, this.maxTextChars);

    return {
      path: resolved.relPath,
      fullPath: resolved.fullPath,
      format,
      fileSize: fileStat.size,
      text: truncated.value,
      extractedChars: normalized.length,
      truncated: truncated.truncated,
      extractor,
    };
  }

  private resolveSafePath(pathInput: string): { fullPath: string; relPath: string } {
    const trimmed = pathInput.trim();
    if (!trimmed) {
      throw new Error("Ruta vacía");
    }

    const fullPath = path.resolve(this.baseDir, trimmed);
    if (!fullPath.startsWith(this.baseDir + path.sep) && fullPath !== this.baseDir) {
      throw new Error("Ruta fuera del directorio permitido");
    }

    return {
      fullPath,
      relPath: path.relative(this.baseDir, fullPath).replace(/\\/g, "/"),
    };
  }

  private async extractPdfText(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      return parsed.text || "";
    } finally {
      await parser.destroy();
    }
  }

  private async extractDocxText(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.value.trim()) {
        return result.value;
      }
    } catch {
      // fallback below
    }

    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await extractZipEntryText(zip, "word/document.xml");
    if (!documentXml) {
      return "";
    }
    return extractTaggedXmlText(documentXml, {
      paragraphEndTags: ["w:p", "w:tr"],
      lineBreakTags: ["w:br", "w:cr"],
    });
  }

  private async extractSpreadsheetText(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer", raw: false });
    const chunks: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        continue;
      }

      const rowsRaw = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        blankrows: false,
      }) as unknown[];

      const rows = rowsRaw.filter(Array.isArray) as unknown[][];
      const lines = rows
        .map((row) => row.map((cell) => sanitizeCellValue(cell)).join("\t").trimEnd())
        .filter((line) => line.length > 0);

      if (lines.length === 0) {
        continue;
      }

      chunks.push(`## Sheet: ${sheetName}`);
      chunks.push(...lines);
      chunks.push("");
    }

    return chunks.join("\n");
  }

  private async extractPresentationText(filePath: string, extension: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);

    if (extension === ".pptx") {
      const slideNames = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => {
          const left = Number.parseInt(a.match(/slide(\d+)\.xml/i)?.[1] ?? "0", 10);
          const right = Number.parseInt(b.match(/slide(\d+)\.xml/i)?.[1] ?? "0", 10);
          return left - right;
        });

      const chunks: string[] = [];
      for (let index = 0; index < slideNames.length; index += 1) {
        const slideName = slideNames[index]!;
        const xml = await extractZipEntryText(zip, slideName);
        const texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi))
          .map((match) => decodeXmlEntities(match[1] ?? "").trim())
          .filter(Boolean);
        if (texts.length === 0) {
          continue;
        }
        chunks.push(`## Slide ${index + 1}`);
        chunks.push(texts.join("\n"));
        chunks.push("");
      }

      return chunks.join("\n");
    }

    if (extension === ".odp") {
      const contentXml = await extractZipEntryText(zip, "content.xml");
      return extractTaggedXmlText(contentXml, {
        paragraphEndTags: ["text:p", "text:h", "table:table-row"],
        lineBreakTags: ["text:line-break"],
      });
    }

    return "";
  }

  private async extractOpenDocumentText(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);
    const contentXml = await extractZipEntryText(zip, "content.xml");
    if (!contentXml) {
      return "";
    }
    return extractTaggedXmlText(contentXml, {
      paragraphEndTags: ["text:p", "text:h", "table:table-row"],
      lineBreakTags: ["text:line-break"],
    });
  }
}
