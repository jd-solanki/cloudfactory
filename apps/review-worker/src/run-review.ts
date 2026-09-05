import { getSandbox } from "@cloudflare/sandbox";
import {
  DEFAULT_REVIEW_INSTRUCTIONS,
  GitHub,
  REVIEW_INSTRUCTIONS_PATH,
  type ReviewRequest,
  WORKSPACE_PATH,
} from "core";
import { Effect } from "effect";
import { runWithGitHub } from "./github-runtime.ts";
import { log, logProcessOutput } from "./logging.ts";

const ARCHIVE_PATH = "/tmp/head.tar.gz";
const DIFF_PATH = "/tmp/pull-request.diff";
const INSTRUCTIONS_PATH = "/tmp/review-instructions.md";
const PROMPT_PATH = "/tmp/review-prompt.txt";
const OUTPUT_PATH = "/tmp/review.md";

/** The agent writes these, and they are how a later step learns what happened. */
const AGENT_STDOUT = "/tmp/codex.out";
const AGENT_STDERR = "/tmp/codex.err";
const AGENT_EXIT = "/tmp/codex.exit";

/**
 * Codex writes session state and helper binaries here. It refuses to place
 * helper binaries under a temporary directory, so this is not below /tmp.
 */
const CODEX_HOME = "/var/lib/codex";

/** Sandbox installs its interception certificate at this fixed path. */
const CA_CERTIFICATE_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const EXTRACT_TIMEOUT_MS = 120_000;
const SHORT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * The agent sends no credential. The Worker attaches one to every request that
 * leaves the container, so this provider deliberately declares no `env_key`.
 */
const codexConfig = (env: Env) =>
  [
    `model = "${env.MODEL_NAME}"`,
    `model_reasoning_effort = "${env.MODEL_REASONING_EFFORT}"`,
    'model_provider = "review"',
    "",
    "[model_providers.review]",
    'name = "review"',
    `base_url = "${env.MODEL_BASE_URL}"`,
    'wire_api = "responses"',
    "# The Workflow already retries, so the agent gives up quickly instead of",
    "# spending a step timeout reconnecting to a request that cannot succeed.",
    "request_max_retries = 2",
    "stream_max_retries = 2",
    "",
  ].join("\n");

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

/**
 * Whether the agent has finished, and how much it has written so far.
 *
 * A step's return value always survives into the dashboard, so the byte counts
 * ride along: without them a stalled agent and a working one look identical.
 */
export type ReviewProgress = {
  readonly finished: boolean;
  readonly exitCode?: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly reviewBytes: number;
};

const shell = (script: string) => ["/bin/bash", "-lc", script] as [string, ...string[]];

const openSandbox = (env: Env, sandboxId: string) => getSandbox(env.SANDBOX, sandboxId);

const run = (
  sandbox: ReturnType<typeof openSandbox>,
  script: string,
  timeout = SHORT_COMMAND_TIMEOUT_MS,
) =>
  sandbox
    .exec(shell(script), {
      cwd: WORKSPACE_PATH,
      env: { CODEX_HOME, CODEX_CA_CERTIFICATE: CA_CERTIFICATE_PATH },
      timeout,
    })
    .then((process) => process.output({ encoding: "utf8" }));

/**
 * Check the revision out and start the agent, without waiting for it.
 *
 * A Workflow step cannot hold a container connection open for the length of a
 * review, so this step returns as soon as the agent is running. The agent
 * redirects its own output to files, which later steps read.
 */
export const prepareReview = async (
  env: Env,
  request: ReviewRequest,
  sandboxId: string,
): Promise<{ readonly fileCount: number }> => {
  const [archive, diff] = await runWithGitHub(
    env,
    Effect.flatMap(GitHub, (github) =>
      Effect.all([
        github.downloadArchive(request, request.headSha),
        github.getPullRequestDiff(request),
      ]),
    ),
  );

  const sandbox = openSandbox(env, sandboxId);

  await sandbox.mkdir(WORKSPACE_PATH, { recursive: true });
  await sandbox.mkdir(CODEX_HOME, { recursive: true });
  await sandbox.writeFile(ARCHIVE_PATH, archive);

  // GitHub wraps the tree in one directory named after the repository and
  // commit, so drop that level.
  const extracted = await run(
    sandbox,
    `tar -xzf ${ARCHIVE_PATH} -C ${WORKSPACE_PATH} --strip-components=1 && rm -f ${ARCHIVE_PATH}`,
    EXTRACT_TIMEOUT_MS,
  );
  if (extracted.exitCode !== 0) {
    throw new Error(`could not extract the head revision: ${extracted.stderr}`);
  }

  // A repository owns its own review rules. Absent rules fall back to ours.
  const own = await run(sandbox, `cat ${WORKSPACE_PATH}/${REVIEW_INSTRUCTIONS_PATH}`);
  const ownInstructions = own.exitCode === 0 && own.stdout.trim() !== "";

  await sandbox.writeFile(DIFF_PATH, diff);
  await sandbox.writeFile(
    INSTRUCTIONS_PATH,
    ownInstructions ? own.stdout : DEFAULT_REVIEW_INSTRUCTIONS,
  );
  await sandbox.writeFile(PROMPT_PATH, REVIEW_PROMPT);
  await sandbox.writeFile(`${CODEX_HOME}/config.toml`, codexConfig(env));

  const counted = await run(sandbox, `find ${WORKSPACE_PATH} -type f | wc -l`);

  // The container is already the isolation boundary: no credential, one
  // reachable host, destroyed at the end. Codex's own nested sandbox needs user
  // namespaces that are not available here, so it is turned off.
  //
  // stdin comes from /dev/null because a sandbox process has no stdin at all,
  // and codex reads it for extra prompt text. The exit file is written last, so
  // its presence is what marks the agent finished.
  await sandbox.exec(
    shell(
      `rm -f ${AGENT_EXIT}; ` +
        `codex exec --ephemeral --skip-git-repo-check` +
        ` --dangerously-bypass-approvals-and-sandbox` +
        ` --output-last-message ${OUTPUT_PATH} "$(cat ${PROMPT_PATH})"` +
        ` < /dev/null > ${AGENT_STDOUT} 2> ${AGENT_STDERR}; ` +
        `echo $? > ${AGENT_EXIT}`,
    ),
    { cwd: WORKSPACE_PATH, env: { CODEX_HOME, CODEX_CA_CERTIFICATE: CA_CERTIFICATE_PATH } },
  );

  const fileCount = Number.parseInt(counted.stdout.trim(), 10);
  log("review.started", { headSha: request.headSha, fileCount });
  return { fileCount };
};

/** Ask whether the agent has finished, and how far it has got. */
export const checkReview = async (env: Env, sandboxId: string): Promise<ReviewProgress> => {
  const probe = await run(
    openSandbox(env, sandboxId),
    "printf '%s|%s|%s|%s' " +
      `"$(cat ${AGENT_EXIT} 2>/dev/null)" ` +
      `"$(wc -c < ${AGENT_STDOUT} 2>/dev/null || echo 0)" ` +
      `"$(wc -c < ${AGENT_STDERR} 2>/dev/null || echo 0)" ` +
      `"$(wc -c < ${OUTPUT_PATH} 2>/dev/null || echo 0)"`,
  );

  const [exit = "", out = "0", err = "0", review = "0"] = probe.stdout.trim().split("|");
  const size = (value: string) => Number.parseInt(value.trim(), 10) || 0;
  const code = Number.parseInt(exit.trim(), 10);
  const finished = Number.isInteger(code);

  const progress: ReviewProgress = {
    finished,
    ...(finished ? { exitCode: code } : {}),
    stdoutBytes: size(out),
    stderrBytes: size(err),
    reviewBytes: size(review),
  };

  if (finished) log("review.finished", progress);
  return progress;
};

/** Read what the agent produced, then take the container down. */
export const collectReview = async (
  env: Env,
  request: ReviewRequest,
  sandboxId: string,
  fileCount: number,
): Promise<ReviewOutcome> => {
  const sandbox = openSandbox(env, sandboxId);

  try {
    const [exit, out, err, body] = await Promise.all([
      run(sandbox, `cat ${AGENT_EXIT} 2>/dev/null || true`),
      run(sandbox, `tail -c 20000 ${AGENT_STDOUT} 2>/dev/null || true`),
      run(sandbox, `tail -c 20000 ${AGENT_STDERR} 2>/dev/null || true`),
      run(sandbox, `cat ${OUTPUT_PATH} 2>/dev/null || true`),
    ]);

    const exitCode = Number.parseInt(exit.stdout.trim(), 10);
    logProcessOutput("codex", { stdout: out.stdout, stderr: err.stdout, exitCode });

    if (exitCode !== 0) {
      throw new Error(
        `the reviewing agent exited ${exitCode}.` +
          ` stdout: ${out.stdout.slice(-1500)} stderr: ${err.stdout.slice(-1500)}`,
      );
    }
    if (body.stdout.trim() === "") {
      throw new Error("the reviewing agent produced no review");
    }

    return { headSha: request.headSha, fileCount, body: body.stdout.trim() };
  } finally {
    await sandbox.destroy();
    log("sandbox.destroyed", { sandboxId });
  }
};

/** Take the container down when a Run gives up before collecting. */
export const abandonSandbox = async (env: Env, sandboxId: string): Promise<void> => {
  await openSandbox(env, sandboxId).destroy();
  log("sandbox.destroyed", { sandboxId, abandoned: true });
};
