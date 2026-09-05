import { getSandbox } from "@cloudflare/sandbox";
import {
  DEFAULT_REVIEW_INSTRUCTIONS,
  GitHub,
  REVIEW_INSTRUCTIONS_PATH,
  type ReviewRequest,
  WORKSPACE_PATH,
  sandboxRunId,
} from "core";
import { Effect } from "effect";
import { runWithGitHub } from "./github-runtime.ts";
import { log, logProcessOutput } from "./logging.ts";
import { MODEL_HOST } from "./sandbox.ts";

const ARCHIVE_PATH = "/tmp/head.tar.gz";
const DIFF_PATH = "/tmp/pull-request.diff";
const INSTRUCTIONS_PATH = "/tmp/review-instructions.md";
const OUTPUT_PATH = "/tmp/review.md";

/**
 * Codex writes session state and helper binaries here. It refuses to place
 * helper binaries under a temporary directory, so this is not below /tmp.
 */
const CODEX_HOME = "/var/lib/codex";

/** Sandbox installs its interception certificate at this fixed path. */
const CA_CERTIFICATE_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const PROMPT_PATH = "/tmp/review-prompt.txt";

const EXTRACT_TIMEOUT_MS = 120_000;
const REVIEW_TIMEOUT_MS = 600_000;

/**
 * The agent sends no credential. The Worker attaches one to every request that
 * leaves the container, so this provider deliberately declares no `env_key`.
 */
const CODEX_CONFIG = `model_provider = "cloudflare-proxy"

[model_providers.cloudflare-proxy]
name = "cloudflare-proxy"
base_url = "https://${MODEL_HOST}/v1"
wire_api = "responses"
# The Workflow step already retries, so the agent gives up quickly instead of
# spending a step timeout reconnecting to a request that cannot succeed.
request_max_retries = 2
stream_max_retries = 2
`;

const REVIEW_PROMPT = `Review one pull request.

- The repository at the reviewed revision is checked out at ${WORKSPACE_PATH}.
- The unified diff of the change is at ${DIFF_PATH}.
- Your review instructions are at ${INSTRUCTIONS_PATH}.

Read the instructions first and follow them exactly. Read the diff, then read
whatever surrounding code you need in order to judge it.

Do not run the repository's build, tests, or scripts.

Answer with the review itself as GitHub-flavoured Markdown. Do not add a
preamble, a summary of what you did, or a sign-off.`;

/** What the Run produced for one revision. */
export type ReviewOutcome = {
  readonly headSha: string;
  readonly fileCount: number;
  readonly body: string;
};

const shell = (script: string) => ["/bin/bash", "-lc", script];

/**
 * Check out the exact head revision in a fresh Sandbox, review it, and report
 * the result.
 *
 * A Sandbox is not durable state, so one pass does the whole job and destroys
 * the container afterwards. A retry repeats the fetch, which is deterministic
 * for a fixed SHA.
 */
export const runReview = async (
  env: Env,
  request: ReviewRequest,
  attempt: number,
): Promise<ReviewOutcome> => {
  const [archive, diff] = await runWithGitHub(
    env,
    Effect.flatMap(GitHub, (github) =>
      Effect.all([
        github.downloadArchive(request, request.headSha),
        github.getPullRequestDiff(request),
      ]),
    ),
  );

  const sandbox = getSandbox(env.SANDBOX, sandboxRunId(request, attempt));

  const run = async (command: ReadonlyArray<string>, timeout?: number) => {
    const started = await sandbox.exec(command as [string, ...string[]], {
      cwd: WORKSPACE_PATH,
      env: { CODEX_HOME, CODEX_CA_CERTIFICATE: CA_CERTIFICATE_PATH },
      ...(timeout === undefined ? {} : { timeout }),
    });
    return started.output({ encoding: "utf8" });
  };

  /**
   * Same as `run`, but the output reaches Workers Logs afterwards.
   *
   * Streaming the output line by line was tried first and burned the step's
   * CPU budget, which is 30 seconds by default and five minutes at most. A
   * step that only awaits the process spends no CPU while it waits.
   */
  const runLogged = async (command: ReadonlyArray<string>, name: string, timeout: number) => {
    const started = await sandbox.exec(command as [string, ...string[]], {
      cwd: WORKSPACE_PATH,
      env: { CODEX_HOME, CODEX_CA_CERTIFICATE: CA_CERTIFICATE_PATH },
      timeout,
    });
    const output = await started.output({ encoding: "utf8" });
    logProcessOutput(name, output);
    return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode };
  };

  try {
    await sandbox.mkdir(WORKSPACE_PATH, { recursive: true });
    await sandbox.mkdir(CODEX_HOME, { recursive: true });
    await sandbox.writeFile(ARCHIVE_PATH, archive);

    // GitHub wraps the tree in one directory named after the repository and
    // commit, so drop that level.
    const extracted = await run(
      shell(
        `tar -xzf ${ARCHIVE_PATH} -C ${WORKSPACE_PATH} --strip-components=1 && rm -f ${ARCHIVE_PATH}`,
      ),
      EXTRACT_TIMEOUT_MS,
    );
    if (extracted.exitCode !== 0) {
      throw new Error(`could not extract the head revision: ${extracted.stderr}`);
    }
    log("checkout.extracted", { headSha: request.headSha });

    // A repository owns its own review rules. Absent rules fall back to ours.
    const own = await run(shell(`cat ${WORKSPACE_PATH}/${REVIEW_INSTRUCTIONS_PATH}`));
    const ownInstructions = own.exitCode === 0 && own.stdout.trim() !== "";
    const instructions = ownInstructions ? own.stdout : DEFAULT_REVIEW_INSTRUCTIONS;
    log("checkout.instructions", {
      source: ownInstructions ? REVIEW_INSTRUCTIONS_PATH : "default",
    });

    await sandbox.writeFile(DIFF_PATH, diff);
    await sandbox.writeFile(INSTRUCTIONS_PATH, instructions);
    await sandbox.writeFile(`${CODEX_HOME}/config.toml`, CODEX_CONFIG);

    // The container is already the isolation boundary: no credential, one
    // reachable host, destroyed at the end. Codex's own nested sandbox needs
    // user namespaces that are not available here, so it is turned off.
    //
    // stdin is redirected from /dev/null because a sandbox process has no stdin
    // at all, and codex reads it for extra prompt text. Without an immediate
    // end of file it waits for input that can never arrive.
    await sandbox.writeFile(PROMPT_PATH, REVIEW_PROMPT);
    log("review.started", { headSha: request.headSha, attempt });

    const review = await runLogged(
      [
        "/bin/bash",
        "-lc",
        `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` +
          ` --output-last-message ${OUTPUT_PATH} "$(cat ${PROMPT_PATH})" < /dev/null`,
      ],
      "codex",
      REVIEW_TIMEOUT_MS,
    );

    log("review.finished", { exitCode: review.exitCode, stdoutBytes: review.stdout.length });

    if (review.exitCode !== 0) {
      throw new Error(`the reviewing agent failed: ${review.stderr.slice(-2000)}`);
    }

    const body = await run(shell(`cat ${OUTPUT_PATH}`));
    if (body.exitCode !== 0 || body.stdout.trim() === "") {
      throw new Error("the reviewing agent produced no review");
    }

    const counted = await run(shell(`find ${WORKSPACE_PATH} -type f | wc -l`));

    return {
      headSha: request.headSha,
      fileCount: Number.parseInt(counted.stdout.trim(), 10),
      body: body.stdout.trim(),
    };
  } finally {
    await sandbox.destroy();
    log("sandbox.destroyed", { headSha: request.headSha, attempt });
  }
};
