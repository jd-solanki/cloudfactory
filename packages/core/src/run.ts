/** Cloudflare sandbox ids allow this character set. */
const UNSAFE_ID_CHARACTERS = /[^a-z0-9-]/g;

const MAX_ID_LENGTH = 64;

/**
 * Identify the Sandbox that belongs to one Run.
 *
 * A Run spans several Workflow steps, and every one of them has to reach the
 * same container, so this is derived from the Workflow instance rather than
 * from the step. One instance is one request, so two requests never share a
 * Sandbox.
 */
export const sandboxRunId = (instanceId: string) =>
  `run-${instanceId.toLowerCase().replace(UNSAFE_ID_CHARACTERS, "-")}`.slice(0, MAX_ID_LENGTH);

/** Where the repository is extracted inside the Sandbox. */
export const WORKSPACE_PATH = "/workspace";
