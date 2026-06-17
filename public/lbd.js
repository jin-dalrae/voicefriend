import { getCurrentIdToken, initAuthUi } from './firebase-client.js';

// Conflict & Feedback Simulator — a leadership "flight simulator" for lateral
// leadership (influence without authority). Pick a scenario and a 1:1 or 1:2
// setup; the counterpart(s) voice each situation; you pick an approach mapped to
// a framework; the app shows the consequence and coaches you on why it fits.

// ---- frameworks --------------------------------------------------------------
const FRAMEWORKS = {
  Fighter: 'Compete — push your position hard.',
  Negotiator: 'Collaborate — expand the pie, trade to a win-win.',
  Diplomat: 'Accommodate strategically — concede the small to hold the essential.',
  Avoider: 'Withdraw — sidestep or defer the conflict.',
  'People Pleaser': 'Accommodate — give in to keep the peace.',
  SBI: 'Situation → Behavior → Impact.',
  AID: 'Action → Impact → Desired change.',
  'Radical Candor': 'Care personally + challenge directly.',
  'Ruinous Empathy': 'Care but won’t challenge — niceness that fails them.',
  'Obnoxious Aggression': 'Challenge without care — bluntness that wounds.',
};

// rating drives the visual + the end debrief tally
// 'strong' = fits this context well | 'mixed' = situational | 'weak' = backfires

const SCENARIOS = [
  {
    id: 'deadline',
    title: 'The Deadline Squeeze',
    blurb: 'A PM wants to cut research and QA to hit a moved-up demo. You own the process — but not the date.',
    counterpart: { name: 'Maya', role: 'Product Manager' },
    ally: { name: 'Sam', role: 'Eng Lead' },
    nodes: [
      {
        line: "The exec demo got moved up two weeks. We already know what users want — let's skip the research round and just build it.",
        allyLine: "Honestly the research never changes much. Eng can start Monday if you greenlight it.",
        prompt: 'Research is your call, but you have no authority over the date. How do you respond?',
        choices: [
          { f: 'Negotiator', rating: 'strong',
            label: "Protect just the riskiest flow with a 3-day guerrilla test, and cut polish elsewhere to hold the date.",
            consequence: "Maya relaxes — she keeps her date, you keep the riskiest decision evidence-based. Sam starts on the settled parts.",
            coaching: "Collaborating expands the pie: you traded scope, not rigor. Highest-leverage move in a priority conflict without authority." },
          { f: 'Fighter', rating: 'mixed',
            label: "“No. We don't ship without research. That's not negotiable.”",
            consequence: "Maya escalates to her director. You 'win', but she now routes around you and frames design as a blocker.",
            coaching: "Competing can be right for a true quality/ethics line — but you rarely have the authority to enforce it, and it spends capital you'll need next sprint." },
          { f: 'People Pleaser', rating: 'weak',
            label: "“If the timeline needs it, we'll skip it and make it work.”",
            consequence: "You ship blind; a checkout bug surfaces in the demo and leadership asks why design didn't catch it.",
            coaching: "Accommodating to keep peace trades your credibility — and denies Maya the risk info she actually needed to decide well." },
          { f: 'Avoider', rating: 'weak',
            label: "“Let me look into it and get back to you.” (then it stalls)",
            consequence: "Silence becomes a decision — eng starts without research by default, and you've lost the room.",
            coaching: "Avoiding can cool a hot moment, but as a dodge it quietly cedes the call and your seat at the table." },
        ],
      },
      {
        line: "Great. While we're at it — can your team skip the design QA pass too? Eng can self-check.",
        allyLine: "We've got it, we know the patterns.",
        prompt: 'Quality is sliding now. Second ask in one conversation. Pick your approach.',
        choices: [
          { f: 'Diplomat', rating: 'strong',
            label: "Keep a 30-min design QA on just the demo path — you'll do it yourself, off eng's critical path.",
            consequence: "Maya accepts a scoped, low-cost check; you hold the bar without making it a fight.",
            coaching: "The Diplomat concedes the small (full QA) to hold the essential (the demo path) — protecting both the relationship and the outcome." },
          { f: 'Fighter', rating: 'mixed',
            label: "“Design QA stays. I'm not signing off otherwise.”",
            consequence: "Maya complies, but tension rises and Sam starts looping you in late to avoid friction.",
            coaching: "A second hard stand in one conversation reads as positional. Save Fighter energy for the one hill that matters." },
          { f: 'People Pleaser', rating: 'weak',
            label: "“Sure, eng can self-check, no problem.”",
            consequence: "Two visual regressions ship; the demo looks sloppy and it lands on you.",
            coaching: "Repeated accommodation compounds — each 'yes' lowers the bar and the perception of what design is for." },
          { f: 'Negotiator', rating: 'mixed',
            label: "“I'll skip QA if eng adds two days.”",
            consequence: "Maya can't move the date, so the trade collapses and you're back to square one.",
            coaching: "Negotiation needs a currency the other side can pay. The date was fixed — trade against scope you control, not time you don't." },
        ],
      },
      {
        line: "That demo went fine, right? So... can we just run lean like that going forward?",
        allyLine: "",
        prompt: 'Now you give Maya feedback on the pattern, 1:1. Which model?',
        choices: [
          { f: 'SBI', rating: 'strong',
            label: "“Last two sprints, research and QA got cut to hit dates. The result was a checkout bug in front of execs and three days of rework.”",
            consequence: "Maya hears data, not blame; she proposes building a research buffer into the next plan.",
            coaching: "SBI keeps feedback specific and non-defensive — situation and behavior are observable, impact is felt. Ideal for a peer you'll keep working with." },
          { f: 'Radical Candor', rating: 'strong',
            label: "“I care about us shipping fast together — which is exactly why I have to be straight: cutting design every time will bite us.”",
            consequence: "Maya respects the directness; the care up front keeps it from feeling like an attack.",
            coaching: "Care personally + challenge directly. Powerful when the relationship can hold it and the stakes are real." },
          { f: 'Ruinous Empathy', rating: 'weak',
            label: "“It's totally fine, we made it work, no worries at all!”",
            consequence: "Nothing changes; next sprint the same squeeze happens, worse.",
            coaching: "Caring without challenging is ruinous empathy — kindness that protects the moment and fails both the person and the work." },
          { f: 'Obnoxious Aggression', rating: 'weak',
            label: "“You keep steamrolling design and it's why things break. Figure it out.”",
            consequence: "Maya shuts down and gets defensive; the real issue gets lost in the sting.",
            coaching: "Challenge without care lands as an attack — you can be right and still lose the person. Always add the 'why I'm telling you this'." },
        ],
      },
    ],
    debrief: "The Squeeze rewards Negotiator/Diplomat moves that protect the essential while honoring real constraints, and feedback (SBI / Radical Candor) that's specific and caring. Fighter is a scarce resource here; People-Pleasing and Avoiding quietly erode design's seat at the table.",
  },

  {
    id: 'critique',
    title: 'Critique Crossfire',
    blurb: 'In a team critique, a peer designer publicly trashes your direction. The room is watching how you handle it.',
    counterpart: { name: 'Devon', role: 'Peer Designer' },
    ally: { name: 'Priya', role: 'Another Designer' },
    nodes: [
      {
        line: "Honestly, I think this whole direction is wrong. It feels dated and I don't get why we're going this way.",
        allyLine: "Yeah... I'm not really sold either.",
        prompt: "You're being challenged publicly, with no authority over Devon. Respond.",
        choices: [
          { f: 'Negotiator', rating: 'strong',
            label: "“Fair to raise — say more about what feels dated? I'd rather pressure-test it now than after we build.”",
            consequence: "Devon engages substantively; the room sees you as secure, and the critique actually sharpens the work.",
            coaching: "Inviting the critique defuses the audience dynamic and turns an attack into signal. Confidence is not defensiveness." },
          { f: 'Fighter', rating: 'mixed',
            label: "“I've already explained the rationale. Let's move on.”",
            consequence: "You hold the floor, but Devon stews and lobbies others after the meeting.",
            coaching: "Shutting it down protects your time but reads as insecure and pushes the conflict underground, where you can't address it." },
          { f: 'People Pleaser', rating: 'weak',
            label: "“You're probably right — maybe we should rethink the whole thing.”",
            consequence: "The team loses confidence in the direction over one offhand reaction; weeks of work wobble.",
            coaching: "Caving to public pressure trades the work's integrity for comfort — and teaches the room that volume wins." },
          { f: 'Avoider', rating: 'mixed',
            label: "“Let's take this offline.” (and you genuinely follow up)",
            consequence: "The public moment de-escalates; whether it works hinges entirely on you actually circling back.",
            coaching: "'Take it offline' is a great de-escalator — but only if you follow through. Used to dodge, the doubt just festers." },
        ],
      },
      {
        line: "(later, in your DMs) Sorry if that was blunt earlier. I just feel strongly about it.",
        allyLine: "",
        prompt: 'Repair and realign 1:1. Approach?',
        choices: [
          { f: 'Diplomat', rating: 'strong',
            label: "“No need to apologize for caring. Grab 20 minutes? I want to understand your concern and show you the constraints I'm juggling.”",
            consequence: "Devon becomes an ally; together you surface a real gap and fix it.",
            coaching: "Turning a critic into a collaborator privately is high-leverage — you keep the relationship and usually improve the work." },
          { f: 'Fighter', rating: 'weak',
            label: "“If you feel strongly, bring it in the meeting — not the DMs.”",
            consequence: "Devon disengages; you've won a point and lost a peer.",
            coaching: "Being technically right about the forum can still cost you the relationship. Meet the olive branch." },
          { f: 'People Pleaser', rating: 'weak',
            label: "“Don't worry about it — I'll just change it to what you wanted.”",
            consequence: "You whipsaw the direction to soothe one person; the team gets whiplash.",
            coaching: "Accommodating privately after holding firm publicly makes you look unanchored. Decide on merits, not on who pushed hardest." },
        ],
      },
      {
        line: "(Devon's blunt openings in crit are a pattern — juniors have started going quiet.) So, we good?",
        allyLine: "",
        prompt: 'Give Devon feedback on the pattern. Which model?',
        choices: [
          { f: 'AID', rating: 'strong',
            label: "“When you open crits with 'this is wrong' (action), newer designers freeze and stop sharing (impact). Try leading with what's working, then the gap (desired).”",
            consequence: "Devon didn't realize the effect; he starts framing critiques more carefully and debate improves.",
            coaching: "AID is crisp and future-focused — it ends on the desired change, so it feels like coaching, not a verdict." },
          { f: 'Radical Candor', rating: 'strong',
            label: "“You're one of the sharpest critics we have — that's why I want to tell you the bluntness is shrinking the room.”",
            consequence: "The praise is specific and true, so the challenge lands as respect, not attack.",
            coaching: "Care personally + challenge directly — naming his real strength earns the right to name the cost." },
          { f: 'Ruinous Empathy', rating: 'weak',
            label: "“We're good! Don't worry about it at all.”",
            consequence: "The juniors keep shrinking; you protected Devon's comfort over the team's.",
            coaching: "Avoiding the hard message to be 'nice' fails everyone — especially the quieter people you're responsible for." },
        ],
      },
    ],
    debrief: "Crossfire is about staying secure under public pressure (Negotiator), repairing privately (Diplomat), and naming patterns with specific, caring feedback (AID / Radical Candor). Fighting in public or caving both cost you the room.",
  },

  {
    id: 'accessibility',
    title: 'The Scope Cut',
    blurb: 'Engineering wants to drop all accessibility work to hit the date. This one tests where your real lines are.',
    counterpart: { name: 'Raj', role: 'Eng Lead' },
    ally: { name: 'Lena', role: 'Product Manager' },
    nodes: [
      {
        line: "To hit the date we're cutting the accessibility work this release — screen reader support, focus states, all of it. We'll do it later.",
        allyLine: "Agreed — it's not in this quarter's success metrics anyway.",
        prompt: 'This is a quality and legal-risk line. Respond.',
        choices: [
          { f: 'Negotiator', rating: 'strong',
            label: "“Let's not cut it wholesale — keyboard nav and labels are cheap and non-negotiable for legal risk. We can defer the fancy ARIA polish. Here's the 80/20.”",
            consequence: "Raj accepts the must-haves; you protect users and de-risk compliance without blowing the date.",
            coaching: "Separate the non-negotiable floor from the nice-to-have, and trade only the latter. Risk + cheap wins is the framing that moves engineers." },
          { f: 'Fighter', rating: 'strong',
            label: "“We don't ship inaccessible products — that's a hard line. Happy to take it to legal and leadership together.”",
            consequence: "Raj pushes back, but you're on solid ground and leadership backs the floor.",
            coaching: "This is exactly when Fighter is right: a genuine ethics/legal line where caving means real harm. Offer to share the escalation, not weaponize it." },
          { f: 'People Pleaser', rating: 'weak',
            label: "“Okay, we'll catch it next release.”",
            consequence: "'Later' never comes; an audit and a user complaint flag it months on, at 5x the cost to retrofit.",
            coaching: "Deferred accessibility is the classic compounding debt — and 'later' is where good intentions go to die." },
          { f: 'Avoider', rating: 'weak',
            label: "“Hmm — let me stay out of it, it's an eng call.”",
            consequence: "You've abdicated the one thing design is uniquely positioned to defend.",
            coaching: "Some calls are squarely yours to hold. Avoiding here isn't neutral — it's a silent yes to cutting users out." },
        ],
      },
      {
        line: "Fine — keyboard nav stays. But tell the team it was YOUR call to keep it, so the timeline risk isn't on eng.",
        allyLine: "",
        prompt: "Raj wants you to absorb the blame for 'the delay'. Approach?",
        choices: [
          { f: 'Diplomat', rating: 'strong',
            label: "“Let's frame it as a shared quality bar we both signed off on — not a delay, a standard.”",
            consequence: "Raj agrees to co-own it; the narrative becomes 'we hold a bar', not 'design slowed us down'.",
            coaching: "Reframing from blame to shared standard preserves both reputations and makes the floor stick beyond this release." },
          { f: 'Fighter', rating: 'mixed',
            label: "“I'm not taking the blame for a standard we should both hold.”",
            consequence: "Raj gets defensive; the accessibility win survives but the partnership cools.",
            coaching: "You're right on principle, but pure refusal misses the chance to convert a tense moment into a shared norm." },
          { f: 'People Pleaser', rating: 'weak',
            label: "“Sure, tell them it was all me.”",
            consequence: "You eat the 'slowed us down' label; next planning, design is treated as the tax.",
            coaching: "Absorbing blame to keep peace quietly rewrites the story into one where doing the right thing is your liability." },
        ],
      },
      {
        line: "(This is the third time accessibility has been first on the chopping block.) We can revisit the process sometime.",
        allyLine: "",
        prompt: 'Give Raj/Lena feedback so this stops being the default. Which model?',
        choices: [
          { f: 'SBI', rating: 'strong',
            label: "“In the last three releases (situation), accessibility was the first cut every time (behavior) — we've now got compliance risk and a retrofit backlog (impact).”",
            consequence: "Framed as a recurring pattern with real cost, it gets a standing 'accessibility floor' added to the definition of done.",
            coaching: "SBI turns a vibe ('we always cut it') into an observable pattern with impact — which is what makes process actually change." },
          { f: 'AID', rating: 'strong',
            label: "“Cutting a11y first (action) keeps creating audit risk and rework (impact). Let's make a baseline part of 'done' so it's never the variable (desired).”",
            consequence: "The desired change is concrete and systemic; it sticks because it's a rule, not a plea.",
            coaching: "AID lands on a specific structural fix — the strongest feedback changes the system, not just the person." },
          { f: 'Obnoxious Aggression', rating: 'weak',
            label: "“You clearly don't care about disabled users. It's gross.”",
            consequence: "Raj and Lena get defensive and dig in; the moral framing makes it about them, not the fix.",
            coaching: "Moralizing without care triggers defensiveness. Lead with shared risk and a concrete fix, not a character verdict." },
        ],
      },
    ],
    debrief: "The Scope Cut is the scenario where Fighter is often correct — accessibility is a floor, not a feature. The real skill is separating non-negotiable from negotiable, using risk/cost framing over moralizing, and turning a one-off win into a standing standard (SBI / AID).",
  },
];

// ---- state -------------------------------------------------------------------
let parties = 1; // 1 = 1:1, 2 = 1:2
let scenario = null;
let nodeIndex = 0;
let picks = []; // { f, rating } per node
let voiceOn = true;

// ---- elements ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const pickerEl = $('picker');
const simEl = $('sim');
const debriefEl = $('debrief');

// ---- speech (counterpart voice) ----------------------------------------------
// v1 uses the browser's built-in speech so /lbd is self-contained (no sign-in,
// no relay). Two distinct voices stand in for the two counterparts in a 1:2.
let voiceA = null;
let voiceB = null;
function pickVoices() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const en = voices.filter((v) => /en[-_]/i.test(v.lang));
  const pool = en.length ? en : voices;
  voiceA = pool.find((v) => /(daniel|alex|google us|fred|male)/i.test(v.name)) || pool[0] || null;
  voiceB = pool.find((v) => v !== voiceA && /(samantha|victoria|karen|google uk english female|female)/i.test(v.name)) || pool[1] || voiceA;
}
if (window.speechSynthesis) {
  pickVoices();
  window.speechSynthesis.onvoiceschanged = pickVoices;
}
function say(text, which = 'A') {
  if (!voiceOn || !text || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.voice = which === 'B' ? voiceB : voiceA;
  u.rate = 1.02;
  u.pitch = which === 'B' ? 1.08 : 0.96;
  window.speechSynthesis.speak(u);
}
function stopSpeaking() {
  window.speechSynthesis?.cancel();
}

// ---- live voice via the talk2me relay (Gemini Live) --------------------------
// Signed-in users hear Luc & Jeenie voice the counterparts through the relay's
// 'lbd' mode; otherwise we fall back to the browser speech above.
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws = null;
let lbdReady = false;
let modeSent = false;
const sayQueue = [];
let speaking = false;

function connectVoice() {
  let url;
  try { url = new URL(window.TALK2ME_WS_URL || `${wsProto}://${location.host}/ws`); } catch { return; }
  ws = new WebSocket(url);
  ws.onopen = () => sendAuth();
  ws.onclose = () => { lbdReady = false; modeSent = false; speaking = false; setTimeout(connectVoice, 2500); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handleVoice(m); };
}
async function sendAuth() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const token = await getCurrentIdToken();
  if (token) ws.send(JSON.stringify({ type: 'auth', token }));
}
function handleVoice(m) {
  switch (m.type) {
    case 'ready':
      if (!modeSent) { modeSent = true; ws.send(JSON.stringify({ type: 'mode', mode: 'lbd' })); }
      else { lbdReady = true; flushQueue(); }
      break;
    case 'audio': playPcm(bytesFromBase64(m.data)); break;
    case 'turn_end': speaking = false; flushQueue(); break;
    default: break; // need_auth / auth_error / auth_ok → stay on browser fallback
  }
}
function liveReady() { return lbdReady && ws?.readyState === WebSocket.OPEN; }

function voiceLine(which, as, line) {
  if (!voiceOn || !line) return;
  if (liveReady()) {
    sayQueue.push({ who: which === 'B' ? 'Jeenie' : 'Luc', as, line });
    flushQueue();
  } else {
    say(line, which); // browser fallback when not signed in / not connected
  }
}
function flushQueue() {
  if (speaking || !liveReady() || !sayQueue.length) return;
  const item = sayQueue.shift();
  speaking = true;
  ws.send(JSON.stringify({ type: 'lbd_say', who: item.who, as: item.as, line: item.line }));
}
function stopVoice() {
  sayQueue.length = 0;
  speaking = false;
  stopSpeaking();
  stopPlayback();
}

// 24kHz PCM playback (ported from the main app's audio path)
let playCtx = null;
let playHead = 0;
let liveSources = [];
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

// ---- picker ------------------------------------------------------------------
function renderPicker() {
  stopVoice();
  show(pickerEl);
  const cards = SCENARIOS.map(
    (s) => `
    <button class="lbd-card" data-id="${s.id}" type="button">
      <strong>${s.title}</strong>
      <span>${s.blurb}</span>
    </button>`,
  ).join('');
  pickerEl.innerHTML = `
    <h1 class="lbd-h1">Conflict &amp; Feedback Simulator</h1>
    <p class="lbd-sub">Rehearse lateral leadership — influence without authority. Pick a situation, choose how you respond, and see what it costs you.</p>
    <div class="lbd-seg" role="radiogroup" aria-label="Number of counterparts">
      <button class="lbd-seg-btn is-on" data-parties="1" type="button">1 : 1 — one counterpart</button>
      <button class="lbd-seg-btn" data-parties="2" type="button">1 : 2 — outnumbered</button>
    </div>
    <div class="lbd-cards">${cards}</div>
    <p class="lbd-foot">Frameworks: Fighter · Negotiator · Diplomat · Avoider · People&nbsp;Pleaser · SBI · AID · Radical&nbsp;Candor</p>`;

  pickerEl.querySelectorAll('.lbd-seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      parties = Number(b.dataset.parties);
      pickerEl.querySelectorAll('.lbd-seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
    }),
  );
  pickerEl.querySelectorAll('.lbd-card').forEach((b) =>
    b.addEventListener('click', () => start(b.dataset.id)),
  );
}

// ---- simulator ---------------------------------------------------------------
function start(id) {
  ensurePlayCtx(); // unlock audio inside the click gesture (for live voice)
  scenario = SCENARIOS.find((s) => s.id === id);
  nodeIndex = 0;
  picks = [];
  renderNode();
}

function renderNode() {
  show(simEl);
  const node = scenario.nodes[nodeIndex];
  const cp = scenario.counterpart;
  const ally = scenario.ally;
  const two = parties === 2 && node.allyLine;

  const lines = [`<div class="lbd-line"><span class="lbd-who" style="color:var(--luc)">${cp.name} · ${cp.role}</span><p>${node.line}</p></div>`];
  if (two) {
    lines.push(`<div class="lbd-line"><span class="lbd-who" style="color:var(--jeenie)">${ally.name} · ${ally.role}</span><p>${node.allyLine}</p></div>`);
  }

  const choices = node.choices
    .map(
      (c, i) => `
      <button class="lbd-choice" data-i="${i}" type="button">
        <span class="lbd-tag lbd-${c.f.replace(/\W/g, '')}">${c.f}</span>
        <span class="lbd-choice-text">${c.label}</span>
      </button>`,
    )
    .join('');

  simEl.innerHTML = `
    <div class="lbd-top">
      <button class="lbd-back" id="lbd-quit" type="button">← Scenarios</button>
      <div class="lbd-progress">${scenario.title} · ${nodeIndex + 1}/${scenario.nodes.length}</div>
      <button class="lbd-mute" id="lbd-mute" type="button">${voiceOn ? '🔊' : '🔇'}</button>
    </div>
    <div class="lbd-stage">
      ${lines.join('')}
      <div class="lbd-prompt">${node.prompt}</div>
      <div class="lbd-choices">${choices}</div>
      <div class="lbd-result" id="lbd-result" hidden></div>
    </div>`;

  $('lbd-quit').addEventListener('click', renderPicker);
  $('lbd-mute').addEventListener('click', () => {
    voiceOn = !voiceOn;
    if (!voiceOn) stopVoice();
    $('lbd-mute').textContent = voiceOn ? '🔊' : '🔇';
    if (voiceOn) speakNode(node, two);
  });
  simEl.querySelectorAll('.lbd-choice').forEach((b) =>
    b.addEventListener('click', () => choose(Number(b.dataset.i))),
  );

  speakNode(node, two);
}

function speakNode(node, two) {
  stopVoice();
  const cp = scenario.counterpart;
  const ally = scenario.ally;
  voiceLine('A', `${cp.name}, ${cp.role}`, node.line);
  if (two) voiceLine('B', `${ally.name}, ${ally.role}`, node.allyLine);
}

function choose(i) {
  const node = scenario.nodes[nodeIndex];
  const c = node.choices[i];
  picks.push({ f: c.f, rating: c.rating });
  stopVoice();

  simEl.querySelectorAll('.lbd-choice').forEach((b, idx) => {
    b.disabled = true;
    b.classList.toggle('is-picked', idx === i);
    b.classList.add(`rating-${node.choices[idx].rating}`);
  });

  const result = $('lbd-result');
  const last = nodeIndex === scenario.nodes.length - 1;
  result.innerHTML = `
    <div class="lbd-ratingbar rating-${c.rating}">${ratingLabel(c.rating)} · ${c.f}</div>
    <p class="lbd-consequence"><strong>What happens:</strong> ${c.consequence}</p>
    <p class="lbd-coaching"><strong>Coaching:</strong> ${c.coaching}</p>
    <button class="lbd-next" id="lbd-next" type="button">${last ? 'See your debrief →' : 'Next →'}</button>`;
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  $('lbd-next').addEventListener('click', () => {
    if (last) renderDebrief();
    else { nodeIndex++; renderNode(); }
  });
}

function ratingLabel(r) {
  return r === 'strong' ? 'Strong fit' : r === 'mixed' ? 'Situational' : 'Backfires';
}

// ---- debrief -----------------------------------------------------------------
function renderDebrief() {
  stopVoice();
  show(debriefEl);
  const strong = picks.filter((p) => p.rating === 'strong').length;
  const counts = {};
  picks.forEach((p) => (counts[p.f] = (counts[p.f] || 0) + 1));
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  const score =
    strong === picks.length ? 'You read the room well — every call fit its context.'
    : strong >= picks.length - 1 ? 'Strong instincts, with one call worth a rethink.'
    : strong >= 1 ? 'A workable read with real room to grow — see the coaching below.'
    : 'Tough run. The patterns below are exactly what this drill is for.';

  const rows = picks
    .map((p, i) => `<li><span class="lbd-tag lbd-${p.f.replace(/\W/g, '')}">${p.f}</span> <em>${ratingLabel(p.rating)}</em> <span class="lbd-mini">— ${scenario.nodes[i].prompt}</span></li>`)
    .join('');

  debriefEl.innerHTML = `
    <div class="lbd-top">
      <button class="lbd-back" id="lbd-quit2" type="button">← Scenarios</button>
      <div class="lbd-progress">Debrief · ${scenario.title}</div>
      <span></span>
    </div>
    <div class="lbd-stage">
      <h2 class="lbd-h1">Debrief</h2>
      <p class="lbd-score">${strong}/${picks.length} strong-fit calls. ${score}</p>
      <p class="lbd-sub">Your default this run leaned toward <strong>${dominant}</strong> (${FRAMEWORKS[dominant] || ''}).</p>
      <ul class="lbd-recap">${rows}</ul>
      <p class="lbd-takeaway">${scenario.debrief}</p>
      <div class="lbd-actions">
        <button class="lbd-next" id="lbd-replay" type="button">Replay this scenario</button>
        <button class="lbd-next ghost" id="lbd-more" type="button">Try another →</button>
      </div>
    </div>`;

  $('lbd-quit2').addEventListener('click', renderPicker);
  $('lbd-replay').addEventListener('click', () => start(scenario.id));
  $('lbd-more').addEventListener('click', renderPicker);
}

// ---- helpers -----------------------------------------------------------------
function show(el) {
  [pickerEl, simEl, debriefEl].forEach((x) => (x.hidden = x !== el));
  window.scrollTo(0, 0);
}

// ---- boot --------------------------------------------------------------------
initAuthUi(); // wires the sign-in / sign-out buttons in the header
window.addEventListener('talk2me:auth-changed', () => {
  // On sign-in, push the token over the live socket so the relay opens the voices.
  if (ws?.readyState === WebSocket.OPEN) sendAuth();
  else connectVoice();
});
connectVoice(); // best-effort; voice goes live once you're signed in
renderPicker();
