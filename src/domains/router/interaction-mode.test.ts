import assert from "node:assert/strict";
import test from "node:test";
import { classifyInteractionMode } from "./interaction-mode.js";

test("classifyInteractionMode detecta operativo", () => {
  assert.equal(classifyInteractionMode("crear archivo reporte.txt en workspace"), "operational");
});

test("classifyInteractionMode detecta conversacional narrativo", () => {
  assert.equal(classifyInteractionMode("hoy tuve un gran dia y sali a caminar"), "conversational");
});

test("classifyInteractionMode detecta mixto", () => {
  assert.equal(classifyInteractionMode("hoy estuve cansado pero recordame una tarea"), "mixed");
});
