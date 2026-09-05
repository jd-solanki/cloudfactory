import { ContainerProxy, Sandbox as BaseSandbox } from "@cloudflare/sandbox";

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
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${await env.MODEL_API_KEY.get()}`);
  return fetch(new Request(request, { headers }));
};
