# driftline.

![Driftline cover art](public/og.svg)

**Catch a bad plan while the agent is still writing it.**

Driftline scores partial agent actions against a goal and its constraints. Its C++ inference process returns `continue`, `pivot`, or `uncertain`, with model signals and a concrete adjustment. A streaming controller can abort generation and restart the model with that adjustment.

The intervention lab runs the same injected bad plan with and without the guard. Both outputs come from a local Qwen3 0.6B model. Native intent scoring uses an int8 DeBERTa NLI model. No API key is required.

The static demo can replay a captured local run, explicitly labeled as a recording. Its editable browser workbench performs fresh inference on scripted or user supplied actions. Live native intervention requires local setup.

## What is real

- C++20 inference through ONNX Runtime and SentencePiece.
- Actual streamed HTTP generation, cancellation, and corrected regeneration.
- A final output gate. An uncertain plan is withheld.
- Request identity checks, stale result rejection, bounded scoring windows, and cancellation during pending inference.
- Exportable events with the exact partial text, model readings, correction, and observed timings.
- Two fixed evaluation corpora and reproducible profile comparisons.

The bad initial plan is a controlled fault injection. This demonstrates the intervention mechanism. It does not measure how often a real autonomous agent drifts, and it does not execute generated tools or code.

## Run locally

The pinned native setup currently supports Apple Silicon macOS. Install the build dependencies and fetch the two models.

```sh
brew install cmake sentencepiece nlohmann-json
npm ci
npm run setup:cpp
npm run setup:generator
```

Start the generator in one terminal.

```sh
npm run dev:generator
```

The first launch can take several minutes while Metal shaders compile. Wait for the model server to finish loading. Then start Driftline in another terminal.

```sh
npm run dev:cpp
```

Open the address printed by Vite and select **Run comparison**. Edit the goal, constraints, or injected plan to try another case. **Inspect observed events** exposes the underlying NDJSON records. **Export event log** saves the run.

The generator is pinned to llama.cpp `b11149` and Qwen3 0.6B Q8. Downloads are checked against SHA256 hashes. The generator model is about 640 MB. The scorer model is about 90 MB. Assets stay in the ignored `.cache` directory, and ONNX Runtime is installed under `build`. Both servers bind to loopback.

For scorer only operation, `npm run dev:fast` uses Node inference. `npm run dev` and the static build use a browser Web Worker. The static site cannot launch the local C++ or generator processes.

## The control loop

```text
Goal + constraints + history
             |
             v
Generator --> partial action --> native NLI scorer
    ^                                  |
    |                 continue / pivot / uncertain
    |                                  |
    +---- exact adjustment <--- abort on current pivot

Completed action --> final score --> approve or withhold
```

The controller serializes scoring and coalesces queued prefixes. A result must match the current goal version, request ID, and text revision before it can intervene. The live lab pauses stream consumption at scoring checkpoints so a fast provider cannot make every reading stale. The provider may buffer upstream output during that pause. Scorer latency alone is not total intervention latency.

Every displayed delta is provisional. Only a `complete` event authorizes accepting the output. Scorer errors, incomplete provider streams, stale final readings, oversized actions, and unresolved uncertainty withhold the plan. Cancellation is forwarded to the provider through its `AbortSignal`. Integrations must implement that signal correctly.

The scorer inspects at most 500 UTF-8 bytes each for the goal and action, and 350 for constraints. Oversized values are rejected rather than silently approved using a truncated action. Recent history and the number of sentence comparisons are bounded. This is a next-action instrument, not an unrestricted document judge.

The live lab opts into `verifyRequirements` for completed output. It asks a separate NLI question for every goal and constraint sentence, using the full action as the premise and retaining entailment, neutral, and contradiction probabilities. This can resolve an uncertain decision when all requirements have positive support and the existing intent safeguards pass. It never overrides a pivot. Existing continue decisions retain the original policy. This is an uncertainty resolver, not proof that a plan is correct.

That extra check accepted one additional valid action across the 87 development snapshots and added no approvals of labeled pivots or uncertain snapshots. It still has low coverage and can reject valid paraphrases. Its raw evidence is included in `requirementVerification`.

The [captured local run](public/live-recording.json) contains the exact 96 observed events. The guard interrupted at 39 characters with a 35.9 ms pivot score, then accepted a generated C++20 correction. These are one run's measurements, not a latency benchmark. Recorded playback runs at quarter speed while displaying the original timings.

## Use the controller

```js
import { NativeBridge } from './native/bridge.js';
import { runGuardedStream } from './src/stream-guard.js';

const scorer = new NativeBridge();
try {
  const result = await runGuardedStream({
    input: {
      goal: 'Implement a bounded C++ queue benchmark.',
      constraints: 'Use C++20. Measure p50, p95, p99 and throughput.',
      profile: 'early',
      goalVersion: 1,
    },
    // Return an async iterable of text deltas. Forward signal to your provider.
    generate: ({ signal, adjustment, attempt }) => yourGenerator({ signal, adjustment, attempt }),
    score: (snapshot) => scorer.score(snapshot),
    finalScore: (snapshot) => scorer.score({ ...snapshot, verifyRequirements: true }),
    signal: AbortSignal.timeout(60_000),
    pauseAtCheckpoints: true,
    maxScoredChars: 500,
    onEvent: (event) => console.log(event),
  });
  if (result.status === 'completed') consumeApprovedPlan(result.text);
} finally {
  scorer.dispose();
}
```

The UI and stream orchestration are JavaScript. Tokenization, model inference, signal assembly, and decision policy run in the native C++ process. The persistent process avoids loading the model for every snapshot.

## Measured detection

The default conservative profile and opt-in early profile use the same model and thresholds. Early changes instruction framing and catches more drift, with more false interventions.

| Profile | Original pivots caught | Original false pivots | Challenge pivots caught | Challenge false pivots |
| --- | --- | --- | --- | --- |
| Conservative | 5 of 10 | 0 of 27 | 13 of 20 | 1 of 30 |
| Early | 8 of 10 | 0 of 27 | 15 of 20 | 3 of 30 |

The original corpus contains 37 snapshots. The challenge corpus contains 50 and was frozen before scoring, then inspected during diagnosis. Both are now development evidence. These results are not representative production accuracy. C++ and JavaScript decisions match on both corpora in both profiles. Numerical signals can differ.

## Verify

```sh
npm test
npm run build
npm run eval:cpp -- --profile conservative --parity-only
npm run eval:cpp -- --profile early --parity-only
npm run eval:holdout -- --backend cpp --profile early
npm run eval:verification
npm run test:live
```

The last command requires the local generator. It checks actual HTTP cancellation before provider completion, corrected regeneration, and acceptance of the complete corrected action. It fails if any stage fails. The unit suite covers controller races, process restart, cancellation, stream parsing, and output gates. See [evaluation notes](evals/README.md) for both backends, full reports, and the unchanged benchmark method.

## What breaks first

Semantic judgment is the weak point. The small model can miss a violation hidden in otherwise relevant text, interrupt a valid plan, or abstain on a valid correction. Confidence and drift scores are uncalibrated. Zero-shot alignment and drift signals omit the neutral class and can overstate evidence. They are not probabilities of correctness.

The early profile is an experiment. A successful recorded correction does not establish general agent reliability. Real tool side effects, remote providers, arbitrary Unicode, and other operating systems have not been validated. C++ does not turn a transformer model into a microsecond system, and no 10x latency claim is made.

## Models and runtime

- [Xenova DeBERTa NLI model](https://huggingface.co/Xenova/nli-deberta-v3-xsmall/tree/2a4f614a701367a02d51389039afc998faeda637), pinned int8 scorer.
- [Original cross-encoder model](https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall), the underlying NLI weights.
- [Qwen3 0.6B GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/tree/23749fefcc72300e3a2ad315e1317431b06b590a), pinned local generator.
- [llama.cpp b11149](https://github.com/ggml-org/llama.cpp/releases/tag/b11149), pinned generation runtime.
- [ONNX Runtime](https://github.com/microsoft/onnxruntime/releases/tag/v1.21.0), native scorer runtime.
