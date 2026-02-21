type NewsApiToolOptions = {
  timeoutMs: number;
  gnewsApiKey?: string;
  newsApiKey?: string;
};

export type NewsArticleResult = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
};

export type NewsSearchParams = {
  query: string;
  limit?: number;
  language?: string;
  from?: Date;
  to?: Date;
};

function clampInt(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeText(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function toIsoDate(date: Date): string {
  return date.toISOString();
}

export class NewsApiTool {
  private readonly timeoutMs: number;
  private readonly gnewsApiKey?: string;
  private readonly newsApiKey?: string;

  constructor(options: NewsApiToolOptions) {
    this.timeoutMs = clampInt(options.timeoutMs, 3000, 60000);
    this.gnewsApiKey = options.gnewsApiKey?.trim() || undefined;
    this.newsApiKey = options.newsApiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.gnewsApiKey || this.newsApiKey);
  }

  providerName(): string {
    if (this.gnewsApiKey) {
      return "gnews";
    }
    if (this.newsApiKey) {
      return "newsapi";
    }
    return "none";
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "houdi-agent/1.0",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`News API error (${response.status})`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchWithGnews(params: NewsSearchParams): Promise<NewsArticleResult[]> {
    if (!this.gnewsApiKey) {
      return [];
    }

    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const limit = clampInt(params.limit, 1, 10);
    const language = normalizeText(params.language) || "es";
    const from = params.from ? toIsoDate(params.from) : undefined;
    const to = params.to ? toIsoDate(params.to) : undefined;

    const endpoint = new URL("https://gnews.io/api/v4/search");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("lang", language);
    endpoint.searchParams.set("sortby", "publishedAt");
    endpoint.searchParams.set("max", String(limit));
    endpoint.searchParams.set("token", this.gnewsApiKey);
    if (from) {
      endpoint.searchParams.set("from", from);
    }
    if (to) {
      endpoint.searchParams.set("to", to);
    }

    const payload = await this.fetchJson<{
      articles?: Array<{
        title?: unknown;
        description?: unknown;
        url?: unknown;
        publishedAt?: unknown;
        source?: { name?: unknown };
      }>;
    }>(endpoint.toString());

    return (payload.articles ?? [])
      .map((item) => ({
        title: normalizeText(item.title),
        description: normalizeText(item.description),
        url: normalizeText(item.url),
        source: normalizeText(item.source?.name) || "unknown",
        publishedAt: normalizeText(item.publishedAt),
      }))
      .filter((item) => item.title && item.url)
      .slice(0, limit);
  }

  private async searchWithNewsApi(params: NewsSearchParams): Promise<NewsArticleResult[]> {
    if (!this.newsApiKey) {
      return [];
    }

    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const limit = clampInt(params.limit, 1, 20);
    const language = normalizeText(params.language) || "es";
    const fromDate = params.from ? params.from.toISOString().slice(0, 10) : undefined;
    const toDate = params.to ? params.to.toISOString().slice(0, 10) : undefined;

    const endpoint = new URL("https://newsapi.org/v2/everything");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("language", language);
    endpoint.searchParams.set("sortBy", "publishedAt");
    endpoint.searchParams.set("pageSize", String(limit));
    endpoint.searchParams.set("apiKey", this.newsApiKey);
    if (fromDate) {
      endpoint.searchParams.set("from", fromDate);
    }
    if (toDate) {
      endpoint.searchParams.set("to", toDate);
    }

    const payload = await this.fetchJson<{
      articles?: Array<{
        title?: unknown;
        description?: unknown;
        url?: unknown;
        publishedAt?: unknown;
        source?: { name?: unknown };
      }>;
    }>(endpoint.toString());

    return (payload.articles ?? [])
      .map((item) => ({
        title: normalizeText(item.title),
        description: normalizeText(item.description),
        url: normalizeText(item.url),
        source: normalizeText(item.source?.name) || "unknown",
        publishedAt: normalizeText(item.publishedAt),
      }))
      .filter((item) => item.title && item.url)
      .slice(0, limit);
  }

  async searchLatest(params: NewsSearchParams): Promise<NewsArticleResult[]> {
    if (!this.isConfigured()) {
      throw new Error("News API no configurada. Define GNEWS_API_KEY o NEWSAPI_KEY.");
    }

    const withGnews = await this.searchWithGnews(params);
    if (withGnews.length > 0) {
      return withGnews;
    }

    const withNewsApi = await this.searchWithNewsApi(params);
    if (withNewsApi.length > 0) {
      return withNewsApi;
    }

    return [];
  }
}
