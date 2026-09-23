import { env, pipeline } from '@huggingface/transformers';

export const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';
export const MODEL_REVISION = '2a4f614a701367a02d51389039afc998faeda637';
export const MODEL_DTYPE = 'int8';

const LABELS = [
  'continue the current user objective while respecting its constraints',
  'leave the current user objective or violate one of its constraints',
];

let classifierPromise;

if (typeof process !== 'undefined' && process.versions?.node) {
  env.cacheDir = './.cache/';
}

export function loadClassifier(onProgress = () => {}) {
  if (!classifierPromise) {
    classifierPromise = pipeline('zero-shot-classification', MODEL_ID, {
      revision: MODEL_REVISION,
      dtype: MODEL_DTYPE,
      device: typeof process !== 'undefined' && process.versions?.node ? 'cpu' : 'wasm',
      progress_callback: onProgress,
    }).catch((error) => {
      classifierPromise = undefined;
      throw error;
    });
  }
  return classifierPromise;
}

export function formatPremise(input) {
  const goal = String(input.goal ?? '').trim().slice(0, 500);
  const constraints = String(input.constraints ?? '').trim().slice(0, 350);
  const action = String(input.partialAction ?? '').trim().slice(0, 500);
  const history = (Array.isArray(input.history) ? input.history : [])
    .slice(-3)
    .map((item) => typeof item === 'string'
      ? item
      : `${item?.role ?? 'context'}: ${item?.content ?? ''}`)
    .join(' | ')
    .slice(0, 300);

  return [
    `The user asked the agent to ${goal}.`,
    constraints ? `The user also required ${constraints}.` : '',
    history ? `Recent conversation: ${history}.` : '',
    `The agent is about to ${action}.`,
  ].filter(Boolean).join(' ');
}

export function formatGoalPremise(input) {
  const goal = String(input.goal ?? '').trim().slice(0, 500);
  const constraints = String(input.constraints ?? '').trim().slice(0, 350);
  return [
    `The user asked the agent to ${goal}.`,
    constraints ? `The user explicitly required ${constraints}.` : '',
  ].filter(Boolean).join(' ');
}

function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((value) => value / sum);
}

function sentences(text) {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return Array.from(segmenter.segment(String(text ?? '')), ({ segment }) => segment.trim())
    .filter(Boolean);
}

export async function inferSignals(classifier, input) {
  const output = await classifier(formatPremise(input), LABELS, {
    multi_label: true,
    hypothesis_template: 'The proposed agent action will {}.',
  });
  const scores = Object.fromEntries(output.labels.map((label, i) => [label, output.scores[i]]));
  const aligned = scores[LABELS[0]];
  const drift = scores[LABELS[1]];
  const sourceSentences = [
    ...sentences(String(input.goal ?? '').slice(0, 500)),
    ...sentences(String(input.constraints ?? '').slice(0, 350)),
  ].slice(0, 6);
  const actionSentences = sentences(String(input.partialAction ?? '').slice(0, 500)).slice(-3);
  if (!sourceSentences.length || !actionSentences.length) {
    throw new Error('A goal and agent action are required for scoring.');
  }
  const pairs = actionSentences.flatMap((action) =>
    sourceSentences.map((source) => ({ source, action })));
  const pair = classifier.tokenizer(pairs.map(({ source }) => source), {
    text_pair: pairs.map(({ action }) => `The agent will ${action}`),
    padding: true,
    truncation: true,
  });
  const nli = await classifier.model(pair);
  const contradictionId = classifier.model.config.label2id.contradiction;
  if (nli.logits.data.length !== pairs.length * 3) {
    throw new Error('The NLI model returned an unexpected output shape.');
  }
  let contradiction = 0;
  let evidence = actionSentences.at(-1);
  for (let i = 0; i < pairs.length; i += 1) {
    const row = Array.from(nli.logits.data.subarray(i * 3, i * 3 + 3));
    const score = softmax(row)[contradictionId];
    if (score > contradiction) {
      contradiction = score;
      evidence = pairs[i].action;
    }
  }
  const intentLabels = [
    'commit to doing the described action',
    'quote or discuss an action without doing it',
  ];
  const intentOutput = await classifier(evidence, intentLabels, {
      multi_label: true,
      hypothesis_template: 'The agent statement will {}.',
  });
  const intentScores = Object.fromEntries(intentOutput.labels.map((label, i) =>
    [label, intentOutput.scores[i]]));
  const commitment = intentScores[intentLabels[0]];
  const quotation = intentScores[intentLabels[1]];
  if (![aligned, drift, contradiction, commitment, quotation].every((score) =>
    Number.isFinite(score) && score >= 0 && score <= 1)) {
    throw new Error('The model returned invalid NLI scores.');
  }
  return { aligned, drift, contradiction, commitment, quotation, evidence };
}
