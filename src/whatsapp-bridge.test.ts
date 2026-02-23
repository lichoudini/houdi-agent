import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { parseWhatsAppWebhookPayload, verifyWhatsAppWebhookSignature } from "./whatsapp-bridge.js";

test("parseWhatsAppWebhookPayload extracts inbound text and media captions", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1234567890" },
              messages: [
                {
                  id: "wamid.1",
                  from: "5491112345678",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "Hola Houdi" },
                },
                {
                  id: "wamid.2",
                  from: "5491112345678",
                  type: "image",
                  image: { caption: "Mira esto" },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const messages = parseWhatsAppWebhookPayload(payload);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.text, "Hola Houdi");
  assert.equal(messages[1]?.text, "Mira esto\n\n[adjunto image]");
});

test("parseWhatsAppWebhookPayload ignores malformed payloads", () => {
  assert.deepEqual(parseWhatsAppWebhookPayload(null), []);
  assert.deepEqual(parseWhatsAppWebhookPayload({ entry: [{}] }), []);
});

test("verifyWhatsAppWebhookSignature validates expected digest", () => {
  const secret = "super-secret";
  const body = JSON.stringify({ ping: true });
  const digest = `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  assert.equal(verifyWhatsAppWebhookSignature(secret, body, digest), true);
  assert.equal(verifyWhatsAppWebhookSignature(secret, body, "sha256=deadbeef"), false);
  assert.equal(verifyWhatsAppWebhookSignature(secret, body, undefined), false);
});
