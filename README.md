# Talk2Me

Talk2Me is a spoken-English practice app with two AI friends, **Luc** and
**Jeenie**. The current version is a deployed prototype: Firebase Hosting serves
the web UI, and a Cloud Run relay streams microphone audio to two Gemini Live
sessions.

## Live Deployments

- Web app: `https://talk-to-me1.web.app`
- Voice relay: `https://talk2me-relay-l2a45sbrxq-uc.a.run.app`
- Relay health check: `https://talk2me-relay-l2a45sbrxq-uc.a.run.app/api/health`

The Firebase web app is in project `talk2me-e90b1`. The Cloud Run relay is in
project `raejin-35457` for now, with permission to access Talk2Me Firestore.

## Current Status

Implemented:

- Push-to-talk voice practice with Luc and Jeenie.
- Two Gemini Live sessions, one per coach voice.
- Google Search grounding in the Live sessions.
- Local profile/transcript persistence for the anonymous prototype.
- Talk2Me design system from `talk2me-app.html`.
- Firebase Hosting on the separate site `talk-to-me1`.
- Firebase Auth UI for Google sign-in and email-link sign-in.
- Firebase ID token forwarding over the established WebSocket when a user is
  signed in.
- Single resilient WebSocket connection: auth is sent in-band over the open
  socket (no reconnect churn or duplicate Live sessions on load).
- Welcome and in-call screens toggle cleanly (driven by the `hidden` attribute).
- Firebase Admin scaffolding in the relay.
- Firestore database, rules, and indexes in `talk2me-e90b1`.

Still in progress:

- Sign-in is available, but not yet required.
- The relay still supports anonymous sessions.
- Memory/history still use local `storage.js`; Firestore-backed per-user memory is next.
- Metering and hard caps are not implemented yet, so this should not be opened broadly.
- Stripe billing is not implemented yet.

See [PLAN.md](./PLAN.md) for the full phased rollout.

## Architecture

```
Firebase Hosting (talk-to-me1.web.app)
  static HTML/CSS/JS
  Firebase Web SDK auth
  WSS -> Cloud Run relay

Cloud Run (talk2me-relay)
  Express static/API server
  ws relay at /ws
  Gemini Live sessions for Luc + Jeenie
  optional Firebase ID-token verification
  Firestore access prepared for Phase 1

Firestore (talk2me-e90b1)
  users/{uid}
  users/{uid}/coaches/{coachId}
  users/{uid}/sessions/{sessionId}/messages/{msgId}
  users/{uid}/usage/{period}
  plans/{tier}
```

## Local Setup

Requirements:

- Node.js 18+
- Chrome or another Chromium browser for microphone + AudioWorklet support
- Gemini API key from Google AI Studio

```bash
npm install
cp .env.example .env
```

Fill in `GEMINI_API_KEY` in `.env`.

Run locally:

```bash
npm start
```

Open `http://localhost:3000`.

## Environment

```env
GEMINI_API_KEY=your-key-here

# Optional
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-latest
LUC_VOICE=Puck
JEENIE_VOICE=Kore
PORT=3000

# Firebase Admin / auth gate
FIREBASE_PROJECT_ID=talk2me-e90b1
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
REQUIRE_FIREBASE_AUTH=0
OPTIONAL_AUTH_TIMEOUT_MS=5000

# Local prototype persistence
LOG_TO_FILE=1
LOG_TRANSCRIPTS=0
REMEMBER=1
```

When `REQUIRE_FIREBASE_AUTH=0`, token verification is best-effort and falls back
to anonymous mode if verification times out. Set `REQUIRE_FIREBASE_AUTH=1` only
after the relay is fully Firestore-backed and token verification is confirmed in
Cloud Run.

## Deploy

Deploy the Cloud Run relay:

```bash
npm run deploy:cloud-run
```

Deploy the separate Firebase Hosting site:

```bash
firebase deploy --project talk2me-e90b1 --only hosting
```

Deploy Firestore rules/indexes only:

```bash
firebase deploy --project talk2me-e90b1 --only firestore:rules,firestore:indexes
```

Do not deploy this app to the Raejin Firebase Hosting site.

## Key Files

```text
server.js                  Express + WebSocket relay
auth.js                    Firebase Admin initialization and ID-token verification
db.js                      Firestore helper scaffolding
prompt.js                  Luc and Jeenie personas
storage.js                 Local prototype transcript/profile persistence
config.js                  Model, voice, and port config
public/index.html          Talk2Me UI shell and Firebase web config
public/app.js              WebSocket, mic capture flow, transcript rendering
public/firebase-client.js  Firebase Web SDK auth UI/token helper
public/capture-worklet.js  AudioWorklet microphone capture
public/style.css           Talk2Me design system styles
firebase.json              Firebase Hosting/Firestore config for talk-to-me1
firestore.rules            Firestore access rules
Dockerfile                 Cloud Run image
scripts/deploy-cloud-run.sh
```

## Notes

Two Live sessions per browser tab means roughly 2x Live API usage. Native-audio
Live is expensive enough that metering and hard caps must ship before broad
signup or paid launch.
