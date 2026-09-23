import './styles.css';
import { scenarios } from './scenarios.js';
import { DriftScorer } from './scorer-client.js';
import { NodeScorer } from './node-scorer.js';
import { PivotGate } from './pivot-gate.js';

const nodeMode = import.meta.env.DEV && import.meta.env.VITE_DRIFTLINE_FAST === '1';
const cppMode = import.meta.env.DEV && import.meta.env.VITE_DRIFTLINE_CPP === '1';

const $ = (selector) => document.querySelector(selector);
const els = {
  status: $('#engine-status'),
  statusText: $('#engine-status-text'),
  statusPercent: $('#engine-percent'),
  progress: $('#model-progress'),
  scenarios: $('#scenario-list'),
  custom: $('#custom-scenario'),
  mode: $('#input-mode'),
  goal: $('#goal-input'),
  constraints: $('#constraints-input'),
  history: $('#history-input'),
  action: $('#action-input'),
  cursor: $('#typing-cursor'),
  streamCaption: $('#stream-caption'),
  editLive: $('#edit-live'),
  replay: $('#replay-button'),
  replayText: $('#replay-button-text'),
  replayIcon: $('#replay-button-icon'),
  signalPanel: $('.signal-panel'),
  signalValue: $('#signal-value'),
  signalUnit: $('#signal-unit'),
  signalTrack: $('#signal-track'),
  signalFill: $('#signal-fill'),
  signalMarker: $('#signal-marker'),
  decision: $('#decision-value'),
  confidence: $('#confidence-value'),
  latency: $('#latency-value'),
  sequence: $('#signal-seq'),
  signalFooter: $('#signal-footer-text'),
  traceEmpty: $('#trace-empty'),
  traceSvg: $('#trace-svg'),
  tracePlot: $('#trace-plot'),
  traceList: $('#trace-list'),
  handoff: $('#handoff-state'),
  dispatchCopy: $('#dispatch-copy'),
  gateStatus: $('#gate-status'),
  dispatchMeta: $('#dispatch-meta'),
  inspector: $('#inspector'),
  inspectorJson: $('#inspector-json'),
  inspectTop: $('#inspect-top'),
  inspectorClose: $('#inspector-close'),
  inspectorBackdrop: $('#inspector-backdrop'),
  copyJson: $('#copy-json'),
  copyFeedback: $('#copy-feedback'),
  srStatus: $('#screenreader-status'),
};

const state = {
  scorer: null,
  ready: false,
  activeScenario: scenarios[0],
  mode: 'replay',
  goalVersion: 1,
  requestId: 0,
  replayToken: 0,
  scoring: false,
  latestTarget: null,
  trace: [],
  lastExchange: null,
  lastDecision: null,
  dispatchCount: 0,
  liveTimer: null,
  returnFocus: null,
};

const gate = new PivotGate({
  onRedirect: (adjustment, decision) => dispatchAdjustment(adjustment, decision),
});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function setEngineStatus(kind, message, percentage = null) {
  els.status.dataset.state = kind;
  els.statusText.textContent = message;
  els.statusPercent.textContent = Number.isFinite(percentage) ? `${Math.round(percentage)}%` : '';
  els.progress.hidden = !Number.isFinite(percentage) || kind !== 'loading';
  if (!els.progress.hidden) els.progress.value = Math.max(0, Math.min(100, percentage));
}

function handleModelProgress(progress) {
  const raw = typeof progress === 'number'
    ? progress
    : progress?.progress ?? progress?.percent ?? progress?.percentage;
  const numeric = typeof raw === 'string' ? Number(raw) : raw;
  const percentage = Number.isFinite(numeric)
    ? (numeric <= 1 ? numeric * 100 : numeric)
    : null;
  const stage = ({
    initiate: 'Fetching local model',
    progress: 'Downloading local model',
    progress_total: 'Downloading local model',
    done: 'Preparing signal engine',
  })[progress?.status] ?? 'Loading local model';
  setEngineStatus('loading', stage, percentage);
}

function updateScenarioButtons() {
  els.scenarios.innerHTML = scenarios.map((scenario) => `
    <button class="scenario-button${state.activeScenario?.id === scenario.id ? ' is-active' : ''}" type="button" data-scenario="${scenario.id}" aria-pressed="${state.activeScenario?.id === scenario.id}">
      <span>${scenario.number}</span>${scenario.title}
    </button>
  `).join('');
  els.custom.classList.toggle('is-active', !state.activeScenario);
  els.custom.setAttribute('aria-pressed', String(!state.activeScenario));
}

function updateMode() {
  const replay = state.mode === 'replay';
  els.mode.textContent = replay ? 'SCRIPTED REPLAY' : 'LIVE INPUT';
  els.mode.dataset.mode = state.mode;
  els.action.readOnly = replay;
  els.action.placeholder = replay ? 'The replay will write the agent action here.' : 'Start typing what the agent plans to do...';
  els.editLive.hidden = !state.activeScenario;
  els.editLive.textContent = replay ? 'Edit live' : 'Live editing';
  els.editLive.disabled = !replay;
  els.replayText.textContent = state.activeScenario ? 'Replay sequence' : 'Score action';
  els.replayIcon.textContent = state.activeScenario ? '↻' : '↗';
}

function resetReadings() {
  state.latestTarget = null;
  gate.setContext({ goalVersion: state.goalVersion, requestId: state.requestId, phase: 'model' });
  state.trace = [];
  state.lastExchange = null;
  state.lastDecision = null;
  state.dispatchCount = 0;
  els.signalPanel.dataset.kind = 'idle';
  els.signalValue.textContent = '—';
  els.signalUnit.textContent = '/100';
  els.signalFill.style.width = '0%';
  els.signalMarker.style.left = '0%';
  els.signalTrack.setAttribute('aria-label', 'No drift score reading yet');
  els.decision.textContent = 'Awaiting first reading';
  els.confidence.textContent = '—';
  els.latency.textContent = '—';
  els.sequence.textContent = 'READING 000';
  els.signalFooter.textContent = 'Every number comes from the scorer.';
  els.traceSvg.innerHTML = '';
  els.traceEmpty.hidden = false;
  els.tracePlot.setAttribute('aria-label', 'No scored readings yet');
  els.traceList.innerHTML = '';
  els.handoff.innerHTML = '<span class="handoff-symbol">↳</span><span>Waiting for a pivot to dispatch.</span>';
  els.handoff.dataset.state = 'idle';
  els.dispatchCopy.textContent = 'When the scorer returns a pivot, its exact adjustment appears here as the instruction sent to a simulated agent.';
  els.gateStatus.textContent = 'GATE / NO READING';
  els.dispatchMeta.textContent = 'NO ADJUSTMENT DISPATCHED';
  renderInspector();
}

function stopReplay() {
  state.replayToken += 1;
  els.cursor.classList.remove('is-typing');
}

function startScenario(scenario) {
  stopReplay();
  window.clearTimeout(state.liveTimer);
  state.goalVersion += 1;
  state.activeScenario = scenario;
  state.mode = 'replay';
  els.goal.value = scenario.goal;
  els.constraints.value = scenario.constraints;
  els.history.value = scenario.history;
  els.action.value = '';
  updateScenarioButtons();
  updateMode();
  resetReadings();
  els.streamCaption.textContent = state.ready ? 'Preparing the replay' : 'Waiting for the engine';
  if (state.ready) void replayScenario();
}

function startCustom() {
  stopReplay();
  window.clearTimeout(state.liveTimer);
  state.goalVersion += 1;
  state.activeScenario = null;
  state.mode = 'live';
  els.goal.value = '';
  els.constraints.value = '';
  els.history.value = '';
  els.action.value = '';
  updateScenarioButtons();
  updateMode();
  resetReadings();
  els.streamCaption.textContent = 'Write a goal and the agent’s next move';
  els.goal.focus();
}

function enterLive() {
  if (state.mode === 'live') return;
  stopReplay();
  state.goalVersion += 1;
  state.mode = 'live';
  updateMode();
  resetReadings();
  els.streamCaption.textContent = state.ready ? 'Live typing is ready' : 'Waiting for the engine';
}

async function replayScenario() {
  if (!state.ready || !state.activeScenario) return;
  stopReplay();
  state.goalVersion += 1;
  resetReadings();
  const token = state.replayToken;
  const fullAction = state.activeScenario.beats.join(' ');
  els.action.value = '';
  els.cursor.classList.add('is-typing');
  els.streamCaption.textContent = 'Streaming a scripted agent action';

  const tickMs = reducedMotion.matches ? 0 : 15;
  const stepSize = reducedMotion.matches ? 22 : 1;
  for (let index = 0; index < fullAction.length; index += stepSize) {
    if (token !== state.replayToken || state.mode !== 'replay') return;
    const end = Math.min(fullAction.length, index + stepSize);
    const partial = fullAction.slice(0, end);
    els.action.value = partial;
    els.action.scrollTop = els.action.scrollHeight;
    if (end === fullAction.length || (reducedMotion.matches ? end % 44 < stepSize : end % 12 === 0)) {
      queueScore(partial);
    }
    if (tickMs) await wait(tickMs);
  }
  if (token !== state.replayToken) return;
  els.cursor.classList.remove('is-typing');
  els.streamCaption.textContent = 'Replay complete. Scoring the final action';
  queueScore(fullAction);
}

function queueScore(partialAction) {
  if (!state.ready || !partialAction.trim() || !els.goal.value.trim()) return;
  const requestId = ++state.requestId;
  state.latestTarget = {
    goal: els.goal.value.trim(),
    constraints: els.constraints.value.trim(),
    history: els.history.value.trim() ? [els.history.value.trim()] : [],
    partialAction,
    goalVersion: state.goalVersion,
    requestId,
    mode: state.mode,
  };
  if (state.mode === 'replay') {
    gate.setContext({ goalVersion: state.goalVersion, requestId, phase: 'model' });
  }
  void drainQueue();
}

async function drainQueue() {
  if (state.scoring || !state.ready) return;
  state.scoring = true;
  while (state.latestTarget) {
    const target = state.latestTarget;
    state.latestTarget = null;
    const { mode, ...input } = target;
    const payload = input;
    try {
      const result = await state.scorer.score(payload);
      if (payload.goalVersion !== state.goalVersion) continue;
      if (result?.goalVersion !== payload.goalVersion || result?.requestId !== payload.requestId) continue;
      if (!['continue', 'pivot', 'uncertain'].includes(result.kind)) throw new Error('The scorer returned an unknown decision.');
      if (!Number.isFinite(result.driftScore) || !Number.isFinite(result.confidence)) throw new Error('The scorer returned an incomplete reading.');
      const gateResult = mode === 'replay' ? gate.apply(result) : null;
      const current = payload.requestId === state.requestId;
      state.trace.push({
        requestId: payload.requestId,
        text: payload.partialAction,
        kind: result.kind,
        driftScore: Math.max(0, Math.min(1, result.driftScore)),
        alignment: Number.isFinite(result.signals?.aligned) ? Math.max(0, Math.min(1, result.signals.aligned)) : null,
        latencyMs: result.latencyMs,
      });
      renderTrace();
      if (!current) continue;
      state.lastExchange = { request: payload, response: result, gate: gateResult };
      renderReading(result);
      renderGateResult(gateResult, result, mode);
      renderInspector();
      if (result.kind !== state.lastDecision) {
        els.srStatus.textContent = `Signal changed to ${result.kind}. Drift score ${Math.round(result.driftScore * 100)} out of 100.`;
        state.lastDecision = result.kind;
      }
      if (state.mode === 'live') els.streamCaption.textContent = 'Live action scored';
      else if (!els.cursor.classList.contains('is-typing')) els.streamCaption.textContent = 'Replay complete. Final action scored';
    } catch (error) {
      if (payload.goalVersion !== state.goalVersion) continue;
      if (error instanceof Error && error.message === 'Superseded by a newer partial action.') continue;
      els.streamCaption.textContent = `Scoring paused. ${error instanceof Error ? error.message : 'Unknown error.'}`;
      els.signalFooter.textContent = 'The scorer did not return a reading.';
      break;
    }
  }
  state.scoring = false;
}

function renderReading(result) {
  const driftScore = Math.max(0, Math.min(1, result.driftScore));
  const confidence = Math.max(0, Math.min(1, result.confidence));
  const percentage = Math.round(driftScore * 100);
  els.signalPanel.dataset.kind = result.kind;
  els.signalValue.textContent = String(percentage);
  els.signalFill.style.width = `${percentage}%`;
  els.signalMarker.style.left = `${percentage}%`;
  els.signalTrack.setAttribute('aria-label', `Uncalibrated model drift score ${percentage} out of 100`);
  els.decision.textContent = ({ continue: 'ON COURSE', pivot: 'PIVOT ADVISED', uncertain: 'UNCERTAIN · MONITOR' })[result.kind];
  els.confidence.textContent = confidence.toFixed(2);
  const roundTripMs = Number.isFinite(result.roundTripMs) ? result.roundTripMs : result.latencyMs;
  els.latency.textContent = Number.isFinite(roundTripMs)
    ? `${roundTripMs < 10 ? roundTripMs.toFixed(1) : Math.round(roundTripMs)} ms`
    : '—';
  els.sequence.textContent = `READING ${String(state.trace.length).padStart(3, '0')}`;
  els.signalFooter.textContent = state.dispatchCount > 0
    ? 'Pivot gate redirected the simulated agent.'
    : result.kind === 'pivot'
    ? 'A typed correction is ready for the agent.'
    : result.kind === 'uncertain'
      ? 'The scorer abstained on this fragment.'
      : 'The next action still matches the goal.';
}

function renderTrace() {
  const points = state.trace.slice(-6);
  els.traceEmpty.hidden = points.length > 0;
  const coordinates = points.map((point, index) => ({
    x: points.length === 1 ? 300 : 24 + (index / (points.length - 1)) * 552,
    driftY: 86 - point.driftScore * 72,
    alignmentY: Number.isFinite(point.alignment) ? 86 - point.alignment * 72 : null,
    kind: point.kind,
  }));
  const driftPath = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.driftY.toFixed(1)}`).join(' ');
  const alignmentCoordinates = coordinates.filter((point) => Number.isFinite(point.alignmentY));
  const alignmentPath = alignmentCoordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.alignmentY.toFixed(1)}`).join(' ');
  els.traceSvg.innerHTML = `
    <path d="M0 14H600M0 50H600M0 86H600" class="plot-grid" />
    ${coordinates.length > 1 ? `<path d="${driftPath}" class="plot-path plot-path-drift" />` : ''}
    ${alignmentCoordinates.length > 1 ? `<path d="${alignmentPath}" class="plot-path plot-path-alignment" />` : ''}
    ${coordinates.map((point) => `<circle cx="${point.x}" cy="${point.driftY}" r="4.5" class="plot-dot plot-dot-drift" />`).join('')}
    ${alignmentCoordinates.map((point) => `<circle cx="${point.x}" cy="${point.alignmentY}" r="3.5" class="plot-dot plot-dot-alignment" />`).join('')}
  `;
  els.tracePlot.setAttribute('aria-label', `Last ${points.length} uncalibrated model drift scores, from ${Math.round(points[0].driftScore * 100)} to ${Math.round(points[points.length - 1].driftScore * 100)} out of 100`);
  els.traceList.innerHTML = points.slice().reverse().map((point) => {
    const clipped = point.text.length > 67 ? `…${point.text.slice(-67)}` : point.text;
    return `<li><span class="trace-index">#${String(point.requestId).padStart(3, '0')}</span><span class="trace-text">${escapeHtml(clipped)}</span><span class="trace-outcome trace-${point.kind}">${Math.round(point.driftScore * 100)} · ${point.kind.toUpperCase()}</span></li>`;
  }).join('');
}

function dispatchAdjustment(adjustment, result) {
  state.dispatchCount += 1;
  els.handoff.dataset.state = 'pivot';
  els.handoff.innerHTML = '<span class="handoff-symbol">↗</span><span>Adjustment dispatched</span>';
  els.dispatchCopy.textContent = adjustment;
  els.dispatchMeta.textContent = `SIMULATED AGENT · REQUEST ${String(result.requestId).padStart(3, '0')}`;
}

function renderGateResult(gateResult, result, mode) {
  if (mode !== 'replay') {
    els.gateStatus.textContent = 'LIVE INPUT / SCORING ONLY';
    return;
  }
  if (state.dispatchCount > 0 && !gateResult.applied) return;
  els.gateStatus.textContent = `GATE / ${gateResult.reason.toUpperCase().replaceAll('_', ' ')}`;
  if (gateResult.applied) {
    els.signalFooter.textContent = 'Pivot gate redirected the simulated agent.';
    return;
  }
  if (state.dispatchCount > 0) return;
  if (result.kind === 'pivot') {
    els.handoff.innerHTML = '<span class="handoff-symbol">↳</span><span>Pivot held by gate</span>';
    els.dispatchCopy.textContent = 'The scorer suggested a pivot. The gate did not dispatch it.';
    els.dispatchMeta.textContent = `NOT APPLIED · ${gateResult.reason.toUpperCase()}`;
  }
}

function renderInspector() {
  els.inspectorJson.textContent = state.lastExchange
    ? JSON.stringify(state.lastExchange, null, 2)
    : 'No reading yet.';
  els.copyJson.disabled = !state.lastExchange;
}

function openInspector() {
  state.returnFocus = document.activeElement;
  els.inspector.hidden = false;
  els.inspectTop.setAttribute('aria-expanded', 'true');
  document.body.classList.add('inspector-open');
  els.inspectorClose.focus();
}

function closeInspector() {
  els.inspector.hidden = true;
  els.inspectTop.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('inspector-open');
  state.returnFocus?.focus();
}

els.scenarios.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scenario]');
  if (!button) return;
  const scenario = scenarios.find((item) => item.id === button.dataset.scenario);
  if (scenario) startScenario(scenario);
});
els.custom.addEventListener('click', startCustom);
els.editLive.addEventListener('click', () => {
  enterLive();
  els.action.focus();
  els.action.setSelectionRange(els.action.value.length, els.action.value.length);
});
els.replay.addEventListener('click', () => {
  if (state.activeScenario) {
    if (state.mode !== 'replay') {
      state.mode = 'replay';
      updateMode();
    }
    void replayScenario();
  } else {
    queueScore(els.action.value);
  }
});

for (const input of [els.goal, els.constraints, els.history]) {
  input.addEventListener('input', () => {
    if (state.mode === 'replay') enterLive();
    else {
      state.goalVersion += 1;
      resetReadings();
    }
    if (els.action.value.trim()) {
      window.clearTimeout(state.liveTimer);
      state.liveTimer = window.setTimeout(() => queueScore(els.action.value), 180);
    }
  });
}
els.action.addEventListener('input', () => {
  if (state.mode !== 'live') return;
  window.clearTimeout(state.liveTimer);
  if (!els.action.value.trim()) {
    state.goalVersion += 1;
    resetReadings();
    els.streamCaption.textContent = 'Start typing to score the next move';
    return;
  }
  els.streamCaption.textContent = state.ready ? 'Reading the partial action' : 'Waiting for the engine';
  state.liveTimer = window.setTimeout(() => queueScore(els.action.value), 120);
});

els.inspectTop.addEventListener('click', openInspector);
els.inspectorClose.addEventListener('click', closeInspector);
els.inspectorBackdrop.addEventListener('click', closeInspector);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.inspector.hidden) closeInspector();
  if (event.key === 'Tab' && !els.inspector.hidden) {
    const focusable = [els.inspectorClose, els.inspectorJson, els.copyJson].filter((item) => !item.disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
els.copyJson.addEventListener('click', async () => {
  if (!state.lastExchange) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.lastExchange, null, 2));
    els.copyFeedback.textContent = 'Copied';
  } catch {
    els.copyFeedback.textContent = 'Clipboard unavailable';
  }
  window.setTimeout(() => { els.copyFeedback.textContent = ''; }, 2500);
});

updateScenarioButtons();
updateMode();
resetReadings();
els.goal.value = state.activeScenario.goal;
els.constraints.value = state.activeScenario.constraints;
els.history.value = state.activeScenario.history;
setEngineStatus('loading', cppMode ? 'Loading native C++ model' : nodeMode ? 'Loading local Node model' : 'Loading browser model');

async function initializeScorer() {
  try {
    state.scorer = nodeMode || cppMode ? new NodeScorer() : new DriftScorer();
    await state.scorer.ready(handleModelProgress);
    state.ready = true;
    setEngineStatus('ready', cppMode ? 'C++ scorer ready' : nodeMode ? 'Node scorer ready' : 'Browser scorer ready');
    if (state.mode === 'replay') void replayScenario();
    else if (els.action.value.trim()) queueScore(els.action.value);
    else els.streamCaption.textContent = 'Start typing to score the next move';
  } catch (error) {
    setEngineStatus('error', 'Signal engine unavailable');
    els.streamCaption.textContent = error instanceof Error ? error.message : 'The local model could not start.';
    els.signalFooter.textContent = 'No readings are available.';
  }
}

void initializeScorer();
