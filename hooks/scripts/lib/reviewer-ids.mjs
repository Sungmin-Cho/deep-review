export const REVIEWER_IDS = Object.freeze([
  'claude-opus',
  'codex-review',
  'codex-adversarial',
  'agy',
  'grok',
]);

const REVIEWER_ID_SET = new Set(REVIEWER_IDS);

export function isReviewerId(value) {
  return REVIEWER_ID_SET.has(value);
}

export const REVIEWER_PROVIDERS = Object.freeze({
  'claude-opus': 'claude',
  'codex-review': 'codex',
  'codex-adversarial': 'codex',
  agy: 'agy',
  grok: 'grok',
});
