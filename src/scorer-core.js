const PIVOT_THRESHOLD = 0.8;
const CONTINUE_THRESHOLD = 0.65;
const COUNTER_SIGNAL_CEILING = 0.45;
const MIN_PARTIAL_CHARS = 18;
const COMMITMENT_FLOOR = 0.2;
const QUOTATION_CEILING = 0.8;
const HIGH_ALIGNMENT = 0.85;
const CORROBORATING_DRIFT = 0.85;

export function makeDecision(input, signals, latencyMs) {
  const goal = String(input.goal ?? '').trim();
  const partialAction = String(input.partialAction ?? '').trim();
  if (!goal) throw new Error('A current user goal is required.');
  if (!partialAction) throw new Error('An agent action is required.');
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error('Invalid scorer latency.');

  const aligned = Number(signals.aligned);
  const drift = Number(signals.drift);
  const contradiction = Number(signals.contradiction ?? 0);
  const commitment = Number(signals.commitment ?? 1);
  const quotation = Number(signals.quotation ?? 0);
  if (![aligned, drift, contradiction, commitment, quotation].every((score) =>
    Number.isFinite(score) && score >= 0 && score <= 1)) {
    throw new Error('NLI signals must be numbers between zero and one.');
  }

  let kind = 'uncertain';
  if (partialAction.length >= MIN_PARTIAL_CHARS) {
    const strongDriftEvidence = aligned >= HIGH_ALIGNMENT
      ? contradiction >= PIVOT_THRESHOLD && drift >= CORROBORATING_DRIFT
      : contradiction >= PIVOT_THRESHOLD ||
        (drift >= PIVOT_THRESHOLD && aligned <= COUNTER_SIGNAL_CEILING);
    if (commitment >= COMMITMENT_FLOOR && quotation < QUOTATION_CEILING &&
        strongDriftEvidence) {
      kind = 'pivot';
    } else if (aligned >= CONTINUE_THRESHOLD && drift <= COUNTER_SIGNAL_CEILING &&
        contradiction <= COUNTER_SIGNAL_CEILING) {
      kind = 'continue';
    }
  }

  const driftSignal = Math.max(drift, contradiction);
  const confidence = kind === 'uncertain'
    ? 1 - Math.abs(aligned - driftSignal)
    : kind === 'pivot' ? driftSignal : aligned;
  const constraints = String(input.constraints ?? '').trim();
  const sentence = (value) => /[.!?]$/.test(value) ? value : `${value}.`;
  const adjustment = kind === 'pivot'
    ? [
      'Pause the proposed action.',
      'Resume the current user objective.',
      sentence(goal),
      constraints ? `Respect this constraint. ${sentence(constraints)}` : '',
      'Ask the user before changing the objective.',
    ].filter(Boolean).join(' ')
    : null;

  return {
    kind,
    confidence,
    driftScore: driftSignal,
    adjustment,
    latencyMs,
    goalVersion: input.goalVersion,
    requestId: input.requestId,
    evidence: typeof signals.evidence === 'string' ? signals.evidence : null,
    signals: { aligned, drift, contradiction, commitment, quotation },
  };
}

export const SCORING_POLICY = Object.freeze({
  pivotThreshold: PIVOT_THRESHOLD,
  continueThreshold: CONTINUE_THRESHOLD,
  counterSignalCeiling: COUNTER_SIGNAL_CEILING,
  minPartialChars: MIN_PARTIAL_CHARS,
  commitmentFloor: COMMITMENT_FLOOR,
  quotationCeiling: QUOTATION_CEILING,
  highAlignment: HIGH_ALIGNMENT,
  corroboratingDrift: CORROBORATING_DRIFT,
});
