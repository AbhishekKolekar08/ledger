const MAX_STATE_BYTES = 1_800_000;
const MAX_TRANSACTIONS = 20_000;
const encoder = new TextEncoder();
let cachedKeys;
let cachedKeysUntil = 0;

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function accessKeys(teamDomain, forceRefresh = false) {
  if (!forceRefresh && cachedKeys && Date.now() < cachedKeysUntil) return cachedKeys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error("Could not fetch Access signing keys");
  const result = await response.json();
  if (!Array.isArray(result.keys)) throw new Error("Invalid Access signing keys response");
  cachedKeys = result.keys;
  cachedKeysUntil = Date.now() + 5 * 60 * 1000;
  return cachedKeys;
}

async function verifyAccessToken(token, env) {
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = String(env.ACCESS_AUD ?? "").trim();
  const allowedEmail = String(env.ALLOWED_EMAIL ?? "").trim().toLowerCase();
  if (!teamDomain || !audience || !allowedEmail) return { email: null, reason: "missing_worker_configuration" };

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return { email: null, reason: "malformed_access_token" };
    const header = decodeJwtPart(encodedHeader);
    const claims = decodeJwtPart(encodedPayload);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return { email: null, reason: "unsupported_token_header" };

    const issuer = `https://${teamDomain}`;
    const now = Math.floor(Date.now() / 1000);
    const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer) return { email: null, reason: "issuer_mismatch" };
    if (!tokenAudiences.includes(audience)) return { email: null, reason: "audience_mismatch" };
    if (!Number.isFinite(claims.exp) || claims.exp <= now || (Number.isFinite(claims.nbf) && claims.nbf > now)) {
      return { email: null, reason: "token_expired_or_not_yet_valid" };
    }
    if (typeof claims.email !== "string" || claims.email.toLowerCase() !== allowedEmail) {
      return { email: null, reason: "email_not_allowlisted" };
    }

    let signingKey;
    try {
      signingKey = (await accessKeys(teamDomain)).find((key) => key.kid === header.kid);
      if (!signingKey) signingKey = (await accessKeys(teamDomain, true)).find((key) => key.kid === header.kid);
    } catch {
      return { email: null, reason: "jwks_fetch_failed" };
    }
    if (!signingKey) return { email: null, reason: "signing_key_not_found" };

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      signingKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signedContent = encoder.encode(`${encodedHeader}.${encodedPayload}`);
    const signature = decodeBase64Url(encodedSignature);
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signedContent,
    );
    return validSignature
      ? { email: claims.email.toLowerCase(), reason: null }
      : { email: null, reason: "invalid_token_signature" };
  } catch {
    return { email: null, reason: "token_validation_error" };
  }
}

async function requireIdentity(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { email: null, reason: "access_token_header_missing" };
  return verifyAccessToken(token, env);
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.transactions)) return null;
  if (value.transactions.length > MAX_TRANSACTIONS) return null;
  const transactions = [];
  for (const transaction of value.transactions) {
    if (!transaction || typeof transaction.id !== "string" || transaction.id.length > 300) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) return null;
    if (!Number.isFinite(transaction.amount) || transaction.amount < 0) return null;
    if (typeof transaction.label !== "string" || transaction.label.length > 500) return null;
    if (typeof transaction.category !== "string" || transaction.category.length > 60) return null;
    transactions.push({
      id: transaction.id,
      ...(typeof transaction.sourceId === "string" ? { sourceId: transaction.sourceId } : {}),
      createdAt: Number.isFinite(transaction.createdAt) ? transaction.createdAt : 0,
      date: transaction.date,
      amount: transaction.amount,
      label: transaction.label,
      category: transaction.category,
      reserved: Boolean(transaction.reserved),
    });
  }

  const budget = value.budget && typeof value.budget === "object" && !Array.isArray(value.budget)
    ? value.budget
    : {};
  const deletedSourceIds = Array.isArray(value.deletedSourceIds)
    ? value.deletedSourceIds.filter((id) => typeof id === "string" && id.length <= 300).slice(0, MAX_TRANSACTIONS)
    : [];
  return { version: 1, budget, transactions, deletedSourceIds };
}

async function stateEndpoint(request, env, owner) {
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT state_json FROM ledger_state WHERE owner_email = ?")
      .bind(owner)
      .first();
    if (!row) return jsonResponse({ version: 1, budget: null, transactions: [], deletedSourceIds: [] });
    try {
      return jsonResponse(JSON.parse(row.state_json));
    } catch {
      return jsonResponse({ error: "Stored Ledger data is unreadable" }, 500);
    }
  }

  if (request.method === "PUT") {
    const contentLength = Number(request.headers.get("Content-Length") ?? 0);
    if (contentLength > MAX_STATE_BYTES) return jsonResponse({ error: "Ledger data exceeds size limit" }, 413);
    let incoming;
    try {
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_STATE_BYTES) return jsonResponse({ error: "Ledger data exceeds size limit" }, 413);
      incoming = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const state = normalizeState(incoming);
    if (!state) return jsonResponse({ error: "Invalid Ledger data" }, 400);
    const serialized = JSON.stringify(state);
    if (encoder.encode(serialized).byteLength > MAX_STATE_BYTES) {
      return jsonResponse({ error: "Ledger data exceeds size limit" }, 413);
    }
    await env.DB.prepare(`
      INSERT INTO ledger_state (owner_email, state_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_email) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = CURRENT_TIMESTAMP
    `).bind(owner, serialized).run();
    return jsonResponse({ ok: true });
  }

  return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, PUT" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const identity = await requireIdentity(request, env);
      if (!identity.email) {
        console.warn("[ledger-auth] request rejected", identity.reason);
        return jsonResponse({ error: "Sign in through your Cloudflare Access-protected Ledger URL" }, 401);
      }
      if (!env.DB) return jsonResponse({ error: "D1 database binding is missing" }, 503);
      if (url.pathname === "/api/state") return stateEndpoint(request, env, identity.email);
      return jsonResponse({ error: "Not found" }, 404);
    }

    const identity = await requireIdentity(request, env);
    if (!identity.email) {
      console.warn("[ledger-auth] request rejected", identity.reason);
      return new Response("Ledger requires your authenticated Cloudflare Access session.", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};

export { normalizeState, verifyAccessToken };