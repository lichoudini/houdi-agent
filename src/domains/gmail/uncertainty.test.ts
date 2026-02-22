import assert from "node:assert/strict";
import test from "node:test";
import { shouldBypassGmailRecipientsAmbiguity } from "./uncertainty.js";

test("bypass ambiguity for explicit email send request", () => {
  assert.equal(
    shouldBypassGmailRecipientsAmbiguity("escribir un email a nazareno.tomaselli@vrand.biz con noticias de porno"),
    true,
  );
});

test("bypass ambiguity for mail inbox operation", () => {
  assert.equal(shouldBypassGmailRecipientsAmbiguity("leer correos no leidos"), true);
});

test("bypass ambiguity for recipients management operation", () => {
  assert.equal(
    shouldBypassGmailRecipientsAmbiguity("agrega destinatario maria maria@empresa.com"),
    true,
  );
});

test("keep ambiguity when phrase is generic and unclear", () => {
  assert.equal(shouldBypassGmailRecipientsAmbiguity("tema gmail destinatarios"), false);
});
