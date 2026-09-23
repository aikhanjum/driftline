export class PivotGate {
  constructor({ onRedirect, onSteer, threshold = 0.8 } = {}) {
    this.onRedirect = onRedirect;
    this.onSteer = onSteer;
    this.threshold = threshold;
    this.context = null;
    this.lastApplied = null;
  }

  setContext({ goalVersion, requestId, phase }) {
    if (phase !== 'model' && phase !== 'tool') {
      throw new Error('phase must be model or tool');
    }
    this.context = { goalVersion, requestId, phase };
  }

  apply(decision) {
    if (!this.context ||
        decision.goalVersion !== this.context.goalVersion ||
        decision.requestId !== this.context.requestId) {
      return { applied: false, reason: 'stale' };
    }
    if (decision.kind !== 'pivot') {
      return { applied: false, reason: 'no_pivot' };
    }
    if (this.lastApplied?.goalVersion === this.context.goalVersion &&
        this.lastApplied?.phase === this.context.phase) {
      return { applied: false, reason: 'already_applied' };
    }
    if (!Number.isFinite(decision.confidence) ||
        decision.confidence < this.threshold ||
        !decision.adjustment) {
      return { applied: false, reason: 'low_confidence' };
    }
    const isModel = this.context.phase === 'model';
    const handler = isModel ? this.onRedirect : this.onSteer;
    if (typeof handler !== 'function') {
      return { applied: false, reason: 'no_handler' };
    }
    handler(decision.adjustment, decision);
    this.lastApplied = {
      goalVersion: this.context.goalVersion,
      phase: this.context.phase,
    };
    return { applied: true, reason: isModel ? 'redirected' : 'steered' };
  }
}
