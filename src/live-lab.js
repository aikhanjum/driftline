import './live-lab.css';

const LANES = ['unguarded', 'guarded'];
const MAX_EVENT_CHARS = 1_048_576;
const MAX_RECORDED_EVENTS = 20_000;
const MAX_OUTPUT_CHARS = 150_000;
const REPLAY_SPEED = 0.25;

export function validateRecording(recording) {
  if (!recording || recording.version !== 1 || typeof recording.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(recording.recordedAt)) ||
      typeof recording.model !== 'string' || !recording.model ||
      !recording.inputs || !['goal', 'constraints', 'disturbance'].every((key) => typeof recording.inputs[key] === 'string') ||
      !recording.result || !Array.isArray(recording.events) ||
      !recording.events.length || recording.events.length > MAX_RECORDED_EVENTS) {
    throw new Error('The recorded run is incomplete or unreadable.');
  }
  let previous = 0;
  for (const event of recording.events) {
    if (!event || typeof event.type !== 'string' ||
        !Number.isFinite(event.elapsedMs) || event.elapsedMs < previous) {
      throw new Error('The recorded run has invalid event timings.');
    }
    previous = event.elapsedMs;
  }
  if (!recording.events.some((event) => event.type === 'result')) {
    throw new Error('The recorded run has no final result event.');
  }
  return recording;
}

function waitForPlayback(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Replay canceled', 'AbortError')); return; }
    if (ms <= 0) { resolve(); return; }
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('Replay canceled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function playRecordedEvents(recording, onEvent, signal) {
  validateRecording(recording);
  const started = performance.now();
  for (const event of recording.events) {
    await waitForPlayback(started + event.elapsedMs / REPLAY_SPEED - performance.now(), signal);
    if (signal?.aborted) throw new DOMException('Replay canceled', 'AbortError');
    onEvent(event);
  }
}

// Read complete NDJSON records across arbitrary network and UTF-8 boundaries.
export async function readEventStream(response, onEvent, signal) {
  if (!response.body) throw new Error('The generator returned no event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const parse = (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_EVENT_CHARS) throw new Error('A generator event exceeded the display limit.');
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error('The generator returned an unreadable event.'); }
    if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new Error('The generator returned an invalid event.');
    }
    onEvent(event);
  };
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Run canceled', 'AbortError');
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > MAX_EVENT_CHARS) throw new Error('A generator event exceeded the display limit.');
      if (done) break;
    }
    if (signal?.aborted) throw new DOMException('Run canceled', 'AbortError');
    parse(pending);
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const seconds = (ms) => Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : '';
const boundedScore = (score) => Number.isFinite(score) && score >= 0 && score <= 1;

export function initLiveLab() {
  const root = document.querySelector('#live-lab');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  const $ = (id) => root.querySelector(`#lab-${id}`);
  const ui = Object.fromEntries([
    'form', 'goal', 'constraints', 'disturbance', 'run', 'replay', 'cancel', 'run-status',
    'engine', 'setup', 'setup-detail', 'retry', 'decision', 'reading-detail',
    'reading-count', 'trace', 'trace-line', 'export', 'event-count', 'events-json', 'announcement',
    'source', 'source-badge', 'source-detail', 'requirements',
  ].map((id) => [id, $(id)]));
  const lanes = Object.fromEntries(LANES.map((name) => [name, {
    element: root.querySelector(`[data-lane="${name}"]`),
    transcript: $(`${name}-transcript`), state: $(`${name}-state`),
    detail: $(`${name}-detail`), time: $(`${name}-time`),
    current: null, text: '', terminal: false, started: false, startedAt: null, attempt: 0,
  }]));
  let ready = false;
  let model = '';
  let activeController = null;
  let readinessController = null;
  let eventLog = [];
  let scores = [];
  let capturedInputs = null;
  let runResult = null;
  let logTruncated = false;
  let captureMetadata = null;
  let capturedModel = '';

  function announce(message) { ui.announcement.textContent = message; }
  function setStatus(message) { ui['run-status'].textContent = message; }
  function isReplay() { return captureMetadata?.source === 'recorded'; }
  function showSource() {
    ui.source.hidden = false;
    ui.source.dataset.source = captureMetadata.source;
    ui['source-badge'].textContent = isReplay() ? 'RECORDED RUN' : 'LIVE RUN';
    ui['source-detail'].textContent = isReplay()
      ? `0.25× playback. Original timings unchanged.${captureMetadata.recordedAt ? ` Captured ${new Date(captureMetadata.recordedAt).toLocaleString()} with ${capturedModel}.` : ' Loading the captured local run.'}`
      : 'Local generation. Native scores measured during this run.';
  }
  function setBusy(busy) {
    ui.run.disabled = busy || !ready;
    ui.replay.disabled = busy;
    ui.cancel.hidden = !busy;
    ui.cancel.textContent = isReplay() ? 'Cancel replay' : 'Cancel run';
    ui.run.firstChild.textContent = busy && !isReplay() ? 'Comparison running ' : 'Run comparison ';
    ui.replay.firstChild.textContent = busy && isReplay() ? 'Replaying recorded run ' : 'Replay recorded run ';
    ui.retry.disabled = busy;
    for (const field of [ui.goal, ui.constraints, ui.disturbance]) field.disabled = busy;
    ui.form.setAttribute('aria-busy', String(busy));
  }
  function laneState(lane, state, label) {
    lane.element.dataset.state = state;
    lane.state.textContent = label;
  }
  function nextAttempt(lane, label) {
    const wasNearBottom = lane.transcript.scrollHeight - lane.transcript.scrollTop - lane.transcript.clientHeight < 45;
    if (!lane.started) {
      lane.transcript.replaceChildren();
      lane.started = true;
    }
    if (label) {
      const heading = document.createElement('p');
      heading.className = 'lab-attempt-label';
      heading.textContent = label;
      lane.transcript.append(heading);
    }
    const output = document.createElement('p');
    output.className = 'lab-output';
    lane.transcript.append(output);
    lane.current = output;
    lane.text = '';
    lane.attempt += 1;
    if (wasNearBottom) lane.transcript.scrollTop = lane.transcript.scrollHeight;
  }
  function appendText(lane, text, replace = false) {
    if (typeof text !== 'string' || !text) return;
    if (!lane.current) nextAttempt(lane);
    const wasNearBottom = lane.transcript.scrollHeight - lane.transcript.scrollTop - lane.transcript.clientHeight < 45;
    lane.text = (replace ? text : lane.text + text).slice(0, MAX_OUTPUT_CHARS);
    lane.current.textContent = lane.text;
    if (wasNearBottom) lane.transcript.scrollTop = lane.transcript.scrollHeight;
  }
  function drawReading(decision) {
    if (!decision || typeof decision !== 'object') return;
    const verified = decision.requirementVerification?.applied === true;
    ui.requirements.hidden = !verified;
    ui.requirements.textContent = verified ? 'Every requirement supported' : '';
    const minimum = decision.requirementVerification?.minimumEntailment;
    ui.requirements.title = verified && boundedScore(minimum)
      ? `Minimum requirement entailment ${(minimum * 100).toFixed(0)} percent. Uncalibrated model evidence.` : '';
    const label = { pivot: 'Pivot detected', continue: 'On course', uncertain: 'Abstaining' }[decision.kind];
    if (label) {
      ui.decision.textContent = label;
      ui.decision.parentElement.dataset.kind = decision.kind;
    }
    const details = [];
    if (boundedScore(decision.confidence)) details.push(`${Math.round(decision.confidence * 100)}% decision support`);
    if (Number.isFinite(decision.latencyMs) && decision.latencyMs >= 0) details.push(`${decision.latencyMs.toFixed(1)} ms ${isReplay() ? 'recorded native inference' : 'inference'}`);
    ui['reading-detail'].textContent = details.join(' · ') || 'No numeric score returned.';
    if (boundedScore(decision.driftScore)) {
      scores.push(decision.driftScore);
      const recent = scores.slice(-64);
      const path = recent.map((score, index) => `${index ? 'L' : 'M'}${(index * 480 / Math.max(1, recent.length - 1)).toFixed(1)},${(56 - score * 48).toFixed(1)}`).join(' ');
      ui['trace-line'].setAttribute('d', recent.length === 1 ? `${path} l1,0` : path);
      ui.trace.setAttribute('aria-label', `${scores.length} observed snapshots. Latest drift score ${(decision.driftScore * 100).toFixed(0)} percent. The trace shows the most recent ${recent.length} scores.`);
      ui['reading-count'].textContent = `${scores.length} snapshot${scores.length === 1 ? '' : 's'}`;
    }
  }
  function record(event) {
    if (eventLog.length < MAX_RECORDED_EVENTS) eventLog.push(event);
    else logTruncated = true;
    ui['event-count'].textContent = `${eventLog.length}${logTruncated ? '+' : ''} events`;
    ui.export.disabled = false;
    if (root.querySelector('.lab-events').open) renderEventLog();
  }
  function renderEventLog() {
    // Limit expensive formatting to the expanded inspector and the last 200 events.
    const prefix = eventLog.length > 200 ? 'Showing the latest 200 events. Export the log for all captured events.\n\n' : '';
    ui['events-json'].textContent = eventLog.length
      ? prefix + eventLog.slice(-200).map((event) => JSON.stringify(event)).join('\n')
      : 'No events recorded.';
  }
  function handleEvent(event) {
    record(event);
    if (event.type === 'result') {
      runResult = event.result ?? {};
      setStatus(isReplay() ? 'Recorded run replayed. Original measurements remain unchanged.' : 'Comparison recorded. Inspect the output and observed events.');
      announce(isReplay() ? 'Recorded run replayed. Inspect the captured outputs and events.' : 'Comparison complete. Both model outputs are available.');
      return;
    }
    const lane = lanes[event.lane];
    if (!lane) {
      if (event.type === 'error') throw new Error(event.error || event.message || 'The comparison failed.');
      return;
    }
    if (event.type === 'start') lane.startedAt = event.elapsedMs;
    if (Number.isFinite(event.elapsedMs)) lane.time.textContent = `${seconds(event.elapsedMs - (lane.startedAt ?? 0))} ${isReplay() ? 'recorded' : 'elapsed'}`;
    switch (event.type) {
      case 'start':
        if (!lane.current) nextAttempt(lane);
        laneState(lane, 'streaming', isReplay() ? 'Replaying capture' : 'Generating');
        lane.detail.textContent = event.lane === 'guarded'
          ? isReplay() ? 'Recorded native readings on partial output' : 'Native scorer observing partial output'
          : isReplay() ? 'Recorded baseline without intervention' : 'No intervention applied';
        setStatus(isReplay()
          ? `Recorded run. Replaying the ${event.lane === 'guarded' ? 'guarded' : 'baseline'} generation at 0.25×.`
          : event.lane === 'guarded' ? 'Guard on. Scoring the same injected plan.' : 'Guard off. Generating the baseline plan.');
        break;
      case 'delta':
        appendText(lane, event.delta);
        break;
      case 'reading':
        if (event.lane === 'guarded' && !event.stale) drawReading(event.decision);
        break;
      case 'interrupted': {
        if (event.reason !== 'pivot') {
          lane.terminal = true;
          laneState(lane, 'canceled', isReplay() ? 'Recorded cancellation' : 'Canceled');
          lane.detail.textContent = `${isReplay() ? 'Recorded generation' : 'Generation'} canceled. Partial output remains provisional.`;
          break;
        }
        laneState(lane, 'interrupted', isReplay() ? 'Recorded cancellation' : 'Stream canceled');
        const marker = document.createElement('div');
        marker.className = 'lab-interruption';
        const title = document.createElement('strong');
        title.textContent = isReplay() ? '↳ Recorded stream cancellation. Correction issued.' : '↳ Stream canceled. Correction issued.';
        marker.append(title);
        if (Number.isFinite(event.decision?.latencyMs) && typeof event.text === 'string') {
          const measurement = document.createElement('p');
          measurement.textContent = `Caught at ${event.text.length} characters. ${event.decision.latencyMs.toFixed(1)} ms ${isReplay() ? 'recorded native' : 'native'} inference.`;
          marker.append(measurement);
        }
        const adjustment = typeof event.adjustment === 'string' ? event.adjustment : event.decision?.adjustment;
        if (adjustment) {
          const detail = document.createElement('p');
          detail.textContent = adjustment;
          marker.append(detail);
        }
        lane.transcript.append(marker);
        lane.detail.textContent = isReplay() ? 'Recorded request abort after a pivot signal' : 'Generator request aborted after a pivot signal';
        announce(isReplay() ? 'In the recording, Driftline canceled the guarded stream and issued a correction.' : 'Driftline canceled the guarded model stream and issued a correction.');
        break;
      }
      case 'resumed':
        nextAttempt(lane, `${isReplay() ? 'Recorded' : 'New'} generation · correction ${lane.attempt}`);
        laneState(lane, 'streaming', isReplay() ? 'Replaying correction' : 'Generating again');
        lane.detail.textContent = isReplay() ? 'Recorded restart with the original goal and correction' : 'Resumed with the original goal and correction';
        setStatus(isReplay() ? 'Recorded correction. Replaying the restarted generation at 0.25×.' : 'Correction issued. Generating a new plan for the original goal.');
        break;
      case 'complete':
        if (typeof event.text === 'string') appendText(lane, event.text, true);
        lane.terminal = true;
        laneState(lane, 'complete', event.lane === 'guarded'
          ? isReplay() ? 'Recorded approval' : 'Plan approved'
          : isReplay() ? 'Recorded end' : 'Generation ended');
        lane.detail.textContent = event.lane === 'guarded'
          ? lane.attempt > 1 ? 'New plan recorded after correction' : 'Generation ended without an applied correction'
          : 'Baseline output recorded';
        break;
      case 'blocked':
        lane.terminal = true;
        laneState(lane, 'blocked', isReplay() ? 'Recorded block' : 'Plan withheld');
        lane.detail.textContent = event.reason === 'uncertain'
          ? 'The scorer abstained. This plan has not been approved.'
          : `Output withheld. ${String(event.error || event.reason || 'Review the event log.')}`;
        announce(isReplay() ? 'The recording shows the guarded model being stopped. Review the event log for the reason.' : 'The guarded model was stopped. Review the event log for the reason.');
        break;
      case 'error':
        lane.terminal = true;
        laneState(lane, 'error', 'Run failed');
        lane.detail.textContent = String(event.error || event.message || 'The generator reported an error.');
        throw new Error(lane.detail.textContent);
      default:
        // Preserve unfamiliar events for inspection without inventing their meaning.
        break;
    }
  }
  async function checkGenerator() {
    readinessController?.abort();
    const controller = new AbortController();
    readinessController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    ui.retry.disabled = true;
    ui.engine.lastChild.textContent = 'Checking local generator';
    try {
      const response = await fetch('/api/generator', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('The live lab is available when you run the local server.');
      const result = await response.json();
      ready = result.ready === true;
      model = typeof result.model === 'string' ? result.model : 'local model';
      ui.engine.dataset.ready = String(ready);
      ui.engine.lastChild.textContent = ready ? `${model} · local generator ready` : 'Local generator unavailable';
      ui.setup.hidden = ready;
      if (!ready) ui['setup-detail'].textContent = `${result.error || 'Start the local generator and native C++ server.'} Run npm run setup:generator, npm run dev:generator, then npm run dev:cpp in another terminal.`;
    } catch (error) {
      if (controller !== readinessController) return;
      ready = false;
      ui.engine.dataset.ready = 'false';
      ui.engine.lastChild.textContent = 'Local runtime required';
      ui.setup.hidden = false;
      ui['setup-detail'].textContent = 'Run npm run setup:generator, start npm run dev:generator, then start npm run dev:cpp in a second terminal. The browser scorer below works without the generator.';
    } finally {
      clearTimeout(timeout);
      if (controller === readinessController) setBusy(Boolean(activeController));
    }
  }
  function resetRun() {
    eventLog = [];
    scores = [];
    runResult = null;
    logTruncated = false;
    for (const [name, lane] of Object.entries(lanes)) {
      lane.current = null;
      lane.text = '';
      lane.terminal = false;
      lane.started = false;
      lane.startedAt = null;
      lane.attempt = 0;
      lane.transcript.replaceChildren();
      const placeholder = document.createElement('p');
      placeholder.className = 'lab-empty';
      placeholder.textContent = isReplay()
        ? name === 'unguarded' ? 'Waiting for the recorded baseline.' : 'The recorded guard follows the baseline.'
        : name === 'unguarded' ? 'Waiting for baseline generation.' : 'The guarded run follows the baseline.';
      lane.transcript.append(placeholder);
      lane.detail.textContent = isReplay() ? 'Waiting for recorded events' : 'Waiting for generator';
      lane.time.textContent = '';
      laneState(lane, 'waiting', name === 'unguarded' ? 'Guard off' : 'Guard on');
    }
    ui.decision.textContent = 'No reading yet';
    ui.requirements.hidden = true;
    ui.requirements.textContent = '';
    ui.requirements.title = '';
    ui.decision.parentElement.removeAttribute('data-kind');
    ui['reading-detail'].textContent = isReplay() ? 'Original scores appear with their recorded events.' : 'Scores appear only after inference.';
    ui['reading-count'].textContent = '0 snapshots';
    ui['trace-line'].setAttribute('d', '');
    ui.trace.setAttribute('aria-label', 'No observed drift scores yet');
    ui['event-count'].textContent = '0 events';
    ui.export.disabled = true;
    renderEventLog();
  }
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (activeController || !ready || !ui.form.reportValidity()) return;
    const inputs = { goal: ui.goal.value.trim(), constraints: ui.constraints.value.trim(), disturbance: ui.disturbance.value.trim() };
    if (!inputs.goal || !inputs.disturbance) { setStatus('Enter a task and a controlled drift injection.'); return; }
    captureMetadata = { source: 'live', recordedAt: new Date().toISOString(), playbackSpeed: 1 };
    capturedModel = model;
    showSource();
    resetRun();
    capturedInputs = inputs;
    const controller = new AbortController();
    activeController = controller;
    setBusy(true);
    setStatus('Opening a live generation stream.');
    try {
      const response = await fetch('/api/duel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs), signal: controller.signal,
      });
      if (!response.ok) {
        let reason = `The comparison could not start. HTTP ${response.status}.`;
        if (response.headers.get('content-type')?.includes('application/json')) {
          const detail = await response.json();
          if (typeof detail.error === 'string') reason = detail.error;
        }
        throw new Error(reason);
      }
      if (!response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('The local server did not return a generation event stream.');
      await readEventStream(response, handleEvent, controller.signal);
      if (!runResult && !Object.values(lanes).every((lane) => lane.terminal)) throw new Error('The event stream ended before both runs finished. Partial output is preserved.');
      if (!runResult) setStatus('Both generation runs ended. Inspect the observed events.');
    } catch (error) {
      const canceled = controller.signal.aborted;
      const message = canceled ? 'Run canceled. Partial output and observed events are preserved.' : error.message || 'The live comparison failed.';
      setStatus(message);
      announce(message);
      for (const lane of Object.values(lanes)) {
        if (lane.started && !lane.terminal) laneState(lane, canceled ? 'canceled' : 'error', canceled ? 'Canceled' : 'Interrupted by error');
      }
    } finally {
      if (activeController === controller) activeController = null;
      setBusy(false);
      renderEventLog();
    }
  });
  ui.replay.addEventListener('click', async () => {
    if (activeController) return;
    const controller = new AbortController();
    activeController = controller;
    captureMetadata = { source: 'recorded', recordedAt: null, playbackSpeed: REPLAY_SPEED };
    capturedModel = '';
    capturedInputs = null;
    showSource();
    resetRun();
    setBusy(true);
    setStatus('Loading a captured local run for 0.25× playback.');
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}live-recording.json`, { signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('The recorded run is unavailable. No recording was replayed.');
      }
      const recording = validateRecording(await response.json());
      captureMetadata.recordedAt = recording.recordedAt;
      capturedModel = recording.model;
      capturedInputs = { ...recording.inputs };
      for (const key of ['goal', 'constraints', 'disturbance']) ui[key].value = recording.inputs[key];
      showSource();
      await playRecordedEvents(recording, handleEvent, controller.signal);
    } catch (error) {
      const canceled = controller.signal.aborted;
      const message = canceled
        ? 'Replay canceled. Captured events already shown are preserved.'
        : error.message || 'The recording could not be replayed.';
      setStatus(message);
      announce(message);
      for (const lane of Object.values(lanes)) {
        if (lane.started && !lane.terminal) laneState(lane, canceled ? 'canceled' : 'error', canceled ? 'Replay canceled' : 'Replay error');
      }
    } finally {
      if (activeController === controller) activeController = null;
      setBusy(false);
      renderEventLog();
    }
  });
  ui.cancel.addEventListener('click', () => { activeController?.abort(); });
  ui.retry.addEventListener('click', checkGenerator);
  root.querySelector('.lab-events').addEventListener('toggle', renderEventLog);
  ui.export.addEventListener('click', () => {
    if (!eventLog.length) return;
    const report = { version: 1, exportedAt: new Date().toISOString(), ...captureMetadata, model: capturedModel, inputs: capturedInputs, result: runResult, truncated: logTruncated, events: eventLog };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `driftline-comparison-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener('pagehide', () => { activeController?.abort(); readinessController?.abort(); }, { once: true });
  checkGenerator();
}
