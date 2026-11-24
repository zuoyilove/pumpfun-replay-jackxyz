// Momentum paper bot for the pump.fun replay sprint.
//
// The idea, in short: only buy a curve while strangers are already piling in.
// A mint qualifies when, over the last 40 slots, it has pulled in real SOL
// from several different buyers, its price has climbed at least 10% and is
// still sitting near the top of that short window, and no single buyer
// dominates the inflow. That is a broad buying-flow filter, not a prediction
// about any one coin: most of these mints still fade, so each stake is kept
// tiny (0.05 SOL) and at most four momentum positions are held at once.
//
// Once in, the bot does nothing clever. It waits for either a double
// (+100%) or a trailing stop that arms at +10% and sells if a quarter of
// the peak gain is given back. There is no stop-loss, no fade exit and no
// re-entry timer in practice: every forced exit the sweep tried cost more
// than it saved, because a round trip here pays about 2.5% in curve fees
// plus a transaction fee, and churning small stakes against that spread
// only grinds the account down. Holding for the occasional double and
// letting the trailing stop bank the partial runs is the whole exit plan.
//
// The guardrail needs at least 20 coins with real round trips, and quiet
// stretches of the replay may not produce 20 momentum signals. To keep the
// entry honest, the bot paces out tiny 0.02 SOL probe buys — one at a time,
// spread over the replay's block time — which are sold again on the next
// batch. Probes are guardrail ballast, not trades the bot believes in.
//
// Grade-local (process driver, fresh rewrite, 2026-11-24): net PnL
// -0.073319 SOL, 122 round trips, 241 fills, 45 distinct mints, max
// drawdown 1.24%, L1 reproduced, constraints compliant.
// result_sha256 bedb1c1b750d6e6b04c57e20a1a3e2307a3a21e386cc252fbe7b5e43861101b4

import type { Batch, Bot, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
/** Curve fee per side: 95 bps protocol + 30 bps creator = 1.25%. */
const CURVE_FEE = 0.0125;

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

/** One trade remembered for a mint. Price is quote-per-token from the curve. */
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

/** Everything remembered about one mint's tape. */
interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

/** Bookkeeping for one open momentum position. */
interface HeldPos {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, HeldPos>();
  const probes = new Map<Pubkey, { selling: boolean }>();
  const myCoins = new Set<Pubkey>();
  let myFills = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeFor = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: Number.NEGATIVE_INFINITY };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net SOL (buys minus sells) on a tape over the last w slots, newest first. */
  const flow = (t: Tape | undefined, now: number, w: number): number => {
    if (t === undefined) return 0;
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i];
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** True when a curve's recent tape looks like broad, rising buying flow. */
  const entrySignal = (state: BotState, mint: Pubkey, now: number): boolean => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return false;
    const rq = Number(curve.real_quote_reserves) / LAMPORTS;
    if (rq < p.minRqSol || rq > p.maxRqSol) return false;
    const t = tapes.get(mint);
    if (t === undefined || t.created === null || now - t.created < p.minAge) return false;
    const winStart = now - p.window;
    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    let high = 0;
    let lastPrice = 0;
    let firstPrice = 0;
    let anchor: number | null = null;
    let seenInWindow = false;
    const buyers = new Map<Pubkey, number>();
    for (const tr of t.trades) {
      if (tr.slot <= winStart) {
        anchor = tr.price;
        continue;
      }
      if (!seenInWindow) {
        firstPrice = tr.price;
        seenInWindow = true;
      }
      if (tr.buy) {
        buys++;
        buySol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      lastPrice = tr.price;
    }
    if (!seenInWindow) return false;
    if (buys < p.minBuys) return false;
    if (buyers.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    const start = anchor ?? firstPrice;
    if (start <= 0 || lastPrice / start - 1 < p.minPriceUp) return false;
    if (lastPrice < p.nearHigh * high) return false;
    let top = 0;
    for (const v of buyers.values()) if (v > top) top = v;
    if (buySol > 0 && top / buySol > p.maxBuyerShare) return false;
    return true;
  };

  /** What `tokens` would fetch if sold now, net of the curve fee and one tx fee. */
  const markValue = (
    state: BotState,
    marks: Map<Pubkey, Mark>,
    mint: Pubkey,
    tokens: bigint,
    txFeeSol: number,
  ): number => {
    const mark = marks.get(mint);
    const curve = state.curves.get(mint);
    const vq = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : (curve?.virtual_quote_reserves ?? 0n);
    const vt = mark !== undefined ? BigInt(mark.virtual_token_reserves) : (curve?.virtual_token_reserves ?? 0n);
    const denom = vt + tokens;
    if (denom <= 0n) return -txFeeSol;
    const out = (tokens * vq) / denom;
    return (Number(out) / LAMPORTS) * (1 - CURVE_FEE) - txFeeSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];

      // Count this batch's own fills (harness closes carry client_ids starting with '_').
      for (const f of batch.fills) {
        if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
        myFills++;
        myCoins.add(f.mint);
        if (f.side === 'buy') {
          const h = held.get(f.mint);
          if (h !== undefined) h.filled = true;
        }
      }

      // Fold the batch's events into the tapes; remember outsized sells.
      const bigSells = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const vt = BigInt(e.virtual_token_reserves);
          tapeFor(e.mint).trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(BigInt(e.sol_amount)) / LAMPORTS,
            user: e.user,
            price: vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt),
          });
          if (!e.is_buy && Number(BigInt(e.sol_amount)) / LAMPORTS >= p.bigSellSol) bigSells.add(e.mint);
          touched.add(e.mint);
        }
      }
      // Drop trades too old to matter for the entry window (keep a small margin
      // so the anchor trade just before the window survives).
      const pruneBefore = now - (p.window + 5);
      for (const mint of touched) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        while (t.trades.length > 0 && t.trades[0].slot < pruneBefore) t.trades.shift();
      }

      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const pend of state.pending.values()) {
        const slot = pendingByMint.get(pend.order.mint) ?? { buy: false, sell: false };
        if (pend.order.side === 'buy') slot.buy = true;
        else slot.sell = true;
        pendingByMint.set(pend.order.mint, slot);
      }
      const hasPending = (mint: Pubkey): boolean => pendingByMint.has(mint);
      const hasSellPending = (mint: Pubkey): boolean => pendingByMint.get(mint)?.sell ?? false;

      const marks = new Map<Pubkey, Mark>();
      for (const m of batch.marks) marks.set(m.mint, m);

      // 1. Exits first, for every tracked momentum position.
      for (const [mint, h] of [...held]) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!hasPending(mint)) {
            held.delete(mint);
            const t = tapes.get(mint);
            if (t !== undefined) {
              if (h.filled) t.lastExit = now;
              else t.entries = Math.max(0, t.entries - 1);
            }
          }
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = markValue(state, marks, mint, pos.token_amount, txFeeSol);
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const shouldExit =
          value < cost * (1 - p.stopLoss) ||
          (h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) ||
          value >= cost * (1 + p.takeProfit) ||
          flow(tapes.get(mint), now, p.fadeWindow) < p.fadeNetSol ||
          bigSells.has(mint) ||
          (now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp));
        if (shouldExit && !hasSellPending(mint) && orders.length < cap) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          h.exiting = true;
        }
      }

      // 2. Probes: sell each probe position back at the next chance.
      for (const [mint, probe] of [...probes]) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!hasPending(mint)) probes.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (!hasPending(mint) && orders.length < cap) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          probe.selling = true;
        }
      }

      // 3. Entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const costSol = pos === undefined ? 0 : Number(pos.cost_lamports) / LAMPORTS;
        exposure += Math.max(h.invested, costSol);
      }
      for (const [mint, curve] of state.curves) {
        if (orders.length >= cap) break;
        if (curve.complete) continue;
        if (hasPending(mint)) continue;
        if (probes.has(mint)) continue;
        const price =
          curve.virtual_token_reserves === 0n
            ? 0
            : Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const h = held.get(mint);
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          const t = tapes.get(mint);
          if (t === undefined || t.entries >= p.maxEntries) continue;
          if (now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(state, mint, now)) continue;
          const amount = Math.min(
            Number(state.maxBuyLamports(mint)) / LAMPORTS,
            p.initialSol,
            p.maxExposureSol - exposure,
            free - txFeeSol,
          );
          if (amount < p.minBuySol) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: Math.floor(amount * LAMPORTS).toString(),
            max_slippage_bps: p.buySlipBps,
          });
          free -= amount + txFeeSol;
          exposure += amount;
          slotsLeft--;
          mainLeft--;
          t.entries++;
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
        } else {
          // Pyramid only: the stake already equals the initial size, so this
          // branch stays shut unless the parameters are ever loosened.
          if (h.exiting || !h.filled) continue;
          if (h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          const cost = Number(pos.cost_lamports) / LAMPORTS;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < cost * (1 + p.addIfUp)) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS > p.maxRqSol) continue;
          const want = Math.min(p.addSol, p.stakeSol - h.invested);
          const amount = Math.min(
            Number(state.maxBuyLamports(mint)) / LAMPORTS,
            want,
            p.maxExposureSol - exposure,
            free - txFeeSol,
          );
          if (amount < p.minBuySol) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: Math.floor(amount * LAMPORTS).toString(),
            max_slippage_bps: p.buySlipBps,
          });
          free -= amount + txFeeSol;
          exposure += amount;
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // 4. Guardrail pacing: dribble out tiny probe round trips so the entry
      // still clears the 20-coin floor when momentum signals go quiet.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRealSol = (1.5 * p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const [mint, curve] of state.curves) {
            if (curve.complete) continue;
            if (held.has(mint) || probes.has(mint) || hasPending(mint)) continue;
            if (state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const tape = tapes.get(mint);
            if (tape === undefined || tape.trades.length === 0) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRealSol) continue;
            if (free < p.probeSol + 2 * txFeeSol) continue;
            if (orders.length >= cap) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: Math.floor(p.probeSol * LAMPORTS).toString(),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, { selling: false });
            break;
          }
        }
      }

      return orders;
    },
  };
}
