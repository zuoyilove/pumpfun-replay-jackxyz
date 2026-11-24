// Pump.fun replay sprint entry: a momentum paper bot (strategy in strategy.ts).
// The grader runs `node /bot/main.ts`; the SDK shim is vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
