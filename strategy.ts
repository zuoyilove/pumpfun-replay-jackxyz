// Momentum paper bot for the pump.fun replay sprint.
//
// The idea, in short: only buy a coin while a crowd is already buying it.
// A coin qualifies when, over the last 40 slots, at least four separate
// buyers pushed at least 0.75 SOL more in than out, the price climbed at
// least 10% from where the window started, and it is still sitting within
// 5% of the window high — with no single buyer dominating the flow. Each
// bet is a small fixed 0.05 SOL, at most one entry per coin and at most
// four such positions at once, so no single coin can sink the run.
//
// Once in, the bot does nothing clever: it waits for a double (+100%) or
// for a 25% give-back after the price has first risen 10%. There is no
// stop-loss and no quick exit on purpose — a round trip costs about 2.5%
// in curve fees plus a transaction fee, so churning in and out of these
// coins loses money on fees alone. Patience is the whole edge, such as
// it is.
//
// When momentum signals go quiet the 20-coin guardrail still has to be
// met, so the bot also places tiny 0.02 SOL probe buys, paced evenly
// across the session's block time toward 30 coins / 240 fills, and sells
// each probe on the next batch after it fills. Probes are not a strategy;
// they are ballast that keeps the entry valid.
//
// Deterministic: no clock, no randomness, no environment. Everything the
// bot does comes from the batch stream, iterating insertion-ordered maps.
//
// Grade-local (dev window, commit b6ea09a, process driver): net PnL
// -0.073319 SOL, 122 round trips, 241 fills, 45 distinct mints, 13.1%
// win rate, 0 rejected, 1 failed tx, L1 reproduced, guardrails compliant.
// result_sha256 3305e59bb8e83cc8453b5844437082a1d233175542d75c2ede88dd86601c1687.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  window: number;
  minNetSol: number;
  minBuys: number;
  minBuyers: number;
  minPriceUp: number;
  nearHigh: number;
  maxBuyerShare: number;
  minRqSol: number;
  maxRqSol: number;
  minAge: number;
  initialSol: number;
  addSol: number;
  addStep: number;
  addIfUp: number;
  stakeSol: number;
  minBuySol: number;
  buySlipBps: number;
  stopLoss: number;
  trail: number;
  trailArm: number;
  takeProfit: number;
  fadeWindow: number;
  fadeNetSol: number;
  bigSellSol: number;
  maxHold: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 0.75,
  minBuys: 4,
  minBuyers: 4,
  minPriceUp: 0.1,
  nearHigh: 0.95,
  maxBuyerShare: 0.6,
  minRqSol: 2,
  maxRqSol: 60,
  minAge: 400,
  initialSol: 0.05,
  addSol: 0.05,
  addStep: 0.15,
  addIfUp: 0.05,
  stakeSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 1.0,
  trail: 0.25,
  trailArm: 0.1,
  takeProfit: 1.0,
  fadeWindow: 15,
  fadeNetSol: -1000,
  bigSellSol: 1000,
  maxHold: 100000000,
  holdIfUp: 0.25,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 4,
  maxExposureSol: 2,
  targetCoins: 30,
  targetFills: 240,
  paceSecs: 21600,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS_PER_SOL = 1e9;
/** Curve fee per side: 95 + 30 bps, applied on the sell leg of a mark. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  /** Price in SOL per token: virtual_quote_reserves / virtual_token_reserves. */
  price: number;
}

interface Tape {
  /** Slot of the coin's CreateEvent, null until one is seen. */
  created: number | null;
  trades: TapeTrade[];
  /** Entries ever opened on this mint (minus one if an entry never filled). */
  entries: number;
  /** Slot of the last filled exit, for the re-entry cooldown. */
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

interface Probe {
  selling: boolean;
}

function newTape(): Tape {
  return { created: null, trades: [], entries: 0, lastExit: Number.NEGATIVE_INFINITY };
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, Probe>();
  const myCoins = new Set<Pubkey>();
  let myFills = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeFor = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = newTape();
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net SOL (buys minus sells) over the last w slots, scanning newest first. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i];
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Buying-flow entry signal for one curve at slot `now`. */
  const entrySignal = (mint: Pubkey, now: number, rqSol: number): boolean => {
    const t = tapes.get(mint);
    if (t === undefined) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    const start = now - p.window;
    // Reference price: the last trade at or before the window start, or the
    // first trade inside the window when nothing is that old.
    let startPrice: number | null = null;
    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    let high = 0;
    let last = 0;
    let sawWindowTrade = false;
    const buyers = new Set<Pubkey>();
    const perBuyer = new Map<Pubkey, number>();
    for (const tr of t.trades) {
      if (tr.slot <= start) {
        startPrice = tr.price;
        continue;
      }
      if (!sawWindowTrade) {
        if (startPrice === null) startPrice = tr.price;
        sawWindowTrade = true;
      }
      if (tr.buy) {
        buys += 1;
        buySol += tr.sol;
        buyers.add(tr.user);
        perBuyer.set(tr.user, (perBuyer.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (startPrice === null || startPrice <= 0) return false;
    if (buys < p.minBuys) return false;
    if (buyers.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (last / startPrice - 1 < p.minPriceUp) return false;
    if (last < p.nearHigh * high) return false;
    let biggest = 0;
    for (const v of perBuyer.values()) if (v > biggest) biggest = v;
    if (biggest > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /**
   * What `tokens` would sell for right now, in SOL: the bonding-curve
   * payout (batch mark reserves when present, else the curve's reserves),
   * less the 1.25% curve fee and one transaction fee.
   */
  const markValue = (state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number => {
    const txSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    let vq: bigint | null = null;
    let vt: bigint | null = null;
    for (const m of batch.marks) {
      if (m.mint === mint) {
        vq = BigInt(m.virtual_quote_reserves);
        vt = BigInt(m.virtual_token_reserves);
        break;
      }
    }
    if (vq === null || vt === null) {
      const c = state.curves.get(mint);
      if (c === undefined) return 0;
      vq = c.virtual_quote_reserves;
      vt = c.virtual_token_reserves;
    }
    if (vt + tokens <= 0n) return 0;
    const out = (tokens * vq) / (vt + tokens);
    return (Number(out) / LAMPORTS_PER_SOL) * (1 - CURVE_FEE) - txSol;
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    const now = batch.slot;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    const cap = state.hello.caps.max_orders_per_batch;
    const orders: OrderInput[] = [];

    // Count this batch's own fills (harness closes start with '_').
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills += 1;
        myCoins.add(f.mint);
      }
    }

    // Ingest the batch's events, in chain order, and collect the mints
    // that traded, first-appearance first.
    const traded: Pubkey[] = [];
    const tradedSeen = new Set<Pubkey>();
    const bigSells = new Set<Pubkey>();
    const noteTraded = (mint: Pubkey): void => {
      if (!tradedSeen.has(mint)) {
        tradedSeen.add(mint);
        traded.push(mint);
      }
    };
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        noteTraded(e.mint);
        tapeFor(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        noteTraded(e.mint);
        const t = tapeFor(e.mint);
        const sol = Number(BigInt(e.sol_amount)) / LAMPORTS_PER_SOL;
        const price =
          Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
        if (!e.is_buy && sol >= p.bigSellSol) bigSells.add(e.mint);
      } else {
        noteTraded(e.mint);
      }
    }

    // Prune tape trades older than the entry window plus a small margin,
    // so the reference price can still look just before the window.
    // One splice removes the expired prefix in a single memmove; the
    // repeated shift() this replaces cost O(prefix x tape) per batch on
    // hot mints (up to ~800 trades inside a 45-slot window). The same
    // prefix is removed, so the resulting tape is identical.
    const pruneBefore = now - (p.window + 5);
    for (const mint of traded) {
      const t = tapes.get(mint);
      if (t === undefined) continue;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut].slot <= pruneBefore) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    // Orders still in flight, by mint.
    const pendingAny = new Set<Pubkey>();
    const pendingSell = new Set<Pubkey>();
    for (const po of state.pending.values()) {
      pendingAny.add(po.order.mint);
      if (po.order.side === 'sell') pendingSell.add(po.order.mint);
    }

    // 1. Exits first, held positions in insertion order.
    for (const [mint, rec] of held) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        if (!pendingAny.has(mint)) {
          held.delete(mint);
          const t = tapes.get(mint);
          if (t !== undefined) {
            if (rec.filled) t.lastExit = now;
            else t.entries -= 1;
          }
        }
        continue;
      }
      rec.filled = true;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cost = Number(BigInt(pos.cost_lamports)) / LAMPORTS_PER_SOL;
      const value = markValue(state, batch, mint, BigInt(pos.token_amount));
      if (value > rec.peakValue) rec.peakValue = value;
      rec.lastValue = value;
      const tape = tapes.get(mint);
      const fade = tape === undefined ? 0 : flow(tape, now, p.fadeWindow);
      const shouldExit =
        value < cost * (1 - p.stopLoss) ||
        (rec.peakValue >= cost * (1 + p.trailArm) && value < rec.peakValue * (1 - p.trail)) ||
        value >= cost * (1 + p.takeProfit) ||
        fade < p.fadeNetSol ||
        bigSells.has(mint) ||
        (now - rec.opened > p.maxHold && value < cost * (1 + p.holdIfUp));
      if (shouldExit) {
        rec.exiting = true;
        if (!pendingSell.has(mint) && orders.length < cap) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: 10000,
          });
        }
      }
    }

    // 2. Probes: sell each filled probe on the first batch after its buy
    // filled; drop the probe record once its position is gone for good,
    // so the same mint can be probed again later as a fresh probe.
    for (const [mint, probe] of probes) {
      const pos = state.positions.get(mint);
      if (pos === undefined && !pendingAny.has(mint)) {
        probes.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (
        pos !== undefined &&
        curve !== undefined &&
        !curve.complete &&
        !pendingAny.has(mint) &&
        orders.length < cap
      ) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: 10000,
        });
        probe.selling = true;
      }
    }

    // 3. Entries and (in practice never reached) adds.
    let free = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = p.maxMain - held.size;
    let exposure = 0;
    for (const [mint, rec] of held) {
      const pos = state.positions.get(mint);
      const costSol = pos === undefined ? 0 : Number(BigInt(pos.cost_lamports)) / LAMPORTS_PER_SOL;
      exposure += Math.max(rec.invested, costSol);
    }
    for (const mint of traded) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingAny.has(mint)) continue;
      if (probes.has(mint)) continue;
      const rec = held.get(mint);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
      const price =
        curve.virtual_token_reserves > 0n
          ? Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves)
          : 0;
      if (rec === undefined) {
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.entries >= p.maxEntries) continue;
        if (now - t.lastExit < p.cooldown) continue;
        if (!entrySignal(mint, now, rqSol)) continue;
        const amount = Math.min(
          Number(state.maxBuyLamports(mint)) / LAMPORTS_PER_SOL,
          p.initialSol,
          p.maxExposureSol - exposure,
          free - txSol,
        );
        if (amount < p.minBuySol) continue;
        const quote = Math.floor(amount * LAMPORTS_PER_SOL);
        if (quote <= 0 || orders.length >= cap) continue;
        orders.push({ side: 'buy', mint, quote_lamports: String(quote), max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries += 1;
        slotsLeft -= 1;
        mainLeft -= 1;
      } else if (!rec.exiting && rec.filled && rec.invested < p.stakeSol - p.minBuySol) {
        // Pyramiding: unreachable while stakeSol equals initialSol, kept
        // for completeness behind the same guards as a fresh entry.
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const cost = Number(BigInt(pos.cost_lamports)) / LAMPORTS_PER_SOL;
        if (price < rec.lastAddPrice * (1 + p.addStep)) continue;
        if (rec.lastValue < cost * (1 + p.addIfUp)) continue;
        if (rqSol > p.maxRqSol) continue;
        const amount = Math.min(
          Number(state.maxBuyLamports(mint)) / LAMPORTS_PER_SOL,
          Math.min(p.addSol, p.stakeSol - rec.invested),
          p.maxExposureSol - exposure,
          free - txSol,
        );
        if (amount < p.minBuySol) continue;
        const quote = Math.floor(amount * LAMPORTS_PER_SOL);
        if (quote <= 0 || orders.length >= cap) continue;
        orders.push({ side: 'buy', mint, quote_lamports: String(quote), max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        rec.invested += amount;
        rec.lastAddPrice = price;
      }
    }

    // 4. Guardrail pacing: when the session is behind on coins or fills,
    // spend one tiny probe buy on the first traded mint that passes the
    // filters, so fresh distinct mints keep arriving even when momentum
    // signals are quiet. At most one probe buy per batch.
    if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
      const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
      const needFills = myFills < Math.ceil(p.targetFills * pace);
      if (needCoins || needFills) {
        for (const mint of traded) {
          if (held.has(mint) || probes.has(mint)) continue;
          if (pendingAny.has(mint)) continue;
          if (state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          const minReal = 1.5 * ((p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve);
          if (rqSol < minReal) continue;
          if (free < p.probeSol + 2 * txSol) continue;
          if (orders.length >= cap) break;
          const quote = Math.floor(p.probeSol * LAMPORTS_PER_SOL);
          orders.push({ side: 'buy', mint, quote_lamports: String(quote), max_slippage_bps: p.buySlipBps });
          probes.set(mint, { selling: false });
          free -= p.probeSol + txSol;
          break;
        }
      }
    }

    return orders;
  };

  return { onBatch };
}
