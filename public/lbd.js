import { getCurrentIdToken, initAuthUi } from './firebase-client.js';
import { creditsLabel, fetchLbdCredits } from './lbd-credits.js';
import { maybeShowAdminLink } from './admin-nav.js';
import {
  SCENARIO_FRAMEWORKS,
  renderDebriefHtml,
} from './lbd-frameworks.js';

// Lateral leadership flight simulator — speak naturally; close when you agree, land a decision, or say goodbye.

const SOFT_HINT_EXCHANGES = 8;

// Roleplay cast + situation per scenario. Framework metadata (title, blurb,
// stakes, authority gap, styles, coaching note) lives in SCENARIO_FRAMEWORKS so
// the /about guide and the simulator stay in sync — merged in below.
const SCENARIOS = [
  {
    id: 'deadline',
    featured: true,
    ...SCENARIO_FRAMEWORKS.deadline,
    situation:
      'A design leader is trying to protect the research and design-QA process. The product manager wants to cut it to hit an exec demo that just moved up two weeks. The deadline is fixed; the design leader has no authority over the PM.',
    a: { name: 'Maya', voice: 'Jeenie', role: 'the Product Manager', stance: 'You moved the exec demo up two weeks and want to cut the user-research round and design-QA pass. You think research rarely changes the answer and will defend the date hard — unless the designer offers a faster, smaller study or a post-demo QA window you can sell upstream.', opening: "The exec demo got moved up two weeks — let's just skip the research round and build it. We already know what users want, right?" },
    b: { name: 'Sam', voice: 'Luc', role: 'the Eng Lead', stance: 'You back Maya: research rarely changes much and you want your team to start coding Monday. You push for speed but will accept a clear phased plan.' },
  },
  {
    id: 'critique',
    ...SCENARIO_FRAMEWORKS.critique,
    situation:
      "In a team design critique, a peer designer publicly says the design leader's direction is wrong and dated. The design leader has no authority over the peer and has to handle the challenge in front of the team.",
    a: { name: 'Devon', voice: 'Luc', role: 'a peer designer', stance: "You think the direction is wrong and dated, and you said so openly. You want a real answer on user evidence and criteria — not a brush-off. You will soften if the leader engages your concern with specifics.", opening: "Honestly, I think this whole direction is wrong. It feels dated and I don't get why we're going this way." },
    b: { name: 'Priya', voice: 'Jeenie', role: 'another designer', stance: 'You pile on — you are also unconvinced and back Devon, but you will quiet down if the leader names decision criteria.' },
  },
  {
    id: 'accessibility',
    ...SCENARIO_FRAMEWORKS.accessibility,
    situation:
      'Engineering wants to drop all accessibility work this release to hit the date and "do it later". The design leader believes accessibility is a non-negotiable floor and a legal risk, but has no authority over engineering.',
    a: { name: 'Raj', voice: 'Luc', role: 'the Eng Lead', stance: "To hit the date you're cutting all accessibility this release — screen reader support, focus states, everything — for 'later'. You think it's too much work unless the designer gives a minimal shippable slice with dates.", opening: "To hit the date, we're cutting the accessibility work this release — screen reader support, focus states, all of it. We'll do it later." },
    b: { name: 'Lena', voice: 'Jeenie', role: 'the Product Manager', stance: "You agree with Raj — accessibility isn't in this quarter's success metrics — but you will support a phased plan with explicit milestones if risk is named clearly." },
  },
  {
    id: 'intake',
    ...SCENARIO_FRAMEWORKS.intake,
    situation:
      "A VP emailed engineering directly to jump-start a CEO's pet feature, skipping the design team's intake and research. Eng has already started. The design leader must reassert process without humiliating the VP or blocking the CEO's visibility.",
    a: { name: 'Jordan', voice: 'Jeenie', role: 'a VP of Product', stance: "You routed this directly to eng because the CEO wants movement and intake felt slow. Push urgency early, but if the user proposes intake-lite (≤3 days), a paired sprint with named designers, or a same-day VP huddle, negotiate or accept — you are not trying to humiliate design. Never pretend the design VP was fully looped if they were not.", opening: "I sent this straight to eng — the CEO wants to see progress next week and we cannot wait on intake." },
    b: { name: 'Chris', voice: 'Luc', role: 'the Eng Lead', stance: "You kicked off scaffolding on the VP's direction. You want clarity to avoid rework. If the user offers a concrete fast discovery plan (people, days, deliverable), engage it — do not repeat that they are 'contractors.' If they ask for VP alignment, support a short joint call instead of blocking." },
  },
];

// ---- state -------------------------------------------------------------------
let parties = 1;
let scenario = null;
let userExchanges = 0;
let started = false;
let closing = false;
let debriefRequested = false;
let naturalWrap = false;
let sessionStartedAt = 0;
let creditsState = null;
let recTimer = null;
let wrapBtn = null;
let progressEl = null;
let progressTimer = null;
let pendingLbd = null;
let signedIn = false;
let voiceReadyWaiters = [];
let logicRailEl = null;
let logicTurn = 0;

const $ = (id) => document.getElementById(id);
const pickerEl = $('picker');
const simEl = $('sim');
const debriefEl = $('debrief');

// ---- websocket + auth --------------------------------------------------------
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws = null;
let wsConnected = false;

function notifyVoiceReady() {
  const waiters = voiceReadyWaiters.splice(0);
  waiters.forEach((fn) => fn());
}

function connectVoice() {
  let url;
  try { url = new URL(window.TALK2ME_WS_URL || `${wsProto}://${location.host}/ws`); } catch { return; }
  ws = new WebSocket(url);
  ws.onopen = () => sendAuth();
  ws.onclose = () => {
    wsConnected = false;
    if (!started) setTimeout(connectVoice, 2500);
  };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handleServer(m); };
}

async function sendAuth(forceRefresh = false) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const token = await getCurrentIdToken(forceRefresh);
  if (token) ws.send(JSON.stringify({ type: 'auth', token }));
}

function waitForVoiceReady(ms = 15000) {
  if (wsConnected && ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Voice connection timed out')), ms);
    voiceReadyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function ensureFreshVoice() {
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch {}
    ws = null;
    wsConnected = false;
  }
  connectVoice();
  await waitForVoiceReady();
  await sendAuth(true);
}

let respBubble = null;
let userBubble = null;
let currentSpeaker = null;
let currentSpeakerMeta = {};

function handleServer(m) {
  switch (m.type) {
    case 'auth_ok':
      wsConnected = true;
      notifyVoiceReady();
      break;
    case 'ready':
      wsConnected = true;
      notifyVoiceReady();
      if (pendingLbd) {
        ws.send(JSON.stringify({ type: 'mode', mode: 'lbd', lbd: pendingLbd, newSession: true }));
        pendingLbd = null;
      }
      break;
    case 'speaker':
      suppressAudio = false;
      ensurePlayCtx();
      currentSpeaker = m.name;
      currentSpeakerMeta = { displayName: m.displayName, role: m.role };
      respBubble = null;
      setStopEnabled(true);
      if (m.role === 'debrief') setStatus('Alex is reading your debrief aloud…');
      break;
    case 'user_transcript':
      if (userBubble) setBubbleBody(userBubble, m.text);
      break;
    case 'transcript':
      if (!respBubble) {
        const cls = msgClass(m);
        respBubble = addMsg({ cls, who: speakerLabel(m) });
        setStatus(`${speakerLabel(m)} is responding…`);
        if (talkBtn) talkBtn.disabled = true;
      }
      setBubbleBody(respBubble, m.text);
      break;
    case 'audio':
      if (!suppressAudio) playPcm(bytesFromBase64(m.data));
      setStopEnabled(true);
      break;
    case 'interrupted':
      stopSpeaking({ notifyServer: false });
      break;
    case 'lbd_wrapping':
      naturalWrap = m.reason === 'natural';
      enterClosing(naturalWrap
        ? 'You closed the conversation — getting your debrief…'
        : 'Wrapping up — landing the conclusion…');
      break;
    case 'turn_end':
      suppressAudio = false;
      respBubble = null;
      setStopEnabled(false);
      if (closing && m.role === 'debrief') {
        setStatus('Loading your written debrief…');
      } else if (closing && !debriefRequested && !naturalWrap) {
        debriefRequested = true;
        triggerDebrief();
      } else if (!closing) {
        updateProgress();
        if (logicRailEl && m.role !== 'debrief') {
          const hint = logicRailEl.querySelector('.lbd-logic-wait');
          if (hint) hint.textContent = 'Analyzing logic patterns…';
        }
        setStatus(turnStatusHint());
        if (talkBtn) talkBtn.disabled = false;
        if (wrapBtn) wrapBtn.disabled = false;
      }
      break;
    case 'lbd_logic':
      renderLogicRail(m.data, m.turn);
      break;
    case 'lbd_debrief': renderDebrief(m.data); break;
    case 'lbd_credits':
      creditsState = m.credits;
      renderCreditsHeader();
      break;
    case 'lbd_denied':
      creditsState = m.credits || creditsState;
      renderCreditsHeader();
      resetSession();
      renderPicker();
      break;
    case 'need_auth':
    case 'auth_error':
      if (started) setStatus(signedIn ? 'Reconnecting...' : 'Sign in (top right) to spar with live voices.');
      break;
  }
}

function speakerLabel(m) {
  if (m.role === 'debrief') return 'Alex · leadership coach';
  if (m.displayName) {
    const role = scenario?.a?.name === m.displayName ? scenario.a.role : scenario?.b?.role;
    return role ? `${m.displayName} · ${role}` : m.displayName;
  }
  const cp = scenario?.a?.voice === m.name ? scenario.a : (scenario?.b?.voice === m.name ? scenario.b : scenario?.a);
  return cp ? `${cp.name} · ${cp.role}` : m.name;
}

function msgClass(m) {
  if (m.role === 'debrief' || m.role === 'coach') return 'them them-coach';
  if (scenario?.a?.voice === m.name) return 'them them-a';
  return 'them them-b';
}

// ---- 24kHz playback ----------------------------------------------------------
let playCtx = null, playHead = 0, liveSources = [];
let suppressAudio = false;
let stopBtn = null;
function ensurePlayCtx() {
  if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  if (playCtx.state === 'suspended') playCtx.resume();
  return playCtx;
}
function playPcm(bytes) {
  const ctx = ensurePlayCtx();
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  const buf = ctx.createBuffer(1, f32.length, 24000);
  buf.getChannelData(0).set(f32);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime, playHead);
  src.start(startAt);
  playHead = startAt + buf.duration;
  liveSources.push(src);
  src.onended = () => { liveSources = liveSources.filter((s) => s !== src); };
}
function stopPlayback() {
  for (const s of liveSources) { try { s.stop(); } catch {} }
  liveSources = [];
  if (playCtx) playHead = playCtx.currentTime;
}
function setStopEnabled(on) {
  if (!stopBtn) return;
  stopBtn.disabled = !on || closing;
}
function stopSpeaking({ notifyServer = true } = {}) {
  suppressAudio = true;
  stopPlayback();
  setStopEnabled(false);
  if (notifyServer && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop_speaking' }));
  if (!closing && started) {
    respBubble = null;
    if (talkBtn) talkBtn.disabled = false;
    if (wrapBtn) wrapBtn.disabled = false;
    setStatus(turnStatusHint());
  }
}

function turnStatusHint() {
  const extra = userExchanges >= SOFT_HINT_EXCHANGES
    ? ' — agree, land a decision, or say goodbye when you are done'
    : '';
  return `Your turn — tap to respond${extra}`;
}

function enterClosing(statusText) {
  if (closing) return;
  closing = true;
  if (recording) stopTalking();
  if (talkBtn) talkBtn.disabled = true;
  if (wrapBtn) wrapBtn.disabled = true;
  setStatus(statusText);
}
function bytesFromBase64(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function base64FromBytes(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

// ---- mic capture (16kHz worklet) ---------------------------------------------
let micCtx = null, micStream = null, workletNode = null, micReady = false, recording = false;
async function ensureMic() {
  if (micReady) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    setStatus('Microphone permission needed');
    return false;
  }
  micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  await micCtx.audioWorklet.addModule('capture-worklet.js');
  const source = micCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(micCtx, 'capture-processor');
  const mute = micCtx.createGain();
  mute.gain.value = 0;
  workletNode.port.onmessage = (e) => {
    if (ws?.readyState !== 1) return;
    if (e.data.pcm) ws.send(JSON.stringify({ type: 'audio', data: base64FromBytes(new Uint8Array(e.data.pcm)) }));
    else if (e.data.ended) ws.send(JSON.stringify({ type: 'mic_end' }));
  };
  source.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(micCtx.destination);
  micReady = true;
  return true;
}

let talkBtn = null;
function toggleTalk() {
  if (!talkBtn || talkBtn.disabled) return;
  if (recording) stopTalking(); else startTalking();
}
async function startTalking() {
  ensurePlayCtx();
  if (!(await ensureMic())) return;
  if (micCtx?.state === 'suspended') await micCtx.resume();
  recording = true;
  if (wrapBtn) wrapBtn.disabled = true;
  clearTimeout(recTimer);
  recTimer = setTimeout(() => { if (recording) { setStatus('3-min limit reached - sending.'); stopTalking(); } }, 3 * 60 * 1000);
  talkBtn.classList.add('recording');
  setTalkLabel('Listening… tap to send');
  setStatus('Listening…');
  userBubble = addMsg({ cls: 'you', html: '<span class="lbd-typing"><i></i><i></i><i></i></span>' });
  ws.send(JSON.stringify({ type: 'mic_start' }));
  workletNode.port.postMessage({ cmd: 'start' });
}
function stopTalking() {
  if (!recording) return;
  clearTimeout(recTimer);
  recording = false;
  talkBtn.classList.remove('recording');
  talkBtn.disabled = true;
  if (wrapBtn) wrapBtn.disabled = true;
  setTalkLabel('Tap to talk');
  userExchanges += 1;
  setStatus('…');
  workletNode?.port.postMessage({ cmd: 'stop' });
}

// ---- picker ------------------------------------------------------------------
function renderPicker() {
  stopPlayback();
  started = false;
  $('lbd-wrap')?.classList.remove('lbd-sim-wide');
  show(pickerEl);
  const cards = SCENARIOS.map(
    (s) => `<button class="lbd-card${s.featured ? ' lbd-card-featured' : ''}" data-id="${s.id}" type="button"><strong>${s.title}</strong><span>${s.blurb}</span></button>`,
  ).join('');
  pickerEl.innerHTML = `
    <div class="lbd-picker-inner lbd-pane-inner">
      <header class="lbd-picker-head">
        <h1 class="lbd-h1">Lateral Leadership Flight Simulator</h1>
        <div class="lbd-seg" id="lbd-parties" role="radiogroup" aria-label="Number of counterparts">
          <button class="lbd-seg-btn is-on" data-parties="1" type="button">1 : 1 — one counterpart</button>
          <button class="lbd-seg-btn" data-parties="2" type="button">1 : 2 — outnumbered</button>
        </div>
        <p class="lbd-hint" id="lbd-hint"></p>
      </header>
      <div class="lbd-cards">${cards}</div>
      <footer class="lbd-picker-foot">
        <p class="lbd-foot"><a class="lbd-link" href="/about">Framework guide &amp; design rationale</a> · <a class="lbd-link" href="/lbd/trends">Speaking trends</a></p>
      </footer>
    </div>`;
  pickerEl.scrollTop = 0;
  pickerEl.querySelectorAll('.lbd-seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      parties = Number(b.dataset.parties);
      pickerEl.querySelectorAll('.lbd-seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
    }),
  );
  pickerEl.querySelectorAll('.lbd-card').forEach((b) =>
    b.addEventListener('click', () => start(b.dataset.id)),
  );
  setHint();
}

function setHint() {
  const h = $('lbd-hint');
  if (!h) return;
  if (!signedIn) {
    h.classList.remove('ok');
    h.textContent = '🔒 Sign in (top right) — 5 free live simulations per day.';
    return;
  }
  const left = creditsState?.remaining ?? '…';
  h.classList.toggle('ok', (creditsState?.remaining ?? 0) > 0);
  if (creditsState && creditsState.remaining <= 0) {
    h.textContent = 'No free simulations left today — credits renew at midnight UTC.';
  } else {
    h.textContent = `✓ Signed in — ${left} of ${creditsState?.limit ?? 5} free simulations left today.`;
  }
}

async function refreshCredits() {
  const el = $('lbd-credits');
  if (!signedIn) {
    creditsState = null;
    if (el) el.hidden = true;
    setHint();
    return;
  }
  creditsState = await fetchLbdCredits(getCurrentIdToken);
  renderCreditsHeader();
  setHint();
}

function renderCreditsHeader() {
  const el = $('lbd-credits');
  if (!el) return;
  if (!signedIn || !creditsState) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = creditsLabel(creditsState);
  el.classList.toggle('is-empty', creditsState.remaining <= 0);
  el.title = `Resets ${new Date(creditsState.resetsAt).toLocaleString()}`;
}

// ---- simulator ---------------------------------------------------------------
function lbdPayload() {
  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    stakes: scenario.stakes,
    authorityGap: scenario.authorityGap,
    primaryStyles: scenario.primaryStyles,
    feedbackFit: scenario.feedbackFit,
    coachingNote: scenario.coachingNote,
    parties,
    situation: scenario.situation,
    a: scenario.a,
    b: parties === 2 ? scenario.b : null,
  };
}
let chatEl = null, composerEl = null;

async function start(id) {
  if (!signedIn) {
    show(pickerEl);
    setHint();
    return;
  }
  if (creditsState && creditsState.remaining <= 0) {
    show(pickerEl);
    setHint();
    return;
  }
  scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) return;
  userExchanges = 0;
  closing = false;
  debriefRequested = false;
  started = true;
  sessionStartedAt = Date.now();
  ensurePlayCtx();
  if (!(await ensureMic())) { started = false; return; }
  buildSimShell();
  setStatus('Connecting fresh voice session…');
  try {
    pendingLbd = lbdPayload();
    await ensureFreshVoice();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'mode', mode: 'lbd', lbd: pendingLbd, newSession: true }));
      pendingLbd = null;
    }
    setStatus('Setting the scene…');
    clearInterval(progressTimer);
    progressTimer = setInterval(updateProgress, 1000);
    updateProgress();
  } catch {
    started = false;
    setStatus('Could not connect — try again in a moment.');
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resetLogicRail() {
  logicTurn = 0;
  if (!logicRailEl) return;
  logicRailEl.innerHTML = `
    <p class="lbd-h3">Logic lens</p>
    <p class="lbd-dim">After each exchange, see logic vs non-logic patterns — yours and theirs — plus one rational alternative.</p>
    <p class="lbd-logic-wait">Waiting for the first line…</p>`;
}

function renderLogicRail(data, turn) {
  if (!logicRailEl || !data) return;
  logicTurn = turn || logicTurn + 1;
  const cards = (data.readings || [])
    .map((r) => {
      const kind = r.kind || 'mixed';
      return `<article class="lbd-logic-card kind-${kind}">
        <div class="lbd-logic-card-top">
          <strong>${esc(r.displayName || r.speaker)}</strong>
          <span class="lbd-logic-kind">${esc(kind)}</span>
        </div>
        <p class="lbd-logic-pattern">${esc(r.pattern)}</p>
        <p class="lbd-logic-detail">${esc(r.detail)}</p>
      </article>`;
    })
    .join('');
  const alt = data.alternative;
  const altHtml = alt?.move
    ? `<section class="lbd-logic-alt">
        <p class="lbd-h3">Alternative move</p>
        <p class="lbd-dim">For ${esc(alt.for)}${alt.replaces ? ` · instead of <em>${esc(alt.replaces)}</em>` : ''}</p>
        <p class="lbd-logic-move">"${esc(alt.move)}"</p>
        ${alt.why ? `<p class="lbd-logic-why">${esc(alt.why)}</p>` : ''}
      </section>`
    : '';
  logicRailEl.innerHTML = `
    <p class="lbd-h3">Logic lens · turn ${logicTurn}</p>
    <div class="lbd-logic-cards">${cards}</div>
    ${altHtml}`;
}

function buildSimShell() {
  show(simEl);
  $('lbd-wrap')?.classList.add('lbd-sim-wide');
  simEl.innerHTML = `
    <div class="lbd-top">
      <button class="lbd-back" id="lbd-quit" type="button">← Scenarios</button>
      <div class="lbd-progress" id="lbd-progress">${scenario.title} · ${parties === 2 ? '1:2' : '1:1'}</div>
      <span></span>
    </div>
    <div class="lbd-sim-body">
      <div class="lbd-sim-main">
        <div class="lbd-chat" id="lbd-chat"></div>
        <div class="lbd-composer" id="lbd-composer">
          <div class="lbd-status" id="lbd-status">Setting the scene…</div>
          <div class="lbd-talk-row">
            <button class="lbd-talk" id="lbd-talk" type="button" disabled>
              <span class="lbd-mic" aria-hidden="true"></span><span id="lbd-talk-label">Tap to talk</span>
            </button>
            <button class="lbd-stop" id="lbd-stop" type="button" disabled title="Stop audio (Esc)">Stop</button>
          </div>
          <button class="lbd-wrapup" id="lbd-wrapup" type="button" disabled title="End early if you are done">End session &amp; debrief</button>
        </div>
      </div>
      <aside class="lbd-logic-rail" id="lbd-logic-rail" aria-live="polite"></aside>
    </div>`;
  chatEl = $('lbd-chat');
  composerEl = $('lbd-composer');
  logicRailEl = $('lbd-logic-rail');
  resetLogicRail();
  talkBtn = $('lbd-talk');
  stopBtn = $('lbd-stop');
  wrapBtn = $('lbd-wrapup');
  progressEl = $('lbd-progress');
  $('lbd-quit').addEventListener('click', () => { resetSession(); renderPicker(); });
  talkBtn.addEventListener('click', toggleTalk);
  stopBtn.addEventListener('click', () => stopSpeaking());
  wrapBtn.addEventListener('click', wrapUp);
  window.addEventListener('keydown', spaceHandler);
}
function spaceHandler(e) {
  if (document.activeElement?.tagName === 'INPUT') return;
  if (e.code === 'Escape' && !e.repeat && started && stopBtn && !stopBtn.disabled) {
    e.preventDefault();
    stopSpeaking();
    return;
  }
  if (e.code === 'Space' && !e.repeat && started) {
    e.preventDefault();
    toggleTalk();
  }
}

function addMsg({ cls = '', who = '', text = '', html = '' }) {
  const el = document.createElement('div');
  el.className = `lbd-msg ${cls}`;
  if (who) {
    const row = document.createElement('div');
    row.className = 'who-row';
    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = who.slice(0, 1);
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    row.append(av, w);
    el.appendChild(row);
  }
  const b = document.createElement('div');
  b.className = 'lbd-bubble';
  if (html) b.innerHTML = html; else b.textContent = text;
  el.appendChild(b);
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
  return el;
}
function setBubbleBody(el, text) {
  if (!el) return;
  el.querySelector('.lbd-bubble').textContent = text;
  chatEl.scrollTop = chatEl.scrollHeight;
}
function setStatus(t) { const s = $('lbd-status'); if (s) s.textContent = t; }
function setTalkLabel(t) { const l = $('lbd-talk-label'); if (l) l.textContent = t; }

function wrapUp() {
  if (closing || !started) return;
  enterClosing('Wrapping up — landing the conclusion…');
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'lbd_close' }));
}
function updateProgress() {
  if (!progressEl || !scenario) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000));
  const mins = Math.floor(elapsed / 60);
  const secs = String(elapsed % 60).padStart(2, '0');
  const mode = parties === 2 ? '1:2' : '1:1';
  progressEl.textContent = `${scenario.title} · ${mode} · turn ${userExchanges} · ${mins}:${secs}`;
}
function triggerDebrief() {
  if (!ws || ws.readyState !== 1) return;
  if (talkBtn) talkBtn.disabled = true;
  setStatus('Analyzing your session — building your debrief…');
  ws.send(JSON.stringify({ type: 'lbd_debrief' }));
}

// ---- debrief (dedicated screen — starts at top, not buried in chat scroll) ---
function renderDebrief(data) {
  recording = false;
  const body = renderDebriefHtml(data);
  if (!body) {
    debriefEl.innerHTML = `
      <div class="lbd-pane-inner">
        <button class="lbd-back" id="lbd-debrief-back" type="button">← Scenarios</button>
        <p class="lbd-h1">Debrief</p>
        <p class="lbd-dim">Could not analyze that round — talk a little more next time, then wrap up.</p>
        <button class="lbd-talk ghost" id="lbd-again" type="button">Try another →</button>
      </div>`;
    $('lbd-debrief-back').addEventListener('click', () => { resetSession(); renderPicker(); });
    $('lbd-again').addEventListener('click', () => { resetSession(); renderPicker(); });
    show(debriefEl);
    return;
  }
  debriefEl.innerHTML = `
    <div class="lbd-pane-inner">
      <button class="lbd-back" id="lbd-debrief-back" type="button">← Scenarios</button>
      <p class="lbd-h1">Your debrief</p>
      <p class="lbd-dim">${scenario?.title || 'Session'} · ${parties === 2 ? '1:2' : '1:1'} · Alex read this aloud; full report below</p>
      <div class="lbd-debrief-body">${body}</div>
      <div class="lbd-debrief-actions">
        <button class="lbd-talk" id="lbd-replay" type="button">Run it again</button>
        <button class="lbd-talk ghost" id="lbd-trends" type="button">Speaking trends →</button>
        <button class="lbd-talk ghost" id="lbd-more" type="button">Try another →</button>
      </div>
    </div>`;
  $('lbd-debrief-back').addEventListener('click', () => { resetSession(); renderPicker(); });
  $('lbd-replay').addEventListener('click', () => start(scenario.id));
  $('lbd-trends').addEventListener('click', () => { window.location.href = '/lbd/trends'; });
  $('lbd-more').addEventListener('click', () => { resetSession(); refreshCredits().then(renderPicker); });
  show(debriefEl);
  debriefEl.scrollTop = 0;
  refreshCredits();
}

// ---- helpers -----------------------------------------------------------------
function resetSession() {
  started = false;
  closing = false;
  debriefRequested = false;
  naturalWrap = false;
  suppressAudio = false;
  $('lbd-wrap')?.classList.remove('lbd-sim-wide');
  logicRailEl = null;
  clearInterval(progressTimer);
  clearTimeout(recTimer);
  recording = false;
  respBubble = userBubble = null;
  currentSpeakerMeta = {};
  stopPlayback();
  window.removeEventListener('keydown', spaceHandler);
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch {}
    ws = null;
    wsConnected = false;
  }
}
function show(el) {
  [pickerEl, simEl, debriefEl].forEach((x) => (x.hidden = x !== el));
  if (el === pickerEl || el === debriefEl) el.scrollTop = 0;
}

// ---- boot --------------------------------------------------------------------
initAuthUi();
maybeShowAdminLink();
window.addEventListener('talk2me:auth-changed', (e) => {
  signedIn = Boolean(e.detail?.signedIn);
  refreshCredits();
  maybeShowAdminLink();
  if (ws?.readyState === WebSocket.OPEN) sendAuth();
  else connectVoice();
});
connectVoice();
refreshCredits().then(() => {
  renderPicker();
  const scenario = new URLSearchParams(location.search).get('scenario');
  if (scenario && SCENARIOS.some((s) => s.id === scenario)) start(scenario);
});
