// pumpfun-replay-jackxyz: momentum paper bot for the Pump.fun Replay Sprint.
// The strategy lives in strategy.ts; the SDK shim is vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
