# OpenCode llama-swap Auth Plugin

🔌 Authentication plugin for [OpenCode](https://opencode.ai) to connect to [llama-swap](https://github.com/mostlygeek/llama-swap) API.

## Features

- **Dynamic Model Fetching** - Automatically fetches available models from `/v1/models` endpoint
- **API Key Authentication** - Simple and secure API key-based auth
- **Provider Auto-Registration** - Registers an `llama-swap` provider via plugin hooks
- **Simple `/connect` Command** - No manual configuration needed
- **Model Caching** - Intelligent caching with TTL for better performance
- **Model Metadata Normalization** - Reads all llama-swap field variants (camelCase, snake_case, capabilities object) with proper precedence
- **Provider Alias Deduplication** - Automatically deduplicates alias/canonical model entries (e.g., `cx/gpt-5.5` → `codex/gpt-5.5`)
- **models.dev Enrichment** - Enriches model metadata from models.dev API with provider alias resolution
- **Model Variant Support** - Automatically strips reasoning effort suffixes (e.g., `gpt-5.5-xhigh` → `gpt-5.5`) for lookup
- **Secure Logging** - Sanitized log output with async file I/O to prevent event loop blocking

## Installation

```bash
npm install opencode-llamaswap-auth
```

## Quick Start

### 1. Add plugin to opencode config
```json
{
  "plugin": ["opencode-llamaswap-auth"]
}
```

### 2. Connect to llama-swap

Simply run the `/connect` command in OpenCode:

```
/connect llama-swap
```

The plugin will prompt you for your **API key** or none by default.

### 3. Done! 🎉

The plugin automatically:
- Fetches available models from `/v1/models`
- Configures OpenCode to use llama-swap
- Stores your credentials securely

No manual configuration file editing required!

## Usage

Once connected, OpenCode will automatically use llama-swap for AI requests:

```bash
# The plugin is now active and ready to use
# All AI requests will be routed through llama-swap
```

### Refresh Models

By default, the plugin refreshes the model list whenever provider options are reloaded (`refreshOnList: true`).

You can disable refreshes by setting `provider.llama-swap.options.refreshOnList` to `false` and clear the cache programmatically:

```typescript
import { clearModelCache } from 'opencode-llamaswap-auth/runtime';

clearModelCache();
```

## Configuration (Optional)

While the plugin works out-of-the-box with `/connect`, you can also configure it manually in your OpenCode config:

```json
{
  "plugin": [
    "opencode-llamaswap-auth"
  ],
  "provider": {
    "llama-swap": {
      "options": {
        "baseURL": "http://localhost:8080/v1",
        "apiMode": "chat",
        "apiKey": "<your-API-key>",
        "refreshOnList": true,
        "modelCacheTtl": 300000
      }
    }
  }
}
```

Use `/connect llama-swap` to store your API key in `~/.local/share/opencode/auth.json`.

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `plugin` | string[] | No | npm plugin packages to load (use `opencode-llamaswap-auth` when installed from npm) |
| `provider.llama-swap.options.baseURL` | string | No | llama-swap API base URL (default: `http://localhost:8080/v1`) |
| `provider.llama-swap.options.apiMode` | `'chat' \| 'responses'` | No | Provider API mode (default: `chat`) |
| `provider.llama-swap.options.apiKey` | string | No | Usually not needed, llama-swap is default-allow |
| `provider.llama-swap.options.modelCacheTtl` | number | No | Model cache TTL in milliseconds (default: 5 minutes) |
| `provider.llama-swap.options.refreshOnList` | boolean | No | Whether to refresh models when provider options load (default: true) |
| `provider.llama-swap.options.modelsDev` | object | No | Enrich model metadata from models.dev on refresh (default: enabled) |
| `provider.llama-swap.options.modelMetadata` | object \| array | No | Override/add metadata for custom/virtual models (works well in `opencode.js`) |

### Model Metadata Enrichment (models.dev)

llama-swap may not expose model context/output limits in `/v1/models`. When enabled, this plugin attempts to
enrich `contextWindow` and `maxTokens` by matching your llama-swap models against `models.dev`.

You can disable enrichment or override defaults:

```js
{
  provider: {
    "llama-swap": {
      options: {
        modelsDev: {
          enabled: true,
          url: 'https://models.dev/api.json',
          timeoutMs: 1000,
          cacheTtl: 86400000,
          providerAliases: {
            cx: 'openai',
          },
        },
      },
    },
  },
}
```

### Custom / Virtual Model Overrides (config blocks)

For custom/virtual models (or when matching is imperfect), you can provide metadata overrides.

In `opencode.js` you can use RegExp matchers:

```js
{
  provider: {
    "llama-swap": {
      options: {
        modelMetadata: [
          { match: /gpt-5\.3-codex$/i, contextWindow: 200000, maxTokens: 8192 },
          { match: 'llama-swap/virtual/my-custom-model', addIfMissing: true, contextWindow: 50000 },
        ],
      },
    },
  },
}
```

In JSON configs, use an object keyed by model id:

```json
{
  "provider": {
    "llama-swap": {
      "options": {
        "modelMetadata": {
          "virtual/my-custom-model": { "contextWindow": 50000, "maxTokens": 2048 }
        }
      }
    }
  }
}
```

### API Mode

The plugin supports two provider API modes:

- `chat` (default) - best compatibility with existing OpenAI-compatible chat workflows.
- `responses` - enables Responses API mode when your llama-swap/OpenCode setup supports it.

Example:

```json
{
  "provider": {
    "llama-swap": {
      "options": {
        "apiMode": "responses"
      }
    }
  }
}
```

If an unsupported value is provided, the plugin falls back to `chat`.

## Dynamic Model Fetching

This plugin automatically fetches available models from llama-swap's `/v1/models` endpoint. This ensures you always have access to the latest models without manual configuration.

### How It Works

1. On first request, the plugin fetches models from `/v1/models`
2. By default, models are refreshed every time you open the model list (`refreshOnList: true`)
3. If `refreshOnList` is disabled, models are cached for 5 minutes (configurable via `modelCacheTtl`)

## API

### Types

```typescript
import type {
  LlamaSwapApiMode,
  LlamaSwapConfig,
  LlamaSwapModel,
  LlamaSwapModelMetadataConfig,
  LlamaSwapModelsDevConfig,
} from "opencode-llamaswap-auth";

interface LlamaSwapConfig {
  baseUrl: string;
  apiKey: string;
  apiMode: LlamaSwapApiMode;
  defaultModels?: LlamaSwapModel[];
  modelCacheTtl?: number;
  refreshOnList?: boolean;
  modelsDev?: LlamaSwapModelsDevConfig;
  modelMetadata?: LlamaSwapModelMetadataConfig;
}

type LlamaSwapApiMode = 'chat' | 'responses';

interface LlamaSwapModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsTemperature?: boolean;
  supportsReasoning?: boolean;
  supportsAttachment?: boolean;
  // llama-swap native fields (normalized automatically)
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  capabilities?: {
    vision?: boolean;
    tool_calling?: boolean;
    reasoning?: boolean;
    thinking?: boolean;
    attachment?: boolean;
    temperature?: boolean;
  };
  pricing?: {
    input?: number;
    output?: number;
  };
}
```

### Functions

```typescript
import {
  fetchModels,
  clearModelCache,
  refreshModels,
} from 'opencode-llamaswap-auth/runtime';

// Fetch models manually (with automatic normalization and enrichment)
const models = await fetchModels(config, apiKey);

// Force refresh models
const freshModels = await refreshModels(config, apiKey);
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Clean
npm run clean
```

## Troubleshooting

### Connection Failed

If you see "Connection failed" when running `/connect llama-swap`:

1. **Check your configured base URL** - Ensure `provider.llama-swap.options.baseURL` points to your llama-swap endpoint
2. **Verify your API key** - Ensure your API key starts with `sk-` and is valid
3. **Check llama-swap is running** - Ensure your llama-swap instance is accessible

### Models Not Loading

If models aren't loading:

1. Check your llama-swap `/v1/models` endpoint is accessible
2. Ensure `provider.llama-swap.options.baseURL` points to your llama-swap endpoint
3. Re-run `/connect llama-swap` to refresh your API key
4. If you use the package programmatically, call `clearModelCache()` from `opencode-llamaswap-auth/runtime`
5. Check the OpenCode logs for error messages

### Plugin Not Loading Outside This Repo

If the plugin loads only through a local shim (for example from `.opencode/plugins`) but not from npm in `opencode.json`:

1. Ensure you are using `opencode-llamaswap-auth@1.0.1` or newer
2. Confirm your config includes `"plugin": ["opencode-llamaswap-auth"]`
3. Restart OpenCode so npm plugins are reloaded
4. Check plugin install cache/logs under `~/.cache/opencode/node_modules`

If needed, clear and reinstall plugin dependencies, then restart OpenCode.

## Credits

Inspired by and adapted from [opencode-omniroute-auth](https://github.com/Alph4d0g/opencode-omniroute-auth) by [Alph4d0g](https://github.com/Alph4d0g).

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For support, please open an issue on GitHub.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jpetrina/opencode-llamaswap-auth&type=Date)](https://star-history.com/#jpetrina/opencode-llamaswap-auth&Date)
