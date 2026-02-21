type OpenMeteoApiToolOptions = {
  timeoutMs: number;
};

export type WeatherSnapshot = {
  locationName: string;
  timezone: string;
  latitude: number;
  longitude: number;
  current: {
    time: string;
    temperatureC: number;
    windKmh: number;
    humidityPct: number | null;
    weatherCode: number;
    weatherText: string;
  };
  nextDays: Array<{
    date: string;
    maxC: number;
    minC: number;
    weatherCode: number;
    weatherText: string;
  }>;
};

function clampInt(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function weatherCodeToText(code: number): string {
  const mapping: Record<number, string> = {
    0: "Despejado",
    1: "Mayormente despejado",
    2: "Parcialmente nublado",
    3: "Nublado",
    45: "Niebla",
    48: "Niebla con escarcha",
    51: "Llovizna ligera",
    53: "Llovizna",
    55: "Llovizna intensa",
    61: "Lluvia ligera",
    63: "Lluvia",
    65: "Lluvia intensa",
    71: "Nieve ligera",
    73: "Nieve",
    75: "Nieve intensa",
    80: "Chubascos ligeros",
    81: "Chubascos",
    82: "Chubascos intensos",
    95: "Tormenta",
    96: "Tormenta con granizo",
    99: "Tormenta severa",
  };
  return mapping[code] ?? "Condición no especificada";
}

export class OpenMeteoApiTool {
  private readonly timeoutMs: number;

  constructor(options: OpenMeteoApiToolOptions) {
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
        throw new Error(`Open-Meteo API error (${response.status})`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getWeather(locationQuery: string): Promise<WeatherSnapshot> {
    const query = locationQuery.trim();
    if (!query) {
      throw new Error("Ubicación vacía");
    }

    const geocodeEndpoint = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geocodeEndpoint.searchParams.set("name", query);
    geocodeEndpoint.searchParams.set("count", "1");
    geocodeEndpoint.searchParams.set("language", "es");
    geocodeEndpoint.searchParams.set("format", "json");

    const geoPayload = await this.fetchJson<{
      results?: Array<{
        name?: unknown;
        country?: unknown;
        latitude?: unknown;
        longitude?: unknown;
      }>;
    }>(geocodeEndpoint.toString());

    const first = geoPayload.results?.[0];
    if (!first) {
      throw new Error(`No encontré la ubicación: ${query}`);
    }

    const latitude = asNumber(first.latitude);
    const longitude = asNumber(first.longitude);
    if (latitude === null || longitude === null) {
      throw new Error("La ubicación encontrada no tiene coordenadas válidas");
    }

    const locationName = [String(first.name ?? "").trim(), String(first.country ?? "").trim()]
      .filter(Boolean)
      .join(", ");

    const forecastEndpoint = new URL("https://api.open-meteo.com/v1/forecast");
    forecastEndpoint.searchParams.set("latitude", String(latitude));
    forecastEndpoint.searchParams.set("longitude", String(longitude));
    forecastEndpoint.searchParams.set(
      "current",
      "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
    );
    forecastEndpoint.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    forecastEndpoint.searchParams.set("timezone", "auto");
    forecastEndpoint.searchParams.set("forecast_days", "3");

    const payload = await this.fetchJson<{
      timezone?: unknown;
      current?: {
        time?: unknown;
        temperature_2m?: unknown;
        relative_humidity_2m?: unknown;
        weather_code?: unknown;
        wind_speed_10m?: unknown;
      };
      daily?: {
        time?: unknown;
        weather_code?: unknown;
        temperature_2m_max?: unknown;
        temperature_2m_min?: unknown;
      };
    }>(forecastEndpoint.toString());

    const currentCode = asNumber(payload.current?.weather_code) ?? -1;
    const currentTemp = asNumber(payload.current?.temperature_2m);
    const currentWind = asNumber(payload.current?.wind_speed_10m);
    if (currentTemp === null || currentWind === null) {
      throw new Error("No pude obtener clima actual para esa ubicación");
    }

    const dates = Array.isArray(payload.daily?.time) ? payload.daily?.time : [];
    const codes = Array.isArray(payload.daily?.weather_code) ? payload.daily?.weather_code : [];
    const maxs = Array.isArray(payload.daily?.temperature_2m_max) ? payload.daily?.temperature_2m_max : [];
    const mins = Array.isArray(payload.daily?.temperature_2m_min) ? payload.daily?.temperature_2m_min : [];

    const nextDays: WeatherSnapshot["nextDays"] = [];
    for (let index = 0; index < dates.length; index += 1) {
      const dayCode = asNumber(codes[index]) ?? -1;
      const dayMax = asNumber(maxs[index]);
      const dayMin = asNumber(mins[index]);
      const dateRaw = typeof dates[index] === "string" ? dates[index] : "";
      if (!dateRaw || dayMax === null || dayMin === null) {
        continue;
      }
      nextDays.push({
        date: dateRaw,
        maxC: dayMax,
        minC: dayMin,
        weatherCode: dayCode,
        weatherText: weatherCodeToText(dayCode),
      });
    }

    return {
      locationName: locationName || query,
      timezone: String(payload.timezone ?? "desconocida"),
      latitude,
      longitude,
      current: {
        time: String(payload.current?.time ?? ""),
        temperatureC: currentTemp,
        windKmh: currentWind,
        humidityPct: asNumber(payload.current?.relative_humidity_2m),
        weatherCode: currentCode,
        weatherText: weatherCodeToText(currentCode),
      },
      nextDays,
    };
  }
}
