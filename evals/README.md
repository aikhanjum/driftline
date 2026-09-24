# Evaluation

Run these commands from the repository root. The native setup currently supports Apple Silicon macOS and downloads the pinned ONNX Runtime package and model assets.

```sh
brew install cmake sentencepiece nlohmann-json
npm ci
npm run setup:cpp
```

## Corpora and labels

The original corpus in [scenarios.json](scenarios.json) has 16 scenarios and 37 snapshots. It was used while developing the scorer.

The challenge corpus in [holdout.json](holdout.json) has 25 scenarios and 50 snapshots covering unrelated tasks, explicit constraints, quoted and negated actions, legitimate substeps, goal corrections, and incomplete prefixes. Its text and labels were frozen before candidate scoring. It has since been inspected during diagnosis and now serves as a fixed challenge set. Future validation requires new examples. The filename and command retain their original names.

Both corpora use the same labels.

- `continue` means the proposed action serves the active goal.
- `pivot` means the proposed action leaves that goal or violates a constraint.
- `uncertain` means the prefix does not support either conclusion.

The challenge runner verifies this SHA256 before scoring and refuses changed corpus contents.

```text
e6562e059201fc57d1c6da5658dea6eebc08faaeb748ac1c02c967a36119d74b
```

## Compare profiles

`conservative` is the default. `early` changes the wording used to compare instructions with planned actions. Both profiles use the same model and decision thresholds.

Run the original corpus through both C++ and JavaScript and compare their decisions.

```sh
npm run eval:cpp -- --profile conservative --parity-only
npm run eval:cpp -- --profile early --parity-only
```

Run the frozen challenge corpus through C++.

```sh
npm run eval:holdout -- --backend cpp --profile conservative
npm run eval:holdout -- --backend cpp --profile early
```

Change `--backend cpp` to `--backend js` to evaluate JavaScript. To save machine readable JSON without npm's command banner, invoke the runner directly with `--json`. Reports include complete decisions, signals, runtime details, corpus hash, and native binary hash when applicable.

```sh
node evals/run-holdout.mjs --backend cpp --profile conservative --json > challenge-conservative.json
node evals/run-holdout.mjs --backend cpp --profile early --json > challenge-early.json
```

The historical JavaScript baseline can also be loaded from its Git commit without changing the working tree. This requires that commit to be present locally.

```sh
node evals/run-holdout.mjs --backend js --source-ref 882e03e76d29b789be8b99744b1162cbc6a17249
```

## Recorded results

Measured on Apple Silicon macOS on September 23, 2026. Pivot counts use labeled pivots as the denominator. False pivot counts use all labeled nonpivot snapshots, including uncertain prefixes.

| Profile | Original pivots detected | Original false pivots | Challenge pivots detected | Challenge false pivots |
| --- | --- | --- | --- | --- |
| Conservative | 5/10 | 0/27 | 13/20 | 1/30 |
| Early | 8/10 | 0/27 | 15/20 | 3/30 |

The early profile detects more drift and also makes more false interventions on the challenge corpus. Exact challenge label matches are 28/50 for conservative and 27/50 for early. Both return `uncertain` on 26/50 snapshots. Both produce three incorrect committed labels with a confidence score of at least 0.9.

C++ and JavaScript have zero decision mismatches across all 37 original snapshots and all 50 challenge snapshots in each profile. This measures agreement on `kind`. The underlying signals are not identical, and numerical differences were observed on quoted text.

## Measure latency

The JavaScript runner evaluates the original corpus with the conservative profile. It reports cold model load, first score, and warm p50, p95, and p99 over sequential mixed inputs. It uses 20 warmup calls and 200 measured calls by default.

```sh
npm run eval
npm run eval -- --bench-runs 1000
```

The native runner includes a benchmark when `--parity-only` is omitted. It uses 20 warmup calls and 200 measured process round trips.

```sh
npm run eval:cpp -- --profile conservative
```

Run latency measurements separately on an otherwise idle machine. Native round trips include process communication. JavaScript timings include inference and decision assembly. Neither includes model download, browser rendering, generator latency, or checkpoint backpressure. The challenge runner reports startup time but does not run a warm latency benchmark.

## Verify real stream correction

Audit optional final requirement verification separately from the default detector profile tables.

```sh
npm run eval:verification
```

This compares default and verified decisions across both frozen corpora in C++ and JavaScript with the early profile. It rejects changed corpus hashes, new approvals of labeled pivots or uncertain snapshots, and backend decision mismatches. The recorded run added one valid approval and zero pivot or uncertain approvals per backend, with zero mismatches across 174 decision comparisons. Two existing approvals of uncertain snapshots remain visible in both modes. These results are development evidence and do not establish general final verification accuracy.

The optional smoke test uses a local Qwen3 0.6B generator. Start it in a separate terminal after native setup.

```sh
npm run setup:generator
npm run dev:generator
```

Wait for the generator to finish loading, then run the test.

```sh
npm run test:live
```

The test requires a real HTTP generation stream to be cancelled before completion, restarted with a correction, and accepted only after a current score of the complete corrected action. The initial bad plan is deliberately injected. This controlled experiment does not measure naturally occurring drift or tool execution outcomes.

## Interpretation and limits

These are small hand authored corpora. They do not establish representative accuracy, production latency, or calibrated probabilities. Confidence values are derived from model signals. High scores can accompany incorrect decisions.

The challenge runner checks response types, score ranges, adjustment shape, latency validity, goal version, and request identity. A zero exit status means those contracts passed. It does not mean all labels matched or that the scorer is safe to use without supervision. The original native runner also fails when C++ and JavaScript decisions disagree.

Valid actions can be blocked or redirected, and real drift can be missed. The profiles, prompts, thresholds, and examples have been inspected during development. Keep these corpus labels fixed and use newly collected cases for future validation. Native behavior outside the tested English examples and Apple Silicon environment remains unverified.
