import { ContainerProxy, Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { log } from "./logging.ts";

// Outbound interception needs this class deployed alongside the Sandbox.
export { ContainerProxy };

const modelHost = (env: Env) => new URL(env.MODEL_BASE_URL).hostname;

/**
 * The isolated checkout a Run works in.
 *
 * Repository content reaches this container, so the container is treated as
 * hostile. It holds no credential, and the only host it can reach is the one
 * the configured model endpoint names.
 */
export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false;
  allowedHosts = [modelHost(this.env)];

  // The container has to survive the gaps between polling steps, so this is
  // longer than the poll interval by a wide margin. It is also the only
  // backstop for an orphan, because a terminated Workflow runs no cleanup.
  sleepAfter = "10m";
}

/**
 * Attach the model credential after the request leaves the container.
 *
 * This handler runs in the Workers runtime, not in the sandbox, so the key
 * exists only where repository content cannot read it. The reviewing agent is
 * configured to send no credential of its own.
 */
Sandbox.outbound = async (request: Request, env: Env) => {
  const started = Date.now();
  const url = new URL(request.url);

  try {
    const key = await env.MODEL_API_KEY.get();
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${key}`);

    const response = await fetch(new Request(request, { headers }));
    log("outbound.forwarded", {
      host: url.hostname,
      path: url.pathname,
      method: request.method,
      status: response.status,
      ms: Date.now() - started,
    });
    return response;
  } catch (error) {
    // A handler that throws leaves the container waiting on a request that
    // will never answer, which is indistinguishable from a slow model.
    const reason = error instanceof Error ? error.message : String(error);
    log("outbound.failed", { host: url.hostname, path: url.pathname, reason });
    return new Response(`outbound handler failed: ${reason}`, { status: 502 });
  }
};
