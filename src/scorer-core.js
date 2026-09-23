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

  let requirementVerification;
  let verifiedConfidence;
  if (input.verifyRequirements === true) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    const required = [goal, String(input.constraints ?? '').trim()].flatMap((text) =>
      Array.from(segmenter.segment(text), ({ segment }) => segment.trim()).filter(Boolean));
    const requirements = Array.isArray(signals.requirements) ? signals.requirements : [];
    const completeEvidence = requirements.length === required.length && requirements.every((row, i) =>
      row?.requirement === required[i] &&
      [row.contradiction, row.entailment, row.neutral].every((score) =>
        Number.isFinite(score) && score >= 0 && score <= 1));
    const supported = completeEvidence && requirements.length > 0 &&
      requirements.every((row) => row.entailment >= CONTINUE_THRESHOLD);
    const baseKind = kind;
    const applied = kind === 'uncertain' && partialAction.length >= MIN_PARTIAL_CHARS &&
      commitment >= COMMITMENT_FLOOR && quotation < QUOTATION_CEILING &&
      contradiction <= COUNTER_SIGNAL_CEILING && supported;
    const minimumEntailment = completeEvidence && requirements.length
      ? Math.min(...requirements.map((row) => row.entailment)) : null;
    if (applied) {
      kind = 'continue';
      verifiedConfidence = minimumEntailment;
    }
    requirementVerification = {
      baseKind,
      applied,
      supported,
      threshold: CONTINUE_THRESHOLD,
      minimumEntailment,
      requirements,
      reason: applied
        ? 'Every explicit requirement is entailed by the full proposed action.'
        : !supported
          ? 'The full proposed action does not entail every explicit requirement.'
          : 'The existing decision or intervention safeguards prevent a validation override.',
    };
  }

  const driftSignal = Math.max(drift, contradiction);
  const confidence = verifiedConfidence ?? (kind === 'uncertain'
    ? 1 - Math.abs(aligned - driftSignal)
    : kind === 'pivot' ? driftSignal : aligned);
  const constraints = String(input.constraints ?? '').trim();
  const sentence = (value) => /[.!?]$/.test(value) ? value : `${value}.`;
  const adjustment = kind === 'pivot'
    ? [
      'Pause the proposed action.',
      'Resume the current user objective.',
      sentence(goal),
      constraints ? `Respect this constraint. ${sentence(constraints)}` : '',
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
    ...(requirementVerification ? { requirementVerification } : {}),
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
