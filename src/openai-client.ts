import OpenAI from "openai";
import { z } from "zod";
import { config } from "./config.js";

function extractTextOutput(response: unknown): string {
  const fromTopLevel =
    typeof (response as { output_text?: unknown })?.output_text === "string"
      ? (response as { output_text: string }).output_text.trim()
      : "";
  if (fromTopLevel) {
    return fromTopLevel;
  }

  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const chunks: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if ((part as { type?: unknown })?.type !== "output_text") {
        continue;
      }
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string" && text.trim()) {
        chunks.push(text.trim());
      }
    }
  }

  return chunks.join("\n\n").trim();
}

function stripJsonCodeFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("```")) {
    return text;
  }
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

const ShellPlanSchema = z.object({
  action: z.enum(["reply", "exec"]),
  reply: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});

export type ShellPlan =
  | { action: "reply"; reply: string }
  | { action: "exec"; command: string; args: string[]; reply?: string };

export class OpenAiService {
  private readonly client: OpenAI | null;

  constructor() {
    this.client = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getModel(): string {
    return config.openAiModel;
  }

  async ask(prompt: string): Promise<string> {
    if (!this.client) {
      throw new Error("OPENAI_API_KEY no está configurada en .env");
    }

    const question = prompt.trim();
    if (!question) {
      throw new Error("Pregunta vacía");
    }

    const response = await this.client.responses.create({
      model: config.openAiModel,
      max_output_tokens: config.openAiMaxOutputTokens,
      input: [
        {
          role: "system",
          content:
            "Eres Houdi Agent. Responde en español, de forma directa, útil y breve salvo que te pidan detalle.",
        },
        {
          role: "user",
          content: question,
        },
      ],
    });

    const text = extractTextOutput(response);
    if (!text) {
      throw new Error("OpenAI no devolvió texto en la respuesta");
    }
    return text;
  }

  async planShellAction(params: {
    instruction: string;
    allowedCommands: string[];
    cwd: string;
  }): Promise<ShellPlan> {
    if (!this.client) {
      throw new Error("OPENAI_API_KEY no está configurada en .env");
    }

    const instruction = params.instruction.trim();
    if (!instruction) {
      return { action: "reply", reply: "No recibí ninguna instrucción." };
    }

    const allowed = Array.from(
      new Set(params.allowedCommands.map((command) => command.trim().toLowerCase()).filter(Boolean)),
    );
    const allowedDisplay = allowed.join(", ");

    const response = await this.client.responses.create({
      model: config.openAiModel,
      max_output_tokens: 500,
      input: [
        {
          role: "system",
          content: [
            "Eres Houdi Agent en modo shell.",
            "Devuelve SOLO JSON válido, sin texto extra.",
            'Schema exacto: {"action":"reply"|"exec","reply?":"string","command?":"string","args?":["string"]}.',
            'Usa action="reply" cuando no sea necesario ejecutar comandos.',
            'Usa action="exec" solo con un comando de la allowlist.',
            "Nunca uses pipes, redirecciones, subshell, ni operadores de shell.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `CWD del agente: ${params.cwd}`,
            `Allowlist de comandos: ${allowedDisplay}`,
            `Instrucción del usuario: ${instruction}`,
          ].join("\n"),
        },
      ],
    });

    const raw = extractTextOutput(response);
    if (!raw) {
      return { action: "reply", reply: "No pude generar una acción para esa instrucción." };
    }

    const normalized = stripJsonCodeFence(raw);
    let parsed: z.infer<typeof ShellPlanSchema>;
    try {
      parsed = ShellPlanSchema.parse(JSON.parse(normalized));
    } catch {
      return { action: "reply", reply: raw };
    }

    if (parsed.action === "reply") {
      return {
        action: "reply",
        reply: parsed.reply?.trim() || "No hace falta ejecutar comandos para responder eso.",
      };
    }

    const command = parsed.command?.trim().toLowerCase() ?? "";
    if (!command) {
      return { action: "reply", reply: "La IA no devolvió un comando válido." };
    }
    if (!/^[a-z0-9._-]+$/.test(command)) {
      return { action: "reply", reply: `Comando inválido propuesto por IA: ${command}` };
    }
    if (!allowed.includes(command)) {
      return {
        action: "reply",
        reply: `Comando no permitido por el agente: ${command}. Permitidos: ${allowedDisplay}`,
      };
    }

    const args = (parsed.args ?? [])
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0)
      .filter((arg) => !arg.includes("\n"))
      .slice(0, 20);

    return {
      action: "exec",
      command,
      args,
      ...(parsed.reply?.trim() ? { reply: parsed.reply.trim() } : {}),
    };
  }
}
