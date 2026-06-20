# Talk2Me

> A sample **product-engineering project**: a real-time **voice agent** for end users,
> built end-to-end on the **Google Cloud Platform ecosystem** (Gemini Live, Cloud Run,
> Firebase Hosting/Auth, Cloud Firestore, Secret Manager, Cloud Build).

Talk2Me lets a user hold a *spoken* conversation with AI personas that talk back in real,
native voices. It started as a tool for international students to practice conversational
English with two AI friends — **Luc** and **Jeenie** — and grew a second surface,
**Learn-by-Doing**, a spoken flight simulator for workplace leadership.

This repo is intentionally small and readable. It shows how the pieces of a production-shaped
voice product fit together — low-latency audio streaming, multi-tenant auth, durable
per-user state, usage credits, and an admin console — without a heavy framework getting in
the way.

- **Web app:** https://talk-to-me1.web.app
- **Voice relay:** https://talk2me-relay-l2a45sbrxq-uc.a.run.app
- **Relay health:** https://talk2me-relay-l2a45sbrxq-uc.a.run.app/api/health

---

## What this project demonstrates

If you are reading this as a reference for building voice agents on Google Cloud, these are
the patterns worth borrowing:

- **Real-time native-audio agents over the Gemini Live API.** The browser streams 16 kHz PCM
  to a relay; the relay opens **two** Gemini Live sessions (one voice per persona) and streams
  24 kHz audio back. No TTS workaround — the model speaks directly.
- **A WebSocket relay on Cloud Run** that keeps the Gemini API key server-side and brokers
  audio both ways. Cloud Run's request timeout doubles as a hard ceiling on any single live
  session.
- **In-band auth over the open socket.** A Firebase ID token is sent *as a message* on the
  already-connected WebSocket and verified by the Firebase Admin SDK — so there is no reconnect
  churn and no duplicate Live sessions on load.
- **Multi-tenant state in Firestore.** Each signed-in user gets a profile, transcripts, saved
  coaches, and usage counters. Coaches greet you by name and remember you across sessions.
- **Usage credits enforced server-side.** Daily Learn-by-Doing simulations are spent through an
  atomic Firestore transaction — a worked example of metering an expensive AI feature.
- **A second agent shape from the same engine.** The same relay/`Conversation` class powers a
  role-play "flight simulator" with a live reasoning lens and a structured debrief — showing how
  one voice backbone can serve very different products.
- **An operator surface.** An `/admin` console aggregates per-user activity, mode mix, and credit
  usage for whoever runs the platform.

---

## The product, in two surfaces

### 1. Talk2Me — spoken conversation practice (`/`)

Two AI friends, **Luc** (upbeat, keeps it flowing) and **Jeenie** (calm, sharpens your
phrasing), share one group conversation: they know each other exists, build on each other, can
**search the web** for current facts, and **open the conversation themselves** so you never have
to start cold. The priority is expressing yourself with more natural vocabulary — not accent
drilling.

Modes:

- **Coaching** — friendly "sandwich" feedback: react warmly, offer one high-value phrasing
  upgrade, invite you to try it.
- **Free chat** — just a flowing conversation, no drills.
- **Interview drill** — a two-person mock-interview panel that tailors questions to a pasted job
  description and résumé (the résumé is saved to your account).

### 2. Learn-by-Doing — a leadership flight simulator (`/lbd`)

A spoken simulator for **lateral leadership** — influence *without* authority. You play a design
leader; AI counterparts (PMs, engineers, execs) push back in character in real time. It includes:

- a **live logic lens** that flags, turn by turn, whether you argued from evidence and interests
  or slid into fallacies and pressure;
- a structured **debrief** (spoken and written) that reports your mix across the five
  **Thomas-Kilmann** conflict styles and scores feedback against **SBI / AID / Radical Candor**;
- a **trends dashboard** (`/lbd/trends`) across past sessions;
- **daily credits** (5 free/day) enforced atomically in Firestore;
- a **frameworks guide** (`/about`) explaining the design rationale behind every scenario.

---

## Why it's built this way

The product was shaped by user research with international students, and a few findings drove
the core technical decisions (the full decision log is in [ARCHITECTURE.md](./ARCHITECTURE.md)).

### Live audio, not TTS

The simplest "voice" would be text-to-speech: let the model write a reply, then read it aloud.
Talk2Me deliberately doesn't do that. For *conversation practice*, TTS is the wrong shape:

- **It's a conversation, not narration.** TTS reads finished text aloud — one direction,
  turn-by-turn. A friend has to hear you *as you speak*, react with natural timing, and be
  interruptible. Native live audio is a real-time spoken exchange; TTS is a player.
- **It hears *how* you say it, not just the words.** A native-audio model takes your audio in,
  so tone, hesitation, and emphasis are available to it. A TTS pipeline only ever sees the
  transcript — it throws away everything about *how* something was said, which is half of
  real conversation.
- **It speaks like speech, not recited prose.** Native audio carries prosody, emphasis,
  laughter, and the rhythm/contractions/fillers of natural spoken English — exactly what a
  learner needs to hear and imitate. TTS of written text tends to sound like an essay read aloud.
- **Lower latency.** A TTS pipeline waits for the model to finish text, then synthesizes, then
  plays. Native audio streams speech as it's produced — better **time-to-first-audio**, which is
  what the user actually feels (and what `/api/metrics` now measures).

So the relay uses a **native-audio model** (`gemini-2.5-flash-native-audio-latest`), not an
LLM-to-TTS pipeline. (A cheap text model still runs *off* the hot path for memory summaries and
the LbD debrief/logic lens — real-time work uses native audio, non-real-time analysis uses text.)

### Two friends, not one tutor

- **Avoid the single-AI failure modes ("AI psychosis").** A lone, always-agreeable partner
  becomes a mirror that validates whatever the user says and invites parasocial 1:1 dependency.
  Two partners who have their own views, occasionally disagree, and reference each other break
  that mirror — the user is a participant in a group, not the fixed center of a sycophantic loop.
- **Model exemplar speech in the third person.** With two partners, the learner *overhears*
  natural English spoken between the AIs, not only English aimed at correcting them —
  observational learning, lower-pressure than constant correction.

### Metering is first-class

Native audio is expensive and students are price-sensitive, so usage is capped (daily credits
today; token caps and paid tiers next) rather than bolted on later. Sequencing is **caps before
billing** — never expose uncapped native-audio cost. The cost model and credit/subscription
structure (grounded in the real native-audio rates) are in [PRICING.md](./PRICING.md).

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│   • static HTML/CSS/JS (no framework)                              │
│   • AudioWorklet mic capture → 16 kHz PCM                          │
│   • Firebase Web SDK (Google + email-link sign-in)                │
└───────────────┬───────────────────────────────┬───────────────────┘
                │ HTTPS (static assets)          │ WSS  /ws  (audio + JSON)
                ▼                                 ▼
   ┌────────────────────────┐        ┌──────────────────────────────────┐
   │ Firebase Hosting       │        │ Cloud Run — talk2me-relay        │
   │ site: talk-to-me1      │        │  • Express static/API + ws relay │
   │ serves public/         │        │  • verifies Firebase ID token     │
   └────────────────────────┘        │  • Conversation class per tab     │
                                      │  • 2 × Gemini Live sessions       │
                                      │  • Google Search grounding        │
                                      │  • cheap gemini-2.5-flash for     │
                                      │    profile/debrief/logic lens     │
                                      └──────┬──────────────┬────────────┘
                                             │              │
                              ┌──────────────▼──┐   ┌───────▼──────────────┐
                              │ Gemini Live API │   │ Cloud Firestore      │
                              │ (Google AI)     │   │ project: talk2me-e90b1│
                              │ native audio    │   │ users / sessions /    │
                              └─────────────────┘   │ lbd_sessions / usage  │
                                                     └───────────────────────┘
   Secret Manager → GEMINI_API_KEY        Cloud Build + Artifact Registry → image
```

The relay lives in GCP project **`raejin-35457`**; Hosting, Auth, and Firestore live in the
Firebase project **`talk2me-e90b1`**. The relay has permission to access Talk2Me Firestore
across projects.

> Note: this uses the **Gemini Developer API (Google AI)**, *not* Vertex AI.

---

## Google Cloud building blocks

| Concern | Service | Where |
| --- | --- | --- |
| Native-audio agent | **Gemini Live API** (`@google/genai`, `gemini-2.5-flash-native-audio-latest`) | `server.js`, `config.js` |
| Text reasoning (profile, debrief, logic lens) | **Gemini** `gemini-2.5-flash` | `server.js`, `public/lbd-frameworks.js` |
| Grounding | **Google Search** tool on the Live session | `server.js` |
| Voice relay host | **Cloud Run** (`talk2me-relay`, `us-central1`) | `Dockerfile`, `scripts/deploy-cloud-run.sh` |
| Static web app | **Firebase Hosting** (site `talk-to-me1`) | `firebase.json`, `public/` |
| Identity | **Firebase Authentication** (Google + email-link) | `public/firebase-client.js`, `auth.js` |
| Token verification | **Firebase Admin SDK** | `auth.js` |
| Durable user data | **Cloud Firestore** | `db.js`, `firestore.rules` |
| API key storage | **Secret Manager** (`gemini-api-key`) | `scripts/deploy-cloud-run.sh` |
| Build & registry | **Cloud Build** + **Artifact Registry** (source deploy) | `Dockerfile` |

---

## Voice round-trip (how a turn works)

1. User taps to talk. An **AudioWorklet** captures the mic and posts 16 kHz mono PCM frames.
2. `public/app.js` sends `mic_start`, a stream of `audio` messages, then `mic_end` over the
   single `/ws` connection.
3. The relay forwards audio into the active **Gemini Live** session(s). When the model replies,
   the relay streams 24 kHz audio chunks back, which the browser plays.
4. If a coach turn stalls (e.g. a grounded web search hangs with no `turnComplete`), a server-side
   watchdog (`TURN_STALL_MS`) re-arms the client so the user is never stranded.
5. After the session, a cheap text model folds durable facts into the user's saved Firestore
   profile (so coaches remember you next time).

---

## Local setup

Requirements: **Node.js 18+** and a Chromium browser (for mic + AudioWorklet), plus a Gemini API
key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
npm install
cp .env.example .env      # then fill in GEMINI_API_KEY
npm start                 # or: npm run dev  (node --watch)
```

Open http://localhost:3000.

Locally you can run **without** Firebase (`REQUIRE_FIREBASE_AUTH=0`): persistence falls back to
the filesystem (`data/profile.json`, `data/transcript.jsonl`) via `storage.js`. Production runs
with auth required and Firestore-backed state.

### Environment

```env
# Required
GEMINI_API_KEY=

# Optional model/voice/port overrides (defaults shown)
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-latest
LUC_VOICE=Puck
JEENIE_VOICE=Kore
PORT=3000

# Firebase Admin / auth gate
FIREBASE_PROJECT_ID=talk2me-e90b1
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}   # or use ADC on Cloud Run
REQUIRE_FIREBASE_AUTH=0          # 1 in production
OPTIONAL_AUTH_TIMEOUT_MS=5000

# Who can load /admin and /api/admin/* (comma-separated emails)
ADMIN_EMAILS=dalrae.jin.work@gmail.com

# Re-arm the client if a coach turn produces no output for this long (ms)
TURN_STALL_MS=30000

# Local-only prototype persistence
LOG_TO_FILE=1        # data/transcript.jsonl
LOG_TRANSCRIPTS=0    # also print transcripts to the console
REMEMBER=1           # remember the user across sessions in data/profile.json
```

On Cloud Run the key comes from Secret Manager and credentials come from
Application Default Credentials, so you do not set `GEMINI_API_KEY` or
`FIREBASE_SERVICE_ACCOUNT_JSON` by hand. See [SETUP.md](./SETUP.md) for the one-time
Google Cloud setup (enabling APIs, creating the secret, granting IAM).

---

## Deploy

```bash
# Relay → Cloud Run (source build via Dockerfile; injects the secret; sets auth on)
npm run deploy:cloud-run

# Static web app → Firebase Hosting (separate site talk-to-me1)
firebase deploy --project talk2me-e90b1 --only hosting

# Firestore rules / indexes only
firebase deploy --project talk2me-e90b1 --only firestore:rules,firestore:indexes
```

The Cloud Run deploy sets `REQUIRE_FIREBASE_AUTH=1` explicitly so a `--source` redeploy can never
silently fall back to anonymous access, and uses `--timeout=1200` as a 20-minute hard ceiling on
any single WebSocket/live session (a Gemini cost safety net — daily usage is capped separately via
LbD credits).

> Do **not** deploy this app to the Raejin Firebase Hosting site — Hosting belongs to
> `talk-to-me1`.

**Caching:** `firebase.json` sets `Cache-Control: no-cache, max-age=0` on `.js/.css/.html`, so
deploys take effect immediately (no stale-asset window).

---

## Firestore data model

```
users/{uid}
  email, tier, onboarded, resume, profile{ name, summary, goals[], interests[], facts[] }
  ├── coaches/{coachId}                         per-user coach customization (Phase 2)
  ├── sessions/{sessionId}                       mode, startedAt
  │     └── messages/{msgId}                     transcript turns
  ├── lbd_sessions/{id}                          debrief, conflict-style mix, scenario, exchangeCount
  └── usage/{period}                             lbd-YYYY-MM-DD (daily credits) · YYYY-MM (token usage)
```

Client writes are blocked by `firestore.rules`; all writes go through the relay (server-only),
including the atomic daily-credit transaction in `consumeLbdCredit`.

---

## Routes & API

| Path | Purpose |
| --- | --- |
| `/` | Talk2Me conversation app |
| `/lbd` | Learn-by-Doing simulator |
| `/lbd/trends` | LbD trends dashboard |
| `/about` | Frameworks & design-rationale guide |
| `/admin` | Platform admin console (email-gated) |
| `GET /api/health` | Liveness (`{"ok":true}`) — **use this, not `/healthz`** (the GFE shadows `/healthz`) |
| `GET /api/lbd/credits` | Caller's remaining daily LbD credits |
| `GET /api/lbd/trends` | Caller's LbD history aggregates |
| `GET /api/admin/check` | Whether the caller is an admin |
| `GET /api/admin/overview` | All-users overview (admin only) |
| `GET /api/admin/users/:uid` | Per-user detail (admin only) |
| `WS /ws` | Audio + control messages; auth sent in-band |

---

## Repository layout

```text
server.js                  Express + WebSocket relay; Gemini Live sessions; LbD orchestration
config.js                  Model, voice, port, and audio-format constants
prompt.js                  Luc/Jeenie personas, mode rules, interview + LbD system instructions
auth.js                    Firebase Admin init, ID-token verification, admin Firestore handle
db.js                      Firestore helpers: users, sessions, lbd_sessions, credits, admin queries
storage.js                 Local (filesystem) profile/transcript fallback for dev
Dockerfile                 Cloud Run image (node:22-slim)
firebase.json              Hosting site talk-to-me1, route rewrites, cache headers, Firestore config
firestore.rules            Server-only writes; per-user read scoping
scripts/deploy-cloud-run.sh  gcloud run deploy with secret + env wiring

public/
  index.html               Talk2Me UI shell + Firebase web config + WS URL
  app.js                   WebSocket client, mic capture flow, transcript rendering
  capture-worklet.js       AudioWorklet microphone capture
  firebase-client.js       Firebase Web SDK auth UI + token helper
  lbd.html / lbd.js / lbd.css            Learn-by-Doing simulator UI
  lbd-frameworks.js        Conflict styles, feedback models, debrief/logic-lens prompts (shared with relay)
  lbd-trends.html / lbd-trends.js        Trends dashboard
  lbd-session-panel.js / lbd-credits.js  LbD session panel + credit display
  about.html / about.js    Frameworks & rationale guide
  admin.html / admin.js / admin-nav.js   Platform admin console
  style.css                Talk2Me design system
```

---

## Cost & safety

Native-audio Live is expensive, and Talk2Me runs **two** Live sessions per tab (~2× usage). The
guardrails in place today:

- **Required sign-in** in production (no anonymous Live sessions).
- **Daily LbD credits** (5/day) enforced via an atomic Firestore transaction.
- **Cloud Run request timeout** (1200s) caps any single live session.
- **Turn-stall watchdog** prevents wedged sessions from hanging open.

Still on the roadmap before broad/paid launch: per-user **token metering and hard caps**
(the `usage/{month}` counters are currently read by `/admin` but not yet enforced) and **Stripe**
billing. The minute-credit primitive (`consumeMinutes` / `getMinuteBalance` / `addTopupMinutes`)
is in `db.js`; the cost model and plans are in [PRICING.md](./PRICING.md), and the full phased
rollout is in [PLAN.md](./PLAN.md).
