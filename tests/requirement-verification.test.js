import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDecision } from '../src/scorer-core.js';

const input = {
  goal: 'Write a project summary.',
  constraints: 'Use English.',
  partialAction: 'I will write the project summary in English.',
  verifyRequirements: true,
};
const requirements = [input.goal, input.constraints].map((requirement) => ({
  requirement, entailment: 0.96, contradiction: 0.01, neutral: 0.03,
}));
const signals = {
  aligned: 0.99, drift: 0.64, contradiction: 0.01,
  commitment: 0.8, quotation: 0.01, requirements,
};

test('explicit final verification can resolve uncertainty without replacing raw drift scores', () => {
  const result = makeDecision(input, signals, 20);
  assert.equal(result.kind, 'continue');
  assert.equal(result.confidence, 0.96);
  assert.equal(result.signals.drift, 0.64);
  assert.equal(result.requirementVerification.baseKind, 'uncertain');
  assert.equal(result.requirementVerification.applied, true);
  assert.deepEqual(result.requirementVerification.requirements, requirements);
  const ordinary = makeDecision({ ...input, verifyRequirements: false }, signals, 20);
  assert.equal(ordinary.kind, 'uncertain');
  assert.equal(ordinary.requirementVerification, undefined);
});

test('every explicit requirement needs valid positive entailment evidence', () => {
  for (const evidence of [
    [],
    requirements.slice(0, 1),
    [...requirements, requirements[0]],
    [requirements[0], { ...requirements[1], requirement: 'A different instruction.' }],
    [requirements[0], { ...requirements[1], entailment: 0.3, neutral: 0.69 }],
    [requirements[0], { ...requirements[1], entailment: NaN }],
  ]) {
    const result = makeDecision(input, { ...signals, requirements: evidence }, 20);
    assert.equal(result.kind, 'uncertain');
    assert.equal(result.requirementVerification.applied, false);
  }
});

test('final verification preserves a pivot and speech or contradiction safeguards', () => {
  const pivot = makeDecision(input, { ...signals, aligned: 0.1, contradiction: 0.99 }, 20);
  assert.equal(pivot.kind, 'pivot');
  assert.equal(pivot.requirementVerification.applied, false);
  for (const guarded of [
    { commitment: 0.1 },
    { quotation: 0.9 },
    { contradiction: 0.7 },
  ]) {
    const result = makeDecision(input, { ...signals, ...guarded }, 20);
    assert.equal(result.kind, 'uncertain');
    assert.equal(result.requirementVerification.applied, false);
  }
  assert.equal(makeDecision({ ...input, partialAction: 'I will' }, signals, 20).kind, 'uncertain');
});
