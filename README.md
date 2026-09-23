# driftline.

![Driftline cover art](public/og.svg)

Driftline watches an agent's next action while it is still being written. It scores whether that action serves the current user goal, emits a typed decision, and can send a concrete correction before the action is carried out.

The demo runs a real local NLI model. The replays are scripted inputs, but the readings, timings, and decisions come from inference. You can also edit the goal and action live.

## Try it

```sh
npm ci
npm run dev:fast
```

Open the local address printed by Vite. This mode runs inference in a local Node process and shows the browser's round-trip latency. The first run downloads an int8 model of about 90 MB to `.cache`. Later runs reuse it. No API key is needed.

Use `npm run dev` for the browser-only version. It runs the same model and decision policy in a Web Worker and needs no local scoring server. The production build uses this browser mode, which is substantially slower on the machine used for this project.

Select one of the three replays to watch an action develop across partial snapshots. Use **Edit live** or **Start from scratch** to score your own text. **Inspect JSON** shows each request, decision, and gate result.

## How it works

```text
current goal + constraints + recent history + partial action
                         ↓
      local Node process or browser Web Worker
                         ↓
        local NLI model and signal assembly
                         ↓
           continue | pivot | uncertain
                         ↓
       goal-version and request-ID pivot gate
                         ↓
              simulated agent handoff
```

The scorer combines semantic alignment, drift, contradiction, and whether the text looks like a committed action or a quotation. A small threshold policy turns those model signals into a typed decision. It has no keyword list for specific goals or actions. When evidence is weak or conflicting, it abstains with `uncertain`.

The client coalesces queued partial actions so an old fragment cannot hold up the newest one. Each result carries its goal version and request ID. The gate rejects stale results and sends at most one correction per goal phase. An accepted pivot goes to a redirect callback during model generation or a steer callback during a tool action. The workbench uses a simulated callback and does not control an external agent.

The output contract includes `kind`, `confidence`, `driftScore`, `adjustment`, `latencyMs`, `goalVersion`, `requestId`, `evidence`, and the underlying `signals`. A pivot includes a plain instruction to pause, return to the user's goal, respect its constraints, and ask before changing the objective. Other decisions have a null adjustment.

`confidence` is a heuristic decision-support score derived from model outputs. `driftScore` is the stronger of the drift and contradiction signals. Neither is a calibrated probability.

## Verify

```sh
npm test
npm run eval
npm run build
```

The unit tests cover typed decisions and stale-result handling. The evaluation runs 16 hand-labeled scenarios with 37 partial-action snapshots against the same local model used by the demo. It prints a confusion matrix, pivot precision and recall, missed pivots, and warm p50, p95, and p99 scorer latency. The evaluation notes are in [evals/README.md](evals/README.md).

This corpus is a regression set, not a representative accuracy study. It includes quoted instructions, negated actions, adjacent subtasks, explicit constraint violations, and incomplete fragments. Do not interpret its precision or recall as production performance.

On September 23, 2026, `npm run eval` on Node 26 and macOS arm64 detected 5 of 10 labeled pivots with no false pivots among 27 other snapshots. Warm local scorer latency over 200 sequential mixed inputs was 35.3 ms at p50, 48.7 ms at p95, and 52.0 ms at p99. Those timings exclude browser rendering and model download. The static browser replay took more than one second per warm reading on this machine. Run the commands above to measure your own hardware.

## Current limits

- The scorer missed half the labeled pivots in this small regression set. It can miss a real pivot when an action contains both relevant and conflicting language. The gate only redirects on a high-confidence pivot.
- Scores are uncalibrated. Thresholds need a larger, independent dataset before use in an autonomous agent.
- Browser inference is slower than Node CPU inference on the same machine. The model download dominates first use. The fast mode is a local development server, not a deployed inference service.
- The demo sink shows the exact correction that would be sent, but it does not interrupt a live model or tool call.

Driftline uses [`Xenova/nli-deberta-v3-xsmall`](https://huggingface.co/Xenova/nli-deberta-v3-xsmall) pinned to a model revision through [Transformers.js](https://huggingface.co/docs/transformers.js/v3.8.1/en/api/pipelines). The underlying model is [`cross-encoder/nli-deberta-v3-xsmall`](https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall). [Agent Trajectory Sentinel](https://arxiv.org/abs/2608.02464) is related work on completed-step telemetry monitoring. Driftline scores the semantics of partial action text and does not reuse that paper's latency or detection claims.
