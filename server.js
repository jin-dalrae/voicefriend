import { readFileSync } from 'node:fs';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import { MODEL, VOICES, PORT } from './config.js';
import { buildSystemInstruction, getStarter } from './prompt.js';
import {
  buildDebriefPrompt,
  buildDebriefSpeakPrompt,
  buildLogicLensPrompt,
  detectWrapUpSignal,
  normalizeDebrief,
  normalizeLogicLens,
} from './public/lbd-frameworks.js';
import { loadProfile, saveProfile, profileContext, appendTranscript } from './storage.js';
import {
  ensureUser,
  getUserDoc,
  saveUserProfile,
  saveUserResume,
  startSession,
  appendSessionMessage,
  saveLbdDebrief,
  getLbdSessions,
  getLbdCredits,
  consumeLbdCredit,
  getAdminOverview,
} from './db.js';
import { authenticateWebSocketRequest, verifyFirebaseIdToken, getBearerToken, REQUIRE_FIREBASE_AUTH } from './auth.js';

const LOG_TRANSCRIPTS = process.env.LOG_TRANSCRIPTS === '1'; // set LOG_TRANSCRIPTS=1 to also print to console
const LOG_TO_FILE = process.env.LOG_TO_FILE !== '0'; // transcripts → data/transcript.jsonl (on by default)
const REMEMBER = process.env.REMEMBER !== '0'; // remember the user across sessions (on by default)
const PROFILE_MODEL = 'gemini-2.5-flash'; // cheap text model used to update the saved profile
// If a coach turn produces no output for this long, treat it as stalled and
// re-arm the client so the user isn't stranded on "Thinking…". A grounded web
// search (googleSearch tool) can hang without ever sending turnComplete or an
// error; the watchdog is the safety net for that and any silent disconnect.
const TURN_STALL_MS = Number(process.env.TURN_STALL_MS) || 30000;
// Who may load /api/admin/overview. Comma-separated emails; override via env.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'dalrae.jin.work@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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
    this.lbd = null; // /lbd conflict simulator: { parties, a, b, situation }
    this.lbdUserTurns = 0;
    this.lbdIntents = [];
    this.lbdLogicTurn = 0;
    this.lbdClosing = false;
    this.turnAborted = false;
    this.speakingDebrief = false;
    this.debriefSpeakResolve = null;
    this.debriefSpeakTimer = null;
    this.currentIntent = 'natural';
    this.authed = false;
    this.sessionId = null;
    this.turnWatchdog = null; // re-arms the client if a coach turn stalls

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

  // Restart the stall timer. Called when the user's turn is committed and again
  // on every chunk of model output, so a long-but-active reply never trips it —
  // only true silence (e.g. a hung web search) does.
  bumpTurnWatchdog() {
    this.clearTurnWatchdog();
    this.turnWatchdog = setTimeout(() => {
      this.turnWatchdog = null;
      if (this.turnAborted) return;
      console.warn(`  ⚠ ${this.responder} turn stalled (${TURN_STALL_MS}ms, no output) — re-arming client`);
      this.userTurnText = '';
      this.respTurnText = '';
      this.send({ type: 'error', message: "Sorry — that one didn't go through. Tap to talk and try again." });
    }, TURN_STALL_MS);
  }

  clearTurnWatchdog() {
    if (this.turnWatchdog) {
      clearTimeout(this.turnWatchdog);
      this.turnWatchdog = null;
    }
  }

  async connectAll() {
    try {
      await Promise.all(CHARACTERS.map((name) => this.connectOne(name)));
      // Only coaching/free chat use durable memory. The interview drill and the
      // conflict sim get context from the current JD/resume or scenario — never
      // seed a former session's profile (or its role/JD) into them.
      if (this.mode === 'coaching' || this.mode === 'free') this.seedProfile();
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
        systemInstruction: buildSystemInstruction(name, this.mode, { jobDescription: this.jobDescription, resume: this.resume, lbd: this.lbd }),
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
    // The Live API sends session-control signals (goAway before a disconnect,
    // toolCall, etc.) as top-level fields, not inside serverContent. Silently
    // dropping these made a goAway indistinguishable from silence — it stranded
    // the client. Surface it so the user can recover instead of waiting forever.
    if (msg.goAway) {
      console.warn(`  ⚠ [${name}] Live API goAway (timeLeft: ${msg.goAway.timeLeft || 'n/a'})`);
      if (name === this.responder) {
        this.clearTurnWatchdog();
        this.send({ type: 'error', message: 'The voice session dropped — tap to talk to continue.' });
      }
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    // Only the chosen responder is ever fed audio, but guard anyway.
    if (name !== this.responder) return;
    // Real model output — the turn is alive, so keep the stall watchdog fed.
    this.bumpTurnWatchdog();

    if (sc.inputTranscription?.text) {
      this.userTurnText = (this.userTurnText || '') + sc.inputTranscription.text;
      this.send({ type: 'user_transcript', text: this.userTurnText });
    }
    if (sc.outputTranscription?.text) {
      this.respTurnText = (this.respTurnText || '') + sc.outputTranscription.text;
      const meta = this.lbdTranscriptMeta(name);
      this.send({ type: 'transcript', name, text: this.respTurnText, ...meta });
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
      this.clearTurnWatchdog();
      // Conflict simulator: keep the exchange in memory for the debrief, but
      // never persist it to the user's Firestore profile/transcript.
      if (this.mode === 'lbd' && this.speakingDebrief) {
        this.finishDebriefSpeak();
        this.send({ type: 'turn_end', name, displayName: 'Alex', role: 'debrief' });
        this.userTurnText = '';
        this.respTurnText = '';
        return;
      }
      if (this.turnAborted) {
        this.turnAborted = false;
        this.userTurnText = '';
        this.respTurnText = '';
        return;
      }
      if (this.mode === 'lbd') {
        const ut = (this.userTurnText || '').trim();
        const rt = (this.respTurnText || '').trim();
        if (ut) this.transcript.push({ speaker: 'You', text: ut });
        if (rt) this.transcript.push({ speaker: this.lbdSpeakerLabel(name), text: rt });
        this.seen[name] = this.transcript.length;
        this.lastSpeaker = name;
        this.send({ type: 'turn_end', name, ...this.lbdTranscriptMeta(name) });
        if (!this.lbdClosing && rt) {
          this.analyzeLogicLens().catch((err) =>
            console.error('logic lens failed:', err?.message || err),
          );
        }
        if (!this.lbdClosing && ut && rt) {
          const wrap = detectWrapUpSignal(ut, {
            userTurns: this.lbdUserTurns,
            transcriptLines: this.transcript.length,
          });
          if (wrap) this.beginNaturalWrap();
        }
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
  lbdAntagonistVoice() {
    return this.lbd?.a?.voice === 'Jeenie' ? 'Jeenie' : 'Luc';
  }

  lbdDebriefVoice() {
    return this.lbdAntagonistVoice() === 'Jeenie' ? 'Luc' : 'Jeenie';
  }

  lbdSpeakerLabel(voice) {
    if (voice === (this.lbd?.a?.voice === 'Jeenie' ? 'Jeenie' : 'Luc')) return this.lbd?.a?.name || voice;
    if (voice === (this.lbd?.b?.voice === 'Jeenie' ? 'Jeenie' : 'Luc')) return this.lbd?.b?.name || voice;
    return voice;
  }

  lbdTranscriptMeta(voice) {
    if (this.mode !== 'lbd') return {};
    const displayName = this.lbdSpeakerLabel(voice);
    return {
      displayName,
      role: 'antagonist',
    };
  }

  finishDebriefSpeak() {
    if (this.debriefSpeakTimer) clearTimeout(this.debriefSpeakTimer);
    this.debriefSpeakTimer = null;
    this.speakingDebrief = false;
    if (this.debriefSpeakResolve) {
      this.debriefSpeakResolve();
      this.debriefSpeakResolve = null;
    }
  }

  speakDebriefAloud(data) {
    const voice = this.lbdDebriefVoice();
    const session = this.sessions[voice];
    const prompt = buildDebriefSpeakPrompt(data);
    if (!session || !prompt) return Promise.resolve();
    this.responder = voice;
    this.userTurnText = '';
    this.respTurnText = '';
    this.speakingDebrief = true;
    this.send({ type: 'speaker', name: voice, displayName: 'Alex', role: 'debrief' });
    return new Promise((resolve) => {
      this.debriefSpeakResolve = resolve;
      this.debriefSpeakTimer = setTimeout(() => {
        this.finishDebriefSpeak();
        this.send({ type: 'turn_end', name: voice, displayName: 'Alex', role: 'debrief' });
      }, 90000);
      try {
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: prompt }] }],
          turnComplete: true,
        });
      } catch (e) {
        console.error('speakDebriefAloud failed:', e?.message || e);
        this.finishDebriefSpeak();
        resolve();
      }
    });
  }

  pickResponder() {
    if (this.mode === 'lbd') {
      const a = this.lbdAntagonistVoice();
      if ((this.lbd?.parties || 1) < 2) return a;
      const b = this.lbd?.b?.voice === 'Jeenie' ? 'Jeenie' : 'Luc';
      return this.lastSpeaker === a ? b : a;
    }
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
    // Only coaching/free build durable memory. Never fold a drill's job
    // description, resume, or roleplay into it — that leaks into later sessions.
    if (this.mode !== 'coaching' && this.mode !== 'free') return;
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

  // Conflict simulator: counterpart A (Luc) opens the scene with the provocation.
  beginLbd() {
    this.greeted = true;
    const a = this.lbd?.a;
    const voice = a?.voice === 'Jeenie' ? 'Jeenie' : 'Luc';
    const session = this.sessions[voice];
    if (!a || !session) return;
    this.responder = voice;
    this.lastSpeaker = voice;
    this.userTurnText = '';
    this.respTurnText = '';
    this.send({ type: 'speaker', name: voice, displayName: a.name, role: 'antagonist' });
    const opener = a.opening ? ` Open with something close to: "${a.opening}".` : '';
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `Start the scene now. In character as ${a.name}, ${a.role}, open the conflict in one or two natural spoken sentences, then stop and wait for the user's reply.${opener}` }] }],
        turnComplete: true,
      });
    } catch (e) {
      console.error('beginLbd failed:', e?.message || e);
    }
  }

  // Conflict simulator: give a specific, multi-dimensional read of how the user
  // communicated (style MIX, reasoning, the arc) — not one reductive label.
  async analyzeLogicLens() {
    if (this.mode !== 'lbd' || !this.transcript.length) return;
    const lastUser = [...this.transcript].reverse().find((e) => e.speaker === 'You')?.text || '';
    const lastFoeEntry = [...this.transcript].reverse().find((e) => e.speaker !== 'You');
    if (!lastFoeEntry?.text) return;
    this.lbdLogicTurn += 1;
    try {
      const res = await this.ai.models.generateContent({
        model: PROFILE_MODEL,
        contents: buildLogicLensPrompt({
          transcript: this.transcript,
          lastUser,
          lastFoe: lastFoeEntry,
          scenario: this.lbd,
          turn: this.lbdLogicTurn,
        }),
        config: { responseMimeType: 'application/json' },
      });
      const data = normalizeLogicLens(JSON.parse(res.text));
      if (data) this.send({ type: 'lbd_logic', data, turn: this.lbdLogicTurn });
    } catch (e) {
      console.error('analyzeLogicLens:', e?.message || e);
    }
  }

  beginLbdClose() {
    if (this.lbdClosing) return;
    this.lbdClosing = true;
    this.send({ type: 'lbd_wrapping', reason: 'manual' });
    const a = this.lbd?.a;
    const voice = a?.voice === 'Jeenie' ? 'Jeenie' : 'Luc';
    const s = this.sessions[voice];
    if (!a || !s) return;
    this.responder = voice;
    this.userTurnText = '';
    this.respTurnText = '';
    this.send({ type: 'speaker', name: voice, displayName: a.name, role: 'antagonist' });
    try {
      s.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `The conversation is wrapping up now. In character as ${a.name}, bring it to a concrete conclusion: state the final decision or compromise you're landing on, based on how the user argued — agree to a fair middle ground if they negotiated well, or hold your position with a clear call if they didn't. One or two natural spoken sentences, then stop.` }] }],
        turnComplete: true,
      });
    } catch (e) {
      console.error('lbd_close failed:', e?.message || e);
    }
  }

  beginNaturalWrap() {
    if (this.lbdClosing) return;
    this.lbdClosing = true;
    this.send({ type: 'lbd_wrapping', reason: 'natural' });
    this.debriefLbd();
  }

  async debriefLbd() {
    const convo = this.transcript.map((e) => `${e.speaker}: ${e.text}`).join('\n');
    if (!convo) {
      this.send({ type: 'lbd_debrief', data: null });
      return;
    }
    try {
      const res = await this.ai.models.generateContent({
        model: PROFILE_MODEL,
        contents: buildDebriefPrompt({ convo, scenario: this.lbd, intents: this.lbdIntents }),
        config: { responseMimeType: 'application/json' },
      });
        const data = normalizeDebrief(JSON.parse(res.text));
        if (!data) {
          this.send({ type: 'lbd_debrief', data: null });
          return;
        }
        if (this.identity?.uid) {
          const userQuotes = this.transcript
            .filter((e) => e.speaker === 'You')
            .map((e) => e.text)
            .filter(Boolean)
            .slice(-12);
          saveLbdDebrief(this.identity.uid, {
            scenarioId: this.lbd?.scenarioId || null,
            scenarioTitle: this.lbd?.scenarioTitle || null,
            variant: this.lbd?.variant || 'standard',
            parties: this.lbd?.parties || 1,
            exchangeCount: this.lbdUserTurns,
            debrief: data,
            userQuotes,
            intents: this.lbdIntents?.length ? [...this.lbdIntents] : [],
          }).catch((err) => console.error('lbd debrief save failed:', err?.message || err));
        }
        // Debrief is shown as a written report only — no spoken read-aloud.
        this.send({ type: 'lbd_debrief', data });
    } catch (e) {
      console.error('lbd debrief failed:', e?.message || e);
      this.finishDebriefSpeak();
      this.send({ type: 'lbd_debrief', data: null });
    }
  }

  // Quietly bring a coach up to speed on what it missed since it last spoke,
  // injected as context with turnComplete:false so it does NOT trigger a reply.
  injectLbdTurnHint(session) {
    const text = (this.userTurnText || '').toLowerCase();
    if (!text) return;
    const me = this.lbdSpeakerLabel(this.responder);
    let hint = null;
    if (/intake|process|vp|manager|boss|report|chain|escalat|subordinate|contractor|design lead/.test(text)) {
      hint = `(Reply as ${me} only.) The user raised process, reporting line, or escalation — answer their specific point. If they proposed intake-lite, a VP call, or a time-box, negotiate terms or agree with conditions. Do not loop generic urgency without engaging their offer.`;
    } else if (/rapid|sprint|discovery|time.?box|\b\d+\s*(day|hour)/.test(text)) {
      hint = `(Reply as ${me} only.) The user is shaping a fast path — engage specifics (duration, people, deliverable, what eng may continue). Move toward a concrete agreement.`;
    } else if (/can't talk|stop fighting|not sold|hide this/.test(text)) {
      hint = `(Reply as ${me} only.) The user is disengaging or challenging motives — de-escalate slightly, name a concrete next step (joint call, written scope, date), do not pile on pressure.`;
    }
    if (!hint) return;
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: hint }] }],
        turnComplete: false,
      });
    } catch (e) {
      console.error('injectLbdTurnHint failed:', e?.message || e);
    }
  }

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
        this.currentIntent = typeof m.intent === 'string' ? m.intent : 'natural';
        const s = this.sessions[this.responder];
        if (!s) return;
        this.catchUp(this.responder); // let this coach know what it missed
        if (this.mode === 'lbd') {
          this.lbdUserTurns += 1;
        }
        const speakerMeta = this.mode === 'lbd' ? this.lbdTranscriptMeta(this.responder) : {};
        this.send({ type: 'speaker', name: this.responder, ...speakerMeta });
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
        if (s) {
          if (this.mode === 'lbd') this.injectLbdTurnHint(s);
          s.sendRealtimeInput({ activityEnd: {} });
        }
        const ms = Math.round((this.turnBytes / 2 / 16000) * 1000);
        console.log(`  ■ ${this.responder} turn: received ${this.turnChunks} chunks, ~${ms}ms of audio`);
        // Watch for a model turn that never produces output (e.g. a hung web search).
        this.bumpTurnWatchdog();
        break;
      }
      case 'stop_speaking': {
        if (this.speakingDebrief) {
          this.finishDebriefSpeak();
          this.send({ type: 'interrupted' });
          this.send({ type: 'turn_end', name: this.responder, displayName: 'Alex', role: 'debrief' });
          break;
        }
        this.turnAborted = true;
        this.clearTurnWatchdog();
        this.userTurnText = '';
        this.respTurnText = '';
        this.send({ type: 'interrupted' });
        const stopMeta = this.mode === 'lbd' ? this.lbdTranscriptMeta(this.responder) : {};
        this.send({ type: 'turn_end', name: this.responder, ...stopMeta });
        break;
      }
      case 'lbd_close': {
        this.beginLbdClose();
        break;
      }
      case 'lbd_debrief': {
        // Conflict simulator: analyze the spoken transcript and classify the user.
        this.debriefLbd();
        break;
      }
      case 'mode': {
        this.handleModeChange(m).catch((e) =>
          console.error('handleModeChange failed:', e?.message || e),
        );
        break;
      }
    }
  }

  async handleModeChange(m) {
    const mode = ['free', 'interview', 'coaching', 'lbd'].includes(m.mode) ? m.mode : 'coaching';
    const jd = typeof m.jobDescription === 'string' ? m.jobDescription : this.jobDescription;
    const resume = typeof m.resume === 'string' ? m.resume : this.resume;
    const resumeChanged = resume !== this.resume;
    const lbdChanged = mode === 'lbd' && m.lbd && JSON.stringify(m.lbd) !== JSON.stringify(this.lbd);
    const changed =
      mode !== this.mode ||
      (mode === 'interview' && (jd !== this.jobDescription || resumeChanged)) ||
      lbdChanged;

    if (mode === 'lbd' && m.lbd && m.newSession) {
      if (!this.identity?.uid) {
        this.send({ type: 'lbd_denied', message: 'Sign in to use your free daily simulations.' });
        return;
      }
      const credit = await consumeLbdCredit(this.identity.uid);
      if (!credit.ok) {
        this.send({
          type: 'lbd_denied',
          message: 'No free simulations left today. Credits renew at midnight UTC.',
          credits: credit,
        });
        return;
      }
      this.send({ type: 'lbd_credits', credits: credit });
    }

    this.mode = mode;
    this.jobDescription = jd;
    this.resume = resume;
    if (mode === 'lbd' && m.lbd) {
      this.lbd = m.lbd;
      this.lbdUserTurns = 0;
      this.lbdIntents = [];
      this.lbdLogicTurn = 0;
      this.lbdClosing = false;
      this.currentIntent = 'natural';
      this.transcript = [];
      this.seen = { Luc: 0, Jeenie: 0 };
    }
    if (resumeChanged && this.identity?.uid && typeof resume === 'string') {
      saveUserResume(this.identity.uid, resume).catch((e) =>
        console.error('resume save failed:', e?.message || e),
      );
    }
    if (changed) {
      await this.reconnect();
      if (this.mode === 'interview') this.beginInterview();
      else if (this.mode === 'lbd') this.beginLbd();
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
    this.clearTurnWatchdog();
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
  res.status(200).json({ ok: true, build: 'lbd-2026-06-19' });
});

// LbD speaking-trends dashboard (persisted debriefs in Firestore).
app.get('/api/lbd/credits', async (req, res) => {
  try {
    const identity = await verifyFirebaseIdToken(getBearerToken(req), { required: true });
    const credits = await getLbdCredits(identity.uid);
    res.status(200).json(credits);
  } catch (err) {
    res.status(401).json({ error: err?.message || 'Unauthorized' });
  }
});

app.get('/api/lbd/trends', async (req, res) => {
  try {
    const identity = await verifyFirebaseIdToken(getBearerToken(req), { required: true });
    const sessions = await getLbdSessions(identity.uid);
    res.status(200).json({ sessions });
  } catch (err) {
    res.status(401).json({ error: err?.message || 'Unauthorized' });
  }
});

// Admin dashboard — every user + LbD usage. Gated by the ADMIN_EMAILS allowlist
// (401 = not signed in, 403 = signed in but not an admin).
app.get('/api/admin/overview', async (req, res) => {
  let identity;
  try {
    identity = await verifyFirebaseIdToken(getBearerToken(req), { required: true });
  } catch (err) {
    return res.status(401).json({ error: err?.message || 'Unauthorized' });
  }
  const email = (identity.email || '').toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const data = await getAdminOverview();
    res.status(200).json({ ...data, admin: email });
  } catch (err) {
    console.error('admin overview failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
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
