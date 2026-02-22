import assert from "node:assert/strict";
import test from "node:test";
import { isLikelyConversationalNarrative } from "./conversation-cues.js";

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

test("detects conversational narrative in first-person day recap", () => {
  const text = "Hoy tuve un gran dia. Fui a comer con amigos y luego me dormi una siesta.";
  const detected = isLikelyConversationalNarrative({
    normalizedText: normalizeIntentText(text),
    hasOperationalCue: false,
  });
  assert.equal(detected, true);
});

test("does not classify explicit operational chain as narrative", () => {
  const text = "Primero crea un archivo notas.txt y luego enviamelo por gmail.";
  const detected = isLikelyConversationalNarrative({
    normalizedText: normalizeIntentText(text),
    hasOperationalCue: true,
  });
  assert.equal(detected, false);
});

test("does not classify directive with first-person pronoun as narrative", () => {
  const text = "Hoy necesito que me envies un correo con el resumen.";
  const detected = isLikelyConversationalNarrative({
    normalizedText: normalizeIntentText(text),
    hasOperationalCue: false,
  });
  assert.equal(detected, false);
});

test("does not classify short follow-up question as narrative", () => {
  const text = "Y luego que hacemos?";
  const detected = isLikelyConversationalNarrative({
    normalizedText: normalizeIntentText(text),
    hasOperationalCue: false,
  });
  assert.equal(detected, false);
});
