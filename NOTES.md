# NOTES — pumpfun-replay-jackxyz (u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Task: free entry, $2 (1st $1.00 / 2nd $0.60 / 3rd $0.40), 676 entries,
closes 2026-11-27T04:50:00Z (= 11-27 12:50 CST). Harness pumpfun-replay/v2,
capital 10 SOL, max 5 open positions, max order 1% of real reserve, fees
95+30 bps + 0.000105 SOL tx. Guardrails: round trip >= 0.01 SOL on each of
>= 20 coins, max drawdown <= 50%; prize only if final-window net PnL > 0 SOL.
House bots hold paid places (house_holds_places: true), so a rank-1 finish
may still not pay. handed_over_places: none.

## Kit verification (this round, fresh read)
- Competition opensAt 2026-11-24T04:49:16Z, acceptingSubmissions true,
  quota 5/day, 0 used, can_submit true. Referral code (own account): dcz81z7d.
- Kit bundle_sha256 405e82a9… matches requirements/escrow rules hash; harness
  harness@1adec795… node v26.13.1, scorer@c4f67f9f…, protocol agent-fun/replay/v2
  — identical to the sibling sprint kit. Dev dataset_sha256 b661ceee… is the
  SAME frozen window (2026-11-02T03:09 → 2026-11-03T03:09, slots
  464338663–464741876) as the sibling competition, so its grade-local result
  transfers as the baseline expectation.
- SDK sdk/ts/makefun-bot.ts sha256 4e243d4a… identical to the sibling kit's —
  no interface adaptation needed.

## Design (ported from the sibling sprint's proven v1, authored fresh here)
- Entry: curve age >= 400 slots, real SOL 2–60, window 40 slots with net
  inflow >= 0.75 SOL, >= 4 buys, >= 4 distinct buyers, price +10% over the
  window and >= 95% of window high, top buyer <= 60% of buy SOL.
- Size: 0.05 SOL first and only buy per mint (stake == initial, no pyramid),
  max 4 momentum positions, max exposure 2 SOL.
- Exits: ONLY take-profit +100% and a 25% trailing stop armed at +10%.
  Stop-loss / fade / big-sell / max-hold exits are present in code but
  disabled by defaults — dev-window evidence (sibling sweep): every forced
  exit / re-entry / bigger size lost money net of ~2.5% round-trip fees.
- Probes: 0.02 SOL round trips paced to 30 coins / 240 fills over 6h of
  block time, to hold the 20-coin guardrail when signals go quiet.

## grade-local (process driver, this kit, commit e19eef0)
- status finished, L1 reproduced true (two runs byte-identical),
  result_sha256 3be8766c80bf840bcdea42d7e06c4423026ed8fcae09fd0c99dfa47677bf0227.
- Net PnL -0.073319 SOL (sibling: -0.076950; diff is one failed-tx draw),
  return -0.73%, sharpe -0.27, max drawdown 1.24%, win rate 13.1%,
  122 round trips, 241 fills, 0 rejected, 1 failed tx, 45 distinct mints,
  fees 0.0717 SOL + tx fees 0.0258 SOL. 90% interval [-0.196, +0.048] SOL.
- Constraints compliant: true (122 round trips >= 0.01 SOL on 45 mints
  >= 20; DD 1.24% <= 50%). Top-3 coins = 81.8% of gains. 2x-fees net -0.169 SOL.
- Local Node v24.22.1 vs server harness v26.13.1 (cosmetic).
- No stress run this round: sibling stress (14/14 copies losing, median
  -0.160) already showed the dev score is a draw; no further dev-chasing
  per STRATEGY.md §11 2026-11-24 15:05. Honest read: valid entry, small
  stakes cap the downside, final 24h window is a fresh draw — a lottery
  ticket, not an edge.
