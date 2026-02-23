import assert from "node:assert/strict";
import test from "node:test";
import { detectSelfMaintenanceIntent, normalizeSelfSkillIntentText } from "./intents.js";

test("detecta alta de skill con instrucción embebida", () => {
  const intent = detectSelfMaintenanceIntent("agrega una habilidad para responder con checklist");
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "add-skill");
  assert.equal(intent.instruction, "responder con checklist");
});

test("detecta listado de skills", () => {
  const intent = detectSelfMaintenanceIntent("que habilidades dinamicas tenes agregadas?");
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "list-skills");
});

test("detecta variantes naturales de listado de skills", () => {
  const cases = [
    "listar habilidades activas del bot",
    "mostrar skills dinamicas activas",
    "que capacidades del agente estan activas",
    "ver estado de herramientas del bot",
  ];
  for (const input of cases) {
    const intent = detectSelfMaintenanceIntent(input);
    assert.equal(intent.shouldHandle, true, input);
    assert.equal(intent.action, "list-skills", input);
  }
});

test("detecta eliminar última skill", () => {
  const intent = detectSelfMaintenanceIntent("elimina la ultima habilidad");
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "delete-skill");
  assert.equal(intent.skillIndex, -1);
});

test("detecta eliminar skill por id #ref", () => {
  const intent = detectSelfMaintenanceIntent("elimina la habilidad #sk-abc123");
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "delete-skill");
  assert.equal(intent.skillRef, "sk-abc123");
});

test("detecta reinicio y update", () => {
  const restart = detectSelfMaintenanceIntent("reinicia el agente");
  assert.equal(restart.action, "restart-service");
  const update = detectSelfMaintenanceIntent("actualiza el repo del bot");
  assert.equal(update.action, "update-service");
});

test("normalización remueve diacríticos", () => {
  assert.equal(normalizeSelfSkillIntentText("AñádE Habilidad"), "anade habilidad");
});
