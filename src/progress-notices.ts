type ProgressNoticeKind =
  | "openai"
  | "shell-plan"
  | "doc-read"
  | "doc-analyze"
  | "web-search"
  | "web-open"
  | "gmail-query"
  | "gmail-send"
  | "audio-transcribe"
  | "audio-analyze"
  | "generic";

const PROGRESS_NOTICE_VARIANTS: Record<ProgressNoticeKind, string[]> = {
  openai: [
    "Calentando neuronas digitales...",
    "Abriendo el cajon de ideas premium...",
    "Consultando al oraculo de silicio...",
    "Sincronizando sinapsis virtuales...",
    "Poniendo cafe virtual al modelo...",
    "Afinando la brújula mental del bot...",
    "Ordenando ideas en modo quirúrgico...",
    "Cargando contexto de alto octanaje...",
    "Puliendo la respuesta para que salga fina...",
    "Encendiendo motor de razonamiento sin humo...",
  ],
  "shell-plan": [
    "Afilando la navaja suiza de comandos...",
    "Revisando que no explote nada raro...",
    "Negociando con la terminal para que coopere...",
    "Montando plan de ataque con casco y linterna...",
    "Ajustando tornillos del plan shell...",
    "Mapeando comandos seguros antes de tocar nada...",
    "Desarmando el problema en pasos ejecutables...",
    "Chequeando permisos y bordes peligrosos...",
    "Diseñando ruta de terminal con cinturón puesto...",
    "Preparando comando limpio, corto y reversible...",
  ],
  "doc-read": [
    "Abriendo el archivo con guantes blancos...",
    "Pasando paginas a velocidad turbo...",
    "Escaneando letras con lupa digital...",
    "Activando modo bibliotecario serio...",
    "Leyendo sin pestañear...",
    "Extrayendo texto como arqueólogo paciente...",
    "Desenrollando el documento hoja por hoja...",
    "Inspeccionando el archivo con foco de precisión...",
    "Levantando contenido útil del documento...",
    "Decodificando formato y contenido en paralelo...",
  ],
  "doc-analyze": [
    "Subrayando lo importante en fosforito imaginario...",
    "Armando resumen con bisturi y cafe...",
    "Buscando hallazgos entre lineas...",
    "Conectando pistas del documento...",
    "Montando analisis sin humo...",
    "Separando señal de ruido en el documento...",
    "Convirtiendo texto largo en conclusiones claras...",
    "Sintetizando puntos críticos y accionables...",
    "Cruzando secciones para detectar inconsistencias...",
    "Preparando lectura ejecutiva del contenido...",
  ],
  "web-search": [
    "Soltando sabuesos binarios por internet...",
    "Rastreando la web sin perderse en clickbait...",
    "Encendiendo radar anti-ruido en buscadores...",
    "Pescando fuentes utiles en mar abierto...",
    "Navegando con mapa, brujula y sentido comun...",
    "Barrido web en curso con filtro anti-humo...",
    "Levantando señales frescas entre titulares...",
    "Escarbando fuentes recientes con criterio...",
    "Explorando la red para traer solo lo relevante...",
    "Cazando evidencias web con casco y paciencia...",
  ],
  "web-open": [
    "Abriendo la pagina con casco de seguridad...",
    "Entrando al sitio en modo inspector...",
    "Chequeando el contenido sin tragar humo...",
    "Aterrizando en la URL con tren de aterrizaje...",
    "Desempolvando el contenido de la pagina...",
    "Inspeccionando la URL en modo lupa forense...",
    "Descargando y limpiando contenido de la página...",
    "Abriendo enlace con protocolo anti-ruido...",
    "Leyendo la página con ojos de auditor...",
    "Extrayendo lo útil del sitio sin vueltas...",
  ],
  "gmail-query": [
    "Revisando la bandeja con traje de detective...",
    "Buscando correos como sabueso de oficina...",
    "Peinando Gmail sin perder hilos...",
    "Abriendo la correspondencia del dia...",
    "Filtrando correos con lupa y mate...",
    "Consultando Gmail con criterio de archivista...",
    "Rastreando mensajes clave en la bandeja...",
    "Ordenando correos por prioridad y contexto...",
    "Buscando el hilo correcto sin perder el rumbo...",
    "Escaneando inbox en modo precisión...",
  ],
  "gmail-send": [
    "Puliendo el correo antes del despegue...",
    "Ensobrando el mensaje con precision quirurgica...",
    "Ajustando asunto y cuerpo para envio...",
    "Despachando correo con sello oficial...",
    "Empujando el email por la pista de salida...",
    "Armando envío con asunto y cuerpo bien atados...",
    "Revisando destinatario y contenido antes de salir...",
    "Preparando correo para entrega sin rebotes...",
    "Finalizando email en modo prolijo...",
    "Lanzando correo con control de calidad...",
  ],
  "audio-transcribe": [
    "Afinando oidos de robot para transcribir...",
    "Convirtiendo ondas de audio en texto legible...",
    "Escuchando con auriculares imaginarios...",
    "Traduciendo vibraciones a palabras...",
    "Procesando audio en modo estenografo turbo...",
    "Desgranando el audio palabra por palabra...",
    "Levantando texto desde la señal de voz...",
    "Convirtiendo voz en texto con bisturí digital...",
    "Transcribiendo audio con paciencia de relojero...",
    "Capturando cada frase del audio sin perder contexto...",
  ],
  "audio-analyze": [
    "Exprimiendo la transcripcion gota a gota...",
    "Ordenando ideas del audio en fila india...",
    "Armando respuesta a partir de la transcripcion...",
    "Conectando puntos del audio transcripto...",
    "Procesando lo dicho sin perder contexto...",
    "Interpretando la transcripción con lupa semántica...",
    "Traduciendo audio a acciones concretas...",
    "Separando intención principal de detalles secundarios...",
    "Convirtiendo voz transcripta en plan ejecutable...",
    "Aterrizando el pedido de audio en pasos claros...",
  ],
  generic: [
    "Moviendo engranajes internos...",
    "Acomodando piezas del rompecabezas...",
    "Cargando motores sin derramar el cafe...",
    "Haciendo magia sin trucos baratos...",
    "Preparando resultado con precision...",
    "Alineando contexto para responder mejor...",
    "Encajando piezas con paciencia quirúrgica...",
    "Activando modo resolución de problemas...",
    "Procesando solicitud con método y calma...",
    "Terminando de cocinar una respuesta útil...",
  ],
};

function normalizeProgressText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function classifyProgressNoticeKind(text: string): ProgressNoticeKind {
  const normalized = normalizeProgressText(text);

  if (normalized.includes("transcribiendo")) {
    return "audio-transcribe";
  }
  if (normalized.includes("analizando transcripcion")) {
    return "audio-analyze";
  }
  if (normalized.includes("enviando email")) {
    return "gmail-send";
  }
  if (normalized.includes("consultando gmail")) {
    return "gmail-query";
  }
  if (normalized.includes("buscando y sintetizando en web") || normalized.includes("buscando en web")) {
    return "web-search";
  }
  if (normalized.includes("abriendo http") || (normalized.startsWith("abriendo ") && normalized.includes("://"))) {
    return "web-open";
  }
  if (normalized.includes("documento detectado") && normalized.includes("analizando")) {
    return "doc-analyze";
  }
  if (normalized.includes("leyendo archivo")) {
    return "doc-read";
  }
  if (normalized.includes("instruccion para shell")) {
    return "shell-plan";
  }
  if (normalized.includes("openai")) {
    return "openai";
  }

  return "generic";
}

export class ProgressNoticeService {
  private readonly lastByChat = new Map<number, string>();

  private pickVariant(kind: ProgressNoticeKind, chatId?: number): string {
    const variants = PROGRESS_NOTICE_VARIANTS[kind];
    if (!variants || variants.length === 0) {
      return "Trabajando en eso...";
    }
    const base = variants[Math.floor(Math.random() * variants.length)] ?? "Trabajando en eso...";
    if (variants.length === 1 || typeof chatId !== "number") {
      return base;
    }
    const last = this.lastByChat.get(chatId) ?? "";
    let chosen = base;
    for (let attempts = 0; attempts < 5 && chosen === last; attempts += 1) {
      chosen = variants[Math.floor(Math.random() * variants.length)] ?? base;
    }
    this.lastByChat.set(chatId, chosen);
    return chosen;
  }

  build(text: string, chatId?: number): string {
    const kind = classifyProgressNoticeKind(text);
    return this.pickVariant(kind, chatId);
  }
}
