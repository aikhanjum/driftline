# Evaluation

Run the checked-in scenarios against the same local model used by the demo.

```sh
npm run eval
```

Use more measured calls when you need a steadier tail latency estimate.

```sh
npm run eval -- --bench-runs 1000
```

The corpus in `scenarios.json` contains hand-labeled snapshots of an agent action as it is written. `continue` means the action serves the active goal. `pivot` means the action leaves that goal or violates a constraint. `uncertain` means the prefix does not yet support either conclusion.

The runner checks every returned decision, including its type, score ranges, adjustment, goal version, and request identity. It prints a confusion matrix, pivot precision and recall, false pivots, and the number of snapshots between the first labeled pivot and the first detected pivot. It also prints cold model load time, first score time, and warm p50, p95, and p99 latency across sequential mixed inputs.

The scenarios are a small regression set written for this project. They do not establish population accuracy, calibrated confidence, or production latency. The latency report includes the runtime and platform so results can be compared on similar machines.
