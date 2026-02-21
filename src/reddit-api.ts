type RedditApiToolOptions = {
  timeoutMs: number;
  userAgent?: string;
};

export type RedditSearchParams = {
  query: string;
  subreddit?: string;
  limit?: number;
  sort?: "relevance" | "hot" | "new" | "top" | "comments";
  time?: "hour" | "day" | "week" | "month" | "year" | "all";
};

export type RedditPostResult = {
  id: string;
  title: string;
  url: string;
  permalink: string;
  subreddit: string;
  author: string;
  score: number;
  numComments: number;
  createdUtc: number;
  selfText: string;
  over18: boolean;
};

function clampInt(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function normalizeText(raw: string): string {
  return raw.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function pickPostUrl(data: {
  permalink?: unknown;
  url?: unknown;
  is_self?: unknown;
  subreddit?: unknown;
}): { url: string; permalink: string } {
  const permalinkRaw = typeof data.permalink === "string" ? data.permalink.trim() : "";
  const permalink = permalinkRaw.startsWith("http")
    ? permalinkRaw
    : permalinkRaw
      ? `https://www.reddit.com${permalinkRaw}`
      : "";
  const directUrl = typeof data.url === "string" ? data.url.trim() : "";
  const usePermalink = Boolean(data.is_self) || !directUrl;
  return {
    url: usePermalink ? permalink || directUrl : directUrl,
    permalink: permalink || directUrl,
  };
}

export class RedditApiTool {
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: RedditApiToolOptions) {
    this.timeoutMs = clampInt(options.timeoutMs, 3000, 60_000);
    this.userAgent =
      options.userAgent?.trim() || "houdi-agent/1.0 (by u/houdi_assistant; +https://github.com/lichoudini/houdi-agent)";
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": this.userAgent,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Reddit API error (${response.status})`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async searchPosts(params: RedditSearchParams): Promise<RedditPostResult[]> {
    const query = params.query.trim();
    if (!query) {
      return [];
    }
    const limit = clampInt(params.limit, 1, 25);
    const sort = params.sort ?? "new";
    const time = params.time ?? "week";
    const subreddit = params.subreddit?.trim();

    const endpoint = subreddit
      ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=${encodeURIComponent(sort)}&t=${encodeURIComponent(time)}&limit=${limit}&raw_json=1`
      : `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}&t=${encodeURIComponent(time)}&limit=${limit}&raw_json=1`;

    const payload = await this.fetchJson<{
      data?: {
        children?: Array<{
          data?: Record<string, unknown>;
        }>;
      };
    }>(endpoint);

    const children = payload.data?.children ?? [];
    const results: RedditPostResult[] = [];
    for (const child of children) {
      const data = child.data ?? {};
      const id = typeof data.id === "string" ? data.id.trim() : "";
      const title = typeof data.title === "string" ? normalizeText(data.title) : "";
      if (!id || !title) {
        continue;
      }
      const urls = pickPostUrl(data);
      if (!urls.url) {
        continue;
      }
      results.push({
        id,
        title,
        url: urls.url,
        permalink: urls.permalink || urls.url,
        subreddit: typeof data.subreddit === "string" ? data.subreddit : "unknown",
        author: typeof data.author === "string" ? data.author : "unknown",
        score: typeof data.score === "number" ? data.score : 0,
        numComments: typeof data.num_comments === "number" ? data.num_comments : 0,
        createdUtc: typeof data.created_utc === "number" ? data.created_utc : 0,
        selfText: typeof data.selftext === "string" ? normalizeText(data.selftext) : "",
        over18: Boolean(data.over_18),
      });
    }
    return results;
  }
}

