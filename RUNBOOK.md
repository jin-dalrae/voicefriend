# Talk2Me — Deployment Runbook

How to deploy, verify, and debug the live system. Everything here is a real step
or a real bug that cost time to find — written down so the next deploy doesn't
re-learn it.

For first-time Google Cloud setup (enabling APIs, creating the secret, IAM), see
[SETUP.md](./SETUP.md). For architecture rationale, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Topology (what runs where)

| Piece | Service | Project | Notes |
| --- | --- | --- | --- |
| Web app (static) | Firebase Hosting, site `talk-to-me1` | `talk2me-e90b1` | serves `public/` |
| Voice relay | Cloud Run `talk2me-relay`, `us-central1` | `raejin-35457` | Express + `/ws`, holds the Gemini key |
| Auth / DB | Firebase Auth + Firestore | `talk2me-e90b1` | relay reaches Firestore **cross-project** |
| Secret | Secret Manager `gemini-api-key` | `raejin-35457` | injected at deploy |

The relay and the data plane live in **different GCP projects**. The relay's Cloud
Run service account must have Firestore access in `talk2me-e90b1` — if that IAM
binding is missing, the relay boots fine and only fails when it first touches
Firestore (sign-in, credits, transcripts).

The browser's WS endpoint is hard-coded in `public/index.html` as
`window.TALK2ME_WS_URL`. If you move the relay, update that and redeploy Hosting.

---

## Deploy

```bash
# 1) Relay → Cloud Run (source build via Dockerfile; injects the secret; auth ON)
npm run deploy:cloud-run

# 2) Web app → Firebase Hosting
firebase deploy --project talk2me-e90b1 --only hosting

# 3) Firestore rules / indexes (only when they change)
firebase deploy --project talk2me-e90b1 --only firestore:rules,firestore:indexes
```

The deploy script (`scripts/deploy-cloud-run.sh`) pins three things on purpose:

- `--set-env-vars REQUIRE_FIREBASE_AUTH=1` — set explicitly so a `--source`
  redeploy can **never silently fall back to anonymous** (= unmetered Gemini cost).
- `--timeout=1200` — 20-minute hard ceiling on a single WebSocket/live session.
  This is a cost safety net, **not** a login-session length.
- `--set-secrets GEMINI_API_KEY=gemini-api-key:latest` — the key is never in env
  files or the image.

The Dockerfile has an `ARG ASSETS_REV` cache-buster; bump it if a static-asset
change doesn't show up in a rebuild.

---

## Verify a deploy (in order)

```bash
RELAY=https://talk2me-relay-l2a45sbrxq-uc.a.run.app

# 1) Is the relay up and on the latest build?
curl -s "$RELAY/api/health"     # -> {"ok":true,"build":"..."}

# 2) Latency since this instance started (after a few real turns)
curl -s "$RELAY/api/metrics"    # -> p50/p95 time-to-first-audio + full-turn

# 3) Is auth actually enforced? (current code replies auth_error to a bad token)
#    Pre-auth-fix code silently ignored it — this is how you tell them apart.
#    Use a WS client and send: {"type":"auth","token":"bogus"}

# 4) Hosting: hard-refresh https://talk-to-me1.web.app, sign in, press Start.
```

Then open the app in Chrome, allow the mic, and run one turn in each mode you
touched (coaching / interview / `/lbd`).

---

## Gotchas (the ones that actually bit)

**`/healthz` always 404s on Cloud Run.** The Google Front End shadows that path
before it reaches the container, even though the route exists in `server.js`. Do
**not** use it to judge whether a deploy is live — it will make a healthy relay
look dead. Use **`/api/health`** instead.

**Stale assets after a Hosting deploy.** This was a 1-hour `max-age=3600` window
(Firebase's default). `firebase.json` now sets `Cache-Control: no-cache, max-age=0`
on `*.js/*.css/*.html`, so deploys take effect immediately. If you ever see old
behavior post-deploy, confirm those headers are still present before debugging code.

**Reconnect churn / duplicate Live sessions on load.** A WebSocket can't carry an
`Authorization` header, so auth is sent **in-band** as a `{type:'auth'}` message
over the already-open socket. Don't "fix" this by reconnecting after sign-in — that
re-opens (and re-bills) two Gemini Live sessions per load.

**A turn hangs on "Thinking…".** A grounded web search can stall without ever
sending `turnComplete` or an error. The server-side watchdog (`TURN_STALL_MS`,
default 30s) re-arms the client so the user isn't stranded. If users report frequent
stalls, check relay logs for `turn stalled` and watch p95 in `/api/metrics`.

**`goAway` from the Live API.** The API signals an imminent disconnect as a
top-level `goAway` field (not inside `serverContent`). The relay surfaces it as a
recoverable error; if you see these in logs near session limits, it's the model
ending a long session, not your bug.

**Cross-project Firestore permission.** If sign-in works but credits/transcripts
fail, it's almost always the relay's Cloud Run service account missing Firestore
access in `talk2me-e90b1` (see Topology).

---

## Observability

- **Relay logs** (`gcloud run services logs read talk2me-relay --region us-central1`):
  per turn you get audio length, `⏱ first audio in Nms`, stall warnings, and
  `goAway` notices.
- **`/api/metrics`**: rolling p50/p95/min/max/avg for time-to-first-audio and
  full-turn latency on the live instance. Resets on deploy (it's a live signal,
  not an analytics store).
- **`/admin`** (email-gated via `ADMIN_EMAILS`): per-user activity, mode mix, and
  daily LbD credit usage.

---

## Cost controls in place

- Required sign-in in production (no anonymous Live sessions).
- Daily LbD credits (5/day) via an **atomic Firestore transaction**
  (`consumeLbdCredit`) — the client cannot mint credits; rules block client writes.
- Cloud Run `--timeout=1200` caps any single session.
- Turn-stall watchdog closes the loop on wedged turns.

Not yet enforced: per-user **token metering / hard caps** (the `usage/{month}`
counters are read by `/admin` but not enforced) and Stripe billing. Keep the app
gated until those land — two Live sessions per tab means ~2× native-audio cost.
See [PLAN.md](./PLAN.md).
