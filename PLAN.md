# Talk2Me — Build Plan

> From a single-user voice prototype to a B2C SaaS for spoken-English practice.

## Context

The current app is a working **single-user** voice English-practice tool: a Node + `ws`
relay holds one shared `GEMINI_API_KEY`, opens **two** Gemini Live sessions (one per coach),
routes push-to-talk turns, and persists a profile + transcript to **local disk**
(`storage.js`). It has no accounts, no metering, no billing, and runs on plain HTTP.

**Talk2Me** turns this into a real product for international students who lack regular
spoken-English practice — two AI friends who chat, web-search, know each other, give balanced
opinions, and start conversations themselves.

### Locked decisions

| Area | Decision |
|---|---|
| Cost model | Owner pays for Gemini; **every user is metered and hard-capped** by tier |
| Backend | Firebase **Auth + Firestore**; voice relay on **Cloud Run** |
| Auth | Firebase Auth — **Google sign-in + email magic link** |
| Billing | **Stripe** subscriptions in v1; tier sets the usage cap |
| Frontend | **React + Vite** |
| Sequencing | **Caps before Stripe** (Phases 0–3, then 4) |
| Customization | Per-user coach names / personalities / voices |

### Why these constraints drive the design

- Native-audio Live is **expensive per minute**, and each user runs **two** simultaneous
  sessions → per-user budget enforcement is load-bearing, not optional. **Caps must ship
  before any open signup.**
- A persistent WebSocket relay **cannot** run on Cloud Functions → it needs **Cloud Run**.
- Mic capture requires **HTTPS** in production.

**Verified against the live API this session:** the Live API streams `usageMetadata` per
message with `totalTokenCount` + `responseTokensDetails` (per-modality audio/text breakdown)
— the metering primitive everything hinges on.

---

## Target architecture

```
Browser (Firebase JS SDK: auth + Firestore reads)
  │   1. Sign in (Google / magic link) → Firebase ID token
  │   2. Read own profile / coach config / usage from Firestore (locked by security rules)
  │   3. Stripe Checkout / Customer Portal (redirect)
  │
  ├──(HTTPS) Firebase Hosting ── static React frontend (landing, auth, onboarding, app, settings)
  │
  ├──(WSS) Cloud Run relay ── verifies ID token (firebase-admin) on connect,
  │        loads user's coach config + remaining budget from Firestore,
  │        opens 2 Gemini Live sessions, meters usageMetadata per turn,
  │        enforces cap mid-session, writes usage + transcript + memory back to Firestore
  │
  └──(HTTPS) Cloud Run API (same service, Express routes) ── Stripe checkout,
           Stripe webhook → sync subscription/tier → Firestore
```

One Cloud Run service hosts both the Express HTTP routes (Stripe) and the `/ws` WebSocket
relay — reuses today's single-process `server.js` shape.

### Proposed repo layout (monorepo)

```
talk2me/
  server/    Cloud Run: Express + ws relay + Stripe routes
    server.js          multi-tenant relay (evolved from today's server.js)
    prompt.js          data-driven personas (evolved)
    config.js          model, plan/cap config, global ceiling
    db.js              Firestore data access (replaces storage.js)
    auth.js            Firebase ID-token verification
    metering.js        usage accounting + cap checks
    billing.js         Stripe checkout / webhook / portal
    Dockerfile
  web/       Vite + React frontend
    src/ (pages: landing, auth, onboarding, app, settings; firebase client init)
  firestore.rules
  firestore.indexes.json
  firebase.json
  SETUP.md   interactive account-setup checklist
  PLAN.md    this document
```

---

## Firestore data model

```
users/{uid}
  email, displayName, createdAt, onboarded:bool
  tier: "free" | "starter" | "pro"          // mirrored from subscription
  stripeCustomerId, stripeSubscriptionId, subscriptionStatus
  profile: { name, summary, goals[], interests[], facts[] }   // the AI memory (was profile.json)

users/{uid}/coaches/{coachId}            // exactly two docs (replaces hardcoded Luc/Jeenie)
  name, gender, voice (Gemini voice name), personaPrompt, order:0|1

users/{uid}/usage/{period}               // period = "2026-06" monthly bucket
  tokensUsed, secondsUsed, turns, capTokens, updatedAt

users/{uid}/sessions/{sessionId}
  startedAt, endedAt, mode, tokensUsed, secondsUsed

users/{uid}/sessions/{sessionId}/messages/{msgId}
  speaker ("You"|coachId), text, ts        // transcript (was transcript.jsonl)

plans/{tier}        // server-readable config: capTokens, priceId, displayName, features[]
```

**Security rules:** a user can read/write only their own `users/{uid}/**`. `plans/**` is
read-only to clients. **`usage`, `tier`, and subscription fields are written only by the
relay/webhook via firebase-admin (which bypasses rules)** — clients may read but never write
them (prevents users from raising their own cap). Messages/profile are client-readable (for
settings UI) but written server-side during sessions.

---

## Key flows

### Auth & token
- Frontend uses the **Firebase JS SDK** for sign-in and direct Firestore reads of the user's
  own data (rules enforce isolation).
- To open the voice socket, the browser passes its **Firebase ID token** (`getIdToken()`).
  The relay calls `admin.auth().verifyIdToken(token)` → `uid`; reject if invalid/expired.
- The relay uses **firebase-admin** (service account) for all writes, bypassing client rules.

### Relay (evolve `server.js`, reuse the `Conversation` class)
1. On WS connect: verify token → `uid`; load `profile`, the two `coaches/*`, and current
   `usage/{period}` → remaining budget.
2. Reject early if over cap → `{type:'cap_reached'}`, close.
3. Build personas **from Firestore** (data-driven `buildSystemInstruction`), voices per coach.
4. Meter: read `usageMetadata.totalTokenCount` per turn; batch-flush to `usage/{period}`
   (Firestore increment) every N turns / on disconnect.
5. Mid-session cap: pre-check before each `mic_start` with a small reserve; on exceed, send
   `cap_reached` and stop accepting turns (let the current reply finish).
6. Persistence: append messages to `sessions/{id}/messages`; on disconnect run the existing
   `generateContent` summarizer → write `users/{uid}.profile`.

Reused as-is: two-session setup, manual-VAD push-to-talk, responder routing, cross-coach
catch-up, Google Search grounding, greeting/opener, audio relay framing.

### Metering & caps
- **Unit:** tokens (`usageMetadata.totalTokenCount`); also log `secondsUsed` for display.
- **Cap source:** `plans/{tier}.capTokens` copied onto `usage/{period}.capTokens`.
- **Enforce at:** (a) connect, (b) per-turn pre-check w/ reserve, (c) hard stop →
  `cap_reached` → "upgrade" CTA.
- **Safeguard:** a global daily spend ceiling (env var) the relay refuses to exceed across
  all users.

### Stripe
- `plans/{tier}` holds Stripe `priceId` + `capTokens`.
- `POST /api/checkout` → Checkout Session for the chosen price.
- `POST /api/stripe/webhook` → on subscription events, write `tier`/`subscriptionStatus` to
  `users/{uid}` and reset cap. **Webhook is the only source of truth for tier.**
- `POST /api/portal` → Stripe billing portal for self-serve manage/cancel.

### Frontend (React + Vite, served by Firebase Hosting)
- **Landing** `/` — pitch + sign-up.
- **Auth** `/auth` — Google + magic link.
- **Onboarding** `/onboarding` — goals/level/interests → seed profile; name & shape the two
  coaches (name, gender, voice audition, personality) → write `coaches/*`; `onboarded=true`.
- **App** `/app` — reuse the existing voice UI (`app.js` + `capture-worklet.js`); WS points
  at Cloud Run with the ID token; coach names/colors from Firestore; live usage meter.
- **Settings** `/settings` — view/edit AI memory, view/delete history, regenerate/forget
  memory, edit coaches, usage + plan, manage subscription (portal).

---

## Phased rollout (smallest-first, each phase independently testable)

| Phase | Ships | Verify |
|---|---|---|
| **0 — Scaffolding & secrets** | Monorepo restructure; Firebase project; Auth providers + Firestore enabled; Stripe test mode; Cloud Run skeleton; SETUP.md | A hello WS echoes after verifying an ID token |
| **1 — Auth + multi-tenant relay** *(no billing/caps)* | Firebase Auth UI; relay verifies token, Firestore-backed profile + transcript (retire `storage.js`); data-driven personas | Two accounts get isolated memory/history; a real voice session works over WSS |
| **2 — Onboarding + coach customization** | Onboarding seeds profile + two coach docs; voice audition; app reads coach config | New user names coaches and hears chosen voices |
| **3 — Metering + caps** | `usageMetadata` → `usage/{period}`; usage meter; connect + per-turn cap enforcement; global daily ceiling | Tiny cap triggers `cap_reached` mid-session; usage matches API tokens |
| **4 — Stripe subscriptions** | Plans in Firestore; checkout; webhook → tier → cap; portal; billing UI | Test mode: subscribe raises cap; portal cancel downgrades |
| **5 — Settings/data mgmt + hardening** | Edit/forget memory; delete history; account deletion; rate limiting; error states; prod secrets; rules audit | Full self-serve data lifecycle; rules deny cross-user access |

---

## Tiers & caps (placeholders — tune after measuring real token cost)

| Tier | Price | Allowance |
|---|---|---|
| Free trial | $0 | ~15 min / month |
| Starter | ~$12 / mo | ~120 min / month |
| Pro | ~$29 / mo | ~400 min / month |

Stored in `plans/{tier}` (Stripe `priceId` + `capTokens`); minutes → token budget once
measured. Real prices/caps confirmed before launch.

---

## Biggest risks / safeguards

- **Runaway cost** → per-user caps (Phase 3) + global daily ceiling + min-instances limits.
  Caps must ship before any open signup.
- **Cap bypass** → tier/usage writable only server-side; never trust the client.
- **WebSocket on serverless** → Cloud Run (not Functions); tune concurrency/timeouts for
  long-lived sockets.
- **Token→cost mapping** → confirm current native-audio token pricing before setting caps;
  keep caps conservative at launch.
- **Stripe/Firestore drift** → webhook is the single source of truth for tier.

---

## What needs *your* interactive login (can't be automated)

These require your Google/Stripe credentials — they'll go in `SETUP.md` as copy-paste steps:

- `firebase login` + create the Firebase project; enable Google + Email-link Auth and
  Firestore.
- `gcloud auth login` + enable Cloud Run; deploy the relay service.
- Create a Stripe account (test mode), products/prices, and webhook secret.
- Provide secrets: `GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  firebase-admin service-account JSON.

Everything else (all code, Firestore rules, local emulator testing) is automated.

---

## Status

### Done

- [x] Current single-user prototype works locally with the existing Express + `ws` relay.
- [x] Cloud Run deployment packaging added:
  - `Dockerfile`
  - `.dockerignore`
  - `scripts/deploy-cloud-run.sh`
  - `npm run deploy:cloud-run`
- [x] Health endpoints added:
  - `/healthz`
  - `/api/health`
- [x] `SETUP.md` added with the current deployment path.
- [x] Google Cloud project `raejin-35457` prepared for the prototype deploy:
  - Cloud Run / Cloud Build / Artifact Registry / Secret Manager APIs enabled
  - `gemini-api-key` created in Secret Manager
  - Cloud Run runtime service account granted access to that one secret
- [x] Prototype deployed to Cloud Run:
  - Service: `talk2me-relay`
  - Region: `us-central1`
  - URL: `https://talk2me-relay-l2a45sbrxq-uc.a.run.app`
  - Verified: `/api/health` returns `{"ok":true}`
- [x] Applied the `talk2me-app.html` design system to the current prototype UI:
  - dark phone-shell layout
  - `talk2me` wordmark and Luc/Jeenie identity colors
  - welcome screen with optional first-name field
  - pill mode toggle
  - avatar-labelled coach bubbles
  - redesigned push-to-talk footer
- [x] Local Firebase scaffolding added:
  - `firebase.json`
  - `.firebaserc`
  - `firestore.rules`
  - `firestore.indexes.json`
- [x] Firebase Hosting config separated from Raejin project:
  - default Firebase project changed to `talk2me-e90b1`
  - Hosting rewrites are static-only
  - hosted frontend connects to Cloud Run through explicit `TALK2ME_WS_URL`
- [x] Separate Firebase Hosting site deployed:
  - Project: `talk2me-e90b1`
  - URL: `https://talk-to-me1.web.app`
  - Verified live HTML includes `TALK2ME_WS_URL`
- [x] Fixed and redeployed the welcome/start flow on `talk-to-me1.web.app`:
  - backend readiness is tracked with `wsReady`
  - first Start click enables the call controls when the relay is already ready
- [x] Phase 1 auth scaffolding started without breaking anonymous prototype use:
  - `firebase` and `firebase-admin` dependencies installed
  - `auth.js` initializes Firebase Admin lazily
  - relay can verify Firebase ID tokens from `?token=...`
  - `REQUIRE_FIREBASE_AUTH=1` will enforce sign-in later
  - `db.js` added for initial Firestore user/session helpers
- [x] Optional browser sign-in UI added and deployed:
  - Firebase Web SDK initialized from the `talk2me-e90b1` config
  - Google sign-in button
  - email-link sign-in button
  - signed-in users send ID tokens over the established WebSocket
  - deployed to `https://talk-to-me1.web.app`
- [x] Talk2Me Firestore created and secured:
  - Project: `talk2me-e90b1`
  - Database: `(default)` Firestore Native in `nam5`
  - `firestore.rules` deployed
  - `firestore.indexes.json` deployed
- [x] Cloud Run relay prepared for cross-project Firestore access:
  - Runtime service account `267981036962-compute@developer.gserviceaccount.com`
  - Granted `roles/datastore.user` on `talk2me-e90b1`
- [x] Firebase Auth is available for `talk2me-e90b1`:
  - Google sign-in provider available
  - Email-link sign-in available
- [x] Authenticated deployed voice loop verified:
  - `.env` test account signs in through Firebase Auth REST API
  - browser-style WebSocket auth message returns `auth_ok`
  - relay reaches `ready`
  - opener completes
  - synthesized speech sample streams through `/ws`
  - coach response returns audio and transcript
  - tokens are not sent in WebSocket URLs
- [x] Fixed two frontend bugs on `talk-to-me1.web.app` (commit `92130d2`):
  - WebSocket reconnect churn: Firebase's initial `onAuthStateChanged` no longer
    tears down the fresh socket. Auth is re-sent in-band over the open socket
    instead, removing the "Disconnected. Reconnecting…" flash and the throwaway
    second pair of Gemini Live sessions opened on every page load.
  - Overlapping screens: `.welcome, .call { display: flex }` was overriding the
    `[hidden]` attribute, so both screens rendered at once. Added
    `.welcome[hidden], .call[hidden] { display: none }` so the welcome and
    in-call screens toggle correctly.
  - Verified live against the deployed relay with a clean-cache browser: clean
    single connection (no flash), and the two screens toggle as expected.
  - Note: hosting assets cache for 1h (Firebase default); returning visitors may
    see the old build until revalidation.

- [x] Phase 1 — Auth + multi-tenant Firestore-backed relay (shipped):
  - sign-in is now **required**; relay sends `need_auth` and opens no Live
    session until the in-band `{type:'auth'}` token verifies (`REQUIRE_FIREBASE_AUTH=1`)
  - relay verifies the Firebase ID token with `firebase-admin`, then loads/creates
    the user's Firestore record (`ensureUser`) and seeds memory from it
  - per-user profile + session transcripts in Firestore replace local `storage.js`
    for signed-in users; profile summary is written back on disconnect
  - frontend gates "Start" behind sign-in, drops the optional name field, and
    uses the account name (email-link users are asked once)
  - verified on a no-traffic candidate revision with a test account: gate holds,
    valid token → opener + audio, `users/{uid}` + session messages written, then
    flipped 100% traffic to the required-auth revision

### Still left before this is a SaaS

- [ ] Phase 0 remainder — real product scaffolding:
  - Stripe test-mode account/products/prices
- [ ] Phase 1 follow-ups:
  - prove two users have fully isolated profile/transcript state (spot-checked, not exhaustive)
- [ ] Phase 2 — Onboarding + coach customization UI:
  - React + Vite frontend using the applied `talk2me-app.html` design system
  - onboarding flow
  - per-user coach names, voices, and persona prompts
  - app reads coach config from Firestore
- [ ] Phase 3 — Metering + hard caps:
  - capture Gemini Live `usageMetadata`
  - write monthly usage buckets
  - enforce per-user caps on connect and per turn
  - global daily spend ceiling
  - usage meter in the UI
- [ ] Phase 4 — Stripe subscriptions:
  - checkout
  - webhook subscription sync
  - plan/tier updates in Firestore
  - customer portal
- [ ] Phase 5 — Settings/data management + launch hardening:
  - edit/forget memory
  - delete history
  - account deletion
  - rate limiting
  - production error states
  - security rules audit
