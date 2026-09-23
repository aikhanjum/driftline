async function readResponse(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Scorer request failed with ${response.status}.`);
  return body;
}

export class NodeScorer {
  constructor() {
    this.readyPromise = null;
  }

  ready() {
    if (!this.readyPromise) {
      this.readyPromise = fetch('/api/ready', { cache: 'no-store' })
        .then(readResponse)
        .catch((error) => {
          this.readyPromise = null;
          throw error;
        });
    }
    return this.readyPromise;
  }

  async score(input) {
    await this.ready();
    const start = performance.now();
    const result = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(readResponse);
    return { ...result, roundTripMs: performance.now() - start };
  }

  dispose() {}
}
