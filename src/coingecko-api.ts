type CoinGeckoApiToolOptions = {
  timeoutMs: number;
};

export type CoinMarketResult = {
  id: string;
  symbol: string;
  name: string;
  currentPriceUsd: number;
  priceChange24hPct: number | null;
  marketCapRank: number | null;
  lastUpdated: string;
};

function clampInt(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class CoinGeckoApiTool {
  private readonly timeoutMs: number;

  constructor(options: CoinGeckoApiToolOptions) {
    this.timeoutMs = clampInt(options.timeoutMs, 3000, 60000);
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
        throw new Error(`CoinGecko API error (${response.status})`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapMarkets(
    rows: Array<{
      id?: unknown;
      symbol?: unknown;
      name?: unknown;
      current_price?: unknown;
      price_change_percentage_24h?: unknown;
      market_cap_rank?: unknown;
      last_updated?: unknown;
    }>,
    limit: number,
  ): CoinMarketResult[] {
    return rows
      .map((row) => ({
        id: normalizeText(row.id),
        symbol: normalizeText(row.symbol),
        name: normalizeText(row.name),
        currentPriceUsd: typeof row.current_price === "number" ? row.current_price : Number.NaN,
        priceChange24hPct:
          typeof row.price_change_percentage_24h === "number" ? row.price_change_percentage_24h : null,
        marketCapRank: typeof row.market_cap_rank === "number" ? row.market_cap_rank : null,
        lastUpdated: normalizeText(row.last_updated),
      }))
      .filter((row) => row.id && row.name && Number.isFinite(row.currentPriceUsd))
      .slice(0, limit);
  }

  async getTopMarkets(limitInput?: number): Promise<CoinMarketResult[]> {
    const limit = clampInt(limitInput, 1, 10);
    const endpoint = new URL("https://api.coingecko.com/api/v3/coins/markets");
    endpoint.searchParams.set("vs_currency", "usd");
    endpoint.searchParams.set("order", "market_cap_desc");
    endpoint.searchParams.set("per_page", String(limit));
    endpoint.searchParams.set("page", "1");
    endpoint.searchParams.set("sparkline", "false");

    const payload = await this.fetchJson<
      Array<{
        id?: unknown;
        symbol?: unknown;
        name?: unknown;
        current_price?: unknown;
        price_change_percentage_24h?: unknown;
        market_cap_rank?: unknown;
        last_updated?: unknown;
      }>
    >(endpoint.toString());

    return this.mapMarkets(payload, limit);
  }

  async searchMarkets(query: string, limitInput?: number): Promise<CoinMarketResult[]> {
    const limit = clampInt(limitInput, 1, 10);
    const cleanQuery = query.trim();
    if (!cleanQuery) {
      return this.getTopMarkets(limit);
    }

    const searchEndpoint = new URL("https://api.coingecko.com/api/v3/search");
    searchEndpoint.searchParams.set("query", cleanQuery);

    const searchPayload = await this.fetchJson<{
      coins?: Array<{
        id?: unknown;
      }>;
    }>(searchEndpoint.toString());

    const ids = (searchPayload.coins ?? [])
      .map((coin) => normalizeText(coin.id))
      .filter(Boolean)
      .slice(0, limit);

    if (ids.length === 0) {
      return [];
    }

    const marketsEndpoint = new URL("https://api.coingecko.com/api/v3/coins/markets");
    marketsEndpoint.searchParams.set("vs_currency", "usd");
    marketsEndpoint.searchParams.set("ids", ids.join(","));
    marketsEndpoint.searchParams.set("order", "market_cap_desc");
    marketsEndpoint.searchParams.set("per_page", String(limit));
    marketsEndpoint.searchParams.set("page", "1");
    marketsEndpoint.searchParams.set("sparkline", "false");

    const marketsPayload = await this.fetchJson<
      Array<{
        id?: unknown;
        symbol?: unknown;
        name?: unknown;
        current_price?: unknown;
        price_change_percentage_24h?: unknown;
        market_cap_rank?: unknown;
        last_updated?: unknown;
      }>
    >(marketsEndpoint.toString());

    return this.mapMarkets(marketsPayload, limit);
  }
}
