# NOTES — pumpfun-replay-jackxyz (u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Task: free entry, $2 (1st $1.00 / 2nd $0.60 / 3rd $0.40), 676 entries,
closes 2026-11-27T04:50:00Z (= 11-27 12:50 CST). Harness pumpfun-replay/v2,
capital 10 SOL, max 5 open positions, max order 1% of real reserve, fees
95+30 bps + 0.000105 SOL tx. Guardrails: round trip >= 0.01 SOL on each of
>= 20 coins, max drawdown <= 50%; prize only if final-window net PnL > 0 SOL.
House bots hold paid places (house_holds_places: true), so a rank-1 finish
may still not pay. handed_over_places: none.

## Timeout diagnosis + one-variable fix (2026-11-24 ~18:20 CST, subagent round; NOT submitted this round)

- Rejected submission 01a20c8a-1467-752d-9a56-2f1437c342da @ d8cdcd2ca4f1d7883abf73421ac745f9cca83f2c:
  all intake checks pass; only run_completes fails — "The latest grade run
  on the dev phase ended timeout." retry allowed=true,
  unchanged_will_fail=true (status re-read 2026-11-24 18:18 CST).
- Requirements re-read this round: run_completes limits are wall_budget_sec
  1800, cpus 1, memory_mb 1024, pids 64. Quota re-read: day cap 5, taken 1,
  left 4; hard limit 40, left 39; can_submit true. Deadline unchanged
  2026-11-27T04:50:00Z (= 11-27 12:50 CST).
- Local timing (grade-local --worktree, process driver, this kit, worktree
  files; bot.commit worktree@..., dirty=false): 39.1s / 35.6s / 43.6s /
  37.3s across four runs — each run grades the bot TWICE (L1 reproduce),
  so ~18s per run vs the 1800s wall budget (~46x headroom). Same run pinned
  to ONE cpu (taskset -c 0): 38.9s — CPU count is not a factor.
- Local memory (sampled /proc during a grade-local run): bot process peak
  RSS 170 MB vs the 1024 MB sandbox cap (~6x headroom). The CLI/harness
  process peaks ~1010 MB, but it runs in the grader worker, NOT inside the
  bot's sandbox, so it is not under the 1024 MB cap.
- Workload shape: 128,058 events / 63,370 batches per run (one lockstep
  round trip per slot carrying events), ~1,123 distinct mints; hottest mint
  794 trades inside a 45-slot window.
- Control experiment: sibling entry pump-paper-sprint (u-boothlord-...,
  submission 01a20c47) — same harness, same frozen dataset, near-identical
  bot — grade-local 36.2s locally and SCORED on the server. The code is
  not the differentiator.
- Root cause (judgment): NOT bot compute or memory — local headroom is ~46x
  time / ~6x memory and the sibling proves the same code shape completes
  server grading. Most plausibly a server-side sandbox/queue effect on the
  backed-up grading queue that day (submitted 07:51:43Z; grading backlog
  documented in STRATEGY.md §11 2026-11-24 15:05). Cannot be proven from
  our side — the grader keeps server stdout/stderr. unchanged_will_fail
  means the identical snapshot will not be re-graded, so the resubmission
  MUST differ in at least one graded byte regardless of cause.
- One-variable fix (only change this round): tape pruning in strategy.ts —
  the repeated `t.trades.shift()` loop is now a single `splice(0, cut)`
  (the sibling's exact approach, which completed server grading). Same
  expired prefix removed, so the resulting tape is identical by
  construction; it removes the one concrete inefficiency the rewrite
  introduced (O(prefix x tape) per batch on hot mints). Local effect is
  timing-neutral (37.3s vs ~39s), as expected — this is insurance for a
  throttled sandbox plus the required snapshot change, not a local speedup.
- Verification after the fix (grade-local --worktree, 37.3s): status
  finished, L1 reproduced, action_log_sha256 IDENTICAL
  3be47a333b5c8038a9c7765971d6576f5a2ad22bfc3fa98c80e290f05b97a11b,
  net PnL -0.073319 SOL (-73,319,259 lamports), 122 round trips, 241 fills,
  45 distinct mints, 0 rejected, 1 failed tx, fees 0.0717 + tx 0.0258 SOL,
  concentration unchanged (top-3 81.8%). result_sha256 differs only via the
  snapshot hash (worktree run 7ba6e9cdabace8757fad681878ff7690706eec653e...),
  which is the required snapshot change.
- Resubmission readiness: fix committed locally (see git log; NOT pushed,
  NOT submitted this round). Next round: push, re-bundle (bundle MUST
  include this diagnosis subagent session — it authored the strategy.ts
  fix lines — plus its parent; discovery bundling or explicit --session),
  kit check, submit with --keypair ../makefun-keypair.json, poll to
  checked/scored. Quota is ample (4 today, 39 hard). If the resubmission
  times out again with the identical action log, the cause is confirmed
  server-side and no further code change can address it.


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

## Fresh rewrite, round 2 (this session, commit b6ea09a, HEAD d07d173)
- main.ts + strategy.ts deleted unread and rewritten fresh from the spec
  (own code structure/wording; kit SDK + pilot baseline read only).
  No change to design parameters. This rewrite was ordered because a
  prior attempt graded -0.127 SOL / 30 distinct mints / 1 rejected order;
  the rewrite below reproduces the spec-faithful expectation exactly, so
  no implementation deviation was found to fix.
- grade-local (process driver, this kit, commit b6ea09a — graded the
  COMMITTED head, bot.dirty false, source commit; full JSON at
  ~/workspace/makefun/tmp/jackxyz-gradelocal4.json):
  status finished, L1 reproduced true (two runs byte-identical),
  result_sha256 3305e59bb8e83cc8453b5844437082a1d233175542d75c2ede88dd86601c1687,
  action_log_sha256 3be47a333b5c8038a9c7765971d6576f5a2ad22bfc3fa98c80e290f05b97a11b.
- Net PnL -0.073319 SOL (-73,319,259 lamports; exact match to the
  spec-faithful expectation), return -0.73%, sharpe -0.27, max drawdown
  1.24%, win rate 13.1%, 122 round trips, 241 fills, 0 rejected,
  1 failed tx, 45 distinct mints, fees 0.0717 SOL + tx fees 0.0258 SOL.
  90% interval [-0.196, +0.048] SOL. 2x-fees net -0.169 SOL.
- Constraints compliant: true (122 round trips >= 0.01 SOL on 45 mints
  >= 20; DD 1.24% <= 50%). Top-3 coins = 81.8% of gains.
  Net without top 3 = -0.1488 SOL.
- Second revision (commit d07d173): header comment in strategy.ts now
  records the grade-local result + result_sha256; comment-only, graded
  behavior unchanged. Pushed to origin main.

## Fresh rewrite (this session, commit f70f713)
- main.ts + strategy.ts deleted unread and rewritten fresh from the spec
  (own code structure/wording; kit SDK + pilot baseline read only).
  No change to design parameters.
- grade-local (process driver, this kit, commit f70f713, uncommitted at run
  time — graded worktree files):
  status finished, L1 reproduced true (two runs byte-identical),
  result_sha256 bedb1c1b750d6e6b04c57e20a1a3e2307a3a21e386cc252fbe7b5e43861101b4.
- Net PnL -0.073319 SOL (-73,319,259 lamports; exact match to the prior
  commit's dev-window figure), return -0.73%, sharpe -0.27, max drawdown
  1.24%, win rate 13.1%, 122 round trips, 241 fills, 0 rejected,
  1 failed tx, 45 distinct mints, fees 0.0717 SOL + tx fees 0.0258 SOL.
  90% interval [-0.196, +0.048] SOL. 2x-fees net -0.169 SOL.
- Constraints compliant: true (122 round trips >= 0.01 SOL on 45 mints
  >= 20; DD 1.24% <= 50%). Top-3 coins = 81.8% of gains.
  Net without top 3 = -0.1488 SOL.
- No deviations to fix: first grade-local run matched the expected numbers
  exactly, so no implementation debugging was needed. strategy.ts was
  revised a second time (header comment now records the grade-local
  result + result_sha256) before commit.
- Local Node v24.22.1 vs server harness v26.13.1 (cosmetic mismatch only).

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
