import { chatGptProvider, createSubscriptionAuth } from "aisubs";
import { createApiApp } from "aisubs/http";

/**
 * The real aisubs API server, running as a Cloudflare Container.
 *
 * Two reasons it lives here and not in the Worker:
 *   1. A deployed Worker cannot reach chatgpt.com - Cloudflare's bot rules
 *      answer with a 403 challenge page. A Container is an ordinary Linux
 *      process with an ordinary Node TLS fingerprint and is accepted.
 *   2. aisubs' protocol translation lives in dist/compatibility.js
 *      (`proxyCompatible`), which is not in the package exports map, so it
 *      cannot be reached from a Worker bundle at all. Only a real Node process
 *      running the published entry points gets the full OpenAI-compatible
 *      surface, including /v1/chat/completions.
 *
 * `createSubscriptionAuthServer` refuses any non-localhost bind, but
 * `createApiApp` is exported and has no such check, so we build the Fastify app
 * and listen on 0.0.0.0 ourselves.
 */

const PORT = 8080;
const PROVIDER = "chatgpt";

/** Injected by the Durable Object at container start. */
const WORKER_URL = requireEnv("WORKER_URL");
const EGRESS_KEY = requireEnv("EGRESS_KEY");
const API_KEY = requireEnv("GATEWAY_KEY");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on the container`);
  return value;
}

const credentialUrl = (provider) =>
  `${WORKER_URL.replace(/\/+$/, "")}/internal/credential?provider=${encodeURIComponent(provider)}`;

/**
 * CredentialStore backed by the Worker's Durable Object over https.
 *
 * The container is the only writer of the credential. OpenAI rotates refresh
 * tokens on every use, so a second refresher anywhere - a Worker cron, a laptop
 * still running `aisubs dashboard` - would invalidate this one's token. That is
 * why there is no cron trigger in wrangler.jsonc.
 */
class RemoteCredentialStore {
  async #call(method, provider, body) {
    const init = {
      method,
      headers: {
        "x-egress-auth": EGRESS_KEY,
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    };
    // Only set on writes: a GET carrying a body is invalid.
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(credentialUrl(provider), init);
    if (response.status === 409) return { conflict: true };
    if (!response.ok) {
      throw new Error(
        `Credential store ${method} failed: ${response.status} ${await response.text()}`,
      );
    }
    return response.json();
  }

  async read(provider) {
    const result = await this.#call("GET", provider);
    return result.credential ?? null;
  }

  async listKeys() {
    const result = await this.#call("GET", PROVIDER);
    return result.keys ?? [];
  }

  /**
   * Read, apply the callback, write.
   *
   * The callback cannot cross the wire, so the read and the write are two
   * requests. The write carries the access token we read as `previous`, and the
   * Durable Object rejects the write with a 409 if the stored value moved
   * underneath us. On a conflict we start over. That is compare-and-swap, which
   * is what aisubs' modify() contract needs.
   */
  async modify(provider, update) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.read(provider);
      const next = (await update(current)) ?? null;
      const result = await this.#call("POST", provider, {
        previous: current?.accessToken ?? null,
        credential: next,
      });
      if (!result.conflict) return next;
    }
    throw new Error("Credential store modify lost too many races");
  }

  async delete(provider) {
    const current = await this.read(provider);
    await this.#call("POST", provider, {
      previous: current?.accessToken ?? null,
      credential: null,
    });
  }
}

const auth = createSubscriptionAuth({
  store: new RemoteCredentialStore(),
  providers: [chatGptProvider()],
});

const app = createApiApp({ auth, apiKey: API_KEY });

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`aisubs-gw container listening on 0.0.0.0:${PORT}`);
