import assert from "node:assert/strict";
import test from "node:test";
import { countNewsTopicMatches, extractNewsTopicTokens } from "./news-topic-relevance.js";

test("extractNewsTopicTokens mantiene tema puntual en consultas de noticias", () => {
  const tokens = extractNewsTopicTokens("las ultimas noticias de porno hoy");
  assert.deepEqual(tokens, ["porno"]);
});

test("extractNewsTopicTokens conserva tokens de tema compuesto", () => {
  const tokens = extractNewsTopicTokens("ultimas novedades de boca juniors");
  assert.deepEqual(tokens, ["boca", "junior"]);
});

test("countNewsTopicMatches detecta coincidencias del tema en resultados", () => {
  const topic = ["porno"];
  const related = countNewsTopicMatches(
    "Pornografía en EL PAÍS. Todas las noticias sobre Pornografía.",
    topic,
  );
  const unrelated = countNewsTopicMatches(
    "World News | Latest Top Stories | Reuters.",
    topic,
  );
  assert.ok(related > 0);
  assert.equal(unrelated, 0);
});
