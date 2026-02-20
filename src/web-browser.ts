import { URL } from "node:url";
import { load } from "cheerio";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebPageResult = {
  url: string;
  finalUrl: string;
  title: string;
  contentType: string;
  status: number;
  text: string;
  truncated: boolean;
};

type WebBrowserOptions = {
  timeoutMs: number;
  maxFetchBytes: number;
  maxTextChars: number;
  defaultSearchResults: number;
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeWhitespace(raw: string): string {
  return raw.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

function decodeDuckDuckGoRedirect(rawUrl: string): string {
  try {
    const asUrl = new URL(rawUrl, "https://duckduckgo.com");
    const encoded = asUrl.searchParams.get("uddg");
    if (encoded) {
      return decodeURIComponent(encoded);
    }
    return asUrl.toString();
  } catch {
    return rawUrl;
  }
}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower.endsWith(".local") ||
    lower.startsWith("10.") ||
    lower.startsWith("192.168.")
  ) {
    return true;
  }

  const match172 = lower.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number.parseInt(match172[1] ?? "", 10);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }

  return false;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HoudiAgent/1.0 Safari/537.36",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const preTruncated = Number.isFinite(contentLength) && contentLength > maxBytes;

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= maxBytes) {
      return { buffer, truncated: preTruncated };
    }
    return { buffer: buffer.slice(0, maxBytes), truncated: true };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = preTruncated;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk = Buffer.from(next.value);
    if (total + chunk.length > maxBytes) {
      const remain = Math.max(0, maxBytes - total);
      if (remain > 0) {
        chunks.push(chunk.slice(0, remain));
        total += remain;
      }
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      break;
    }
    total += chunk.length;
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

export class WebBrowser {
  private readonly timeoutMs: number;
  private readonly maxFetchBytes: number;
  private readonly maxTextChars: number;
  private readonly defaultSearchResults: number;

  constructor(options: WebBrowserOptions) {
    this.timeoutMs = clampInt(options.timeoutMs, 3000, 120_000);
    this.maxFetchBytes = clampInt(options.maxFetchBytes, 128_000, 10_000_000);
    this.maxTextChars = clampInt(options.maxTextChars, 1000, 200_000);
    this.defaultSearchResults = clampInt(options.defaultSearchResults, 1, 10);
  }

  async search(query: string, limitInput?: number): Promise<WebSearchResult[]> {
    const queryText = query.trim();
    if (!queryText) {
      return [];
    }

    const limit = clampInt(limitInput ?? this.defaultSearchResults, 1, 10);
    const endpoint = `https://duckduckgo.com/html/?q=${encodeURIComponent(queryText)}&kl=us-en`;
    const response = await fetchWithTimeout(endpoint, this.timeoutMs);
    if (!response.ok) {
      throw new Error(`search web falló (${response.status})`);
    }

    const html = await response.text();
    const $ = load(html);
    const hits: WebSearchResult[] = [];
    const seen = new Set<string>();

    $(".result").each((_, item) => {
      if (hits.length >= limit) {
        return;
      }
      const link = $(item).find("a.result__a").first();
      const hrefRaw = link.attr("href")?.trim() ?? "";
      if (!hrefRaw) {
        return;
      }
      const decoded = decodeDuckDuckGoRedirect(hrefRaw).replace(/[\u0000-\u001F\u007F]/g, "").trim();
      if (!isHttpUrl(decoded)) {
        return;
      }
      if (seen.has(decoded)) {
        return;
      }
      seen.add(decoded);

      const title = normalizeWhitespace(link.text() || "(sin título)");
      const snippet = normalizeWhitespace($(item).find(".result__snippet").first().text() || "");
      hits.push({
        title: title || "(sin título)",
        url: decoded,
        snippet,
      });
    });

    return hits.slice(0, limit);
  }

  async open(urlInput: string): Promise<WebPageResult> {
    const normalized = urlInput.trim();
    if (!normalized) {
      throw new Error("URL vacía");
    }
    if (!isHttpUrl(normalized)) {
      throw new Error("Solo se permiten URLs http/https");
    }

    const parsed = new URL(normalized);
    if (isBlockedHostname(parsed.hostname)) {
      throw new Error(`Hostname bloqueado por seguridad: ${parsed.hostname}`);
    }

    const response = await fetchWithTimeout(parsed.toString(), this.timeoutMs);
    if (!response.ok) {
      throw new Error(`no pude abrir la URL (${response.status})`);
    }

    const finalUrl = response.url || parsed.toString();
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const body = await readBodyCapped(response, this.maxFetchBytes);
    const asText = body.buffer.toString("utf8");

    let title = finalUrl;
    let text = "";

    if (contentType.includes("text/html")) {
      const $ = load(asText);
      $("script,style,noscript,svg,canvas,footer,header,nav,form,aside,iframe").remove();
      title = normalizeWhitespace($("title").first().text()) || finalUrl;

      let root = $("article").first();
      if (root.length === 0) {
        root = $("main").first();
      }
      if (root.length === 0) {
        root = $("body").first();
      }
      text = normalizeWhitespace(root.text());
    } else if (
      contentType.includes("text/plain") ||
      contentType.includes("application/json") ||
      contentType.includes("application/xml") ||
      contentType.includes("text/xml")
    ) {
      text = normalizeWhitespace(asText);
    } else {
      throw new Error(`tipo de contenido no soportado: ${contentType || "desconocido"}`);
    }

    const truncated = truncateWithMarker(text, this.maxTextChars);
    return {
      url: parsed.toString(),
      finalUrl,
      title,
      contentType,
      status: response.status,
      text: truncated.value,
      truncated: truncated.truncated || body.truncated,
    };
  }
}
