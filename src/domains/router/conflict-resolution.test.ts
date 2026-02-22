import assert from "node:assert/strict";
import test from "node:test";
import { shouldBypassAmbiguousPair } from "./conflict-resolution.js";

test("bypass gmail vs recipients cuando hay intención explícita", () => {
  const bypass = shouldBypassAmbiguousPair("gmail|gmail-recipients", "enviar correo a maria", {
    normalizeIntentText: (text) => text.toLowerCase(),
    detectSelfMaintenanceIntent: () => ({ shouldHandle: false }),
    shouldBypassGmailRecipientsAmbiguity: () => true,
  });
  assert.equal(bypass, true);
});

test("bypass self-maintenance vs workspace para skill sin cues de archivos", () => {
  const bypass = shouldBypassAmbiguousPair(
    "self-maintenance|workspace",
    "crear una habilidad: responder en checklist",
    {
      normalizeIntentText: (text) => text.toLowerCase(),
      detectSelfMaintenanceIntent: () => ({ shouldHandle: true, action: "add-skill" }),
      shouldBypassGmailRecipientsAmbiguity: () => false,
    },
  );
  assert.equal(bypass, true);
});

test("no bypass self-maintenance vs workspace si hay cue explícito de workspace", () => {
  const bypass = shouldBypassAmbiguousPair(
    "self-maintenance|workspace",
    "crear una habilidad para listar archivos en workspace",
    {
      normalizeIntentText: (text) => text.toLowerCase(),
      detectSelfMaintenanceIntent: () => ({ shouldHandle: true, action: "add-skill" }),
      shouldBypassGmailRecipientsAmbiguity: () => false,
    },
  );
  assert.equal(bypass, false);
});
