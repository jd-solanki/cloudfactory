import { ContainerProxy, Sandbox as BaseSandbox } from "@cloudflare/sandbox";

// Outbound interception needs this class deployed alongside the Sandbox.
export { ContainerProxy };

/** The only host a Run may reach from inside the container. */
export const MODEL_HOST = "api.openai.com";

/**
 * The isolated checkout a Run works in.
 *
 * Repository content reaches this container, so the container is treated as
 * hostile. It holds no credential and can reach exactly one host.
 */
export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false;
  allowedHosts = [MODEL_HOST];
  // A terminated Workflow cannot run cleanup, so an orphaned container has to
  // time itself out. Keep that window short.
  sleepAfter = "2m";
}

/**
 * Attach the model credential after the request leaves the container.
 *
 * This handler runs in the Workers runtime, not in the sandbox, so the key
 * exists only where repository content cannot read it. The reviewing agent is
 * configured to send no credential of its own.
 */
Sandbox.outboundByHost = {
  [MODEL_HOST]: async (request: Request, env: Env) => {
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${await env.OPENAI_API_KEY.get()}`);
    return fetch(new Request(request, { headers }));
  },
};
