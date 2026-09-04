# aisubs-gw

Hosted [`aisubs`](https://github.com/MpMeetPatel/aisubs). A permanent https base
URL backed by your ChatGPT (Codex) subscription, so you no longer keep
`aisubs dashboard` running on your laptop.

## What you paste into an app

```
OPENAI_BASE_URL=https://aisubs-gw.<your-subdomain>.workers.dev/aisubs/chatgpt/default/v1
OPENAI_API_KEY=<AISUBS_GATEWAY_KEY>
```

`<your-subdomain>` is your `workers.dev` subdomain, printed by `wrangler deploy`.

The `/aisubs/<provider>/<account>` prefix is aisubs' own account route
(`accountPath()` in `dist/http.js`): `parts[0] === "aisubs"`, then the provider,
then the account key, then the upstream path with an optional `v1` segment.
Provider is `chatgpt`, account is `default`. Appending `/v1` to the base URL is
what makes a client's `/v1/chat/completions` land on
`/aisubs/chatgpt/default/v1/chat/completions`.

Working endpoints on that base URL:

| Client calls             | Full path                                     |
| ------------------------ | --------------------------------------------- |
| `GET /models`            | `/aisubs/chatgpt/default/v1/models`           |
| `POST /chat/completions` | `/aisubs/chatgpt/default/v1/chat/completions` |
| `POST /responses`        | `/aisubs/chatgpt/default/v1/responses`        |

`/chat/completions` works because the container runs aisubs' real
`proxyCompatible()`, which translates chat/completions into a Codex
`/responses` call. That function is **not** in the package exports map, so it is
unreachable from a Worker build - which is one of the two reasons the container
exists.

Discover model ids at runtime with `GET /models`; do not hard-code them here,
because the catalog changes with the subscription.

## Use it from an app

Anything that accepts a custom OpenAI base URL works. Three worked examples.

### Official OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://aisubs-gw.<your-subdomain>.workers.dev/aisubs/chatgpt/default/v1",
  apiKey: process.env.AISUBS_GATEWAY_KEY,
});

const completion = await client.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "Reply with exactly: pong" }],
});

console.log(completion.choices[0]?.message.content); // pong
```

Streaming works the same way - `stream: true` returns SSE chunks, passed through
the Worker untouched.

### Vercel AI SDK

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const gateway = createOpenAI({
  baseURL: "https://aisubs-gw.<your-subdomain>.workers.dev/aisubs/chatgpt/default/v1",
  apiKey: process.env.AISUBS_GATEWAY_KEY,
});

const result = streamText({
  model: gateway("gpt-5.6-terra"),
  prompt: "Explain a Durable Object in two sentences.",
});

for await (const chunk of result.textStream) process.stdout.write(chunk);
```

### A desktop app that only has three fields

Most tools ([Raycast](https://www.raycast.com/) custom AI provider,
[Cline](https://cline.bot/), [Handy](https://handy.computer/), Open WebUI,
LibreChat) ask for exactly three values:

| Field    | Value                                                                      |
| -------- | -------------------------------------------------------------------------- |
| Provider | `OpenAI compatible` / `Custom`                                             |
| Base URL | `https://aisubs-gw.<your-subdomain>.workers.dev/aisubs/chatgpt/default/v1` |
| API key  | your `AISUBS_GATEWAY_KEY`                                                  |
| Model    | an exact id from `GET /models`, e.g. `gpt-5.4-mini`                        |

Raycast, as a concrete file - `~/.config/raycast/ai/providers.yaml`:

```yaml
providers:
  - id: aisubs-gw
    name: AISubs Gateway
    base_url: https://aisubs-gw.<your-subdomain>.workers.dev/aisubs/chatgpt/default/v1
    api_keys:
      default: REPLACE_WITH_YOUR_GATEWAY_KEY
    models:
      - id: gpt-5.4-mini
        name: GPT-5.4 Mini (ChatGPT subscription)
        context: 272000
        abilities:
          tools: { supported: true }
          system_message: { supported: true }
```

Restart the app after saving. Never put the gateway key in browser-delivered
code: it is a bearer key to your ChatGPT subscription.

### Shell

```bash
export OPENAI_BASE_URL="https://aisubs-gw.<your-subdomain>.workers.dev/aisubs/chatgpt/default/v1"
export OPENAI_API_KEY="<AISUBS_GATEWAY_KEY>"

curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
```

## Architecture

```
client
  -> Worker      gateway key checked here, BEFORE the container wakes
  -> Container   real Node, runs aisubs createApiApp() on 0.0.0.0:8080
       |            \_ outbound call to chatgpt.com  (a Worker gets a 403 bot page here)
       \-> Worker    /internal/credential  read+write the OAuth credential
  <- Worker      response streamed back unchanged (SSE intact)
```

| Piece             | File                          | Job                                                                           |
| ----------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| Front door        | `src/index.ts`                | Key check, `/health`, `/internal/credential`, `/admin/credential`, forwarding |
| Container wrapper | `src/container.ts`            | Durable Object, env var injection, `sleepAfter`                               |
| Credential state  | `src/store.ts`                | `CredentialStoreDO` - the only durable state                                  |
| aisubs server     | `container/server.mjs`        | `createApiApp` + `RemoteCredentialStore`                                      |
| Image             | `container/Dockerfile`        | `node:24-slim`, installs `aisubs`, runs `server.mjs`                          |
| Seeding           | `scripts/push-credential.mjs` | Uploads your laptop's credential once                                         |

### Why the container

1. **A deployed Worker cannot reach chatgpt.com.** Verified: Worker to
   `chatgpt.com/backend-api/codex` is always a `403` Cloudflare bot page, while
   the same Worker reaches `auth.openai.com` (200) and `api.openai.com` (401), so
   it is not an IP or ASN block. A deployed Container gets `200` with a real
   token.
2. **The compatibility layer is not exported.** `proxyCompatible` lives in
   `dist/compatibility.js`, absent from `package.json` `exports`. Only a real
   Node process running the published entry points gets the full
   OpenAI-compatible surface.

`createSubscriptionAuthServer` refuses any non-localhost bind
(`dist/http.js:479`), but `createApiApp(options)` is exported and has no such
check, so `server.mjs` builds the Fastify app and calls
`app.listen({ port: 8080, host: "0.0.0.0" })` itself. No extra forwarder.

### Edge header hygiene - do not remove this

`forward()` in `src/index.ts` deletes `cf-connecting-ip`, `cf-ray`,
`cf-ipcountry`, `cf-visitor`, `cdn-loop`, `x-forwarded-*`, `x-real-ip`,
`forwarded`, `host` and `content-length` before handing the request to the
container. `src/container.ts` likewise deletes `x-aisubs-origin`.

This is load-bearing. aisubs forwards unrecognised request headers upstream
verbatim, so without the strip, Cloudflare's own edge headers travelled all the
way to `chatgpt.com`. The symptom was specific and confusing: `GET /models`
returned `200` while `POST /chat/completions` returned a `403` bot challenge
page. Those headers describe our hop and are meaningless to the provider.

The measurement that isolated it: three POST transport variants sent from a bare
container - `fetch` with a string body, `fetch` with a chunked stream body, and
`node:https` on HTTP/1.1 - all returned `200`. The container was never the
problem; the headers we added were.

### Verified behaviour

Measured against a real deployment, not inferred.

| Origin             | `auth.openai.com` | `api.openai.com` | `chatgpt.com/backend-api/codex` |
| ------------------ | ----------------- | ---------------- | ------------------------------- |
| Deployed Worker    | 200               | 401              | **403 bot page**                |
| Deployed Container | 200               | 401              | **200**                         |
| Local `curl`       | 200               | 401              | 200                             |

The Worker reaching two OpenAI hosts but not the third rules out an IP or ASN
block: `chatgpt.com`'s bot rules reject the Worker signal specifically. Changing
the user-agent does not help, and chasing that further would be detection
evasion rather than engineering, so the container is the answer.

End-to-end checks that pass on the deployed gateway:

| Check                                           | Result                        |
| ----------------------------------------------- | ----------------------------- |
| `GET /v1/models`                                | real Codex model catalog      |
| `POST /v1/chat/completions`                     | returns `pong`                |
| `POST /v1/chat/completions` with `stream: true` | SSE, token by token           |
| No key / wrong key                              | `401`                         |
| `GET /health`                                   | `200`, container stays asleep |

### One refresher, on purpose

OpenAI rotates the refresh token on every use. Two refreshers would each
invalidate the other's token. The **container is the only writer** of the
credential:

- there is **no cron trigger** in `wrangler.jsonc`,
- the Worker never calls `getAccessToken()`,
- once seeded, **stop running `aisubs dashboard` on your laptop** against the
  same account, or it will fight the container for the refresh token.

`/admin/credential` is the one exception: a manual one-time seed, done while
nothing else is refreshing.

### Credential callback

`RemoteCredentialStore` in the container implements aisubs' `CredentialStore`
over https against the Worker's `/internal/credential`, authenticated with
`x-egress-auth`.

A closure cannot cross the wire, so `modify()` is read, apply, write - two
requests. The write carries the access token it read as `previous`, and the
Durable Object compares it inside its critical section, returning `409` if the
stored value moved. On a conflict the container starts over, up to 5 times. That
is compare-and-swap, which restores the atomicity `modify()` assumes.

### How config reaches the container

As **container env vars**, injected by the Durable Object, not as per-request
headers.

`AisubsContainer.fetch()` is an `async` override. It awaits the two Secrets
Store `.get()` calls, sets `this.envVars` - a plain field the base class reads at
container start - and only then calls `super.fetch()`. `server.mjs` reads
`process.env` once at boot: `WORKER_URL`, `EGRESS_KEY`, `GATEWAY_KEY`.

Chosen over headers because the container ends up with its **own** copy of both
secrets, read from Secrets Store, rather than trusting values a caller supplied -
and because it needs no memoisation logic. `WORKER_URL` cannot come from Secrets
Store, so the Worker derives it from the incoming request's origin and passes it
on the `x-aisubs-origin` header, which the Durable Object reads before start.

_Caveat:_ env vars are fixed at container start, so a rotated secret only takes
effect after the container next sleeps and restarts.

### Cost settings

Shared account on the $5 Workers Paid plan, so: smallest of everything.

| Setting         | Value                                   | Why                                                                                                                                                                   |
| --------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_type` | `lite`                                  | 1/16 vCPU, 256 MiB, 2 GB disk - the smallest tier. A Fastify proxy needs no more.                                                                                     |
| `max_instances` | `1`                                     | Stateless, single user, and the account is shared with production.                                                                                                    |
| `sleepAfter`    | `2m`                                    | Long enough to stay warm inside one working session, short enough that an idle gateway stops billing fast. Raise it for fewer cold starts, lower it for less billing. |
| cron            | none                                    | See "One refresher" above.                                                                                                                                            |
| `/health`       | answered in the Worker                  | An uptime probe must never wake the container.                                                                                                                        |
| key check       | in the Worker                           | Junk traffic is rejected before anything bills.                                                                                                                       |
| `limits.cpu_ms` | `30000`                                 | Bounds one runaway invocation. Streaming is wall-clock bound, not CPU bound, so this is far above normal use.                                                         |
| `ratelimits`    | 30 per 10 s per IP, 120 per 60 s global | See below.                                                                                                                                                            |

Expected bill on the $5 Workers Paid plan: **$0.00 to about $0.10/month** on top
of the $5. `lite` gives 100 free awake-hours a month, Durable Object usage for
one small row is free by a wide margin, and Worker requests are a rounding
error. A sleeping container bills nothing at all.

Note the free allowances are **per account**, shared with everything else you
deploy.

### Spend limits - read this before exposing the URL

**Cloudflare has no hard spend cap.** There is no dashboard toggle, no API
field, no wrangler key that stops service at a dollar amount for Workers,
Durable Objects or Containers. The docs are explicit that budget alerts _"are
informational only. They do not pause or cap usage."_

So the ceiling is built here instead:

| Control               | Where                              | What it bounds                                                                                                  |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `max_instances: 1`    | `wrangler.jsonc`                   | Container compute. One `lite` instance cannot cost more than **~$4.57/month** even if pinned for all 730 hours. |
| `ratelimits` bindings | `wrangler.jsonc` + `rateLimited()` | Request volume, checked before the key and before the container wakes.                                          |
| `limits.cpu_ms`       | `wrangler.jsonc`                   | A single runaway invocation.                                                                                    |
| Gateway key           | `rateLimited()` then key check     | Casual access.                                                                                                  |

Two honest limitations of the rate limiting binding:

1. It is **per Cloudflare location**, so a distributed caller sees
   `limit x number of colos`. It stops a retry loop or a single abuser, not a
   determined one.
2. The Worker invocation is **still billed** for every `429` it returns. Only a
   WAF rate limiting rule blocks before the Worker runs — and WAF rules are
   zone-scoped, so they **cannot** attach to a `workers.dev` hostname.

**If you want a true ceiling**, put the Worker on a custom domain in a
Cloudflare zone (a Free zone allows one rate limiting rule) and add:

- Expression `(http.host eq "gw.example.com")`
- Characteristic: IP
- Rate: 20 requests per 10 seconds, action **Block**

Blocked requests never invoke the Worker, so they never bill. With that rule the
worst case for a leaked key is roughly **$10/month**, versus unbounded Worker and
Durable Object request cost on `workers.dev`.

**Also turn on a budget alert**, which is email-only but still worth it:
Dashboard → Manage Account → Billing → Billable Usage → _Create budget alert_.
It is account-wide in USD and fires once per billing cycle.

One term nothing above bounds: **egress**. 1 TB/month is included for North
America and Europe, then $0.025/GB. A proxy is I/O bound, so a leaked key
streaming large responses is the one path to a genuinely large bill. The rate
limits are what keep that in check.

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the two secrets

The store id `dbe91e8e7bed44c2b0618abf954eac6e` is already in `wrangler.jsonc`.

```bash
# Your API key. Keep it: this is OPENAI_API_KEY.
openssl rand -base64 32

# Internal key for the container's credential callback. Never leaves Cloudflare.
openssl rand -base64 32

npx wrangler secrets-store secret create dbe91e8e7bed44c2b0618abf954eac6e \
  --name AISUBS_GATEWAY_KEY --scopes workers --remote

npx wrangler secrets-store secret create dbe91e8e7bed44c2b0618abf954eac6e \
  --name AISUBS_EGRESS_KEY --scopes workers --remote
```

Omitting `--value` makes it prompt, which keeps the keys out of shell history.

### 3. Deploy

Docker must be running: `wrangler` builds the image locally and pushes it to
Cloudflare's registry.

```bash
npx wrangler deploy --dry-run --outdir=dist   # verify first
npx wrangler deploy
```

### 4. Seed the credential, once

aisubs cannot run the OAuth browser flow inside a Worker or a headless
container, so sign in on your laptop and upload the result:

```bash
npx aisubs@latest dashboard      # sign in; writes ~/.aisubs/credentials.json

WORKER_URL=https://aisubs-gw.<your-subdomain>.workers.dev \
GATEWAY_KEY=<AISUBS_GATEWAY_KEY> \
node scripts/push-credential.mjs
```

Then quit the local dashboard. From here the container owns the refresh.

### 5. Use it

```bash
curl https://aisubs-gw.<your-subdomain>.workers.dev/aisubs/chatgpt/default/v1/models \
  -H "Authorization: Bearer $AISUBS_GATEWAY_KEY"
```

## Local development

```bash
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
npm run dry-run      # wrangler deploy --dry-run --outdir=dist
npm run deploy       # wrangler deploy
```

There is deliberately no `build` script: a workspace-wide `vp run -r build`
would otherwise try to run a wrangler dry-run, which needs Docker and Cloudflare
credentials. Use `npm run dry-run` explicitly.

`wrangler dev` runs the container through your local Docker, so its egress
carries **your** machine's fingerprint, not Cloudflare's. Local results say
nothing about the chatgpt.com bot check either way.

Local Secrets Store starts empty, so put fallbacks in `.dev.vars`:

```
GATEWAY_KEY_DEV=local-dev-gateway-key
EGRESS_KEY_DEV=local-dev-egress-key
```

The Worker prefers Secrets Store and falls back to these only if the binding is
missing or unset. **Never set them in production.**

The `ratelimits` bindings are not simulated by `wrangler dev`, so
`rateLimited()` finds no binding and passes everything through locally. That is
intentional: the checks are skipped, not faked.

To exercise the container image on its own:

```bash
docker build --platform=linux/amd64 -t aisubs-gw-local ./container
docker run --rm -p 8090:8080 \
  -e WORKER_URL=https://example.invalid \
  -e EGRESS_KEY=devegress -e GATEWAY_KEY=devgateway \
  aisubs-gw-local
curl -s localhost:8090/health          # {"ok":true}
```

## Caveats

1. **Terms of service.** Routing a ChatGPT subscription through a hosted gateway
   may breach OpenAI's terms. Your call.
2. **Single account.** One provider, one account, one DO instance, one container.
3. **`/health` is unauthenticated** by design so uptime probes need no key. It
   returns only static strings and never wakes the container.
4. **Secret rotation needs a container restart** to take effect - see the config
   caveat above.
5. **Cold starts.** With `sleepAfter: 2m` and `lite`, the first request after an
   idle period waits for the container to boot.
