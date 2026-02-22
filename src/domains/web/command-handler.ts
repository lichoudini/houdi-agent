import type { WebPageResult, WebSearchResult } from "../../web-browser.js";
import type { PromptContextSnapshot } from "../../agent-context-memory.js";
import {
  parseWebAskCommandInput,
  parseWebOpenCommandInput,
  parseWebSearchCommandInput,
} from "./command-parser.js";

type WebChatContext = {
  chat: { id: number };
  from?: { id?: number };
  reply: (text: string) => Promise<unknown>;
};

type RunWebSearchQueryResult = {
  hits: WebSearchResult[];
  query: string;
  usedFallbackQuery: boolean;
};

type BuildPromptContextFn = (query: string, params: { chatId: number }) => Promise<PromptContextSnapshot | undefined>;

type AskOpenAiFn = (params: { chatId: number; prompt: string; context?: PromptContextSnapshot }) => Promise<string>;

type WebCommandDeps = {
  enableWebBrowse: boolean;
  newsMaxAgeDays: number;
  isLikelyNewsQuery: (text: string) => boolean;
  buildFreshNewsSearchQuery: (text: string) => string;
  runWebSearchQuery: (params: { rawQuery: string; newsRequested: boolean }) => Promise<RunWebSearchQueryResult>;
  buildWebResultsListText: (params: { query: string; hits: WebSearchResult[]; newsRequested: boolean }) => string;
  rememberWebResultsListContext: (params: { chatId: number; title: string; hits: WebSearchResult[]; source: string }) => void;
  setLastWebResults: (chatId: number, hits: WebSearchResult[]) => void;
  getLastWebResults: (chatId: number) => WebSearchResult[] | undefined;
  parseWebOpenTarget: (
    input: string,
    lastResults: WebSearchResult[] | undefined,
  ) => { url: string; question: string; sourceIndex?: number };
  openWebPage: (url: string) => Promise<WebPageResult>;
  truncateInline: (text: string, maxChars: number) => string;
  replyLong: (ctx: WebChatContext, text: string) => Promise<void>;
  replyProgress: (ctx: WebChatContext, text: string) => Promise<void>;
  safeAudit: (params: { type: string; chatId: number; userId?: number; details?: Record<string, unknown> }) => Promise<void>;
  appendConversationTurn: (params: {
    chatId: number;
    userId?: number;
    role: "user" | "assistant";
    text: string;
    source: string;
  }) => Promise<void>;
  isOpenAiConfigured: () => boolean;
  isEcoModeEnabled: (chatId: number) => boolean;
  buildPromptContextForQuery: BuildPromptContextFn;
  askOpenAiForChat: AskOpenAiFn;
};

export async function runWebSlashSearchCommand(params: {
  ctx: WebChatContext;
  rawInput: string;
  deps: WebCommandDeps;
}): Promise<void> {
  const { ctx, deps } = params;
  if (!deps.enableWebBrowse) {
    await ctx.reply("Navegación web deshabilitada por configuración (ENABLE_WEB_BROWSE=false).");
    return;
  }

  const parsed = parseWebSearchCommandInput(params.rawInput);
  if (!parsed.ok) {
    await ctx.reply(parsed.error);
    return;
  }
  const rawQuery = parsed.query;
  const newsRequested = deps.isLikelyNewsQuery(rawQuery);
  const searchQuery = newsRequested ? deps.buildFreshNewsSearchQuery(rawQuery) : rawQuery;
  await deps.replyProgress(
    ctx,
    newsRequested
      ? `Buscando noticias recientes: ${searchQuery}`
      : `Buscando en web: ${searchQuery}`,
  );
  try {
    const searchResult = await deps.runWebSearchQuery({ rawQuery, newsRequested });
    const hits = searchResult.hits;
    if (hits.length === 0) {
      await ctx.reply(newsRequested ? "No encontré noticias recientes relevantes sobre ese tema." : "Sin resultados relevantes.");
      return;
    }
    deps.setLastWebResults(ctx.chat.id, hits);
    deps.rememberWebResultsListContext({
      chatId: ctx.chat.id,
      title: `Resultados web: ${rawQuery}`,
      hits,
      source: "telegram:/web",
    });
    const responseText = [
      deps.buildWebResultsListText({ query: rawQuery, hits, newsRequested }),
      "Tip: usa /webopen <n> para abrir uno (ej: /webopen 1).",
    ].join("\n\n");
    await deps.replyLong(ctx, responseText);
    await deps.safeAudit({
      type: "web.search",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: searchResult.query,
        rawQuery,
        usedFallbackQuery: searchResult.usedFallbackQuery,
        newsRequested,
        results: hits.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude buscar en web: ${message}`);
    await deps.safeAudit({
      type: "web.search_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: { query: rawQuery, error: message },
    });
  }
}

export async function runWebSlashOpenCommand(params: {
  ctx: WebChatContext;
  rawInput: string;
  deps: WebCommandDeps;
}): Promise<void> {
  const { ctx, deps } = params;
  if (!deps.enableWebBrowse) {
    await ctx.reply("Navegación web deshabilitada por configuración (ENABLE_WEB_BROWSE=false).");
    return;
  }
  const parsed = parseWebOpenCommandInput({
    raw: params.rawInput,
    lastResults: deps.getLastWebResults(ctx.chat.id),
    parseTarget: deps.parseWebOpenTarget,
  });
  if (!parsed.ok) {
    await ctx.reply(parsed.error);
    return;
  }
  const target = parsed.value;
  await deps.replyProgress(ctx, `Abriendo ${target.url}...`);
  try {
    const page = await deps.openWebPage(target.url);
    const header = [
      `URL: ${page.finalUrl}`,
      `Título: ${page.title}`,
      `Tipo: ${page.contentType || "desconocido"}`,
      `Truncado: ${page.truncated ? "sí" : "no"}`,
    ].join("\n");

    if (!target.question) {
      const preview = deps.truncateInline(page.text, 3500);
      await deps.replyLong(
        ctx,
        [header, "", preview || "(sin contenido textual útil)", "", "Tip: /webopen <n|url> <pregunta> para analizar con IA."].join(
          "\n",
        ),
      );
      return;
    }

    if (!deps.isOpenAiConfigured()) {
      await deps.replyLong(
        ctx,
        [header, "", "OpenAI no está configurado para análisis. Usa /webopen sin pregunta para ver contenido."].join("\n"),
      );
      return;
    }

    const ecoEnabled = deps.isEcoModeEnabled(ctx.chat.id);
    const prompt = [
      "Analiza este contenido web y responde la pregunta del usuario.",
      `URL: ${page.finalUrl}`,
      `Título: ${page.title}`,
      `Tipo: ${page.contentType}`,
      "",
      "Contenido:",
      page.text,
      "",
      `Pregunta: ${target.question}`,
      "",
      ...(ecoEnabled
        ? ["MODO ECO: respuesta ultra-concisa.", "Usa 3 bullets máximos + 1 acción recomendada."]
        : ["Al final, incluye una línea de fuente con la URL usada."]),
    ].join("\n");
    const promptContext = await deps.buildPromptContextForQuery(`${target.question}\n${page.title}`, {
      chatId: ctx.chat.id,
    });
    const answerRaw = await deps.askOpenAiForChat({ chatId: ctx.chat.id, prompt, context: promptContext });
    const answer = ecoEnabled ? deps.truncateInline(answerRaw, 900) : answerRaw;
    await deps.replyLong(ctx, answer);
    await ctx.reply(`Fuente: ${page.finalUrl}`);
    await deps.appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: `[WEBOPEN] ${target.url} | ${target.question}`,
      source: "telegram:/webopen",
    });
    await deps.appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "assistant",
      text: `${answer}\nFuente: ${page.finalUrl}`,
      source: "telegram:/webopen",
    });
    await deps.safeAudit({
      type: "web.open",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        url: target.url,
        finalUrl: page.finalUrl,
        withQuestion: true,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude abrir esa URL: ${message}`);
    await deps.safeAudit({
      type: "web.open_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: { url: target.url, error: message },
    });
  }
}

export async function runWebSlashAskCommand(params: {
  ctx: WebChatContext;
  rawInput: string;
  deps: WebCommandDeps;
}): Promise<void> {
  const { ctx, deps } = params;
  if (!deps.enableWebBrowse) {
    await ctx.reply("Navegación web deshabilitada por configuración (ENABLE_WEB_BROWSE=false).");
    return;
  }
  const parsed = parseWebAskCommandInput(params.rawInput);
  if (!parsed.ok) {
    await ctx.reply(parsed.error);
    return;
  }
  if (!deps.isOpenAiConfigured()) {
    await ctx.reply("OpenAI no está configurado. Agrega OPENAI_API_KEY en .env y reinicia el bot.");
    return;
  }

  const rawQuery = parsed.query;
  const newsRequested = deps.isLikelyNewsQuery(rawQuery);
  const searchQuery = newsRequested ? deps.buildFreshNewsSearchQuery(rawQuery) : rawQuery;
  await deps.replyProgress(
    ctx,
    newsRequested
      ? `Buscando y sintetizando noticias recientes: ${searchQuery}`
      : `Buscando y sintetizando en web: ${searchQuery}`,
  );
  try {
    const searchResult = await deps.runWebSearchQuery({ rawQuery, newsRequested });
    const hits = searchResult.hits;
    if (hits.length === 0) {
      await ctx.reply(
        newsRequested ? "No encontré noticias recientes relevantes para sintetizar." : "Sin resultados relevantes para sintetizar.",
      );
      return;
    }
    deps.setLastWebResults(ctx.chat.id, hits);
    deps.rememberWebResultsListContext({
      chatId: ctx.chat.id,
      title: `Resultados web: ${rawQuery}`,
      hits,
      source: "telegram:/webask",
    });

    const top = hits.slice(0, newsRequested ? 5 : 3);
    const pages = await Promise.allSettled(top.map(async (hit) => ({ hit, page: await deps.openWebPage(hit.url) })));
    const sources: Array<{ title: string; url: string; text: string }> = [];
    for (const item of pages) {
      if (item.status !== "fulfilled") {
        continue;
      }
      const excerpt = deps.truncateInline(item.value.page.text, 5000);
      if (!excerpt) {
        continue;
      }
      sources.push({
        title: item.value.page.title || item.value.hit.title,
        url: item.value.page.finalUrl || item.value.hit.url,
        text: excerpt,
      });
    }
    if (sources.length === 0) {
      await ctx.reply("Encontré resultados, pero no pude extraer contenido utilizable.");
      return;
    }
    const sourceBlocks = sources
      .map((source, index) => [`Fuente ${index + 1}: ${source.title}`, `URL: ${source.url}`, source.text].join("\n"))
      .join("\n\n---\n\n");

    const ecoEnabled = deps.isEcoModeEnabled(ctx.chat.id);
    const prompt = [
      "Responde la consulta del usuario usando SOLO la evidencia de las fuentes provistas.",
      newsRequested
        ? `El pedido es de noticias: prioriza hechos de los ultimos ${deps.newsMaxAgeDays} dias y menciona fechas concretas (dia/mes/ano) cuando esten disponibles.`
        : "Si la evidencia no alcanza, dilo explicitamente.",
      newsRequested
        ? "Prioriza fuentes web especializadas y marca que puntos requieren validacion adicional."
        : "Se claro y breve.",
      newsRequested
        ? `No uses como base noticias de mas de ${deps.newsMaxAgeDays} dias; si no hay suficiente evidencia reciente, dilo explicitamente.`
        : "Evita suposiciones.",
      "No devuelvas JSON, YAML ni bloques de codigo.",
      ...(ecoEnabled
        ? [
            "MODO ECO: salida mínima en español.",
            "Formato exacto y único:",
            "1) 3 bullets máximos con lo más reciente/relevante.",
            "2) 1 acción recomendada.",
            "3) Fuentes usadas: máximo 3 links.",
            "No agregues texto extra.",
          ]
        : [
            "Entrega una respuesta natural en espanol con este formato:",
            "1) Resumen breve (3-5 viñetas).",
            "2) Lecturas recomendadas: hasta 5 items con titulo, mini-resumen y link.",
            "Si no tienes evidencia suficiente, dilo explicitamente.",
          ]),
      `Consulta del usuario: ${rawQuery}`,
      `Consulta web ejecutada: ${searchResult.usedFallbackQuery ? `${searchResult.query} (fallback: ${rawQuery})` : searchResult.query}`,
      "",
      "Fuentes:",
      sourceBlocks,
      "",
      ...(ecoEnabled ? [] : ["Incluye al final una sección 'Fuentes usadas:' con las URLs en viñetas."]),
    ].join("\n");
    const promptContext = await deps.buildPromptContextForQuery(rawQuery, { chatId: ctx.chat.id });
    const answerRaw = await deps.askOpenAiForChat({ chatId: ctx.chat.id, prompt, context: promptContext });
    const answer = ecoEnabled ? deps.truncateInline(answerRaw, 1200) : answerRaw;
    await deps.replyLong(ctx, answer);
    await deps.appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "user",
      text: `[WEBASK] ${rawQuery}`,
      source: "telegram:/webask",
    });
    await deps.appendConversationTurn({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      role: "assistant",
      text: answer,
      source: "telegram:/webask",
    });
    await deps.safeAudit({
      type: "web.ask",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: searchResult.query,
        rawQuery,
        usedFallbackQuery: searchResult.usedFallbackQuery,
        newsRequested,
        sources: sources.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`No pude completar /webask: ${message}`);
    await deps.safeAudit({
      type: "web.ask_failed",
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      details: {
        query: rawQuery,
        error: message,
      },
    });
  }
}
