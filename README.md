# voicefriend

Practice spoken English with two AI friends — **Luc** and **Jeenie** — over the
Gemini Live API. They talk with you in their own real voices, keep the
conversation going as a group, look things up on the web when needed, and gently
upgrade your vocabulary so you can express yourself more clearly.

- **Luc** (upbeat, energetic) keeps the conversation flowing and cheers you on.
- **Jeenie** (calm, sharp) notices your word choices and offers better, more
  natural phrasings — then nudges you to try them.

Each turn, one of them replies in their own native voice. They know what each
other and you have said, so it feels like three friends talking together.

## What it does

- 🎙️ **Real two-way voice** over the Gemini Live API (native audio — it hears
  *how* you say things, not just the words).
- 👥 **Two distinct voices.** The Live API allows one voice per session, so we
  run **two sessions** (one per character) and route each turn to one of them.
- 🧠 **Shared memory between the coaches.** The server keeps the running
  conversation and quietly catches each coach up on what it missed before it
  replies — so they build on each other and the conversation flows.
- 🔎 **Web search.** Luc and Jeenie can look up real, current facts (news,
  weather, word meanings, natural phrasings) and weave them into the chat.
- 🎯 **Two modes:** **Coaching** (validate → suggest a better phrasing → ask you
  to try it) and **Free chat** (just talk, with the occasional natural upgrade).
- 🎬 **Random opener.** Hit **Start** and a coach greets you (by name, if known)
  and asks a random conversation-starter question.
- 💾 **Remembers you.** Between sessions the coaches recall your name, goals, and
  interests — stored only on your machine (see *Your data* below).
- 🗣️ **Reliable capture.** Microphone audio is captured on a dedicated audio
  thread (AudioWorklet), so long answers aren't cut off.

## How it works

```
Browser ──mic 16kHz PCM (AudioWorklet)──▶  Node relay ──▶ Gemini Live "Luc"    (Puck voice)  + web search
        ◀──voice 24kHz PCM + transcripts──             ──▶ Gemini Live "Jeenie" (Kore voice)  + web search
```

- The **relay** holds your API key (never exposed to the browser), runs the two
  Live sessions, picks who answers, streams your speech to that coach, and relays
  the reply back.
- Before a coach answers, the relay injects a short **catch-up** of anything it
  missed (using `turnComplete:false`, so it adds context without triggering an
  early reply).
- It's **push-to-talk**: the worklet buffers your speech and flushes the tail on
  release, so nothing gets clipped.

## Which Gemini APIs it uses

All via the **Gemini Developer API** (a Google AI Studio key + the `@google/genai`
SDK) — **not** Vertex AI:

- **Live API** (WebSocket), model `gemini-2.5-flash-native-audio-latest` — the two
  real-time voice sessions, with **Google Search grounding** enabled.
- **`generateContent`**, model `gemini-2.5-flash` — summarizes each session into
  your saved profile.

## Requirements

- Node.js 18+
- **Google Chrome** (or another Chromium browser) for the microphone + AudioWorklet
- A free **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)

## Setup

```bash
npm install
cp .env.example .env     # then open .env and paste your GEMINI_API_KEY
```

## Run

```bash
npm start
```

Open **http://localhost:3000** in Chrome and allow microphone access.

**Hold the big button** (or hold the **spacebar**) while you speak, then release.
One of your friends will reply. Switch between **Coaching** and **Free chat** at
the top any time.

> Restart `npm start` after any code change to pick it up.
> Mic access needs `localhost` or HTTPS — `http://localhost:3000` is fine.

## Configure (optional — via `.env`)

```env
GEMINI_API_KEY = your-key-here          # required

GEMINI_LIVE_MODEL = gemini-2.5-flash-native-audio-latest   # default
LUC_VOICE    = Puck                       # Luc's voice
JEENIE_VOICE = Kore                       # Jeenie's voice
PORT         = 3000

LOG_TO_FILE     = 1   # save transcripts to data/transcript.jsonl (default on)
LOG_TRANSCRIPTS = 0   # also print transcripts in the console (default off)
REMEMBER        = 1   # remember you across sessions in data/profile.json (default on)
```

**Voices.** Gemini has ~30 prebuilt voices. Preview them in
[Google AI Studio](https://aistudio.google.com/) and set the two you like.
Male-leaning: `Puck, Charon, Fenrir, Orus, Iapetus`. Female-leaning:
`Kore, Aoede, Leda, Zephyr, Autonoe`.

**Models your key can use** (native-audio family): `gemini-2.5-flash-native-audio-latest`,
`gemini-2.5-flash-native-audio-preview-12-2025`, `gemini-3.1-flash-live-preview`.

## Watching it work

The server logs each turn so you can see exactly what was captured:

```
■ Jeenie turn: received 47 chunks, ~3008ms of audio
you: "what's a better way to say I'm very tired"
Jeenie: "Try 'I'm completely wiped out.' Give it a shot!"
```

If a turn's audio length looks far shorter than how long you spoke, that points
to capture trouble — but the AudioWorklet path is designed to prevent exactly
that.

## Your data

Everything personal stays on your machine in the **`data/`** folder, which is
gitignored:

- `data/transcript.jsonl` — an append-only log of every turn, for reviewing your
  practice. Turn it off with `LOG_TO_FILE=0`.
- `data/profile.json` — what the coaches remember about you (name, goals,
  interests). Rebuilt after each session by a quick text model. Turn it off with
  `REMEMBER=0`, or delete the file to make them forget. Want to pre-fill it? Copy
  `profile.example.json` to `data/profile.json` and edit.

The only place your words leave your machine is the **Gemini API** itself (and
Google Search when the coaches look something up) — that's inherent to using
Gemini. On the paid API, Google doesn't use your prompts to train its models.

> Console transcripts are off by default (`LOG_TRANSCRIPTS=0`); only non-sensitive
> per-turn audio timing prints, which is handy for spotting capture problems.

## Cost note

Two Live sessions per browser tab means roughly **2× the Live API usage**, and
native-audio Live is priced higher than text. Web search adds grounded-query
cost when used. Fine for personal practice on your credits — just know the meter
runs while sessions are open.

## Next steps (ideas)

- **Continuous listening + barge-in** (no button; interrupt them mid-sentence).
- **Smart router** — currently the server alternates who speaks with a little
  randomness; a small classifier could pick the better-suited coach per turn.
- **Both chime in** — let one correct and the other follow up in one turn.
- **Pronunciation mode** — the native-audio model hears *how* you speak; a future
  mode could coach accent, not just words.

## Files

```
server.js                  Express + WebSocket relay; two Live sessions, turn
                           routing, cross-coach catch-up, web search, greeting
prompt.js                  Luc & Jeenie personalities, modes, opener questions
storage.js                 Local transcript log + remembered profile (./data)
config.js                  Model, voices, port (override in .env)
profile.example.json       Template for data/profile.json
public/index.html          UI
public/app.js              WebSocket, push-to-talk, voice playback, transcript
public/capture-worklet.js  Audio-thread mic capture (PCM16, flush-on-stop)
public/style.css           Styling
```
