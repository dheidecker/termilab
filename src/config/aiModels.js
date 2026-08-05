/**
 * AI model catalog — single source of truth for the renderer.
 *
 * The main process keeps its own copy of the default IDs in
 * electron/services/ai-service.js (DEFAULT_MODELS): main is CommonJS and can't
 * require this ES module, so those three strings are duplicated on purpose.
 * Keep them in sync when a default changes.
 */

export const PROVIDERS = [
  { id: 'claude-api', label: 'Claude (Anthropic)', keyField: 'claudeApiKey', modelField: 'claudeModel', console: 'console.anthropic.com', keyPlaceholder: 'sk-ant-api03-...' },
  { id: 'deepseek', label: 'DeepSeek', keyField: 'deepseekApiKey', modelField: 'deepseekModel', console: 'platform.deepseek.com', keyPlaceholder: 'sk-...' },
  { id: 'openai', label: 'OpenAI', keyField: 'openaiApiKey', modelField: 'openaiModel', console: 'platform.openai.com', keyPlaceholder: 'sk-...' },
];

/* Model IDs are the exact API strings — never append date suffixes.
 * `short` is for the compact model picker in the terminal's inline AI bar. */
export const MODELS = {
  'claude-api': [
    { id: 'claude-opus-5', label: 'Claude Opus 5', short: 'Opus 5', note: 'Recommended' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', short: 'Sonnet 5', note: 'Balanced' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', short: 'Haiku 4.5', note: 'Fast, cheapest' },
    { id: 'claude-fable-5', label: 'Claude Fable 5', short: 'Fable 5', note: 'Most capable, premium pricing' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', short: 'V4 Pro', note: 'Recommended' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', short: 'V4 Flash', note: 'Fast, cheapest' },
  ],
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', short: 'Sol', note: 'Recommended' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', short: 'Terra', note: 'Balanced' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', short: 'Luna', note: 'Fast, cheapest' },
  ],
};

export const DEFAULT_MODELS = {
  'claude-api': 'claude-opus-5',
  deepseek: 'deepseek-v4-pro',
  openai: 'gpt-5.6-sol',
};

/**
 * Reasoning effort — Claude only. Controls how deeply the model thinks before
 * answering, which is the main latency/cost lever on the Claude 5 family.
 * 'low' keeps the assistant snappy for everyday terminal work.
 */
export const EFFORT_LEVELS = [
  { id: 'low', label: 'Low — fastest, best for everyday commands' },
  { id: 'medium', label: 'Medium — balanced' },
  { id: 'high', label: 'High — most thorough, slower' },
];

export const DEFAULT_EFFORT = 'low';

/** Resolve the configured model for a provider, falling back to its default. */
export function resolveModel(aiSettings = {}, provider) {
  const entry = PROVIDERS.find(p => p.id === provider);
  return (entry && aiSettings[entry.modelField]) || DEFAULT_MODELS[provider] || DEFAULT_MODELS['claude-api'];
}

/** Resolve the configured API key for a provider. */
export function resolveApiKey(aiSettings = {}, provider) {
  const entry = PROVIDERS.find(p => p.id === provider);
  return (entry && aiSettings[entry.keyField]) || '';
}
