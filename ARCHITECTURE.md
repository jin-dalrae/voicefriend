# Talk2Me — Architecture Decisions

Why the system is built the way it is. These are the decisions a reviewer (or a
future me) would otherwise have to reverse-engineer from the code. Each one is
tied to the product reality, not to a framework preference.

## Who this is for (and why it drives the architecture)

The user is an **international student who needs conversational-English practice**
but has limited access to native speakers and doesn't want it to feel like a
tutoring session or homework. The product was shaped by user research and testing,
and a few findings drove real technical choices:

- **It has to feel like talking to friends, not a tutor.** → two distinct personas
  who reference each other, a *group* conversation, and AI that **opens** the chat
  so the user never has to start cold.
- **Latency and natural delivery matter more than transcription precision.** A
  laggy or robotic reply breaks the "friend" illusion; a slightly imperfect
  transcript does not. → **native-audio** model, **manual turn-taking**.
- **The priority is vocabulary and phrasing, not accent/pronunciation.** → the
  coaching prompt offers one high-value phrasing upgrade, not pronunciation drills.
- **Native audio is expensive, and students are price-sensitive.** → usage is
  metered with **daily credits** now, and a **paid credit/subscription tier** is
  the next phase (see "Credits & payment").

## 1. Why live audio at all — and why not just TTS

**Decision: native live audio (Gemini Live), not text-to-speech narration.**

The simplest "voice" is TTS: let the LLM write a reply, then read it aloud. We
rejected that outright, because for *conversation practice* it's the wrong shape:

- **It's narration, not conversation.** TTS reads finished text aloud — one
  direction, turn-by-turn. A friend has to hear you *as you speak*, react with
  natural timing, and be interruptible. Live audio is a real-time spoken exchange;
  TTS is a player.
- **It hears how you say it, not just the words.** Native live audio takes your
  *audio* in, so tone, hesitation, and emphasis are available to it. A TTS
  pipeline only ever sees the transcript — it throws away everything about *how*
  something was said, which is half of conversation.
- **It speaks like speech, not like read-aloud prose.** Native audio carries
  prosody, emphasis, laughter, and the rhythm/contractions/fillers of real spoken
  English — exactly what a learner needs to hear and imitate. TTS of written text
  tends to sound like an essay being recited.
- **Lower latency.** TTS waits for the LLM to finish text, then synthesizes, then
  plays. Native audio streams speech as it's produced — better time-to-first-audio,
  which is what the user actually feels (now measured in `/api/metrics`).

So live audio is non-negotiable for the product. The remaining question is *how*
to produce it: one native-audio model, or a cascaded pipeline whose last stage is
TTS.

A voice agent can be built two ways:

- **Cascaded:** speech-to-text → LLM → text-to-speech, three swappable components.
- **Native audio:** one model takes audio in and emits audio out directly.

Talk2Me uses native audio (`gemini-2.5-flash-native-audio-latest`,
`responseModalities: [AUDIO]`). Why, for *this* product:

- **Lowest latency.** No STT and TTS hops in the turn loop — the model speaks
  directly. Time-to-first-audio is what the user feels as "responsiveness," and
  it's now measured in `/api/metrics`.
- **Affective, natural delivery.** The native-audio model carries prosody and
  emotion, which sells the "two friends" feel that user testing said was essential.
- **Simpler turn loop.** One streaming connection per voice instead of wiring and
  tuning three services.

**What we give up by not going cascaded** — and where a cascaded stack (e.g. a
Deepgram-style STT/TTS pipeline) would genuinely win:

- **Transcription accuracy, custom vocabulary, word-level timestamps, and
  confidence scores.** A dedicated STT is better when exact text matters — menu
  items, proper nouns, domain jargon, captioning.
- **Component independence.** Cascaded lets you swap STT or TTS vendors, pick a
  specific voice, or self-host/run on-prem. Native audio locks you to one
  provider's live stack and its prebuilt voices.
- **Fine control over endpointing, barge-in, and interruption.**
- **Telephony.** Phone deployments (8 kHz, SIP) are a cascaded-pipeline world.
- **Cost shaping at scale** by choosing cheaper components per stage.

For Talk2Me's goal — casual conversational fluency where feel beats precision —
native audio is the right trade. For a transcription-accuracy- or telephony-driven
product, the cascaded pipeline would be the better call. **It's a product
decision, not a "better technology" decision.**

> Hybrid in practice: the relay still enables the Live model's input/output
> transcription and runs a **cheap text model (`gemini-2.5-flash`) off the hot
> path** for memory summaries, the LbD debrief, and the logic lens. Real-time =
> native audio; non-real-time analysis = a small cascaded text step. Use each
> where it's strong.

## 2. Two conversational partners, not one tutor

This is the product's defining decision, and it's about learning and safety, not
just feel:

- **Avoid the single-AI failure modes ("AI psychosis").** A lone, always-agreeable
  partner becomes a mirror: it validates whatever the user says and can foster an
  unhealthy parasocial 1:1 dependency. Two partners who have their own views,
  occasionally disagree, and reference each other break that mirror — the user is a
  participant in a group, not the fixed center of a sycophantic loop.
- **Model exemplar speech in the third person.** With two partners, the learner
  *overhears* natural English spoken between the AIs, not only English aimed at
  correcting them. This is observational learning: you pick up fluent phrasing in
  real context, lower-pressure, instead of every utterance being a correction
  pointed at you.
- **Balanced perspectives.** Two voices give two opinions, so the user isn't
  nudged toward a single "right" answer.

### How it's built

Luc and Jeenie each run in their **own** Live session with their own system
instruction and prebuilt voice. The relay picks a responder per turn and only
feeds that session audio; the other is caught up with a short text recap so it can
build on what was said. This keeps the two voices cleanly separate (no
in-band `[name]:` tag parsing) at the cost of **~2× Live usage per tab** — which is
the single biggest cost driver and the reason metering exists.

## 3. Manual turn-taking (push-to-talk), not automatic VAD

`realtimeInputConfig.automaticActivityDetection.disabled = true`. The client sends
`mic_start` → audio → `mic_end`, and the relay brackets the turn with
`activityStart` / `activityEnd`. Push-to-talk is deliberate for a practice tool:
it's predictable, avoids false triggers in noisy dorm/cafe environments, and gives
the learner control. The trade-off is no natural barge-in — acceptable here, but a
real-time phone agent would want server VAD and interruption handling instead.

## 4. Relay on Cloud Run, static app on Firebase Hosting

The browser can't hold the Gemini API key, and a Live session needs a stateful,
bidirectional stream — so a **WebSocket relay** (`server.js`, `ws`) sits in the
middle on **Cloud Run**, and the static UI is served from **Firebase Hosting**.
The relay also doubles as the trust boundary: it verifies the Firebase ID token,
enforces credits, and is the only writer to Firestore. Cloud Run's request timeout
conveniently caps the maximum length (and cost) of any single session.

## 5. In-band auth over the open socket

A WebSocket can't send an `Authorization` header, so the client sends a
`{type:'auth'}` message on the already-open socket and the relay verifies it with
the Firebase Admin SDK **before** opening any Live session. This avoids a
reconnect-after-login that would re-open (and re-bill) both Live sessions. It's a
small thing that directly protects cost.

## 6. Credits & payment (current + next)

Native audio is expensive and the audience is price-sensitive, so metering is a
first-class concern, not an afterthought:

- **Today:** each user gets **5 free LbD simulations/day**, spent through an
  **atomic Firestore transaction** (`consumeLbdCredit`) keyed by UTC day. The
  client cannot mint credits — Firestore rules block client writes; the relay is
  the only writer.
- **Next:** per-user **token/usage metering with hard caps** (the `usage/{month}`
  counters are already read by `/admin`, just not yet enforced) and a **paid
  credit / subscription tier** (Stripe). The credit primitive is intentionally
  generic so paid top-ups and tiered limits slot in without reworking the data
  model. Sequencing is **caps before billing** — never expose uncapped native-audio
  cost. See [PLAN.md](./PLAN.md).

## 7. Gemini Developer API, not Vertex AI (yet)

The relay talks to Gemini through the **Gemini Developer API** (Google AI):
`new GoogleGenAI({ apiKey: GEMINI_API_KEY })`, key in Secret Manager. The key we
have is a **Developer-API key with Live access** — a "Google Live API key" — and
that is exactly the credential the relay uses. (Vertex AI isn't an API-key surface:
its native auth is IAM / Application Default Credentials — a service account, not
that key. So "I already have a key" points to the Developer API, not Vertex.)

Why the Developer API fits this project:

- **Auth that fits a single-key relay.** One `GEMINI_API_KEY` → Secret Manager →
  Cloud Run. Vertex would need ADC / workload-identity wiring.
- **Newest native-audio Live models land here first**, including the stable
  `-latest` alias (`gemini-2.5-flash-native-audio-latest`); Vertex often trails or
  only exposes dated preview IDs.
- **Cross-project simplicity.** The relay (`raejin-35457`) already reaches Firestore
  in `talk2me-e90b1`; a key keeps model access off the project-IAM path instead of
  adding a second cross-project surface.
- **Free tier + simple per-key billing**, which suits a credit-funded prototype.

When to move to **Vertex** (a production-hardening call, not a capability one): no
long-lived API key (Cloud Run's service account calls Vertex via workload identity),
plus IAM, VPC-SC, CMEK, data residency / regional endpoints, audit logs, higher
quotas, provisioned throughput, and SLAs. Migration is cheap — same `@google/genai`
SDK: `{ apiKey }` → `{ vertexai: true, project, location }` + ADC.

## What I'd revisit

- **Responder selection** is a heuristic (lean toward switching, a little
  randomness, strict alternation in interview/LbD). A classifier that routes by
  what the user said would feel more intentional.
- **Metrics are per-instance and in-memory** (`/api/metrics`) — fine as a live
  health signal; a real SLO would push these to Cloud Monitoring.
- **Native-audio lock-in** is a known risk; the cheap-text-model split already
  keeps the analysis layer provider-flexible, and the turn loop is small enough to
  swap to a cascaded pipeline if accuracy, telephony, or self-hosting ever win.
