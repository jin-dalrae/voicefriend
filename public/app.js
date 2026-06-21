import { getCurrentIdToken, getDisplayName, initAuthUi } from './firebase-client.js';
import { syncAdminNav } from './admin-nav.js';

// ---- websocket ---------------------------------------------------------------
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws;

async function connect() {
  const wsUrl = new URL(window.TALK2ME_WS_URL || `${proto}://${location.host}/ws`);

  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setStatus('Connecting to your friends…');
    sendAuthIfAvailable();
  };
  ws.onclose = () => {
    setStatus('Disconnected. Reconnecting…');
    talkBtn.disabled = true;
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => handleServer(JSON.parse(ev.data));
}

window.addEventListener('talk2me:auth-changed', (e) => {
  signedIn = Boolean(e.detail?.signedIn);
  updateGate();
  syncAdminNav();
  // Auth is sent as an in-band message over the socket, so an auth change never
  // requires a new connection — just push the current token over the live one.
  // The old code closed the socket on every auth event, including Firebase's
  // initial onAuthStateChanged that fires once on load, which flashed
  // "Disconnected. Reconnecting…" and spun up a throwaway second Live session
  // on every page load.
  if (ws?.readyState === WebSocket.OPEN) {
    sendAuthIfAvailable();
  } else if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    wsReady = false;
    connect();
  }
  // CONNECTING: leave it — its onopen handler already calls sendAuthIfAvailable().
});

function handleServer(m) {
  switch (m.type) {
    case 'ready':
      wsReady = true;
      if (!started) {
        updateGate();
      } else {
        talkBtn.disabled = false;
        setStatus('Ready — tap to talk');
      }
      break;
    case 'need_auth':
      // Relay won't open the coaches until a verified token arrives. If we're
      // signed in, (re)send it; otherwise the gate shows the sign-in prompt.
      if (signedIn) sendAuthIfAvailable();
      else updateGate();
      break;
    case 'speaker':
      currentSpeaker = m.name;
      respBubble = null; // new responder bubble created on first transcript chunk
      setStatus(`${m.name} is thinking…`, `speaking-${m.name}`);
      break;
    case 'user_transcript':
      setBubbleText(userBubble, m.text);
      break;
    case 'transcript':
      if (!respBubble) respBubble = addBubble(m.name, m.name);
      setBubbleText(respBubble, m.text);
      setStatus(`${m.name} is speaking…`, `speaking-${m.name}`);
      break;
    case 'searching':
      setStatus(`${m.name} is looking that up...`, `speaking-${m.name}`);
      break;
    case 'audio':
      playPcm(bytesFromBase64(m.data));
      break;
    case 'interrupted':
      stopPlayback();
      break;
    case 'turn_end':
      talkBtn.disabled = false;
      setStatus('Ready — tap to talk');
      break;
    case 'error':
      talkBtn.disabled = false; // don't strand the user mid-turn on an error
      setStatus(m.message);
      break;
    case 'auth_ok':
      break;
    case 'auth_error':
      setStatus(m.message);
      break;
    case 'account':
      // Prefill saved fields (resume persists on the account across sessions).
      if (m.resume && resumeInput && !resumeInput.value) resumeInput.value = m.resume;
      break;
  }
}

// ---- UI ----------------------------------------------------------------------
const welcomeEl = document.getElementById('welcome');
const callEl = document.getElementById('call');
const transcriptEl = document.getElementById('transcript');
const statusEl = document.getElementById('status');
const talkBtn = document.getElementById('talk');
const startBtn = document.getElementById('start');
const backBtn = document.getElementById('back');
const nameInline = document.getElementById('name-inline');
const welcomeHint = document.getElementById('welcome-hint');
const welcomeAuthEl = document.getElementById('welcome-auth');
const welcomeAccountEl = document.getElementById('welcome-account');

let currentSpeaker = null;
let userBubble = null;
let respBubble = null;
let started = false;
let wsReady = false;
let signedIn = false;

initAuthUi();
updateGate();
syncAdminNav();

// Welcome-screen gate: require sign-in before a session can start. The name now
// comes from the account, not a per-visit field.
function updateGate() {
  if (started) return;
  if (welcomeAuthEl) welcomeAuthEl.hidden = signedIn;
  if (welcomeAccountEl) welcomeAccountEl.hidden = !signedIn;
  if (!signedIn) {
    startBtn.hidden = true;
    if (welcomeHint) welcomeHint.textContent = 'Sign in above to start practicing.';
    return;
  }
  if (wsReady) {
    startBtn.hidden = false;
    if (welcomeHint) welcomeHint.textContent = 'Luc & Jeenie will ask you something to kick things off';
  } else {
    startBtn.hidden = true;
    if (welcomeHint) welcomeHint.textContent = 'Connecting…';
  }
}

async function sendAuthIfAvailable() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const token = await getCurrentIdToken();
  if (token) ws.send(JSON.stringify({ type: 'auth', token }));
}

// First gesture: unlock audio, prime the mic, and ask the coaches to open.
startBtn.addEventListener('click', async () => {
  const name = getDisplayName();
  nameInline.textContent = name ? `, ${name}` : '';
  welcomeEl.hidden = true;
  callEl.hidden = false;
  startBtn.hidden = true;
  ensurePlayCtx();
  const ok = await ensureMic();
  if (!ok) {
    startBtn.hidden = false;
    return;
  }
  if (micCtx?.state === 'suspended') await micCtx.resume();

  talkBtn.disabled = !wsReady;
  setStatus(wsReady ? 'Ready — tap to talk' : 'Starting…');

  if (!started && ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'begin' }));
    started = true;
  }
});

backBtn.addEventListener('click', () => {
  callEl.hidden = true;
  welcomeEl.hidden = false;
  startBtn.hidden = false;
});

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
  if (text === 'Ready — tap to talk' || text === 'Ready when you are') {
    resetTalkButtonLabel();
  }
}

function addBubble(cls, who) {
  const el = document.createElement('div');
  el.className = `bubble ${cls}`;

  if (who && who !== 'You') {
    const row = document.createElement('div');
    row.className = 'who-row';

    const avatar = document.createElement('span');
    avatar.className = 'mini-avatar';
    avatar.textContent = who.slice(0, 1);
    row.appendChild(avatar);

    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    row.appendChild(w);

    el.appendChild(row);
  }

  const body = document.createElement('span');
  body.className = 'body bubble-inner';
  el.appendChild(body);

  // The user side is Gemini's input transcription, which is rougher than what
  // the model actually hears — label it so it's clearly not an exact record.
  if (who === 'You') {
    const note = document.createElement('span');
    note.className = 'approx-note';
    note.textContent = '≈ rough transcript';
    el.appendChild(note);
  }

  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return el;
}

function setBubbleText(el, text) {
  if (!el) return;
  el.querySelector('.body').textContent = text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---- mode toggle -------------------------------------------------------------
const jdPanel = document.getElementById('jd-panel');
const jdInput = document.getElementById('jd-input');
const resumeInput = document.getElementById('resume-input');
const jdStart = document.getElementById('jd-start');

document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    if (!e.target.checked) return;
    const mode = e.target.value;
    if (mode === 'interview') {
      // Reveal the paste box; the drill starts on the "Start interview drill" button.
      if (jdPanel) jdPanel.hidden = false;
      if (jdInput) jdInput.focus();
      return;
    }
    if (jdPanel) jdPanel.hidden = true;
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'mode', mode }));
      setStatus('Switching mode…');
      talkBtn.disabled = true;
    }
  });
});

jdStart?.addEventListener('click', () => {
  if (ws?.readyState !== 1) return;
  const jobDescription = (jdInput?.value || '').trim();
  const resume = (resumeInput?.value || '').trim();
  ws.send(JSON.stringify({ type: 'mode', mode: 'interview', jobDescription, resume }));
  setStatus('Setting up your interview…');
  talkBtn.disabled = true;
  if (jdPanel) jdPanel.hidden = true; // collapse once the drill is starting
});

// ---- audio playback (24 kHz PCM) ---------------------------------------------
let playCtx = null;
let playHead = 0;
let liveSources = [];

function ensurePlayCtx() {
  if (!playCtx) {
    playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  }
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

  const start = Math.max(ctx.currentTime, playHead);
  src.start(start);
  playHead = start + buf.duration;

  liveSources.push(src);
  src.onended = () => {
    liveSources = liveSources.filter((s) => s !== src);
  };
}

function stopPlayback() {
  for (const s of liveSources) {
    try { s.stop(); } catch {}
  }
  liveSources = [];
  if (playCtx) playHead = playCtx.currentTime;
}

// ---- mic capture (16 kHz PCM, via AudioWorklet) ------------------------------
// Capture runs on the audio thread so DOM updates can't starve it and drop
// audio. The worklet streams PCM chunks and, on stop, flushes the tail before
// we tell the server the turn is over.
let micCtx = null;
let micStream = null;
let workletNode = null;
let recording = false;
let micReady = false;

async function ensureMic() {
  if (micReady) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    setStatus('Microphone permission needed');
    return false;
  }
  micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  await micCtx.audioWorklet.addModule('capture-worklet.js');

  const source = micCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(micCtx, 'capture-processor');
  const mute = micCtx.createGain();
  mute.gain.value = 0; // keep the graph pulling without echoing the mic

  workletNode.port.onmessage = (e) => {
    if (ws?.readyState !== 1) return;
    if (e.data.pcm) {
      ws.send(JSON.stringify({ type: 'audio', data: base64FromBytes(new Uint8Array(e.data.pcm)) }));
    } else if (e.data.ended) {
      // all buffered audio has been sent — now safe to close the turn
      ws.send(JSON.stringify({ type: 'mic_end' }));
    }
  };

  source.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(micCtx.destination);
  micReady = true;
  return true;
}

// ---- tap to talk (toggle) ----------------------------------------------------
// Tap once to open the mic, tap again to send. This used to be press-and-hold,
// which was fiddly on touch and turned a quick tap into an empty turn (mousedown
// started and mouseup stopped almost instantly).
async function startTalking() {
  if (talkBtn.disabled || recording) return;
  ensurePlayCtx();
  const ok = await ensureMic();
  if (!ok) return;
  if (micCtx?.state === 'suspended') await micCtx.resume();

  recording = true;
  talkBtn.classList.add('recording');
  talkBtn.querySelector('.talk-label').textContent = 'Listening… tap to send';
  talkBtn.querySelector('.talk-hint').textContent = 'mic is open';
  setStatus('Listening…', 'listening');

  // user's bubble first, so it sits above the reply. Show a listening indicator
  // (animated dots), not a literal "…" that reads like the user actually said it.
  userBubble = addBubble('user', 'You');
  userBubble.querySelector('.body').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

  ws.send(JSON.stringify({ type: 'mic_start' }));
  workletNode.port.postMessage({ cmd: 'start' });
}

function stopTalking() {
  if (!recording) return;
  recording = false;
  talkBtn.classList.remove('recording');
  talkBtn.disabled = true; // wait for the reply before opening the mic again
  talkBtn.querySelector('.talk-label').textContent = 'Thinking...';
  talkBtn.querySelector('.talk-hint').textContent = 'waiting for a reply';
  setStatus('Thinking…');
  // tell the worklet to flush; it will post {ended} which sends mic_end for us
  workletNode?.port.postMessage({ cmd: 'stop' });
}

function toggleTalking() {
  if (recording) stopTalking();
  else startTalking();
}

talkBtn.addEventListener('click', toggleTalking);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    toggleTalking();
  }
});

function resetTalkButtonLabel() {
  talkBtn.querySelector('.talk-label').textContent = 'Tap to talk';
  talkBtn.querySelector('.talk-hint').textContent = 'or press the spacebar';
}

// ---- base64 <-> bytes --------------------------------------------------------
function base64FromBytes(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function bytesFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

connect();
