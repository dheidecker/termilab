/**
 * Valid AI model IDs — main process (CommonJS).
 *
 * The renderer has its own catalog with display labels in src/config/aiModels.js;
 * main can't import that ES module, so the IDs live in both places. Keep them in
 * sync — store-service validates saved settings against this list, so an ID that
 * exists only in the renderer catalog gets migrated away on load.
 */

const DEFAULT_MODELS = {
  'claude-api': 'claude-opus-5',
  'deepseek': 'deepseek-v4-pro',
  'openai': 'gpt-5.6-sol',
};

/* Exact API model strings — never append date suffixes. */
const VALID_MODELS = {
  'claude-api': ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'],
  'deepseek': ['deepseek-v4-pro', 'deepseek-v4-flash'],
  'openai': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
};

/* settings.ai field holding each provider's model choice. */
const MODEL_FIELDS = {
  'claude-api': 'claudeModel',
  'deepseek': 'deepseekModel',
  'openai': 'openaiModel',
};

const VALID_EFFORTS = ['low', 'medium', 'high'];
const DEFAULT_EFFORT = 'low';

module.exports = {
  DEFAULT_MODELS,
  VALID_MODELS,
  MODEL_FIELDS,
  VALID_EFFORTS,
  DEFAULT_EFFORT,
};
