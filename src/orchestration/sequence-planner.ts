export type AiSequencePlanStep = {
  instruction: string;
  aiContentPrompt?: string;
};

export type ParseAiSequencePlanOptions = {
  maxSteps: number;
  truncateInline: (text: string, maxChars: number) => string;
};

export function tryParseAiSequencePlan(
  raw: string,
  options: ParseAiSequencePlanOptions,
): { mode: "single" | "sequence"; steps: AiSequencePlanStep[]; reason?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as {
      mode?: unknown;
      steps?: unknown;
      reason?: unknown;
    };
    const modeRaw = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
    if (modeRaw !== "single" && modeRaw !== "sequence") {
      return null;
    }

    const steps = (Array.isArray(parsed.steps) ? parsed.steps : [])
      .map((entry) => {
        const instruction =
          typeof (entry as { instruction?: unknown })?.instruction === "string"
            ? options.truncateInline((entry as { instruction: string }).instruction.trim(), 700)
            : "";
        const aiContentPrompt =
          typeof (entry as { ai_content_prompt?: unknown })?.ai_content_prompt === "string"
            ? options.truncateInline((entry as { ai_content_prompt: string }).ai_content_prompt.trim(), 700)
            : "";
        if (!instruction) {
          return null;
        }
        return {
          instruction,
          ...(aiContentPrompt ? { aiContentPrompt } : {}),
        };
      })
      .filter((item): item is AiSequencePlanStep => Boolean(item))
      .slice(0, options.maxSteps);

    const reason = typeof parsed.reason === "string" ? options.truncateInline(parsed.reason.trim(), 180) : "";
    return {
      mode: modeRaw,
      steps,
      ...(reason ? { reason } : {}),
    };
  } catch {
    return null;
  }
}

export type SequencePlannerDeps = {
  isOpenAiConfigured: () => boolean;
  buildPromptContextForQuery: (query: string, options?: { chatId?: number }) => Promise<unknown>;
  askOpenAiForChat: (params: { chatId: number; prompt: string; context?: unknown }) => Promise<string>;
  getRecentConversationContext: (chatId: number, currentUserText: string, limit: number) => string[];
  truncateInline: (text: string, maxChars: number) => string;
};

export async function classifySequencedIntentPlanWithAi(
  params: {
    chatId: number;
    text: string;
  },
  deps: SequencePlannerDeps,
  options: {
    minTextChars: number;
    maxSteps: number;
    recentTurnsLimit: number;
  },
): Promise<{ steps: AiSequencePlanStep[]; reason?: string } | null> {
  const text = params.text.trim();
  if (!deps.isOpenAiConfigured() || text.length < options.minTextChars) {
    return null;
  }

  const background = deps.getRecentConversationContext(params.chatId, text, options.recentTurnsLimit);
  const prompt = [
    "Eres un router de instrucciones secuenciadas.",
    "Debes decidir si el pedido es single o sequence.",
    "Si es sequence, devuelve pasos concretos en orden de ejecucion.",
    "Devuelve SOLO JSON valido.",
    "",
    "Dominios de ejecucion disponibles: workspace, gmail, gmail-recipients, web, document, memory, schedule, connector, self-maintenance.",
    "",
    "Reglas:",
    "- Usa mode=sequence solo si hay 2 o mas acciones distintas o dependientes.",
    "- Si no, usa mode=single y steps vacio.",
    "- Cada step.instruction debe ser accionable por el agente en lenguaje natural.",
    "- Si un paso necesita texto creativo/largo, agrega ai_content_prompt y usa {{ai_content}} dentro de instruction.",
    `- Maximo ${options.maxSteps} pasos.`,
    "",
    'Formato: {"mode":"single|sequence","steps":[{"instruction":"string","ai_content_prompt":"string opcional"}],"reason":"motivo breve"}',
    `Pedido actual: ${text}`,
    ...(background.length > 0
      ? ["Contexto reciente (ultimos turnos):", ...background]
      : ["Contexto reciente: (vacio)"]),
  ].join("\n");

  const promptContext = await deps.buildPromptContextForQuery(text, { chatId: params.chatId });
  try {
    const answer = await deps.askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
    const parsed = tryParseAiSequencePlan(answer, {
      maxSteps: options.maxSteps,
      truncateInline: deps.truncateInline,
    });
    if (!parsed || parsed.mode !== "sequence" || parsed.steps.length < 2) {
      return null;
    }
    return {
      steps: parsed.steps,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  } catch {
    return null;
  }
}

export async function generateSequenceStepContentWithAi(
  params: {
    chatId: number;
    userText: string;
    stepInstruction: string;
    contentPrompt: string;
  },
  deps: {
    buildPromptContextForQuery: (query: string, options?: { chatId?: number }) => Promise<unknown>;
    askOpenAiForChat: (params: { chatId: number; prompt: string; context?: unknown }) => Promise<string>;
  },
): Promise<string | null> {
  const prompt = [
    "Genera SOLO el contenido solicitado.",
    "No expliques nada, no uses markdown, no agregues encabezados.",
    "",
    `Pedido original: ${params.userText}`,
    `Paso: ${params.stepInstruction}`,
    `Contenido a generar: ${params.contentPrompt}`,
  ].join("\n");

  const promptContext = await deps.buildPromptContextForQuery(params.userText, { chatId: params.chatId });
  try {
    const answer = await deps.askOpenAiForChat({ chatId: params.chatId, prompt, context: promptContext });
    const content = answer.trim();
    return content || null;
  } catch {
    return null;
  }
}

export function materializeSequenceStepInstruction(step: AiSequencePlanStep, aiContent: string | null): string {
  if (!aiContent) {
    return step.instruction;
  }
  if (step.instruction.includes("{{ai_content}}")) {
    return step.instruction.replace(/\{\{ai_content\}\}/g, aiContent);
  }
  return `${step.instruction}\ncontenido: ${aiContent}`;
}
