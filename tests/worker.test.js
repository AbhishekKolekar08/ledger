import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../web/worker.js";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("Access identity is required and D1 state is scoped to the verified email", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const keyId = "ledger-test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }] });

  try {
    const env = {
      ACCESS_TEAM_DOMAIN: "ledger-team.cloudflareaccess.com",
      ACCESS_AUD: "ledger-test-audience",
      ALLOWED_EMAIL: "owner@example.com",
      DB: (() => {
        let storedState = null;
        return {
          prepare() {
            let boundValues = [];
            return {
              bind(...values) {
                boundValues = values;
                return this;
              },
              async first() {
                return storedState === null ? null : { state_json: storedState };
              },
              async run() {
                storedState = boundValues[1];
                return { success: true };
              },
            };
          },
        };
      })(),
      ASSETS: { fetch: async () => new Response("private app") },
    };

    const anonymous = await worker.fetch(new Request("https://ledger.example/api/state"), env);
    assert.equal(anonymous.status, 401);

    const claims = {
      iss: "https://ledger-team.cloudflareaccess.com",
      aud: ["ledger-test-audience"],
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const encodedHeader = encode({ alg: "RS256", typ: "JWT", kid: keyId });
    const encodedPayload = encode(claims);
    const signedContent = `${encodedHeader}.${encodedPayload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(signedContent));
    const token = `${signedContent}.${Buffer.from(signature).toString("base64url")}`;
    const headers = { "Cf-Access-Jwt-Assertion": token };

    const unauthenticatedPage = await worker.fetch(new Request("https://ledger.example/"), env);
    assert.equal(unauthenticatedPage.status, 401);

    const update = await worker.fetch(new Request("https://ledger.example/api/state", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        budget: { income: "31900" },
        transactions: [{ id: "tx-1", date: "2026-09-26", amount: 42, label: "Groceries", category: "groceries" }],
        deletedSourceIds: [],
      }),
    }), env);
    assert.equal(update.status, 200);

    const read = await worker.fetch(new Request("https://ledger.example/api/state", { headers }), env);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), {
      version: 1,
      budget: { income: "31900" },
      transactions: [{ id: "tx-1", createdAt: 0, date: "2026-09-26", amount: 42, label: "Groceries", category: "groceries", reserved: false }],
      deletedSourceIds: [],
    });

    const otherIdentity = { ...claims, email: "other@example.com" };
    const otherPayload = encode(otherIdentity);
    const otherContent = `${encodedHeader}.${otherPayload}`;
    const otherSignature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(otherContent));
    const denied = await worker.fetch(new Request("https://ledger.example/api/state", {
      headers: { "Cf-Access-Jwt-Assertion": `${otherContent}.${Buffer.from(otherSignature).toString("base64url")}` },
    }), env);
    assert.equal(denied.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});