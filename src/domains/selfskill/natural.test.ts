import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSelfSkillInstructionFromText,
  formatSelfSkillDraftLines,
  isLikelySelfSkillDraftLine,
  isSkillDraftCancelRequested,
  isSkillDraftCommitRequested,
  isSkillDraftShowRequested,
  sanitizeSelfSkillText,
} from "./natural.js";

test("extractSelfSkillInstructionFromText prioriza texto entre comillas", () => {
  const instruction = extractSelfSkillInstructionFromText('agrega habilidad: "responder en checklist breve"');
  assert.equal(instruction, "responder en checklist breve");
});

test("extractSelfSkillInstructionFromText extrae variante natural", () => {
  const instruction = extractSelfSkillInstructionFromText("suma una habilidad para mostrar fuentes al buscar web");
  assert.equal(instruction, "mostrar fuentes al buscar web");
});

test("isSkillDraftCommitRequested reconoce confirmación natural", () => {
  assert.equal(isSkillDraftCommitRequested("listo crea la habilidad"), true);
  assert.equal(isSkillDraftCommitRequested("crea una carpeta en workspace"), false);
});

test("draft helpers detectan mostrar y cancelar", () => {
  assert.equal(isSkillDraftShowRequested("mostrame el borrador de skill"), true);
  assert.equal(isSkillDraftCancelRequested("cancelar habilidad"), true);
});

test("isLikelySelfSkillDraftLine evita capturar dominios ajenos", () => {
  assert.equal(isLikelySelfSkillDraftLine("responde siempre en bullets", "responde siempre en bullets"), true);
  assert.equal(isLikelySelfSkillDraftLine("enviar correo a maria", "enviar correo a maria"), false);
});

test("sanitize y format controlan salida del borrador", () => {
  const cleaned = sanitizeSelfSkillText("  responder   con   pasos concretos  ");
  assert.equal(cleaned, "responder con pasos concretos");
  assert.equal(formatSelfSkillDraftLines([cleaned]), "1. responder con pasos concretos");
});
