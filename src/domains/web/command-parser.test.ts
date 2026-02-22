import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWebCommandQuery,
  parseWebAskCommandInput,
  parseWebOpenCommandInput,
  parseWebSearchCommandInput,
} from "./command-parser.js";

test("normalize web command query removes filler words", () => {
  const query = normalizeWebCommandQuery("por favor busca en internet noticias de boca");
  assert.equal(query, "noticias de boca");
});

test("parse /web validates missing query", () => {
  const parsed = parseWebSearchCommandInput("   ");
  assert.equal(parsed.ok, false);
});

test("parse /webask validates missing query", () => {
  const parsed = parseWebAskCommandInput("");
  assert.equal(parsed.ok, false);
});

test("parse /webopen delegates target parser", () => {
  const parsed = parseWebOpenCommandInput({
    raw: "1 que dice",
    lastResults: [{ title: "t", url: "https://example.com", snippet: "s" }],
    parseTarget: () => ({ url: "https://example.com", question: "que dice", sourceIndex: 1 }),
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.value.url, "https://example.com");
  assert.equal(parsed.value.sourceIndex, 1);
});
