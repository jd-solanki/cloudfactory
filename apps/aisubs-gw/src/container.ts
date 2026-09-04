import { Container } from "@cloudflare/containers";
import type { Env } from "./index";

/** Header the Worker uses to tell the Durable Object its own public origin. */
export const ORIGIN_HEADER = "x-aisubs-origin";

/**
 * Durable Object wrapper around the aisubs API container.
 *
 * Configuration is delivered as container **env vars**, not as per-request
 * headers. This override is `async`, so the Secrets Store `.get()` calls
 * resolve before `super.fetch()` starts the container, and `envVars` is a plain
 * field the base class reads at start. The container then reads
 * `process.env` once at boot with no memoisation logic, and - the reason that
 * matters - it gets its own copy of both secrets from Secrets Store instead of
 * trusting values a caller supplied.
 *
 * Caveat: env vars are fixed at container start, so a rotated secret only takes
 * effect after the container next sleeps and restarts.
 */
export class AisubsContainer extends Container<Env> {
  defaultPort = 8080;

  /**
   * 10m: long enough to stay warm across one coding session, short enough that
   * an idle gateway stops billing quickly. Shorter saves money and costs cold
   * starts; on `lite` a cold start is a slow Fastify boot on 1/16 vCPU.
   */
  sleepAfter = "2m";

  override onStart() {
    console.log("aisubs-gw: container started");
  }

  override onStop() {
    console.log("aisubs-gw: container stopped");
  }

  override onError(error: unknown) {
    console.error("aisubs-gw: container error:", error);
  }

  override async fetch(request: Request): Promise<Response> {
    const origin = request.headers.get(ORIGIN_HEADER);
    const [egressKey, gatewayKey] = await Promise.all([
      secret(this.env.EGRESS_KEY, this.env.EGRESS_KEY_DEV),
      secret(this.env.GATEWAY_KEY, this.env.GATEWAY_KEY_DEV),
    ]);

    if (!origin || !egressKey || !gatewayKey) {
      return Response.json(
        {
          error: {
            message: "Container configuration is incomplete (origin, EGRESS_KEY or GATEWAY_KEY).",
            type: "configuration_error",
          },
        },
        { status: 500 },
      );
    }

    this.envVars = {
      ...this.envVars,
      WORKER_URL: origin,
      EGRESS_KEY: egressKey,
      GATEWAY_KEY: gatewayKey,
    };

    // Drop our own control header before the container sees it: aisubs forwards
    // unrecognised request headers upstream verbatim.
    const headers = new Headers(request.headers);
    headers.delete(ORIGIN_HEADER);
    return super.fetch(
      new Request(request.url, { method: request.method, headers, body: request.body }),
    );
  }
}

/** Minimal shape of a Cloudflare Secrets Store binding. */
export interface SecretBinding {
  get(): Promise<string>;
}

/** Reads a Secrets Store secret, falling back to a .dev.vars plain variable. */
export async function secret(
  binding: SecretBinding | undefined,
  fallback: string | undefined,
): Promise<string | null> {
  if (binding) {
    // .get() throws when the binding exists but the secret is unset, which is
    // the normal state of an unseeded local Secrets Store.
    const value = await binding.get().catch(() => null);
    if (value) return value;
  }
  return fallback ?? null;
}
