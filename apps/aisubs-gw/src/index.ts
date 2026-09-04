import { getContainer } from "@cloudflare/containers";
import type { OAuthCredential } from "aisubs";
import { AisubsContainer, ORIGIN_HEADER, secret, type SecretBinding } from "./container";
import { CredentialStoreDO } from "./store";

export { CredentialStoreDO, AisubsContainer };

export interface Env {
  /** The only durable state in the system: the ChatGPT OAuth credential. */
  CREDENTIAL_STORE: DurableObjectNamespace<CredentialStoreDO>;
  /** Runs the real aisubs API. Also the only side that can reach chatgpt.com. */
  AISUBS_CONTAINER: DurableObjectNamespace<AisubsContainer>;
  /** The key end users put in OPENAI_API_KEY. */
  GATEWAY_KEY?: SecretBinding;
  /** Shared secret for the container's callbacks to /internal/credential. */
  EGRESS_KEY?: SecretBinding;
  /** Local-dev fallbacks from .dev.vars. Never set these in production. */
  GATEWAY_KEY_DEV?: string;
  EGRESS_KEY_DEV?: string;
  /** Cost bounds. Absent in `wrangler dev`, where ratelimits are not simulated. */
  IP_RATE_LIMIT?: RateLimitBinding;
  GLOBAL_RATE_LIMIT?: RateLimitBinding;
}

/** Shape of the Workers rate limiting binding. */
interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const PROVIDER = "chatgpt";
const ACCOUNT = "default";
/** One instance holds the single credential, so refreshes serialize. */
const DO_NAME = `${PROVIDER}:${ACCOUNT}`;
/** The container is stateless and max_instances is 1. */
const CONTAINER_ID = "aisubs-singleton";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const errorJson = (status: number, message: string, type = "gateway_error") =>
  json({ error: { message, type, code: null, param: null } }, status);

/** Length-independent constant-time comparison of two UTF-8 strings. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Compare against itself on a length mismatch so the work is the same either way.
  const other = left.length === right.length ? right : left;
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ other[i]!;
  return diff === 0;
}

/**
 * Every place aisubs' own server looks for a key, so a client that works
 * against a local `aisubs dashboard` is not rejected at our front door and then
 * accepted one hop later.
 */
function presentedKeys(request: Request, url: URL): string[] {
  const authorization = request.headers.get("authorization");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "")?.[1]?.trim();
  return [
    bearer,
    request.headers.get("x-api-key"),
    request.headers.get("x-goog-api-key"),
    url.searchParams.get("key"),
  ].filter((value): value is string => typeof value === "string" && value !== "");
}

const credentialStore = (env: Env) =>
  env.CREDENTIAL_STORE.get(env.CREDENTIAL_STORE.idFromName(DO_NAME));

function isCredentialBody(value: unknown): value is OAuthCredential {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.accessToken !== "string" || body.accessToken === "") return false;
  if (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt)) return false;
  if (body.refreshToken != null && typeof body.refreshToken !== "string") return false;
  // chatGptProvider.authorize() throws without an account id, so require it up front.
  const account = body.account;
  if (typeof account !== "object" || account === null) return false;
  return typeof (account as Record<string, unknown>).id === "string";
}

/**
 * Credential API for the container, guarded by EGRESS_KEY.
 *
 * GET  -> { credential, keys }
 * POST -> { previous, credential } with compare-and-swap on `previous`
 *
 * The container's RemoteCredentialStore cannot send a closure over the wire, so
 * its read-modify-write is two requests. `previous` is the access token it read;
 * a 409 here means the stored credential moved underneath it and it should
 * start over. That restores the atomicity aisubs' modify() contract assumes.
 */
async function internalCredential(request: Request, env: Env, url: URL): Promise<Response> {
  const expected = await secret(env.EGRESS_KEY, env.EGRESS_KEY_DEV);
  if (!expected) return errorJson(500, "EGRESS_KEY is not configured.", "configuration_error");
  const presented = request.headers.get("x-egress-auth");
  if (!presented || !timingSafeEqual(presented, expected)) {
    return errorJson(403, "Invalid or missing x-egress-auth.", "invalid_request_error");
  }

  const provider = url.searchParams.get("provider") ?? PROVIDER;
  const stub = credentialStore(env);

  if (request.method === "GET") {
    const [credential, keys] = await Promise.all([stub.read(provider), stub.listKeys()]);
    return json({ credential, keys });
  }

  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      previous?: string | null;
      credential?: unknown;
    } | null;
    if (!body || !("credential" in body)) {
      return errorJson(400, "Body must be {previous, credential}.", "invalid_request_error");
    }
    const next = body.credential === null ? null : body.credential;
    if (next !== null && !isCredentialBody(next)) {
      return errorJson(400, "credential is malformed.", "invalid_request_error");
    }
    const previous = body.previous ?? null;

    let conflict = false;
    await stub.modify(provider, (current) => {
      // Compare-and-swap inside the Durable Object's critical section.
      if ((current?.accessToken ?? null) !== previous) {
        conflict = true;
        return current;
      }
      return next;
    });
    if (conflict) return json({ conflict: true }, 409);
    return json({ ok: true });
  }

  return errorJson(405, "Method not allowed.");
}

/** Seeds the credential from the user's laptop. Guarded by the gateway key. */
async function seedCredential(env: Env, request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!isCredentialBody(body)) {
    return errorJson(
      400,
      "Body must be {accessToken, refreshToken?, expiresAt, account:{id}}.",
      "invalid_request_error",
    );
  }
  await credentialStore(env).put(PROVIDER, body);
  return json({
    ok: true,
    provider: PROVIDER,
    account: ACCOUNT,
    expiresAt: body.expiresAt,
    refreshTokenStored: typeof body.refreshToken === "string",
  });
}

/**
 * Headers describing our own edge hop. aisubs forwards unrecognised request
 * headers upstream verbatim, so leaving these on makes the outbound call to
 * chatgpt.com look like relayed proxy traffic and it is answered with a bot
 * challenge instead of the API. They are meaningless to the provider anyway.
 */
const EDGE_HEADERS = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "forwarded",
  "host",
  "content-length",
];

/** Forwards to the container and streams the response back unchanged. */
async function forward(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of EDGE_HEADERS) headers.delete(name);
  // Tells the Durable Object which origin the container should call back on.
  headers.set(ORIGIN_HEADER, url.origin);

  const container = getContainer(env.AISUBS_CONTAINER, CONTAINER_ID);
  // Body is passed through as a stream and the response is returned untouched,
  // so SSE keeps arriving token by token.
  return container.fetch(new Request(url, { method: request.method, headers, body: request.body }));
}

/**
 * Bounds spend. Cloudflare offers no hard spend cap for Workers, Durable
 * Objects or Containers - budget alerts only send an email - so the ceiling has
 * to be enforced here.
 *
 * Two limits, both checked before the gateway key so a flood of unauthenticated
 * junk is rejected as cheaply as possible: one per caller IP for a runaway
 * client, and one global for a leaked key. Bindings are per-Cloudflare-location,
 * so the global limit is a floor on what an attacker sees, not a hard ceiling.
 * The Worker invocation is still billed for every 429 it returns; only a WAF
 * rate limiting rule on a custom domain blocks before that, and WAF rules
 * cannot attach to a workers.dev hostname.
 */
async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const checks: Array<Promise<{ success: boolean }>> = [];
  if (env.IP_RATE_LIMIT) checks.push(env.IP_RATE_LIMIT.limit({ key: ip }));
  if (env.GLOBAL_RATE_LIMIT) checks.push(env.GLOBAL_RATE_LIMIT.limit({ key: "global" }));
  if (checks.length === 0) return null;

  const outcomes = await Promise.all(checks);
  if (outcomes.every((outcome) => outcome.success)) return null;
  return errorJson(429, "Rate limit exceeded.", "rate_limit_error");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Answered locally on purpose: an uptime probe must never wake the
    // container, because a container bills for every second it is awake.
    if (pathname === "/health") {
      if (request.method !== "GET") return errorJson(405, "Method not allowed.");
      return json({ ok: true, service: "aisubs-gw", provider: PROVIDER, account: ACCOUNT });
    }

    try {
      // Its own guard, and it must not require the gateway key.
      if (pathname === "/internal/credential") {
        return await internalCredential(request, env, url);
      }

      // Cost bound, checked before the key and before the container wakes.
      // Cloudflare sells no hard spend cap, so this is where the ceiling lives.
      const rejection = await rateLimited(request, env);
      if (rejection) return rejection;

      // The gateway key is checked here, before the container is woken, so junk
      // traffic costs nothing but Worker CPU.
      const expected = await secret(env.GATEWAY_KEY, env.GATEWAY_KEY_DEV);
      if (!expected) {
        return errorJson(500, "GATEWAY_KEY is not configured.", "configuration_error");
      }
      if (!presentedKeys(request, url).some((value) => timingSafeEqual(value, expected))) {
        return errorJson(401, "Invalid or missing API key.", "invalid_request_error");
      }

      if (pathname === "/admin/credential") {
        if (request.method !== "POST") return errorJson(405, "Method not allowed.");
        return await seedCredential(env, request);
      }

      return await forward(request, env, url);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = /not authenticated/i.test(message) ? 401 : 502;
      return errorJson(status, message, "upstream_error");
    }
  },
};
