#!/usr/bin/env node
// Seeds the Worker's Durable Object with the ChatGPT credential that aisubs
// wrote locally. Run this after `npx aisubs@latest dashboard` and signing in.
//
//   WORKER_URL=https://aisubs-gw.<you>.workers.dev \
//   GATEWAY_KEY=<your gateway key> \
//   node scripts/push-credential.mjs
//
// Both values may also be passed as positional arguments:
//   node scripts/push-credential.mjs <worker-url> <gateway-key>

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROVIDER = "chatgpt";

function dataDir() {
  const override = process.env.AISUBS_DATA_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".aisubs");
}

function fail(message) {
  console.error(`push-credential: ${message}`);
  process.exit(1);
}

const workerUrl = (process.argv[2] ?? process.env.WORKER_URL ?? "").trim().replace(/\/+$/, "");
const gatewayKey = (process.argv[3] ?? process.env.GATEWAY_KEY ?? "").trim();

if (!workerUrl) fail("set WORKER_URL (or pass it as the first argument).");
if (!gatewayKey) fail("set GATEWAY_KEY (or pass it as the second argument).");

const credentialsFile = join(dataDir(), "credentials.json");

let envelope;
try {
  envelope = JSON.parse(await readFile(credentialsFile, "utf8"));
} catch (cause) {
  if (cause.code === "ENOENT") {
    fail(`${credentialsFile} not found. Sign in first: npx aisubs@latest dashboard`);
  }
  fail(`could not read ${credentialsFile}: ${cause.message}`);
}

const credential = envelope?.[PROVIDER];
if (!credential) {
  const keys = Object.keys(envelope ?? {}).join(", ") || "(none)";
  fail(`no "${PROVIDER}" entry in ${credentialsFile}. Entries present: ${keys}`);
}
if (!credential.account?.id) {
  fail(`the "${PROVIDER}" credential has no account.id; sign in again with aisubs.`);
}

const body = {
  accessToken: credential.accessToken,
  refreshToken: credential.refreshToken,
  expiresAt: credential.expiresAt,
  account: credential.account,
  metadata: credential.metadata,
};

const response = await fetch(`${workerUrl}/admin/credential`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${gatewayKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

const text = await response.text();
if (!response.ok) fail(`worker returned ${response.status}: ${text}`);

console.log(`Pushed ${PROVIDER} credential to ${workerUrl}`);
console.log(`  account id : ${credential.account.id}`);
console.log(`  expires at : ${new Date(credential.expiresAt).toISOString()}`);
console.log(`  worker said: ${text}`);
