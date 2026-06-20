import {
  CONFLICT_STYLES,
  CONFLICT_STYLE_ORDER,
  FEEDBACK_MODELS,
  SCENARIO_FRAMEWORKS,
  SCENARIO_FRAMEWORK_ORDER,
  LATERAL_LEADERSHIP,
  LOGIC_PATTERNS,
} from './lbd-frameworks.js';

const aboutEl = document.getElementById('about');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tag(name) {
  return `<span class="lbd-tag lbd-${String(name || '').replace(/\W/g, '')}">${esc(name)}</span>`;
}

// ---- design rationale (≤ 1 page) --------------------------------------------
function rationaleHtml() {
  return `
    <section class="lbd-panel lbd-trends-section lbd-rationale">
      <h2 class="lbd-h3">Design rationale</h2>
      <p>Design leaders rarely stall for lack of craft — they stall when they have to move people who do
        not report to them: PMs, engineers, peers, execs. That is <strong>lateral leadership</strong>:
        influence without authority. It is hard to rehearse because it is live, social, and high-stakes.
        This is a flight simulator for those moments — you speak, a cross-functional counterpart pushes
        back in real time, and the debrief tells you <em>how</em> you argued.</p>

      <p><strong>Why Thomas-Kilmann for conflict.</strong> The five styles — Fighter (Competing),
        Negotiator (Collaborating), Diplomat (strategic Accommodating), Avoider (Avoiding), and
        People Pleaser (unchecked Accommodating) — come from the Thomas-Kilmann Conflict Mode Instrument,
        a validated, widely used model that treats your conflict response as a <em>mode you choose</em>,
        not a fixed personality trait. That is the whole point: no style is "best." The right move depends
        on the stakes, the relationship, and how much authority you actually have. So the debrief reports a
        <strong>mix across all five</strong> — never a single label — because real conversations blend them.</p>

      <p><strong>Why these three feedback models.</strong> When a scene calls for peer feedback, the
        simulator scores against ${tag('SBI')} (Situation · Behavior · Impact) for specific, depersonalized
        feedback in a crit; ${tag('AID')} (Action · Impact · Desired) for forward-looking behavior change
        with a partner; and ${tag('Radical Candor')} (care personally + challenge directly) for naming a
        hard truth without humiliating someone. They cover the three feedback jobs a design leader hits most.</p>

      <p><strong>Why a live logic lens.</strong> Influence without authority is won on reasoning, not volume.
        A per-turn logic lens flags whether each move leaned on evidence and interests or slid into fallacies
        and pressure — false dichotomy, slippery slope, appeal to urgency, process bypass — so you can see
        your rhetoric as it happens, not just after.</p>

      <p><strong>Frameworks are built into each scenario.</strong> Every scene is constructed around the
        styles and feedback models that fit its power dynamic. The Intake Bypass pairs Diplomat + Negotiator
        because you cannot out-compete a VP; Critique Crossfire leans on Radical Candor + SBI because the
        room is watching; the Scope Cut needs a Fighter's non-negotiable floor <em>then</em> a Negotiator's
        phasing. The "why" for each is in the scenario cards below.</p>

      <p><strong>Principle: situational fit over a "winning" style.</strong> The product never crowns one
        approach. It shows what you did, what it likely cost or won, and which style would fit <em>this</em>
        scenario's stakes — grounded in quotes from what you actually said.</p>
    </section>`;
}

// ---- framework guide (rendered from the same source the simulator uses) ------
function conflictStylesHtml() {
  const cards = CONFLICT_STYLE_ORDER.map((name) => {
    const v = CONFLICT_STYLES[name];
    return `<article class="lbd-about-card">
      ${tag(name)}
      <span class="lbd-about-meta"><strong>Thomas-Kilmann:</strong> ${esc(v.tki)} · ${esc(v.tagline)}</span>
      <p><span class="lbd-kicker">Works when</span><br>${esc(v.whenItWorks)}</p>
      <p><span class="lbd-kicker">Fails when</span><br>${esc(v.whenItFails)}</p>
      <p><span class="lbd-kicker">Lateral tip</span><br>${esc(v.lateralTip)}</p>
    </article>`;
  }).join('');
  return `<section class="lbd-panel lbd-trends-section">
    <h2 class="lbd-h3">Conflict styles · Thomas-Kilmann</h2>
    <p class="lbd-dim">How you can show up in a disagreement. Your debrief reports a mix of all five — pick the mode that fits the moment.</p>
    <div class="lbd-about-grid">${cards}</div>
  </section>`;
}

function feedbackModelsHtml() {
  const cards = Object.entries(FEEDBACK_MODELS).map(([name, v]) => {
    return `<article class="lbd-about-card">
      ${tag(name)}
      <span class="lbd-about-meta">${esc(v.tagline)}</span>
      <p><span class="lbd-kicker">Structure</span><br>${esc(v.structure)}</p>
      <p><span class="lbd-kicker">Works when</span><br>${esc(v.whenItWorks)}</p>
      <p><span class="lbd-kicker">Example</span><br><em>${esc(v.example)}</em></p>
    </article>`;
  }).join('');
  return `<section class="lbd-panel lbd-trends-section">
    <h2 class="lbd-h3">Feedback models</h2>
    <p class="lbd-dim">For scenes where you give a peer feedback — the debrief notes which model you used.</p>
    <div class="lbd-about-grid">${cards}</div>
  </section>`;
}

function logicPatternsHtml() {
  const chips = LOGIC_PATTERNS.map((p) => `<span class="lbd-chip">${esc(p)}</span>`).join('');
  return `<section class="lbd-panel lbd-trends-section">
    <h2 class="lbd-h3">Logic &amp; persuasion lens</h2>
    <p class="lbd-dim">Each turn is read for reasoning quality — evidence and interests vs. fallacies and pressure. The patterns the lens watches for:</p>
    <div class="lbd-chip-row">${chips}</div>
  </section>`;
}

function scenariosHtml() {
  const cards = SCENARIO_FRAMEWORK_ORDER.map((id) => {
    const s = SCENARIO_FRAMEWORKS[id];
    const styles = (s.primaryStyles || []).map(tag).join(' ');
    return `<article class="lbd-about-card">
      <p class="lbd-about-card-title">${esc(s.title)}</p>
      <p>${esc(s.blurb)}</p>
      <div class="lbd-scn-styles">${styles}</div>
      <span class="lbd-about-meta"><strong>Stakes:</strong> ${esc(s.stakes)}</span>
      <span class="lbd-about-meta"><strong>Authority gap:</strong> ${esc(s.authorityGap)}</span>
      ${s.feedbackFit ? `<span class="lbd-about-meta"><strong>Feedback fit:</strong> ${esc(s.feedbackFit)}</span>` : ''}
      <p><span class="lbd-kicker">Why these frameworks</span><br>${esc(s.coachingNote)}</p>
    </article>`;
  }).join('');
  return `<section class="lbd-panel lbd-trends-section">
    <h2 class="lbd-h3">Scenarios → frameworks</h2>
    <p class="lbd-dim">The four scenes and the styles + feedback models each one is built to train.</p>
    <div class="lbd-about-grid">${cards}</div>
  </section>`;
}

function render() {
  aboutEl.innerHTML = `
    <div class="lbd-trends-top">
      <a class="lbd-back" href="/lbd">← Simulator</a>
      <h1 class="lbd-h1">About the Lateral Leadership Simulator</h1>
      <p class="lbd-sub">${esc(LATERAL_LEADERSHIP)}</p>
    </div>
    ${rationaleHtml()}
    ${conflictStylesHtml()}
    ${feedbackModelsHtml()}
    ${logicPatternsHtml()}
    ${scenariosHtml()}
    <p class="lbd-foot"><a class="lbd-link" href="/lbd">Run a scenario →</a></p>`;
}

render();
