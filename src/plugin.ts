import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { homedir } from 'os';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type {
  LlamaSwapApiMode,
  LlamaSwapConfig,
  LlamaSwapModel,
  LlamaSwapModelMetadata,
  LlamaSwapModelMetadataConfig,
  LlamaSwapModelsDevConfig,
  LlamaSwapProviderModel,
  LlamaSwapModelVariant,
} from './types.js';
import {
  LLAMASWAP_PROVIDER_ID,
  LLAMASWAP_ENDPOINTS,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_OUTPUT_LIMIT,
} from './constants.js';
import { fetchModels, resolveProviderAliasForMetadata } from './models.js';
import { warn, debug, sanitizeForLog } from './logger.js';

const LLAMASWAP_PROVIDER_NAME = 'llama-swap';
// NOTE: This provider has a bug for Qwen, see:
//  - https://github.com/anomalyco/opencode/issues/5034#issuecomment-4055045992
//  - https://github.com/anomalyco/opencode/pull/16981
const LLAMASWAP_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const LLAMASWAP_PROVIDER_ENV = ['LLAMASWAP_API_KEY'];

type AuthHook = NonNullable<Hooks['auth']>;
type AuthLoader = NonNullable<AuthHook['loader']>;
type AuthAccessor = Parameters<AuthLoader>[0];
type ProviderDefinition = Parameters<AuthLoader>[1];
const RAW_MODEL_METADATA = Symbol('llamaswap.rawModelMetadata');
const RAW_MODEL_METADATA_OPTION = '__llamaswapRawModelMetadata';
const MODELS_GENERATED_BY_PLUGIN = Symbol('llamaswap.modelsGeneratedByPlugin');
const MODELS_GENERATED_BY_PLUGIN_OPTION = '__llamaswapModelsGeneratedByPlugin';
type OptionsWithRawModelMetadata = Record<string, unknown> & {
  [RAW_MODEL_METADATA]?: unknown;
  [MODELS_GENERATED_BY_PLUGIN]?: unknown;
};

export const LlamaSwapAuthPlugin: Plugin = async (_input) => {
  return {
    config: async (config) => {
      const providers = config.provider ?? {};
      const existingProvider = providers[LLAMASWAP_PROVIDER_ID];
      const baseUrl = getBaseUrl(existingProvider?.options);
      const apiMode = getApiMode(existingProvider?.options);
      const apiKey = getApiKey(existingProvider?.options);
      const providerApi = resolveProviderApi(existingProvider?.api, apiMode);
      const rawUserModelMetadata = getRawUserModelMetadata(existingProvider?.options);

      // Eagerly fetch models for OpenCode <=1.14.48 (which read models from config hook).
      // OpenCode >=1.14.49 uses the provider hook below instead.
      let models: LlamaSwapModel[] = [];
      try {
        const runtimeConfig = createRuntimeConfig(existingProvider?.options ?? {}, apiKey);
        models = await fetchModels(runtimeConfig, apiKey, false);
      } catch (error) {
        warn(`Eager model fetch failed: ${error}`);
      }

      const effectiveModels = applyModelMetadataOverrides(
        models,
        rawUserModelMetadata,
      );

      const generatedModelMetadata: Record<string, LlamaSwapModelMetadata> = {};
      for (const model of models) {
        // Use canonical ID for metadata keys to match user config
        const metadataKey = resolveProviderAliasForMetadata(model.id);
        generatedModelMetadata[metadataKey] = {
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          supportsTemperature: model.supportsTemperature,
          supportsReasoning: model.supportsReasoning,
          supportsAttachment: model.supportsAttachment,
          supportsVision: model.supportsVision,
          supportsTools: model.supportsTools,
          supportsStreaming: model.supportsStreaming,
          pricing: model.pricing,
        };
      }

      const modelMetadata = mergeModelMetadata(
        rawUserModelMetadata,
        generatedModelMetadata,
      );

      const providerOptions: Record<string, unknown> = {
        ...(existingProvider?.options ?? {}),
        baseURL: baseUrl,
        apiMode,
        modelMetadata,
      };
      setRawUserModelMetadata(providerOptions, rawUserModelMetadata);

      const shouldRefreshModels = shouldRefreshProviderModels(existingProvider);
      const providerModels = shouldRefreshModels
        ? toProviderModels(effectiveModels, baseUrl)
        : existingProvider?.models;
      setModelsGeneratedByPlugin(providerOptions, shouldRefreshModels);

      providers[LLAMASWAP_PROVIDER_ID] = {
        ...existingProvider,
        name: existingProvider?.name ?? LLAMASWAP_PROVIDER_NAME,
        api: providerApi,
        npm: existingProvider?.npm ?? LLAMASWAP_PROVIDER_NPM,
        env: existingProvider?.env ?? LLAMASWAP_PROVIDER_ENV,
        options: providerOptions,
        models: providerModels,
      };

      config.provider = providers;
    },
    // Provider hook for OpenCode >=1.14.49
    provider: {
      id: LLAMASWAP_PROVIDER_ID,
      models: async (provider, ctx) => {
        const baseUrl = getBaseUrl(provider.options);

        // Auth available — fetch /v1/models (fetchModels falls back to defaults on error)
        if (ctx.auth?.type === 'api' && ctx.auth.key) {
          const runtimeConfig = createRuntimeConfig(provider.options, ctx.auth.key);
          const models = await fetchModels(runtimeConfig, ctx.auth.key, false);
          const effectiveModels = applyModelMetadataOverrides(
            models,
            getRawUserModelMetadata(provider.options),
          );
          return toProviderModels(effectiveModels, baseUrl);
        }

        // No auth yet (user hasn't /connect'd): return built-in defaults.
        // This ensures models have the correct metadata (like api.url) to work with the plugin.
        const effectiveModels = applyModelMetadataOverrides(
          [],
          getRawUserModelMetadata(provider.options),
        );
        return toProviderModels(effectiveModels, baseUrl);
      },
    },
    auth: createAuthHook(),
  };
};

function createAuthHook(): AuthHook {
  return {
    provider: LLAMASWAP_PROVIDER_ID,
    methods: [
      {
        type: 'api',
        label: 'API Key',
      },
    ],
    loader: loadProviderOptions,
  };
}

async function loadProviderOptions(
  getAuth: AuthAccessor,
  provider: ProviderDefinition,
): Promise<Record<string, unknown>> {
  const auth = await getAuth();
  if (!auth || auth.type !== 'api') {
    throw new Error(
      "No API key available. Please run '/connect llamaswap' to set up your llama-swap connection.",
    );
  }

  const config = createRuntimeConfig(provider.options, auth.key);

  let models: LlamaSwapModel[] = [];
  try {
    const forceRefresh = config.refreshOnList !== false;
    models = await fetchModels(config, config.apiKey, forceRefresh);
    debug(`Available models: ${models.map((model) => sanitizeForLog(model.id)).join(', ')}`);
  } catch (error) {
    warn(`Failed to fetch models: ${error}`);
    models = [];
  }

  const effectiveModels = applyModelMetadataOverrides(
    models,
    getRawUserModelMetadata(provider.options),
  );
  replaceProviderModels(provider, toProviderModels(effectiveModels, config.baseUrl));
  if (isRecord(provider.models)) {
    debug(`Provider models hydrated: ${Object.keys(provider.models).length}`);
  }

  return {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    fetch: createFetchInterceptor(config),
  };
}

function createRuntimeConfig(
  options: Record<string, unknown> | undefined,
  apiKey: string,
): LlamaSwapConfig {
  const baseUrl = getBaseUrl(options);
  const modelCacheTtl = getPositiveNumber(options, 'modelCacheTtl');
  const refreshOnList = getBoolean(options, 'refreshOnList');
  const modelsDev = getModelsDevConfig(options);
  const modelMetadata = getModelMetadataConfig(options);

  return {
    baseUrl,
    apiKey,
    apiMode: getApiMode(options),
    modelCacheTtl,
    refreshOnList,
    modelsDev,
    modelMetadata,
  };
}

function resolveProviderApi(api: unknown, apiMode: LlamaSwapApiMode): LlamaSwapApiMode {
  if (isApiMode(api)) {
    if (api !== apiMode) {
      warn(`provider.api (${sanitizeForLog(String(api))}) and options.apiMode (${sanitizeForLog(apiMode)}) differ; using options.apiMode`);
    }
    return apiMode;
  }

  if (typeof api === 'string') {
    warn(`Unsupported provider.api value: ${sanitizeForLog(String(api))}. Using ${sanitizeForLog(apiMode)}.`);
  }

  return apiMode;
}

function getApiMode(options?: Record<string, unknown>): LlamaSwapApiMode {
  const value = options?.apiMode;
  if (value === undefined) {
    return 'chat';
  }

  if (isApiMode(value)) {
    return value;
  }

  warn(`Unsupported apiMode option: ${sanitizeForLog(String(value))}. Using chat.`);
  return 'chat';
}

function getApiKey(options?: Record<string, unknown>): string {
  const apiKey = options?.apiKey ?? process.env.LLAMASWAP_API_KEY;
  if (typeof apiKey === 'string') {
    return apiKey;
  }

  warn(`No API key found in options or environment variables, trying empty string.`);
  return '';
}

function isApiMode(value: unknown): value is LlamaSwapApiMode {
  return value === 'chat' || value === 'responses';
}

function getBaseUrl(options?: Record<string, unknown>): string {
  const rawBaseUrl = options?.baseURL;
  if (typeof rawBaseUrl !== 'string') {
    return LLAMASWAP_ENDPOINTS.BASE_URL;
  }

  const trimmed = rawBaseUrl.trim();
  if (trimmed === '') {
    return LLAMASWAP_ENDPOINTS.BASE_URL;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      warn(`Ignoring unsupported baseURL protocol: ${sanitizeForLog(parsed.protocol)}`);
      return LLAMASWAP_ENDPOINTS.BASE_URL;
    }

    return trimmed;
  } catch {
    warn(`Ignoring invalid baseURL: ${sanitizeForLog(trimmed)}`);
    return LLAMASWAP_ENDPOINTS.BASE_URL;
  }
}

function getPositiveNumber(
  options: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = options?.[key];
  if (typeof value === 'number' && value > 0) {
    return value;
  }
  return undefined;
}

function getBoolean(
  options: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = options?.[key];
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function getModelsDevConfig(options: Record<string, unknown> | undefined): LlamaSwapModelsDevConfig | undefined {
  const raw = options?.modelsDev;
  if (!isRecord(raw)) return undefined;

  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  const url = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url.trim() : undefined;
  const cacheTtl = getPositiveNumber(raw, 'cacheTtl');
  const timeoutMs = getPositiveNumber(raw, 'timeoutMs');
  const providerAliases = getStringRecord(raw.providerAliases);

  if (
    enabled === undefined &&
    url === undefined &&
    cacheTtl === undefined &&
    timeoutMs === undefined &&
    providerAliases === undefined
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(cacheTtl !== undefined ? { cacheTtl } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(providerAliases !== undefined ? { providerAliases } : {}),
  };
}

function getModelMetadataConfig(
  options: Record<string, unknown> | undefined,
): LlamaSwapModelMetadataConfig | undefined {
  const raw = options?.modelMetadata;
  if (!raw) return undefined;

  if (Array.isArray(raw)) {
    const filtered = raw.filter(
      (item) =>
        isRecord(item) && (typeof item.match === 'string' || coerceRegExp(item.match) !== null),
    );
    return filtered.length > 0 ? (filtered as unknown as LlamaSwapModelMetadataConfig) : undefined;
  }

  if (isRecord(raw)) {
    const hasAny = Object.values(raw).some((value) => isRecord(value));
    return hasAny ? (raw as unknown as LlamaSwapModelMetadataConfig) : undefined;
  }

  return undefined;
}

function getRawUserModelMetadata(options: Record<string, unknown> | undefined): unknown {
  if (!options) return undefined;
  const optionsWithRaw = options as OptionsWithRawModelMetadata;
  // Preserve raw user-authored modelMetadata separately from generated compatibility
  // metadata. The non-enumerable Symbol is the in-memory fast path; if OpenCode
  // clones/serializes options between lifecycle hooks, the internal option field
  // survives and distinguishes "no raw metadata" (null) from generated metadata.
  if (RAW_MODEL_METADATA in optionsWithRaw) {
    return optionsWithRaw[RAW_MODEL_METADATA];
  }
  if (RAW_MODEL_METADATA_OPTION in options) {
    return options[RAW_MODEL_METADATA_OPTION] === null
      ? undefined
      : options[RAW_MODEL_METADATA_OPTION];
  }
  return options.modelMetadata;
}

function setRawUserModelMetadata(options: Record<string, unknown>, rawUserConfig: unknown): void {
  options[RAW_MODEL_METADATA_OPTION] = serializeRawModelMetadataForOption(rawUserConfig) ?? null;
  Object.defineProperty(options, RAW_MODEL_METADATA, {
    value: rawUserConfig,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function serializeRawModelMetadataForOption(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;

  return raw.map((block) => {
    if (!isRecord(block) || !isRegExp(block.match)) return block;

    return {
      ...block,
      match: {
        source: block.match.source,
        flags: block.match.flags,
      },
    };
  });
}

function getModelsGeneratedByPlugin(options: Record<string, unknown> | undefined): boolean {
  if (!options) return false;
  const optionsWithMarker = options as OptionsWithRawModelMetadata;
  if (MODELS_GENERATED_BY_PLUGIN in optionsWithMarker) {
    return optionsWithMarker[MODELS_GENERATED_BY_PLUGIN] === true;
  }
  return options[MODELS_GENERATED_BY_PLUGIN_OPTION] === true;
}

function setModelsGeneratedByPlugin(
  options: Record<string, unknown>,
  generatedByPlugin: boolean,
): void {
  options[MODELS_GENERATED_BY_PLUGIN_OPTION] = generatedByPlugin ? true : null;
  Object.defineProperty(options, MODELS_GENERATED_BY_PLUGIN, {
    value: generatedByPlugin,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function hasProviderModels(provider: ProviderDefinition | undefined): boolean {
  return Boolean(provider?.models && Object.keys(provider.models).length > 0);
}

function shouldRefreshProviderModels(provider: ProviderDefinition | undefined): boolean {
  if (!hasProviderModels(provider)) return true;
  if (getModelsGeneratedByPlugin(provider?.options)) return true;
  return hasLegacyGeneratedProviderModels(provider?.models);
}

function hasLegacyGeneratedProviderModels(models: Record<string, unknown> | undefined): boolean {
  if (!isRecord(models)) return false;
  const values = Object.values(models);
  if (values.length === 0) return false;
  return values.every(isGeneratedLlamaSwapProviderModel);
}

function isGeneratedLlamaSwapProviderModel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.providerID !== LLAMASWAP_PROVIDER_ID) return false;
  if (!isRecord(value.api)) return false;
  return value.api.npm === LLAMASWAP_PROVIDER_NPM;
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;

  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    out[key] = trimmed;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeModelMetadata(
  rawUserConfig: unknown,
  generated: Record<string, LlamaSwapModelMetadata>,
): LlamaSwapModelMetadataConfig {
  const userConfig = getModelMetadataConfig({ modelMetadata: rawUserConfig });

  if (Array.isArray(userConfig)) {
    // Validate user-provided metadata blocks to prevent issues in OpenCode framework
    const validUserConfig = userConfig.filter((block) => {
      const validation = isValidModelMetadata(block);
      if (!validation.valid) {
        warn(`Invalid metadata block for match "${sanitizeForLog(String(block.match))}" (field: ${sanitizeForLog(validation.field ?? '')}), skipping`);
        return false;
      }
      return true;
    });

    const generatedBlocks = Object.entries(generated).map(([id, metadata]) => ({
      match: id,
      ...metadata,
    }));

    // User config comes first so it takes precedence in first-match-wins systems
    return [...validUserConfig, ...generatedBlocks];
  }

  if (userConfig && isRecord(userConfig)) {
    const merged: Record<string, LlamaSwapModelMetadata> = { ...generated };
    for (const [id, metadata] of Object.entries(userConfig)) {
      const validation = isValidModelMetadata(metadata);
      if (!validation.valid) {
        warn(`Invalid metadata for model "${sanitizeForLog(id)}" (field: ${sanitizeForLog(validation.field ?? '')}), skipping`);
        continue;
      }
      // If user uses an alias key (e.g., 'cx/gpt-5.5'), merge into canonical key
      // so it matches the generated metadata and deduplicated model IDs
      const canonicalId = resolveProviderAliasForMetadata(id);
      merged[canonicalId] = {
        ...(merged[canonicalId] ?? {}),
        ...metadata,
      };
    }
    return merged;
  }

  return generated;
}

function applyModelMetadataOverrides(
  models: LlamaSwapModel[],
  rawUserConfig: unknown,
): LlamaSwapModel[] {
  const userConfig = getModelMetadataConfig({ modelMetadata: rawUserConfig });
  if (!userConfig) return models;

  if (Array.isArray(userConfig)) {
    // Pre-process blocks once: canonicalize string matches, compile regexes,
    // and extract metadata. Avoids redundant work inside the per-model loops.
    type ProcessedBlock = {
      match: string | RegExp;
      canonicalMatch: string | null;
      metadata: LlamaSwapModelMetadata;
      addIfMissing: boolean;
    };

    const processedBlocks: ProcessedBlock[] = [];
    for (const block of userConfig) {
      const validation = isValidModelMetadata(block);
      if (!validation.valid) {
        warn(`Invalid metadata block for match "${sanitizeForLog(String(block.match))}" (field: ${sanitizeForLog(validation.field ?? '')}), skipping`);
        continue;
      }

      const match = block.match;
      const canonicalMatch = typeof match === 'string' ? resolveProviderAliasForMetadata(match) : null;
      const metadata = extractModelMetadata(block);
      processedBlocks.push({
        match,
        canonicalMatch,
        metadata,
        addIfMissing: block.addIfMissing === true,
      });
    }

    const modelsWithOverrides = models.map((model) => {
      const canonicalId = resolveProviderAliasForMetadata(model.id);
      const processed = processedBlocks.find((candidate) =>
        processedBlockMatches(candidate, model.id, canonicalId),
      );
      if (!processed) return model;

      return {
        ...model,
        ...processed.metadata,
      };
    });

    const existingModels = modelsWithOverrides.map((model) => ({
      id: model.id,
      canonicalId: resolveProviderAliasForMetadata(model.id),
    }));
    const missingModels: LlamaSwapModel[] = [];
    for (const processed of processedBlocks) {
      if (!processed.addIfMissing || typeof processed.match !== 'string') continue;

      const id = processed.canonicalMatch ?? processed.match;
      const alreadyExists = existingModels.some((model) =>
        processedBlockMatches(processed, model.id, model.canonicalId),
      ) || missingModels.some((model) => model.id === id);
      if (alreadyExists) continue;

      missingModels.push({
        id,
        name: processed.metadata.name ?? id,
        ...processed.metadata,
      });
    }

    return [...modelsWithOverrides, ...missingModels];
  }

  const overrides: Record<string, LlamaSwapModelMetadata> = {};
  for (const [id, metadata] of Object.entries(userConfig)) {
    const validation = isValidModelMetadata(metadata);
    if (!validation.valid) {
      warn(`Invalid metadata for model "${sanitizeForLog(id)}" (field: ${sanitizeForLog(validation.field ?? '')}), skipping`);
      continue;
    }

    const canonicalId = resolveProviderAliasForMetadata(id);
    overrides[canonicalId] = {
      ...(overrides[canonicalId] ?? {}),
      ...extractModelMetadata(metadata),
    };
  }

  return models.map((model) => {
    const canonicalId = resolveProviderAliasForMetadata(model.id);
    const metadata = overrides[canonicalId];
    if (!metadata) return model;

    return {
      ...model,
      ...metadata,
    };
  });
}

function metadataBlockMatches(match: unknown, modelId: string, canonicalId: string): boolean {
  if (typeof match === 'string') {
    const canonicalMatch = resolveProviderAliasForMetadata(match);
    return (
      match === modelId ||
      match === canonicalId ||
      canonicalMatch === modelId ||
      canonicalMatch === canonicalId
    );
  }

  return metadataMatcherMatches(match, modelId) || metadataMatcherMatches(match, canonicalId);
}

function processedBlockMatches(
  processed: { match: string | RegExp; canonicalMatch: string | null },
  modelId: string,
  canonicalId: string,
): boolean {
  if (typeof processed.match === 'string') {
    return (
      processed.match === modelId ||
      processed.match === canonicalId ||
      processed.canonicalMatch === modelId ||
      processed.canonicalMatch === canonicalId
    );
  }

  return metadataMatcherMatches(processed.match, modelId) || metadataMatcherMatches(processed.match, canonicalId);
}

function metadataMatcherMatches(match: unknown, modelId: string): boolean {
  const regexp = coerceRegExp(match);
  if (!regexp) return false;
  regexp.lastIndex = 0;
  return regexp.test(modelId);
}

const MODEL_METADATA_KEYS = [
  'name',
  'description',
  'contextWindow',
  'maxTokens',
  'supportsStreaming',
  'supportsVision',
  'supportsTools',
  'supportsTemperature',
  'supportsReasoning',
  'supportsAttachment',
  'pricing',
] as const satisfies readonly (keyof LlamaSwapModelMetadata)[];

function extractModelMetadata(value: LlamaSwapModelMetadata): LlamaSwapModelMetadata {
  return Object.fromEntries(
    MODEL_METADATA_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .map((key) => [key, value[key]]),
  ) as LlamaSwapModelMetadata;
}

function isRegExp(value: unknown): value is RegExp {
  return Object.prototype.toString.call(value) === '[object RegExp]';
}

function coerceRegExp(value: unknown): RegExp | null {
  if (isRegExp(value)) return value;
  if (!isRecord(value)) return null;

  const source = value.source;
  const flags = value.flags;
  if (typeof source !== 'string' || typeof flags !== 'string') return null;

  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function replaceProviderModels(
  provider: ProviderDefinition,
  models: Record<string, LlamaSwapProviderModel>,
): void {
  if (isRecord(provider.models)) {
    for (const key of Object.keys(provider.models)) {
      delete provider.models[key];
    }
    Object.assign(provider.models, models);
    return;
  }

  provider.models = models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BOOLEAN_FIELDS = [
  'supportsStreaming', 'supportsVision', 'supportsTools',
  'supportsTemperature', 'supportsReasoning', 'supportsAttachment',
];

function isValidModelMetadata(value: unknown): { valid: boolean; field?: string } {
  if (!isRecord(value)) return { valid: false, field: '(not an object)' };

  for (const field of BOOLEAN_FIELDS) {
    if (field in value && typeof value[field] !== 'boolean') {
      return { valid: false, field };
    }
  }

  if ('contextWindow' in value && typeof value.contextWindow !== 'number') {
    return { valid: false, field: 'contextWindow' };
  }
  if ('maxTokens' in value && typeof value.maxTokens !== 'number') {
    return { valid: false, field: 'maxTokens' };
  }
  if ('name' in value && typeof value.name !== 'string') {
    return { valid: false, field: 'name' };
  }
  if ('description' in value && typeof value.description !== 'string') {
    return { valid: false, field: 'description' };
  }
  if ('pricing' in value) {
    const pricing = value.pricing;
    if (!isRecord(pricing)) {
      return { valid: false, field: 'pricing' };
    }
    if ('input' in pricing && typeof pricing.input !== 'number') {
      return { valid: false, field: 'pricing.input' };
    }
    if ('output' in pricing && typeof pricing.output !== 'number') {
      return { valid: false, field: 'pricing.output' };
    }
  }

  return { valid: true };
}

function toProviderModels(
  models: LlamaSwapModel[],
  baseUrl: string,
): Record<string, LlamaSwapProviderModel> {
  const entries: Array<[string, LlamaSwapProviderModel]> = models.map((model) => [
    model.id,
    toProviderModel(model, baseUrl),
  ]);
  return Object.fromEntries(entries);
}

function toProviderModel(model: LlamaSwapModel, baseUrl: string): LlamaSwapProviderModel {
  const supportsVision = model.supportsVision === true;
  // Default to true: if API doesn't explicitly say no tools, assume capability exists
  // This aligns with OpenAI-compatible behavior where most models support tools
  const supportsTools = model.supportsTools !== false;
  const supportsTemperature = model.supportsTemperature !== false;
  const supportsReasoning = model.supportsReasoning === true;
  const supportsAttachment = model.supportsAttachment !== undefined ? model.supportsAttachment : supportsVision;

  return {
    id: model.id,
    name: model.name || model.id,
    providerID: LLAMASWAP_PROVIDER_ID,
    family: getModelFamily(model.id),
    release_date: '',
    attachment: supportsAttachment,
    reasoning: supportsReasoning,
    temperature: supportsTemperature,
    tool_call: supportsTools,
    modalities: {
      input: supportsVision ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
    api: {
      id: model.id,
      url: baseUrl,
      npm: LLAMASWAP_PROVIDER_NPM,
    },
    capabilities: {
      temperature: supportsTemperature,
      reasoning: supportsReasoning,
      attachment: supportsAttachment,
      toolcall: supportsTools,
      input: {
        text: true,
        image: supportsVision,
        audio: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        image: false,
        audio: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: model.pricing?.input ?? 0,
      output: model.pricing?.output ?? 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: model.contextWindow ?? DEFAULT_CONTEXT_LIMIT,
      output: model.maxTokens ?? DEFAULT_OUTPUT_LIMIT,
    },
    options: {},
    headers: {},
    status: 'active',
    variants: model.variants && Object.keys(model.variants).length > 0
      ? model.variants
      : supportsReasoning
        ? {
            low: { reasoningEffort: 'low' },
            medium: { reasoningEffort: 'medium' },
            high: { reasoningEffort: 'high' },
          }
        : {},
  };
}

function getModelFamily(modelId: string): string {
  const withoutProvider = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  const [family] = withoutProvider.split('-');
  return family || withoutProvider;
}

/**
 * Create fetch interceptor for LlamaSwap API
 *
 * @param config - LlamaSwap configuration
 * @returns Fetch interceptor function
 */
function createFetchInterceptor(
  config: LlamaSwapConfig,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const baseUrl = config.baseUrl || 'http://localhost:8080/v1';

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Properly extract URL from RequestInfo (handles Request objects correctly)
    const url = input instanceof Request ? input.url : input.toString();

    // Only intercept requests to the configured LlamaSwap base URL
    // Ensure baseUrl ends with a slash for safe prefix matching to prevent domain spoofing
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const isLlamaSwapRequest = url === baseUrl || url.startsWith(normalizedBaseUrl);

    if (!isLlamaSwapRequest) {
      // Pass through non-LlamaSwap requests
      return fetch(input, init);
    }

    debug(`Intercepting request to ${sanitizeForLog(url)}`);

    // Merge headers from Request and init to avoid dropping existing headers
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      const initHeaders = new Headers(init.headers);
      initHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }

    headers.set('Authorization', `Bearer ${config.apiKey}`);
    headers.set('Content-Type', 'application/json');

    const sanitizedBody = await sanitizeGeminiToolSchemas(input, init, url);

    // Clone init to avoid mutating original
    const modifiedInit: RequestInit = {
      ...init,
      headers,
      ...(sanitizedBody !== undefined ? { body: sanitizedBody } : {}),
    };

    // Make the request
    const response = await fetch(input, modifiedInit);

    // Handle model fetching endpoint specially
    if (url.includes('/v1/models') && response.ok) {
      debug('Processing /v1/models response');
    }

    return response;
  };
}

const GEMINI_SCHEMA_KEYS_TO_REMOVE = new Set(['$schema', '$ref', 'ref', 'additionalProperties']);

async function sanitizeGeminiToolSchemas(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
): Promise<string | undefined> {
  if (!url.includes('/chat/completions') && !url.includes('/responses')) {
    return undefined;
  }

  const rawBody = await getRawJsonBody(input, init);
  if (!rawBody) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return undefined;
  }

  if (!isRecord(payload)) {
    return undefined;
  }

  const model = payload.model;
  if (typeof model !== 'string' || !model.toLowerCase().includes('gemini')) {
    return undefined;
  }

  const tools = payload.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  const clonedPayload = structuredClone(payload);
  const changed = sanitizeToolSchemaContainer(clonedPayload);
  if (!changed) {
    return undefined;
  }

  debug('Sanitized Gemini tool schema keywords');
  return JSON.stringify(clonedPayload);
}

async function getRawJsonBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === 'string') {
    return init.body;
  }

  if (!(input instanceof Request)) {
    return undefined;
  }

  if (init?.body !== undefined) {
    return undefined;
  }

  const contentType = input.headers.get('content-type');
  if (!contentType || !contentType.toLowerCase().includes('application/json')) {
    return undefined;
  }

  return input.clone().text();
}

function sanitizeToolSchemaContainer(payload: Record<string, unknown>): boolean {
  const tools = payload.tools;
  if (!Array.isArray(tools)) {
    return false;
  }

  let changed = false;
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }

    if (isRecord(tool.function) && isRecord(tool.function.parameters)) {
      changed = stripSchemaKeys(tool.function.parameters) || changed;
    }

    if (isRecord(tool.function_declaration) && isRecord(tool.function_declaration.parameters)) {
      changed = stripSchemaKeys(tool.function_declaration.parameters) || changed;
    }

    if (isRecord(tool.input_schema)) {
      changed = stripSchemaKeys(tool.input_schema) || changed;
    }
  }

  return changed;
}

function stripSchemaKeys(schema: Record<string, unknown>): boolean {
  let changed = false;

  for (const key of Object.keys(schema)) {
    if (GEMINI_SCHEMA_KEYS_TO_REMOVE.has(key)) {
      delete schema[key];
      changed = true;
      continue;
    }

    const value = schema[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item)) {
          changed = stripSchemaKeys(item) || changed;
        }
      }
      continue;
    }

    if (isRecord(value)) {
      changed = stripSchemaKeys(value) || changed;
    }
  }

  return changed;
}
