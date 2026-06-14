import type { Model } from '@opencode-ai/sdk';
import type { LlamaSwapProviderModel } from './src/types.js';

// Type compatibility test: LlamaSwapProviderModel should be assignable to Model
const testCompat = (m: LlamaSwapProviderModel): Model => m;
