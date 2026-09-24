// Run with npm run eval:verification after npm run setup:cpp. No flags.
// Both corpora are frozen development/challenge evidence, not unseen validation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeBridge } from '../native/bridge.js';
import {
  inferSignals, loadClassifier, MODEL_ID, MODEL_REVISION,
} from '../src/semantic-model.js';
import { makeDecision } from '../src/scorer-core.js';

const LABELS = ['continue', 'pivot', 'uncertain'];
const CORPORA = [
  { name: 'scenarios.json', sha256: '93950a3ea5f4a50ff428f8a942776c5b6ac6ac7eb1b84737b3c52918384abecf' },
  { name: 'holdout.json', sha256: 'e6562e059201fc57d1c6da5658dea6eebc08faaeb748ac1c02c967a36119d74b' },
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function entries(corpus, name) {
  assert.equal(corpus.version, 1, `${name} must use corpus version 1.`);
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length, `${name} must contain scenarios.`);
  const ids = new Set();
  return corpus.cases.flatMap((scenario) => {
    assert.ok(typeof scenario.id === 'string' && scenario.id && !ids.has(scenario.id), 'Scenario IDs must be unique.');
    ids.add(scenario.id);
    assert.ok(typeof scenario.goal === 'string' && scenario.goal.trim(), 'Each scenario needs a goal.');
    assert.ok(Array.isArray(scenario.snapshots) && scenario.snapshots.length, 'Each scenario needs snapshots.');
    assert.ok(Array.isArray(scenario.constraints ?? []), 'Constraints must be an array.');
    return scenario.snapshots.map((snapshot, index) => {
      assert.ok(LABELS.includes(snapshot.gold), 'Every snapshot needs an existing gold label.');
      assert.ok(typeof snapshot.partialAction === 'string' && snapshot.partialAction.trim(), 'Every snapshot needs an action.');
      const id = `${name}/${scenario.id}#${index}`;
      return {
        id,
        gold: snapshot.gold,
        input: {
          profile: 'early',
          goal: scenario.goal,
          constraints: (scenario.constraints ?? []).join(' '),
          history: scenario.history ?? [],
          partialAction: snapshot.partialAction,
          goalVersion: 1,
          requestId: id,
        },
      };
    });
  });
}

function validateDecision(decision, input, verificationEnabled) {
  assert.ok(LABELS.includes(decision?.kind), 'The scorer must return a typed decision.');
  assert.equal(decision.goalVersion, input.goalVersion, 'The scorer lost the goal revision.');
  assert.equal(decision.requestId, input.requestId, 'The scorer lost the request identity.');
  for (const value of [decision.confidence, decision.driftScore]) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, 'Decision scores must be bounded.');
  }
  if (verificationEnabled) {
    assert.ok(decision.requirementVerification, 'Final verification must expose its evidence.');
    assert.equal(typeof decision.requirementVerification.applied, 'boolean');
    assert.ok(Array.isArray(decision.requirementVerification.requirements));
  } else {
    assert.equal(decision.requirementVerification, undefined, 'The default scorer must not apply optional verification.');
  }
}

async function main() {
  if (process.argv.length > 2) throw new Error('This evaluator takes no flags. Run npm run eval:verification.');
  const inputs = [];
  for (const corpus of CORPORA) {
    const bytes = await readFile(new URL(corpus.name, import.meta.url));
    assert.equal(sha256(bytes), corpus.sha256, `${corpus.name} differs from the frozen corpus.`);
    inputs.push(...entries(JSON.parse(bytes), corpus.name));
  }
  console.log(`Model ${MODEL_ID} @ ${MODEL_REVISION}`);
  console.log(`Profile early. ${inputs.length} frozen original and challenge snapshots.`);
  console.log('Comparing default scoring with optional final requirement verification in C++ and JS.');

  const classifier = await loadClassifier();
  const bridge = new NativeBridge();
  const totals = Object.fromEntries(['cpp', 'js'].map((backend) => [backend, {
    baseline: Object.fromEntries(LABELS.map((label) => [label, 0])),
    verified: Object.fromEntries(LABELS.map((label) => [label, 0])),
    added: Object.fromEntries(LABELS.map((label) => [label, 0])),
  }]));
  let decisionMismatches = 0;
  let applicationMismatches = 0;
  let unsafePromotions = 0;
  const promotions = [];
  try {
    await bridge.ready();
    for (const { id, gold, input } of inputs) {
      const finalInput = { ...input, verifyRequirements: true };
      const results = {
        cpp: {
          baseline: await bridge.score(input),
          verified: await bridge.score(finalInput),
        },
        js: {
          baseline: makeDecision(input, await inferSignals(classifier, input), 0),
          verified: makeDecision(finalInput, await inferSignals(classifier, finalInput), 0),
        },
      };
      for (const phase of ['baseline', 'verified']) {
        for (const backend of ['cpp', 'js']) {
          validateDecision(results[backend][phase], input, phase === 'verified');
        }
        if (results.cpp[phase].kind !== results.js[phase].kind) {
          decisionMismatches += 1;
          console.log(`Decision mismatch ${id} ${phase}. C++ ${results.cpp[phase].kind}, JS ${results.js[phase].kind}.`);
        }
      }
      if (results.cpp.verified.requirementVerification.applied !==
          results.js.verified.requirementVerification.applied) {
        applicationMismatches += 1;
        console.log(`Verification application mismatch ${id}.`);
      }
      for (const backend of ['cpp', 'js']) {
        const { baseline, verified } = results[backend];
        if (baseline.kind === 'continue') totals[backend].baseline[gold] += 1;
        if (verified.kind === 'continue') totals[backend].verified[gold] += 1;
        if (baseline.kind !== 'continue' && verified.kind === 'continue') {
          totals[backend].added[gold] += 1;
          promotions.push(`${backend} ${id}, gold ${gold}, minimum entailment ${verified.requirementVerification.minimumEntailment.toFixed(6)}`);
          if (gold !== 'continue') unsafePromotions += 1;
        }
        if (baseline.kind === 'pivot') assert.equal(verified.kind, 'pivot', `${id} must preserve an existing pivot.`);
      }
    }
  } finally {
    bridge.dispose();
  }

  for (const backend of ['cpp', 'js']) {
    console.log(`${backend.toUpperCase()} accepted actions by gold label, continue / pivot / uncertain`);
    for (const phase of ['baseline', 'verified', 'added']) {
      console.log(`  ${phase.padEnd(8)} ${LABELS.map((label) => totals[backend][phase][label]).join(' / ')}`);
    }
  }
  for (const promotion of promotions) console.log(`New acceptance ${promotion}`);
  console.log(`C++ and JS decision mismatches ${decisionMismatches}/${inputs.length * 2}`);
  console.log(`C++ and JS verification application mismatches ${applicationMismatches}/${inputs.length}`);
  console.log(`Added pivot or uncertain approvals ${unsafePromotions}`);
  for (const corpus of CORPORA) {
    const current = sha256(await readFile(new URL(corpus.name, import.meta.url)));
    assert.equal(current, corpus.sha256, `${corpus.name} changed during evaluation.`);
    console.log(`Unchanged corpus SHA256 ${corpus.name} ${current}`);
  }
  console.log('These corpora informed development. Results do not establish general accuracy or calibrated confidence.');
  assert.equal(decisionMismatches, 0, 'C++ and JS decisions must agree.');
  assert.equal(applicationMismatches, 0, 'C++ and JS must agree on applying verification.');
  assert.equal(unsafePromotions, 0, 'Optional verification must not add a pivot or uncertain approval on the frozen corpora.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
