import { getCurrentIdToken, initAuthUi } from './firebase-client.js';

// Conflict & Feedback Simulator — a spoken leadership "flight simulator". You
// talk (no multiple choice); Luc & Jeenie role-play the counterpart(s) and push
// back in real voice; after a few rounds you get a debrief that classifies your
// conflict style and shows how other styles would have handled the same moments.

const MAX_EXCHANGES = 4; // auto-debrief after roughly this many of your turns

const SCENARIOS = [
  {
    id: 'deadline',
    title: 'The Deadline Squeeze',
    blurb: 'A PM wants to cut research and QA to hit a moved-up demo. Hold the line — or trade.',
    situation:
      'A design leader is trying to protect the research and design-QA process. The product manager wants to cut it to hit an exec demo that just moved up two weeks. The deadline is fixed; the design leader has no authority over the PM.',
    a: { name: 'Maya', role: 'the Product Manager', stance: 'You moved the exec demo up two weeks and you want to cut the user-research round and the design-QA pass to make it. You think research rarely changes the answer. You will defend the date hard.', opening: "The exec demo got moved up two weeks — let's just skip the research round and build it. We already know what users want, right?" },
    b: { name: 'Sam', role: 'the Eng Lead', stance: 'You back Maya: research rarely changes much and you want your team to start coding Monday. You push for speed.' },
  },
  {
    id: 'critique',
    title: 'Critique Crossfire',
    blurb: 'A peer publicly trashes your design direction in a crit. The room is watching.',
    situation:
      "In a team design critique, a peer designer publicly says the design leader's direction is wrong and dated. The design leader has no authority over the peer and has to handle the challenge in front of the team.",
    a: { name: 'Devon', role: 'a peer designer', stance: "You think the design leader's direction is wrong and feels dated, and you said so openly in the crit. You hold your critique and want a real answer, not a brush-off.", opening: "Honestly, I think this whole direction is wrong. It feels dated and I don't get why we're going this way." },
    b: { name: 'Priya', role: 'another designer', stance: 'You pile on — you are also unconvinced by the direction and back Devon.' },
  },
  {
    id: 'accessibility',
    title: 'The Scope Cut',
    blurb: 'Engineering wants to drop all accessibility to hit the date. Where is your line?',
    situation:
      'Engineering wants to drop all accessibility work this release to hit the date and "do it later". The design leader believes accessibility is a non-negotiable floor and a legal risk, but has no authority over engineering.',
    a: { name: 'Raj', role: 'the Eng Lead', stance: "To hit the date you're cutting all accessibility this release — screen reader support, focus states, everything — and doing it 'later'. You think it's not worth the time right now.", opening: "To hit the date, we're cutting the accessibility work this release — screen reader support, focus states, all of it. We'll do it later." },
    b: { name: 'Lena', role: 'the Product Manager', stance: "You agree with Raj — accessibility isn't in this quarter's success metrics, so it can wait." },
  },
];

const FRAMEWORKS = {
  Fighter: 'competes / forces',
  Negotiator: 'collaborates to a win-win',
  Diplomat: 'accommodates strategically',
  Avoider: 'withdraws / defers',
  'People Pleaser': 'caves to keep the peace',
  SBI: 'Situation-Behavior-Impact',
  AID: 'Action-Impact-Desired',
  'Radical Candor': 'care personally + challenge directly',
};

// ---- state -------------------------------------------------------------------
let parties = 1;
let scenario = null;
let userExchanges = 0;
let started = false;
let awaitingDebrief = false;
let signedIn = false;

const $ = (id) => document.getElementById(id);
const pickerEl = $('picker');
const simEl = $('sim');
const debriefEl = $('debrief');

// ---- websocket + auth --------------------------------------------------------
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws = null;
let wsConnected = false;

function connectVoice() {
  let url;
  try { url = new URL(window.TALK2ME_WS_URL || `${wsProto}://${location.host}/ws`); } catch { return; }
  ws = new WebSocket(url);
  ws.onopen = () => sendAuth();
  ws.onclose = () => { wsConnected = false; setTimeout(connectVoice, 2500); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handleServer(m); };
}
async function sendAuth() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const token = await getCurrentIdToken();
  if (token) ws.send(JSON.stringify({ type: 'auth', token }));
}

let respBubble = null;
let userBubble = null;
let currentSpeaker = null;

function handleServer(m) {
  switch (m.type) {
    case 'auth_ok': wsConnected = true; break;
    case 'ready': wsConnected = true; break;
    case 'speaker':
      currentSpeaker = m.name;
      respBubble = null; // a new counterpart bubble starts on the first transcript chunk
      setStatus(`${counterpartName(m.name)} is responding…`);
      talkBtn && (talkBtn.disabled = true);
      break;
    case 'user_transcript':
      if (userBubble) setBubbleBody(userBubble, m.text);
      break;
    case 'transcript':
      if (!respBubble) respBubble = addMsg({ cls: m.name === 'Jeenie' ? 'them them-b' : 'them them-a', who: counterpartName(m.name) });
      setBubbleBody(respBubble, m.text);
      break;
    case 'audio': playPcm(bytesFromBase64(m.data)); break;
    case 'turn_end':
      respBubble = null;
      if (awaitingDebrief || userExchanges >= MAX_EXCHANGES) {
        triggerDebrief();
      } else {
        setStatus('Your turn — tap to respond');
        if (talkBtn) talkBtn.disabled = false;
      }
      break;
    case 'lbd_debrief': renderDebrief(m.data); break;
    case 'need_auth':
    case 'auth_error':
      if (started) setStatus('Sign in (top right) to spar with live voices.');
      break;
  }
}

function counterpartName(voice) {
  const cp = voice === 'Jeenie' ? scenario?.b : scenario?.a;
  return cp ? `${cp.name} · ${cp.role}` : voice;
}

// ---- 24kHz playback ----------------------------------------------------------
let playCtx = null, playHead = 0, liveSources = [];
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
  talkBtn.classList.add('recording');
  setTalkLabel('Listening… tap to send');
  setStatus('Listening…');
  userBubble = addMsg({ cls: 'you', html: '<span class="lbd-typing"><i></i><i></i><i></i></span>' });
  ws.send(JSON.stringify({ type: 'mic_start' }));
  workletNode.port.postMessage({ cmd: 'start' });
}
function stopTalking() {
  if (!recording) return;
  recording = false;
  talkBtn.classList.remove('recording');
  talkBtn.disabled = true;
  setTalkLabel('Tap to talk');
  userExchanges += 1;
  if (userExchanges >= MAX_EXCHANGES) awaitingDebrief = true;
  setStatus('…');
  workletNode?.port.postMessage({ cmd: 'stop' });
}

// ---- picker ------------------------------------------------------------------
function renderPicker() {
  stopPlayback();
  started = false;
  show(pickerEl);
  const cards = SCENARIOS.map(
    (s) => `<button class="lbd-card" data-id="${s.id}" type="button"><strong>${s.title}</strong><span>${s.blurb}</span></button>`,
  ).join('');
  pickerEl.innerHTML = `
    <h1 class="lbd-h1">Conflict &amp; Feedback Simulator</h1>
    <p class="lbd-sub">Rehearse lateral leadership out loud. You speak; Luc &amp; Jeenie role-play the counterpart and push back. After a few rounds you get a debrief on your conflict style.</p>
    <div class="lbd-seg" role="radiogroup" aria-label="Number of counterparts">
      <button class="lbd-seg-btn is-on" data-parties="1" type="button">1 : 1 — one counterpart</button>
      <button class="lbd-seg-btn" data-parties="2" type="button">1 : 2 — outnumbered</button>
    </div>
    <div class="lbd-cards">${cards}</div>
    <p class="lbd-hint" id="lbd-hint"></p>
    <p class="lbd-foot">You'll be scored against: Fighter · Negotiator · Diplomat · Avoider · People&nbsp;Pleaser · SBI · AID · Radical&nbsp;Candor</p>`;
  pickerEl.querySelectorAll('.lbd-seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      parties = Number(b.dataset.parties);
      pickerEl.querySelectorAll('.lbd-seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
    }),
  );
  pickerEl.querySelectorAll('.lbd-card').forEach((b) => b.addEventListener('click', () => start(b.dataset.id)));
  $('lbd-hint').textContent = signedIn ? '' : 'Sign in (top right) to start — the counterparts use live voice.';
}

// ---- simulator ---------------------------------------------------------------
function lbdPayload() {
  return { parties, situation: scenario.situation, a: scenario.a, b: parties === 2 ? scenario.b : null };
}
let chatEl = null, composerEl = null;

async function start(id) {
  if (!signedIn) { $('lbd-hint').textContent = 'Sign in (top right) first — the counterparts use live voice.'; return; }
  scenario = SCENARIOS.find((s) => s.id === id);
  userExchanges = 0;
  awaitingDebrief = false;
  started = true;
  ensurePlayCtx();
  if (!(await ensureMic())) { started = false; return; }
  buildSimShell();
  setStatus('Setting the scene…');
  await sendAuth();
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mode', mode: 'lbd', lbd: lbdPayload() }));
}

function buildSimShell() {
  show(simEl);
  simEl.innerHTML = `
    <div class="lbd-top">
      <button class="lbd-back" id="lbd-quit" type="button">← Scenarios</button>
      <div class="lbd-progress">${scenario.title} · ${parties === 2 ? '1:2' : '1:1'}</div>
      <span></span>
    </div>
    <div class="lbd-chat" id="lbd-chat"></div>
    <div class="lbd-composer" id="lbd-composer">
      <div class="lbd-status" id="lbd-status">Setting the scene…</div>
      <button class="lbd-talk" id="lbd-talk" type="button" disabled>
        <span class="lbd-mic" aria-hidden="true"></span><span id="lbd-talk-label">Tap to talk</span>
      </button>
    </div>`;
  chatEl = $('lbd-chat');
  composerEl = $('lbd-composer');
  talkBtn = $('lbd-talk');
  $('lbd-quit').addEventListener('click', () => { resetSession(); renderPicker(); });
  talkBtn.addEventListener('click', toggleTalk);
  window.addEventListener('keydown', spaceHandler);
}
function spaceHandler(e) {
  if (e.code === 'Space' && !e.repeat && started && document.activeElement?.tagName !== 'INPUT') {
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
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}
function setBubbleBody(el, text) {
  if (!el) return;
  el.querySelector('.lbd-bubble').textContent = text;
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
function setStatus(t) { const s = $('lbd-status'); if (s) s.textContent = t; }
function setTalkLabel(t) { const l = $('lbd-talk-label'); if (l) l.textContent = t; }

function triggerDebrief() {
  if (!ws || ws.readyState !== 1) return;
  awaitingDebrief = false;
  if (talkBtn) talkBtn.disabled = true;
  setStatus('That’s a wrap — analyzing how you handled it…');
  ws.send(JSON.stringify({ type: 'lbd_debrief' }));
}

// ---- debrief -----------------------------------------------------------------
function renderDebrief(data) {
  recording = false;
  if (!data) {
    addMsg({ cls: 'coach', who: 'Debrief', text: 'Could not analyze that round — talk a little more next time, then wrap up.' });
    composerEl.innerHTML = `<button class="lbd-talk ghost" id="lbd-again" type="button">Try another →</button>`;
    $('lbd-again').addEventListener('click', () => { resetSession(); renderPicker(); });
    return;
  }
  const moments = (data.moments || [])
    .map((m) => `<li><span class="lbd-tag lbd-${(m.style || '').replace(/\W/g, '')}">${m.style || ''}</span> <span class="lbd-q">“${m.quote || ''}”</span><span class="lbd-note">${m.note || ''}</span></li>`)
    .join('');
  const alts = (data.alternatives || [])
    .map((a) => `<li><span class="lbd-tag lbd-${(a.style || '').replace(/\W/g, '')}">${a.style || ''}</span> ${a.example || ''}</li>`)
    .join('');
  addMsg({ cls: 'coach', who: 'Debrief', html:
    `<p class="lbd-score">You were mostly a <strong>${data.dominant || '—'}</strong></p>
     <p class="lbd-dim">${FRAMEWORKS[data.dominant] ? '(' + FRAMEWORKS[data.dominant] + ')' : ''}</p>
     <p>${data.summary || ''}</p>
     ${moments ? `<p class="lbd-h3">Key moments</p><ul class="lbd-recap">${moments}</ul>` : ''}
     ${alts ? `<p class="lbd-h3">How other types would play it</p><ul class="lbd-recap alts">${alts}</ul>` : ''}` });
  composerEl.innerHTML = `
    <button class="lbd-talk" id="lbd-replay" type="button">Run it again</button>
    <button class="lbd-talk ghost" id="lbd-more" type="button">Try another →</button>`;
  $('lbd-replay').addEventListener('click', () => start(scenario.id));
  $('lbd-more').addEventListener('click', () => { resetSession(); renderPicker(); });
}

// ---- helpers -----------------------------------------------------------------
function resetSession() {
  started = false;
  awaitingDebrief = false;
  recording = false;
  respBubble = userBubble = null;
  stopPlayback();
  window.removeEventListener('keydown', spaceHandler);
}
function show(el) {
  [pickerEl, simEl, debriefEl].forEach((x) => (x.hidden = x !== el));
  window.scrollTo(0, 0);
}

// ---- boot --------------------------------------------------------------------
initAuthUi();
window.addEventListener('talk2me:auth-changed', (e) => {
  signedIn = Boolean(e.detail?.signedIn);
  const hint = $('lbd-hint');
  if (hint) hint.textContent = signedIn ? '' : 'Sign in (top right) to start — the counterparts use live voice.';
  if (ws?.readyState === WebSocket.OPEN) sendAuth();
  else connectVoice();
});
connectVoice();
renderPicker();
