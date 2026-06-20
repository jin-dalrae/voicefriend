// Lateral leadership + conflict/feedback frameworks for the LbD flight simulator.
// Conflict styles map to Thomas-Kilmann modes (Competing, Collaborating,
// Accommodating, Avoiding, Compromising ≈ Negotiator when trading concessions).

export const CONFLICT_STYLES = {
  Fighter: {
    tki: 'Competing',
    tagline: 'Assert your position',
    whenItWorks:
      'Scarce resources are on the table, you need a clear line on ethics/legal/quality, or the counterpart only responds to directness.',
    whenItFails:
      'Relationship capital matters more than this issue, emotions are already hot, or you have no authority to back up a hard line.',
    lateralTip:
      'Without authority, competing only works when you bring evidence (data, risk, user impact) — not volume.',
  },
  Negotiator: {
    tki: 'Collaborating',
    tagline: 'Expand options, then trade',
    whenItWorks:
      'Cross-functional partners have real constraints you can trade against (scope, timeline, resourcing) and the relationship will outlast this sprint.',
    whenItFails:
      'The other side is acting in bad faith, the deadline is immovable with zero slack, or you have not diagnosed their underlying interest yet.',
    lateralTip:
      'Name their pressure first ("I hear the exec demo is fixed"), then propose a package — not a single demand.',
  },
  Diplomat: {
    tki: 'Accommodating (strategic)',
    tagline: 'Yield now to protect the relationship',
    whenItWorks:
      'You need to de-escalate publicly, the issue is lower-stakes than the relationship, or you are buying time to regroup.',
    whenItFails:
      'Accommodation becomes the default — peers learn your standards are flexible and you absorb cost silently.',
    lateralTip:
      'Strategic accommodation is explicit and temporary: "I can live with X this sprint if we commit to Y next."',
  },
  Avoider: {
    tki: 'Avoiding',
    tagline: 'Step back from the fight',
    whenItWorks:
      'Emotions are too high for a productive reply, you need more data, or the issue is genuinely trivial.',
    whenItFails:
      'The room is waiting for a design leader to speak, bypass creates precedent, or avoidance lets a bad decision ship.',
    lateralTip:
      'In lateral leadership, avoidance must be active: "I want to answer that well — let me take this offline after crit."',
  },
  'People Pleaser': {
    tki: 'Accommodating (unchecked)',
    tagline: 'Keep peace at your own expense',
    whenItWorks: 'Almost never as a default — occasional grace when the relationship is genuinely fragile.',
    whenItFails:
      'You cave on standards (accessibility, research, process), resentments build, and partners learn you will absorb pain.',
    lateralTip:
      'Replace "Sure, whatever you want" with "Here is what I can flex on, and here is what I cannot."',
  },
};

/** All conflict styles — always shown in debrief mix (including 0%). */
export const CONFLICT_STYLE_ORDER = Object.keys(CONFLICT_STYLES);

const STYLE_ALIASES = new Map(
  [
    ['people pleaser', 'People Pleaser'],
    ['peoplepleaser', 'People Pleaser'],
    ['unchecked accommodating', 'People Pleaser'],
    ['fighter', 'Fighter'],
    ['competing', 'Fighter'],
    ['negotiator', 'Negotiator'],
    ['collaborating', 'Negotiator'],
    ['diplomat', 'Diplomat'],
    ['accommodating', 'Diplomat'],
    ['avoider', 'Avoider'],
    ['avoiding', 'Avoider'],
  ].map(([k, v]) => [k, v]),
);

export function canonicalStyleName(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  if (CONFLICT_STYLES[raw]) return raw;
  const alias = STYLE_ALIASES.get(raw.toLowerCase());
  if (alias) return alias;
  const match = CONFLICT_STYLE_ORDER.find((k) => k.toLowerCase() === raw.toLowerCase());
  return match || null;
}

/** Ensure every conflict style appears — missing ones get 0%. */
export function completeStyleMix(mix) {
  const totals = new Map();
  for (const row of mix || []) {
    const style = canonicalStyleName(row?.style);
    if (!style) continue;
    totals.set(style, (totals.get(style) || 0) + (Number(row.pct) || 0));
  }
  return CONFLICT_STYLE_ORDER.map((style) => ({
    style,
    pct: totals.get(style) || 0,
  })).sort((a, b) => b.pct - a.pct || CONFLICT_STYLE_ORDER.indexOf(a.style) - CONFLICT_STYLE_ORDER.indexOf(b.style));
}

export function styleMixBarWidth(pct) {
  const n = Number(pct) || 0;
  if (n <= 0) return 0;
  return Math.max(3, Math.min(100, n));
}

/** Exit / goodbye — strong wrap-up signals. */
const WRAP_UP_EXIT = [
  /\b(talk|speak|chat)\s+(to\s+)?you\s+later\b/i,
  /\b(ttyl|catch\s+you\s+later|see\s+you\s+(later|soon))\b/i,
  /\b(gotta|got\s+to|need\s+to)\s+(run|go|jump|head\s+out)\b/i,
  /\b(let'?s|we\s+should)\s+wrap\s+(up|this)(\s+here)?\b/i,
  /\b(that'?s\s+all|we'?re\s+done|i'?m\s+done)(\s+for\s+now)?\b/i,
  /\bbye\s+for\s+now\b/i,
  /\bhave\s+to\s+run\b/i,
];

/** Agreement / landing the decision — closure once you've been sparring a bit. */
const WRAP_UP_AGREE = [
  /\bokay,?\s+let'?s\s+do\s+(it|that)\b/i,
  /\blet'?s\s+do\s+(it|that)\b/i,
  /\bsounds\s+good\b/i,
  /\b(let'?s|we'?ll)\s+go\s+with\s+that\b/i,
  /\b(i'?m\s+)?good\s+with\s+that\b/i,
  /\bworks\s+for\s+me\b/i,
  /\blet'?s\s+move\s+(on|forward)\b/i,
  /\b(i'?m\s+)?on\s+board\b/i,
  /\bagreed\b/i,
  /\bdeal\b/i,
];

/**
 * Detect when the user is naturally closing the conversation (not just acknowledging).
 * Returns 'exit' | 'agree' | null.
 */
export function detectWrapUpSignal(text, { userTurns = 0, transcriptLines = 0 } = {}) {
  const t = String(text || '').trim();
  if (!t || userTurns < 1) return null;
  if (WRAP_UP_EXIT.some((re) => re.test(t))) return 'exit';
  if (userTurns >= 2 || transcriptLines >= 4) {
    if (WRAP_UP_AGREE.some((re) => re.test(t))) return 'agree';
  }
  return null;
}

export const FEEDBACK_MODELS = {
  SBI: {
    tagline: 'Situation · Behavior · Impact',
    structure: 'Name when/where → observable behavior → effect on team/work/user.',
    whenItWorks:
      'Peer feedback in crits or 1:1s — keeps it specific and depersonalized. Strong when the room is watching.',
    example: '"In today\'s crit (S), when you called the direction dated (B), the team went quiet and we lost 10 minutes (I)."',
  },
  AID: {
    tagline: 'Action · Impact · Desired',
    structure: 'What they did → what it caused → what you want instead.',
    whenItWorks:
      'Coaching a peer toward a behavior change — forward-looking, good for ongoing partnerships.',
    example: '"You went straight to eng (A), which skipped research (I). Next time route through intake (D)."',
  },
  'Radical Candor': {
    tagline: 'Care personally + challenge directly',
    structure: 'Signal you care about them, then name the hard truth — never obnoxious aggression or ruinous empathy.',
    whenItWorks:
      'You have trust with the peer and need to challenge a public critique without humiliating them.',
    example: '"I know you want what is best for users — and calling this dated in front of the team undermines the process we agreed on."',
  },
};

export const SCENARIO_TITLES = {
  deadline: 'Logical Sparring',
  critique: 'Critique Crossfire',
  accessibility: 'The Scope Cut',
  intake: 'The Intake Bypass',
};

/** Human-readable scenario name — never show raw ids like "accessibility" in the UI. */
export function scenarioDisplayName(scenarioId, scenarioTitle) {
  if (scenarioTitle && scenarioTitle !== scenarioId) return scenarioTitle;
  if (scenarioId && SCENARIO_TITLES[scenarioId]) return SCENARIO_TITLES[scenarioId];
  return scenarioTitle || scenarioId || 'Session';
}

/**
 * Framework metadata for each scenario — the single source of truth shared by
 * the simulator (lbd.js merges in the roleplay cast) and the /about guide, so
 * the guide can never drift from what the scenarios actually train.
 */
export const SCENARIO_FRAMEWORKS = {
  deadline: {
    title: 'Logical Sparring',
    blurb: 'Maya pushes to cut research for an exec demo. Speak naturally — your debrief diagnoses how you argued.',
    stakes: 'Ship quality vs. a fixed exec demo; eng is ready to start Monday.',
    authorityGap: 'You influence the design process but do not control the roadmap or eng capacity.',
    primaryStyles: ['Negotiator', 'Fighter'],
    feedbackFit: null,
    coachingNote: 'Collaborating (Negotiator) works when you trade across issues — timeline, scope, risk — not when you only say "research matters."',
  },
  critique: {
    title: 'Critique Crossfire',
    blurb: 'A peer publicly trashes your design direction in a crit. The room is watching.',
    stakes: 'Your credibility with the design team and the direction for the quarter.',
    authorityGap: 'Peers do not report to you; the room expects you to lead without pulling rank.',
    primaryStyles: ['Radical Candor', 'Negotiator'],
    feedbackFit: 'SBI or Radical Candor — respond to public criticism with specificity, not defensiveness.',
    coachingNote: 'Competing (Fighter) in a public crit often escalates; use care + direct challenge, then pivot to criteria.',
  },
  accessibility: {
    title: 'The Scope Cut',
    blurb: 'Engineering wants to drop all accessibility to hit the date. Where is your line?',
    stakes: 'Legal/ethical floor vs. release date; PM metrics do not include accessibility.',
    authorityGap: 'Eng owns implementation; you set standards but cannot force the backlog.',
    primaryStyles: ['Fighter', 'Negotiator'],
    feedbackFit: null,
    coachingNote: 'Hold a non-negotiable floor (compliance, core flows) then negotiate phasing — "later" without a date is not a plan.',
  },
  intake: {
    title: 'The Intake Bypass',
    blurb: "A VP stakeholder routed work straight to eng and skipped your team's process.",
    stakes: 'Team capacity, design quality on a high-visibility exec ask, precedent for bypass.',
    authorityGap: 'The VP has organizational power; you cannot say "no" — only renegotiate how work enters.',
    primaryStyles: ['Negotiator', 'Diplomat'],
    feedbackFit: 'AID works well with senior stakeholders — action, impact, desired routing.',
    coachingNote: 'De-escalate with a senior (Diplomat) then re-anchor process (Negotiator) — competing with a VP rarely ends well.',
  },
};

/** Display order for the scenarios (featured first). */
export const SCENARIO_FRAMEWORK_ORDER = ['deadline', 'critique', 'accessibility', 'intake'];

export const LATERAL_LEADERSHIP = `
Lateral leadership is how design leaders influence without authority: negotiating with PMs and eng,
giving peer feedback in crits, protecting standards (research, accessibility, process), and resolving conflict
with cross-functional partners who do not report to you. Success depends on clarity of interests,
relationship capital, and picking the right conflict style for the moment — not one style for every fight.
`.trim();

export function scenarioBriefing(scenario) {
  return {
    stakes: scenario.stakes,
    authorityGap: scenario.authorityGap,
    primaryStyles: scenario.primaryStyles || [],
    feedbackFit: scenario.feedbackFit || null,
    coachingNote: scenario.coachingNote,
  };
}

export function debriefFrameworkContext(scenario) {
  if (!scenario) return '';
  const lines = [
    `Scenario: ${scenario.scenarioTitle || scenario.title || 'unknown'}`,
    `Stakes: ${scenario.stakes || 'n/a'}`,
    `Authority gap: ${scenario.authorityGap || 'n/a'}`,
  ];
  if (scenario.primaryStyles?.length) {
    lines.push(`Styles that often work here: ${scenario.primaryStyles.join(', ')}`);
  }
  if (scenario.feedbackFit) lines.push(`Feedback model fit: ${scenario.feedbackFit}`);
  if (scenario.coachingNote) lines.push(`Coaching lens: ${scenario.coachingNote}`);
  return lines.join('\n');
}

export const APPROACH_OPTIONS = [
  { id: 'natural', label: 'Respond naturally', group: 'default' },
  { id: 'Fighter', label: 'Fighter', group: 'conflict' },
  { id: 'Negotiator', label: 'Negotiator', group: 'conflict' },
  { id: 'Diplomat', label: 'Diplomat', group: 'conflict' },
  { id: 'Avoider', label: 'Avoider', group: 'conflict' },
  { id: 'People Pleaser', label: 'People Pleaser', group: 'conflict' },
  { id: 'SBI', label: 'SBI feedback', group: 'feedback' },
  { id: 'AID', label: 'AID feedback', group: 'feedback' },
  { id: 'Radical Candor', label: 'Radical Candor', group: 'feedback' },
];

export function approachHint(id) {
  if (id === 'natural') return 'Speak in your own words — debrief will infer your style mix.';
  return CONFLICT_STYLES[id]?.lateralTip || FEEDBACK_MODELS[id]?.whenItWorks || '';
}

export function buildDebriefPrompt({ convo, scenario, intents }) {
  const ctx = debriefFrameworkContext(scenario);
  const intentBlock = intents?.length
    ? `\nUser-stated approach intent per turn (what they aimed for):\n${intents.map((x, i) => `Turn ${i + 1}: ${x}`).join('\n')}\nCompare intent to what they actually said.`
    : '';

  return `A design leader practiced LATERAL LEADERSHIP — influencing cross-functional partners without formal authority — in a spoken conflict simulator.

${LATERAL_LEADERSHIP}

SCENARIO CONTEXT:
${ctx}
${intentBlock}

Transcript ("You" = the user):
${convo}

Analyze HOW THE USER communicated. People use a MIX of styles — never one label.

Conflict styles (Thomas-Kilmann aligned):
- Fighter (Competing): asserts position, win-lose framing
- Negotiator (Collaborating): surfaces interests, expands options, trades across issues
- Diplomat (Strategic Accommodating): yields to de-escalate or protect relationship
- Avoider (Avoiding): withdraws, defers, sidesteps
- People Pleaser (Unchecked Accommodating): caves to keep peace at own expense

Feedback models (if they gave peer feedback): SBI (Situation-Behavior-Impact), AID (Action-Impact-Desired), Radical Candor (care + challenge).

Return JSON ONLY:
{
  "headline":"<nuanced one sentence>",
  "outcome":"<Landed compromise / Held line / Conceded / Impasse / Ran out of time>",
  "arc":"<2-3 sentences on conversation flow>",
  "styleMix":[{"style":"<style>","pct":<integer>}],
  "reasoning":"<1-2 sentences on logic, evidence, framing>",
  "feedbackModel":"<SBI|AID|Radical Candor|none — only if they gave peer feedback>",
  "strengths":["<specific>"],
  "watchouts":["<specific>"],
  "consequences":"<1-2 sentences: what likely happened to trust, standards, or the decision because of their approach>",
  "contextCoaching":"<2-3 sentences: for THIS scenario's stakes, which style(s) fit best and why — cite lateral leadership>",
  "frameworkMoments":[{"quote":"<short user quote>","framework":"<style or SBI etc>","note":"<why this mapped here and effect>"}],
  "alternatives":[{"style":"<different style>","example":"<sentence they could say>","why":"<one sentence why it fits this scenario>"}]
}

styleMix: ALL five conflict styles (Fighter, Negotiator, Diplomat, Avoider, People Pleaser) — integers summing to ~100; use 0 for styles not observed. 1-3 strengths, 1-3 watchouts, 1-3 frameworkMoments, 1-2 alternatives. Ground everything in the transcript.`;
}

// Unify legacy + partial model output so the UI always has core sections.
export function normalizeDebrief(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = { ...raw };

  if (d.style_mix && !d.styleMix) d.styleMix = d.style_mix;
  if (d.framework_moments && !d.frameworkMoments) d.frameworkMoments = d.framework_moments;
  if (d.context_coaching && !d.contextCoaching) d.contextCoaching = d.context_coaching;
  if (d.feedback_model && !d.feedbackModel) d.feedbackModel = d.feedback_model;

  if (!d.headline) {
    if (d.dominant && d.summary) d.headline = `${d.dominant} — ${d.summary}`;
    else if (d.dominant) d.headline = `You leaned ${d.dominant}`;
    else if (d.summary) d.headline = d.summary;
  }

  if ((!d.styleMix || !d.styleMix.length) && d.dominant) {
    d.styleMix = [{ style: d.dominant, pct: 100 }];
  }

  if (!d.arc && d.summary) d.arc = d.summary;

  if ((!d.frameworkMoments || !d.frameworkMoments.length) && Array.isArray(d.moments)) {
    d.frameworkMoments = d.moments.map((m) => ({
      quote: m.quote || '',
      framework: m.style || m.framework || '',
      note: m.note || '',
    }));
  }

  if (!d.strengths) d.strengths = [];
  if (!d.watchouts) d.watchouts = [];
  if (!d.alternatives) d.alternatives = [];
  d.styleMix = completeStyleMix(d.styleMix);

  return d;
}

function freqKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function tallyStrings(items) {
  const map = new Map();
  for (const raw of items) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const key = freqKey(text);
    const row = map.get(key) || { text, count: 0 };
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function avgStyleMixFromSessions(sessions) {
  const totals = Object.fromEntries(CONFLICT_STYLE_ORDER.map((s) => [s, 0]));
  let n = 0;
  for (const s of sessions) {
    const mix = completeStyleMix(s.debrief?.styleMix);
    if (!mix.some((row) => row.pct > 0)) continue;
    n += 1;
    for (const row of mix) {
      totals[row.style] = (totals[row.style] || 0) + row.pct;
    }
  }
  if (!n) return [];
  return CONFLICT_STYLE_ORDER.map((style) => ({
    style,
    pct: Math.round((totals[style] || 0) / n),
  })).sort((a, b) => b.pct - a.pct);
}

/** Aggregate cross-session speaking patterns for the trends dashboard. */
export function buildTrendsInsights(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const withDebrief = list.filter((s) => s.debrief);
  const totalConversations = list.length;
  const totalTurns = list.reduce((sum, s) => sum + (Number(s.exchangeCount) || 0), 0);
  const avgTurns =
    totalConversations > 0 ? Number((totalTurns / totalConversations).toFixed(1)) : null;

  const avgStyleMix = avgStyleMixFromSessions(withDebrief);
  const primaryStyle = avgStyleMix[0]?.style || null;
  const secondaryStyle = avgStyleMix[1]?.pct >= 20 ? avgStyleMix[1]?.style : null;
  const styleMeta = primaryStyle ? CONFLICT_STYLES[primaryStyle] : null;

  const watchouts = [];
  const strengths = [];
  const reasoningSnippets = [];
  for (const s of withDebrief) {
    const d = s.debrief;
    watchouts.push(...(d.watchouts || []));
    strengths.push(...(d.strengths || []));
    if (d.reasoning) reasoningSnippets.push(d.reasoning);
  }

  const quoteMoments = [];
  for (const s of list) {
    const d = s.debrief || {};
    const label = scenarioDisplayName(s.scenarioId, s.scenarioTitle);
    const date = s.createdAt || null;
    for (const m of d.frameworkMoments || []) {
      if (!m?.quote) continue;
      quoteMoments.push({
        quote: m.quote,
        framework: m.framework || '',
        note: m.note || '',
        scenarioTitle: label,
        date,
      });
    }
    if (!d.frameworkMoments?.length && s.userQuotes?.length) {
      for (const q of s.userQuotes.slice(-3)) {
        quoteMoments.push({
          quote: q,
          framework: (d.styleMix || [])[0]?.style || '',
          note: d.headline || '',
          scenarioTitle: label,
          date,
        });
      }
    }
  }

  const altMap = new Map();
  for (const s of withDebrief) {
    for (const a of s.debrief.alternatives || []) {
      const key = `${a.style || ''}|${a.example || ''}`;
      const row = altMap.get(key) || {
        style: a.style || '',
        example: a.example || '',
        why: a.why || '',
        count: 0,
      };
      row.count += 1;
      if (!row.why && a.why) row.why = a.why;
      altMap.set(key, row);
    }
  }
  const betterMoves = [...altMap.values()].sort((a, b) => b.count - a.count).slice(0, 6);

  const outcomes = {};
  for (const s of withDebrief) {
    const o = (s.debrief.outcome || 'Unknown').trim();
    outcomes[o] = (outcomes[o] || 0) + 1;
  }

  const scenariosPlayed = new Set(list.map((s) => s.scenarioId || s.scenarioTitle).filter(Boolean)).size;
  const coachSessions = list.filter((s) => s.variant === 'coach').length;

  let profileSummary = '';
  if (primaryStyle && styleMeta) {
    const blend = secondaryStyle ? `, with a strong ${secondaryStyle} streak` : '';
    profileSummary = `Across ${withDebrief.length} debriefed session${withDebrief.length === 1 ? '' : 's'}, you most often speak as a ${primaryStyle}${blend}. ${styleMeta.tagline} — ${styleMeta.lateralTip}`;
  }

  return {
    totalConversations,
    debriefedCount: withDebrief.length,
    totalTurns,
    avgTurns,
    scenariosPlayed,
    coachSessions,
    primaryStyle,
    secondaryStyle,
    speakerTagline: styleMeta?.tagline || '',
    speakerTip: styleMeta?.lateralTip || '',
    whenItWorks: styleMeta?.whenItWorks || '',
    whenItFails: styleMeta?.whenItFails || '',
    profileSummary,
    avgStyleMix,
    watchoutPatterns: tallyStrings(watchouts).slice(0, 8),
    strengthPatterns: tallyStrings(strengths).slice(0, 6),
    reasoningSnippets: reasoningSnippets.slice(0, 5),
    quoteMoments: quoteMoments.slice(0, 12),
    betterMoves,
    outcomes: Object.entries(outcomes).sort((a, b) => b[1] - a[1]),
  };
}

export const LOGIC_PATTERNS = [
  'Evidence + criteria',
  'Interest surfacing',
  'Trade-off framing',
  'Steelman / best case for other side',
  'Appeal to urgency without evidence',
  'False dichotomy',
  'Slippery slope',
  'Ad hominem / personal',
  'Appeal to authority',
  'Straw man',
  'Circular reasoning',
  'Anchoring / arbitrary constraint',
  'Emotional pressure',
  'Process bypass',
];

export function buildLogicLensPrompt({ transcript, lastUser, lastFoe, scenario, turn }) {
  const ctx = debriefFrameworkContext(scenario);
  const recent = (transcript || [])
    .slice(-6)
    .map((e) => `${e.speaker}: ${e.text}`)
    .join('\n');
  const pickHint =
    turn % 2 === 1
      ? 'For the alternative, prioritize a sharper reframe for the USER — what more rational move could they try next.'
      : 'For the alternative, prioritize countering the COUNTERPART\'s trap — show a logical response that defuses their pattern.';

  return `You are a logic lens for a workplace conflict simulator. Diagnose reasoning patterns in the LATEST exchange only.

SCENARIO:
${ctx}

Recent transcript:
${recent}

Latest user line: ${lastUser ? `"${lastUser}"` : '(none yet)'}
Latest counterpart line (${lastFoe?.speaker || 'counterpart'}): ${lastFoe?.text ? `"${lastFoe.text}"` : '(none)'}

Classify each speaker who spoke in this exchange (include the user if they spoke). Use patterns like: ${LOGIC_PATTERNS.join(', ')}.

Return JSON ONLY:
{
  "readings":[
    {"speaker":"You|name","displayName":"You|name","kind":"logic|non-logic|mixed","pattern":"<short label>","detail":"<one sentence, cite their words>"}
  ],
  "alternative":{
    "for":"<You|counterpart name>",
    "replaces":"<pattern being challenged>",
    "move":"<one concrete alternative sentence they could say>",
    "why":"<one sentence — why this is more rational in this scenario>"
  }
}

Rules:
- 1-2 readings (user and/or counterpart). kind=logic when evidence/criteria/interests; non-logic for fallacies/pressure; mixed when both.
- Pick exactly ONE alternative. ${pickHint}
- Vary the logical tool across turns (reframe, evidence, criteria, interests) — turn ${turn}.
- Ground every reading in what they actually said.`;
}

export function normalizeLogicLens(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = { ...raw };
  if (!Array.isArray(d.readings)) d.readings = [];
  d.readings = d.readings
    .filter((r) => r && (r.pattern || r.detail))
    .map((r) => ({
      speaker: r.speaker || r.displayName || 'Speaker',
      displayName: r.displayName || r.speaker || 'Speaker',
      kind: ['logic', 'non-logic', 'mixed'].includes(r.kind) ? r.kind : 'mixed',
      pattern: r.pattern || 'Unclassified',
      detail: r.detail || '',
    }));
  if (!d.alternative && d.alt) d.alternative = d.alt;
  if (d.alternative && typeof d.alternative === 'object') {
    d.alternative = {
      for: d.alternative.for || d.alternative.target || 'You',
      replaces: d.alternative.replaces || d.alternative.pattern || '',
      move: d.alternative.move || d.alternative.suggestion || '',
      why: d.alternative.why || '',
    };
  } else {
    d.alternative = null;
  }
  if (!d.readings.length) return null;
  return d;
}

/** Prompt for Alex to speak the debrief aloud (Live API audio, not on-screen script). */
export function buildDebriefSpeakPrompt(data) {
  const d = normalizeDebrief(data);
  if (!d) return '';
  const watch = d.watchouts?.[0] || '';
  const alt = d.alternatives?.[0];
  const altLine = alt
    ? `For next time, try leaning ${alt.style} — for example: ${alt.example}`
    : '';
  const lines = [
    'IGNORE any roleplay or character instructions for this turn only.',
    'You are Alex, a warm leadership coach. Speak OUT LOUD in natural conversational audio.',
    'This must be heard as voice — not an essay, not bullet points, not stage directions.',
    'Talk directly to the user ("you") for 30-45 seconds, then stop.',
    '',
    `Open with: ${d.headline || 'how they showed up in this conflict'}`,
    d.arc ? `How it flowed: ${d.arc}` : '',
    d.contextCoaching ? `What fits this scenario: ${d.contextCoaching}` : '',
    watch ? `One watch-out: ${watch}` : '',
    altLine,
  ].filter(Boolean);
  return lines.join('\n');
}

export function renderDebriefHtml(data) {
  const d = normalizeDebrief(data);
  if (!d) return null;

  const bars = (d.styleMix || [])
    .map((x) => {
      const pct = Number(x.pct) || 0;
      const width = styleMixBarWidth(pct);
      const zero = pct <= 0 ? ' is-zero' : '';
      return `<div class="lbd-bar${zero}"><span class="lbd-tag lbd-${(x.style || '').replace(/\W/g, '')}">${x.style || ''}</span><span class="lbd-bar-track"><span class="lbd-bar-fill" style="width:${width}%"></span></span><span class="lbd-bar-pct">${pct}%</span></div>`;
    })
    .join('');

  const li = (arr) => (arr || []).map((x) => `<li>${typeof x === 'string' ? x : ''}</li>`).join('');

  const moments = (d.frameworkMoments || [])
    .map((m) => `<li><span class="lbd-tag lbd-${(m.framework || '').replace(/\W/g, '')}">${m.framework || ''}</span> <span class="lbd-q">"${m.quote || ''}"</span><span class="lbd-note">${m.note || ''}</span></li>`)
    .join('');

  const alts = (d.alternatives || [])
    .map((a) => `<li><span class="lbd-tag lbd-${(a.style || '').replace(/\W/g, '')}">${a.style || ''}</span> ${a.example || ''}${a.why ? `<span class="lbd-note">${a.why}</span>` : ''}</li>`)
    .join('');

  return `
    <p class="lbd-score">${d.headline || 'Your speaking read'}</p>
    ${d.outcome ? `<p class="lbd-dim">Outcome: ${d.outcome}</p>` : ''}
    ${d.consequences ? `<section class="lbd-debrief-block"><p class="lbd-h3">Consequences</p><p>${d.consequences}</p></section>` : ''}
    ${bars ? `<section class="lbd-debrief-block"><p class="lbd-h3">Your style mix</p><div class="lbd-bars">${bars}</div></section>` : ''}
    ${d.reasoning ? `<section class="lbd-debrief-block"><p class="lbd-h3">Reasoning</p><p>${d.reasoning}</p></section>` : ''}
    ${d.feedbackModel && d.feedbackModel !== 'none' ? `<p class="lbd-dim">Feedback model: ${d.feedbackModel}</p>` : ''}
    ${d.arc ? `<section class="lbd-debrief-block"><p class="lbd-h3">How it went</p><p>${d.arc}</p></section>` : ''}
    ${d.contextCoaching ? `<section class="lbd-debrief-block"><p class="lbd-h3">What fits this scenario</p><p>${d.contextCoaching}</p></section>` : ''}
    ${moments ? `<section class="lbd-debrief-block"><p class="lbd-h3">Framework moments</p><ul class="lbd-recap">${moments}</ul></section>` : ''}
    ${d.strengths.length ? `<section class="lbd-debrief-block"><p class="lbd-h3">Strengths</p><ul class="lbd-recap">${li(d.strengths)}</ul></section>` : ''}
    ${d.watchouts.length ? `<section class="lbd-debrief-block"><p class="lbd-h3">Watch-outs</p><ul class="lbd-recap">${li(d.watchouts)}</ul></section>` : ''}
    ${alts ? `<section class="lbd-debrief-block"><p class="lbd-h3">Try next time</p><ul class="lbd-recap alts">${alts}</ul></section>` : ''}`;
}