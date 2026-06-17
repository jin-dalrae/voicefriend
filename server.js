import { readFileSync } from 'node:fs';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import { MODEL, VOICES, PORT } from './config.js';
import { buildSystemInstruction, getStarter } from './prompt.js';
import { loadProfile, saveProfile, profileContext, appendTranscript } from './storage.js';
import { ensureUser, getUserDoc, saveUserProfile, saveUserResume, startSession, appendSessionMessage } from './db.js';
import { authenticateWebSocketRequest, verifyFirebaseIdToken, REQUIRE_FIREBASE_AUTH } from './auth.js';

const LOG_TRANSCRIPTS = process.env.LOG_TRANSCRIPTS === '1'; // set LOG_TRANSCRIPTS=1 to also print to console
const LOG_TO_FILE = process.env.LOG_TO_FILE !== '0'; // transcripts → data/transcript.jsonl (on by default)
const REMEMBER = process.env.REMEMBER !== '0'; // remember the user across sessions (on by default)
const PROFILE_MODEL = 'gemini-2.5-flash'; // cheap text model used to update the saved profile

// --- tiny .env loader (handles "KEY = value", quotes, comments) ----------------
function loadEnv(path = '.env') {
  let txt;
  try {
    txt = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY. Add it to your .env file.');
  process.exit(1);
}

const CHARACTERS = ['Luc', 'Jeenie'];

// --- one of these per connected browser tab -----------------------------------
class Conversation {
  constructor(browser, identity = { anonymous: true }) {
    this.browser = browser;
    this.identity = identity;
    this.ai = new GoogleGenAI({ apiKey: API_KEY });
    this.mode = 'coaching';
    this.sessions = {}; // name -> live session
    this.responder = null; // who is answering the current turn
    this.lastSpeaker = null; // who answered the previous turn
    this.transcript = []; // shared history: { speaker: 'You'|'Luc'|'Jeenie', text }
    this.seen = { Luc: 0, Jeenie: 0 }; // how far each coach has been caught up
    this.greeted = false;
    this.profile = null; // what we remember about the user
    this.jobDescription = null; // interview-drill mode: pasted job description
    this.resume = null; // interview-drill mode: the user's saved resume
    this.authed = false;
    this.sessionId = null;

    if (!REQUIRE_FIREBASE_AUTH) {
      // Dev/local: anonymous, local-file memory, open sessions right away.
      this.profile = REMEMBER ? loadProfile() : null;
      this.connectAll();
    } else if (identity.uid) {
      // A non-browser client identified via Bearer header — proceed authed.
      this.startAuthed(identity);
    } else {
      // Browser: can't send an auth header on a WebSocket, so wait for the
      // in-band {type:'auth'} message before opening (and paying for) sessions.
      this.send({ type: 'need_auth', message: 'Sign in to start.' });
    }
  }

  // Verified sign-in: load (or create) the user's Firestore record, seed memory
  // from it, then open the Live sessions.
  async startAuthed(identity) {
    if (this.authed) return;
    this.identity = identity;
    this.authed = true;
    this.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await ensureUser(identity.uid, {
        email: identity.email,
        profile: identity.name ? { name: identity.name } : undefined,
      });
      const doc = await getUserDoc(identity.uid);
      this.profile = doc?.profile || (identity.name ? { name: identity.name } : null);
      this.resume = doc?.resume || null;
      await startSession(identity.uid, this.sessionId, { mode: this.mode });
    } catch (e) {
      console.error('startAuthed: Firestore load failed:', e?.message || e);
    }
    // Let the client prefill saved account fields (e.g., resume for the drill).
    this.send({ type: 'account', name: this.profile?.name || null, resume: this.resume || null });
    await this.connectAll();
  }

  send(obj) {
    if (this.browser.readyState === 1) this.browser.send(JSON.stringify(obj));
  }

  async connectAll() {
    try {
      await Promise.all(CHARACTERS.map((name) => this.connectOne(name)));
      this.seedProfile(); // tell both coaches what we remember about the user
      this.send({ type: 'ready' });
    } catch (err) {
      console.error('Failed to open Live sessions:', err?.message || err);
      this.send({ type: 'error', message: 'Could not connect to Gemini Live. Check the model name and your API key.' });
    }
  }

  async connectOne(name) {
    const session = await this.ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[name] } },
        },
        systemInstruction: buildSystemInstruction(name, this.mode, { jobDescription: this.jobDescription, resume: this.resume }),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Let them look things up on the web mid-conversation.
        tools: [{ googleSearch: {} }],
        // We drive turns by hand (push-to-talk), so disable automatic VAD.
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
      callbacks: {
        onopen: () => {},
        onmessage: (msg) => this.onModelMessage(name, msg),
        onerror: (e) => {
          console.error(`[${name}] live error:`, e?.message || e);
          this.send({ type: 'error', message: `Voice session error (${name}).` });
        },
        onclose: () => {},
      },
    });
    this.sessions[name] = session;
  }

  onModelMessage(name, msg) {
    const sc = msg.serverContent;
    if (!sc) return;
    // Only the chosen responder is ever fed audio, but guard anyway.
    if (name !== this.responder) return;

    if (sc.inputTranscription?.text) {
      this.userTurnText = (this.userTurnText || '') + sc.inputTranscription.text;
      this.send({ type: 'user_transcript', text: this.userTurnText });
    }
    if (sc.outputTranscription?.text) {
      this.respTurnText = (this.respTurnText || '') + sc.outputTranscription.text;
      this.send({ type: 'transcript', name, text: this.respTurnText });
    }
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.executableCode) this.send({ type: 'searching', name }); // using web search
        if (part.inlineData?.data) {
          this.send({ type: 'audio', data: part.inlineData.data });
        }
      }
    }
    if (sc.interrupted) this.send({ type: 'interrupted' });
    if (sc.turnComplete) {
      // Conflict simulator: just voice the line; don't record it as conversation.
      if (this.mode === 'lbd') {
        this.lastSpeaker = name;
        this.send({ type: 'turn_end', name });
        this.userTurnText = '';
        this.respTurnText = '';
        return;
      }
      const userText = (this.userTurnText || '').trim();
      const respText = (this.respTurnText || '').trim();
      if (LOG_TRANSCRIPTS) {
        if (userText) console.log(`  you: "${userText}"`);
        console.log(`  ${name}: "${respText}"`);
      }
      // record the turn into the shared transcript so the other coach can catch up
      const entries = [];
      if (userText) entries.push({ speaker: 'You', text: userText });
      if (respText) entries.push({ speaker: name, text: respText });
      if (LOG_TO_FILE) {
        if (this.identity?.uid && this.sessionId) {
          for (const e of entries) {
            appendSessionMessage(this.identity.uid, this.sessionId, e).catch((err) =>
              console.error('transcript write failed:', err?.message || err),
            );
          }
        } else {
          appendTranscript(entries);
        }
      }
      this.transcript.push(...entries);
      this.seen[name] = this.transcript.length; // responder has heard everything
      this.lastSpeaker = name;
      this.send({ type: 'turn_end', name });
      this.userTurnText = '';
      this.respTurnText = '';
    }
  }

  // Decide who answers this turn. Heuristic for now: lean toward switching so
  // both stay active, never the same person 3x, with a little randomness.
  // Swap this out later for a smart router (e.g. classify the user's words).
  pickResponder() {
    if (!this.lastSpeaker) return this.mode === 'coaching' ? 'Jeenie' : 'Luc';
    // Interview drill: strict turns — the OTHER coach asks the next question.
    if (this.mode === 'interview') return this.lastSpeaker === 'Luc' ? 'Jeenie' : 'Luc';
    const stay = Math.random() < 0.3;
    if (stay) return this.lastSpeaker;
    return this.lastSpeaker === 'Luc' ? 'Jeenie' : 'Luc';
  }

  // Tell both coaches what we remember about the user (silent context).
  seedProfile() {
    const ctx = profileContext(this.profile);
    if (!ctx) return;
    for (const name of CHARACTERS) {
      try {
        this.sessions[name].sendClientContent({
          turns: [{ role: 'user', parts: [{ text: ctx }] }],
          turnComplete: false,
        });
      } catch {}
    }
  }

  // After a session, fold what we learned into the saved profile (cheap text model).
  async persistProfile() {
    if (!REMEMBER || !this.transcript.length) return;
    const convo = this.transcript.map((e) => `${e.speaker}: ${e.text}`).join('\n');
    const current = this.profile || { name: '', summary: '', goals: [], interests: [], facts: [] };
    try {
      const res = await this.ai.models.generateContent({
        model: PROFILE_MODEL,
        contents: `Current user profile JSON:\n${JSON.stringify(current)}\n\nLatest conversation (You = the user; the others are AI coaches):\n${convo}\n\nReturn an UPDATED user profile as JSON with exactly these fields: name (string), summary (one or two sentences), goals (array of strings), interests (array of strings), facts (array of short strings). Merge in durable, genuine facts about the USER only — never facts about the coaches. Keep arrays short and deduplicated. Output JSON only.`,
        config: { responseMimeType: 'application/json' },
      });
      const updated = JSON.parse(res.text);
      if (this.identity?.uid) {
        await saveUserProfile(this.identity.uid, updated); // per-user memory in Firestore
      } else {
        saveProfile(updated); // anonymous/dev: local file
      }
      console.log('  ✎ remembered this session');
    } catch (e) {
      console.error('profile update failed:', e?.message || e);
    }
  }

  // One of the coaches greets the user and asks a random opener to kick things off.
  startConversation() {
    if (this.greeted) return;
    if (this.mode === 'interview') {
      this.beginInterview();
      return;
    }
    this.greeted = true;
    const opener = Math.random() < 0.5 ? 'Luc' : 'Jeenie';
    const session = this.sessions[opener];
    if (!session) return;
    const question = getStarter();
    this.responder = opener;
    this.userTurnText = '';
    this.respTurnText = '';
    this.send({ type: 'speaker', name: opener });
    const namePart = this.profile?.name ? ` Greet them by name (${this.profile.name}).` : '';
    const instruction = `Start the conversation now. Warmly greet the user in one short sentence.${namePart} Then ask them this in your own natural words: "${question}". Keep it brief and friendly.`;
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: instruction }] }],
        turnComplete: true,
      });
    } catch (e) {
      console.error('startConversation failed:', e?.message || e);
    }
  }

  // Kick off (or restart) the interview drill: one coach greets and asks the
  // first question from the job description. Re-runnable when the user switches
  // into interview mode mid-session.
  beginInterview() {
    this.greeted = true;
    const opener = Math.random() < 0.5 ? 'Luc' : 'Jeenie';
    const session = this.sessions[opener];
    if (!session) return;
    this.responder = opener;
    this.lastSpeaker = opener; // so the OTHER coach asks the next question
    this.userTurnText = '';
    this.respTurnText = '';
    this.send({ type: 'speaker', name: opener });
    const namePart = this.profile?.name ? ` Greet them by name, ${this.profile.name},` : '';
    const instruction = `Begin the interview now.${namePart} In one short sentence, warmly acknowledge the role they're preparing for, then ask your FIRST interview question based on the job description. Ask only one question and keep it natural and spoken.`;
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: instruction }] }],
        turnComplete: true,
      });
    } catch (e) {
      console.error('beginInterview failed:', e?.message || e);
    }
  }

  // Quietly bring a coach up to speed on what it missed since it last spoke,
  // injected as context with turnComplete:false so it does NOT trigger a reply.
  catchUp(name) {
    const missed = this.transcript.slice(this.seen[name]);
    this.seen[name] = this.transcript.length;
    if (!missed.length) return;
    const lines = missed
      .slice(-8)
      .map((e) => `${e.speaker === 'You' ? 'The user' : e.speaker} said: "${e.text}"`);
    const recap = `(Quick catch-up so you're in the loop on the group conversation — do not reply to this directly.) ${lines.join(' ')}`;
    try {
      this.sessions[name].sendClientContent({
        turns: [{ role: 'user', parts: [{ text: recap }] }],
        turnComplete: false,
      });
    } catch (e) {
      console.error('catchUp failed:', e?.message || e);
    }
  }

  handleBrowserMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.type) {
      case 'auth': {
        this.verifyClientToken(m.token);
        break;
      }
      case 'begin': {
        this.startConversation();
        break;
      }
      case 'mic_start': {
        this.responder = this.pickResponder();
        this.userTurnText = '';
        this.respTurnText = '';
        this.turnChunks = 0;
        this.turnBytes = 0;
        const s = this.sessions[this.responder];
        if (!s) return;
        this.catchUp(this.responder); // let this coach know what it missed
        this.send({ type: 'speaker', name: this.responder });
        s.sendRealtimeInput({ activityStart: {} });
        break;
      }
      case 'audio': {
        const s = this.sessions[this.responder];
        if (s && m.data) {
          this.turnChunks++;
          this.turnBytes += Math.floor((m.data.length * 3) / 4); // base64 → byte estimate
          s.sendRealtimeInput({ audio: { data: m.data, mimeType: 'audio/pcm;rate=16000' } });
        }
        break;
      }
      case 'mic_end': {
        const s = this.sessions[this.responder];
        if (s) s.sendRealtimeInput({ activityEnd: {} });
        const ms = Math.round((this.turnBytes / 2 / 16000) * 1000);
        console.log(`  ■ ${this.responder} turn: received ${this.turnChunks} chunks, ~${ms}ms of audio`);
        break;
      }
      case 'lbd_say': {
        // Conflict simulator: have one voice perform a counterpart's line.
        const who = m.who === 'Jeenie' ? 'Jeenie' : 'Luc';
        const s = this.sessions[who];
        const line = typeof m.line === 'string' ? m.line.trim() : '';
        if (!s || !line) return;
        const as = typeof m.as === 'string' && m.as.trim() ? m.as.trim() : 'a colleague';
        this.responder = who;
        this.userTurnText = '';
        this.respTurnText = '';
        this.send({ type: 'speaker', name: who });
        try {
          s.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `In character as ${as}, say this line out loud, naturally and with the right emotion. Say only the line:\n"${line}"` }] }],
            turnComplete: true,
          });
        } catch (e) {
          console.error('lbd_say failed:', e?.message || e);
        }
        break;
      }
      case 'mode': {
        const mode = ['free', 'interview', 'coaching', 'lbd'].includes(m.mode) ? m.mode : 'coaching';
        const jd = typeof m.jobDescription === 'string' ? m.jobDescription : this.jobDescription;
        const resume = typeof m.resume === 'string' ? m.resume : this.resume;
        const resumeChanged = resume !== this.resume;
        const changed =
          mode !== this.mode ||
          (mode === 'interview' && (jd !== this.jobDescription || resumeChanged));
        this.mode = mode;
        this.jobDescription = jd;
        this.resume = resume;
        // Persist the resume to the account so it's there next time.
        if (resumeChanged && this.identity?.uid && typeof resume === 'string') {
          saveUserResume(this.identity.uid, resume).catch((e) =>
            console.error('resume save failed:', e?.message || e),
          );
        }
        if (changed) {
          // System prompt (job description / resume) changed, so re-open both
          // sessions, then kick off the first interview question if entering the drill.
          this.reconnect().then(() => {
            if (this.mode === 'interview') this.beginInterview();
          });
        }
        break;
      }
    }
  }

  async verifyClientToken(token) {
    if (!token) {
      this.send({ type: 'auth_error', message: 'Missing Firebase ID token.' });
      return;
    }

    let identity;
    try {
      identity = await verifyFirebaseIdToken(token, { required: true });
    } catch (err) {
      console.warn(`Firebase auth message failed: ${err?.message || err}`);
      this.send({ type: 'auth_error', message: 'Sign-in could not be verified.' });
      return;
    }

    this.send({ type: 'auth_ok' });
    if (REQUIRE_FIREBASE_AUTH && !this.authed) {
      // First verified sign-in on this socket: load the user and open sessions.
      await this.startAuthed(identity);
    } else {
      // Already running (or dev anonymous mode) — just record the latest identity.
      this.identity = identity;
    }
  }

  async reconnect() {
    this.responder = null;
    this.closeSessions();
    await this.connectAll();
    // Re-seed both fresh sessions with the conversation so far, so switching
    // modes doesn't wipe the context and both stay in sync.
    if (this.transcript.length) {
      const recap = this.transcript
        .slice(-12)
        .map((e) => `${e.speaker === 'You' ? 'The user' : e.speaker} said: "${e.text}"`)
        .join(' ');
      for (const name of CHARACTERS) {
        try {
          this.sessions[name].sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `(Background — the conversation so far, so you're both in sync.) ${recap}` }] }],
            turnComplete: false,
          });
        } catch {}
      }
      this.seen = { Luc: this.transcript.length, Jeenie: this.transcript.length };
    }
  }

  closeSessions() {
    for (const name of Object.keys(this.sessions)) {
      try {
        this.sessions[name].close();
      } catch {}
    }
    this.sessions = {};
  }

  close() {
    this.persistProfile(); // fire-and-forget: save what we learned this session
    this.closeSessions();
  }
}

// --- wire up express + websocket on one port ----------------------------------
const app = express();

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (browser, req) => {
  // Browsers can't set an Authorization header on a WebSocket, so identity comes
  // from the in-band {type:'auth'} message. Honor a Bearer header if a non-browser
  // client sends one; otherwise start anonymous and let the Conversation gate on
  // the auth message when REQUIRE_FIREBASE_AUTH is on.
  let identity = { uid: null, anonymous: true };
  try {
    identity = await authenticateWebSocketRequest(req);
  } catch {
    identity = { uid: null, anonymous: true };
  }

  const conv = new Conversation(browser, identity);
  browser.on('message', (raw) => conv.handleBrowserMessage(raw));
  browser.on('close', () => conv.close());
  browser.on('error', () => conv.close());
});

server.listen(PORT, () => {
  console.log(`\n  voicefriend running → http://localhost:${PORT}`);
  console.log(`  model: ${MODEL}`);
  console.log(`  voices: Luc=${VOICES.Luc}  Jeenie=${VOICES.Jeenie}\n`);
  console.log(`  firebase auth required: ${REQUIRE_FIREBASE_AUTH ? 'yes' : 'no'}\n`);
});
