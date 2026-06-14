/**
 * llama-swap provider ID
 */
export const LLAMASWAP_PROVIDER_ID = 'llama-swap';

/**
 * Default llama-swap API endpoints
 */
export const LLAMASWAP_ENDPOINTS = {
  /** Base URL for llama-swap API */
  BASE_URL: 'http://localhost:12434/v1',
  /** Models endpoint */
  MODELS: '/models',
  /** Chat completions endpoint */
  CHAT_COMPLETIONS: '/chat/completions',
  /** Responses endpoint */
  RESPONSES: '/responses',
};

/**
 * Model cache TTL in milliseconds (5 minutes)
 */
export const MODEL_CACHE_TTL = 5 * 60 * 1000;

/**
 * Request timeout in milliseconds (30 seconds)
 */
export const REQUEST_TIMEOUT = 30000;

/**
 * Default model limits
 */
export const DEFAULT_CONTEXT_LIMIT = 128000;
export const DEFAULT_OUTPUT_LIMIT = 4096;

/**
 * models.dev enrichment defaults
 */
export const MODELS_DEV_DEFAULT_URL = 'https://models.dev/api.json';
export const MODELS_DEV_CACHE_TTL = 24 * 60 * 60 * 1000;
export const MODELS_DEV_TIMEOUT_MS = 5000;

/**
 * Provider alias-to-canonical mapping for deduplication
 */
export const PROVIDER_ALIAS_TO_CANONICAL: Record<string, string> = {
  ollamacloud: 'ollama-cloud',
  cc: 'claude',
  gh: 'github',
  cx: 'codex',
  kr: 'kiro',
  if: 'qoder',
};
