const TELEGRAM_MAX_CHARS = 3800;

export function splitForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > TELEGRAM_MAX_CHARS) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_MAX_CHARS);
    if (cut <= 0) {
      cut = TELEGRAM_MAX_CHARS;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }

  return chunks;
}
