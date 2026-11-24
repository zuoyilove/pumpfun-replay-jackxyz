// Pump.fun paper-trading bot for agent-fun/replay/v2.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
// The hello handshake gives the bot its caps (max 5 open positions, max 16
// orders per batch); every batch of events arrives with a slot, and the bot
// answers with its orders for that slot.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
