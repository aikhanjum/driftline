let runSequence = 0;

function abortReason(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Guard an async stream before accepting its completed output.
 * The generation adapter must stop its provider when its AbortSignal aborts.
 * Deltas are provisional. Only a complete event authorizes use of the output.
 * pauseAtCheckpoints applies backpressure while each sampled prefix is scored.
 * maxScoredChars must match a scorer that cannot inspect longer output.
 * This controller never executes tools or generated actions.
 */
export async function runGuardedStream({
  generate,
  score,
  finalScore,
  input,
  onEvent = () => {},
  signal,
  maxCorrections = 1,
  minChars = 24,
  sampleEveryChars = 32,
  pauseAtCheckpoints = false,
  maxScoredChars = Infinity,
}) {
  if (typeof generate !== 'function' || typeof score !== 'function') {
    throw new TypeError('generate and score must be functions.');
  }
  if (finalScore !== undefined && typeof finalScore !== 'function') {
    throw new TypeError('finalScore must be a function when provided.');
  }
  if (!input || typeof input !== 'object') throw new TypeError('input is required.');
  if (!Number.isInteger(maxCorrections) || maxCorrections < 0 ||
      !Number.isInteger(minChars) || minChars < 1 ||
      !Number.isInteger(sampleEveryChars) || sampleEveryChars < 1) {
    throw new TypeError('Invalid stream sampling or correction limits.');
  }
  if (typeof pauseAtCheckpoints !== 'boolean') {
    throw new TypeError('pauseAtCheckpoints must be a boolean.');
  }
  if (maxScoredChars !== Infinity &&
      (!Number.isInteger(maxScoredChars) || maxScoredChars < 1)) {
    throw new TypeError('maxScoredChars must be a positive integer or Infinity.');
  }

  const runId = ++runSequence;
  const context = { ...input, goalVersion: input.goalVersion ?? 1 };
  let requestSequence = 0;
  let corrections = 0;
  let adjustment = null;
  let decision = null;
  let text = '';

  let cancel;
  const cancelled = new Promise((resolve) => { cancel = resolve; });
  const onAbort = () => cancel({ type: 'cancelled' });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      let iterator;
      let sourceEvent;
      let scoreEvent;
      let scoringSnapshot;
      let pendingSnapshot;
      let lastReading;
      let revision = 0;
      let lastQueuedLength = 0;
      let sourceDone = false;
      text = '';
      decision = null;

      const emit = (type, details = {}) => onEvent({ type, attempt, ...details });
      const stopSource = (message) => {
        if (!controller.signal.aborted) controller.abort(abortReason(message));
        // A provider may leave next() pending after cancellation. Do not let its
        // cleanup hold the caller hostage, and absorb late provider rejections.
        try {
          Promise.resolve(iterator?.return?.()).catch(() => {});
        } catch { /* Provider cleanup cannot authorize output. */ }
      };
      const finish = (status, reason, error) => {
        if (status !== 'completed') stopSource(reason);
        const result = { status, text, corrections, decision };
        const type = status === 'completed' ? 'complete'
          : status === 'cancelled' ? 'interrupted' : 'blocked';
        try {
          emit(type, { ...result, reason, ...(error ? { error: String(error.message ?? error) } : {}) });
        } catch { /* Observer failures cannot turn a block into a completion. */ }
        return result;
      };
      const snapshot = (final = false) => ({
        text,
        revision,
        final,
        requestId: `stream-${runId}-${++requestSequence}`,
      });
      const next = () => Promise.resolve().then(() => iterator.next()).then(
        (result) => ({ type: 'source', result }),
        (error) => ({ type: 'provider_error', error }),
      );

      try {
        if (signal?.aborted) return finish('cancelled', 'cancelled');
        emit(attempt === 0 ? 'start' : 'resumed', {
          adjustment,
          corrections,
          goalVersion: context.goalVersion,
        });
        const source = generate({ signal: controller.signal, adjustment, attempt });
        if (typeof source?.[Symbol.asyncIterator] !== 'function') {
          throw new TypeError('generate must return an async iterable of strings.');
        }
        iterator = source[Symbol.asyncIterator]();
        sourceEvent = next();

        while (true) {
          if (signal?.aborted) return finish('cancelled', 'cancelled');
          if (!scoreEvent && pendingSnapshot) {
            scoringSnapshot = pendingSnapshot;
            pendingSnapshot = null;
            const requested = scoringSnapshot;
            scoreEvent = Promise.resolve().then(() => (requested.final && finalScore ? finalScore : score)({
              ...context,
              partialAction: requested.text,
              requestId: requested.requestId,
            })).then(
              (result) => ({ type: 'score', result, snapshot: requested }),
              (error) => ({ type: 'scorer_error', error }),
            );
          }

          if (sourceDone && !scoreEvent && !pendingSnapshot) {
            if (lastReading?.revision !== revision || lastReading.stale || (finalScore && !lastReading.final)) {
              return finish('blocked', 'stale_decision');
            }
            return decision?.kind === 'continue'
              ? finish('completed', 'approved')
              : finish('blocked', 'uncertain');
          }

          const event = await Promise.race(
            [cancelled, scoreEvent, sourceEvent].filter(Boolean),
          );
          // Parent cancellation wins even if a score resolves in the same turn.
          if (signal?.aborted || event.type === 'cancelled') {
            return finish('cancelled', 'cancelled');
          }
          if (event.type === 'provider_error' || event.type === 'scorer_error') {
            return finish('blocked', event.type, event.error);
          }
          if (event.type === 'source') {
            if (event.result.done) {
              sourceDone = true;
              sourceEvent = null;
              // Completion always waits for a score of the full final text,
              // including output shorter than the streaming sample threshold.
              if (finalScore || (scoringSnapshot?.revision !== revision && lastReading?.revision !== revision)) {
                pendingSnapshot = snapshot(true);
              }
              continue;
            }
            if (typeof event.result.value !== 'string') {
              return finish('blocked', 'provider_error', new TypeError('Stream deltas must be strings.'));
            }
            if (event.result.value) {
              text += event.result.value;
              revision += 1;
              if (text.length > maxScoredChars) {
                return finish('blocked', 'unscored_suffix');
              }
              emit('delta', { delta: event.result.value, text });
              if (text.length >= minChars &&
                  (scoreEvent || lastQueuedLength === 0 || text.length - lastQueuedLength >= sampleEveryChars)) {
                pendingSnapshot = snapshot();
                lastQueuedLength = text.length;
              }
            }
            // Keep the iterator at this checkpoint until its score settles.
            // The provider may buffer upstream tokens, but none are consumed
            // or accepted here until the current prefix has been checked.
            sourceEvent = pauseAtCheckpoints && pendingSnapshot ? null : next();
            continue;
          }

          scoreEvent = null;
          scoringSnapshot = null;
          const candidate = event.result;
          const stale = event.snapshot.revision !== revision ||
            candidate?.goalVersion !== context.goalVersion ||
            candidate?.requestId !== event.snapshot.requestId;
          emit('reading', {
            text: event.snapshot.text,
            requestId: event.snapshot.requestId,
            decision: candidate,
            stale,
            final: event.snapshot.final,
          });
          lastReading = { revision: event.snapshot.revision, stale, final: event.snapshot.final };
          if (stale) {
            if (pauseAtCheckpoints && !sourceDone) sourceEvent = next();
            continue;
          }
          if (!['continue', 'uncertain', 'pivot'].includes(candidate?.kind) ||
              !Number.isFinite(candidate.confidence) ||
              candidate.confidence < 0 || candidate.confidence > 1) {
            return finish('blocked', 'invalid_decision');
          }
          decision = candidate;
          if (candidate.kind !== 'pivot') {
            if (pauseAtCheckpoints && !sourceDone) sourceEvent = next();
            continue;
          }

          stopSource('The current action requires correction.');
          emit('interrupted', {
            text,
            decision,
            adjustment: candidate.adjustment,
            reason: 'pivot',
          });
          if (typeof candidate.adjustment !== 'string' || !candidate.adjustment.trim()) {
            return finish('blocked', 'missing_adjustment');
          }
          if (corrections >= maxCorrections) return finish('blocked', 'correction_limit');
          adjustment = candidate.adjustment;
          corrections += 1;
          break;
        }
      } catch (error) {
        return finish('blocked', 'stream_error', error);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
