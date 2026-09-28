# Fork integration rehearsal: real relay and keeper processes (2026-10-06)

One-time, user-approved extension of `FORK_REHEARSAL_2026-10-06.md`. The real `backend/src/relay/index.ts` and `backend/src/keeper/index.ts` ran as long-lived processes against a local anvil fork of Monad mainnet, with the real contracts deployed on that fork by the real `Deploy.s.sol` and `ListMarket.s.sol`. Nothing was broadcast to Monad. No file in `contract/` (other than this report) or `backend/` was changed; scripts ran from a byte-identical sandbox copy (`/tmp/fir/contract`, init and runtime bytecode hashes equal to `contract/out` for all five contracts), so no chain-143 `broadcast/` artifact exists in the repo. Harness and logs: `/tmp/fir` (`logs/keeper.log`, `logs/relay.log`, `logs/monitor.jsonl`, `logs/runbook_*.log`).

**Verdict: conditional GO for deploying the backend against the mainnet canary.** Every designed path ran end to end with the real processes: sponsored onboarding over HTTP, operator and owner trades with covers, autonomous fast-path triggers, step walks in the fast lane at 1-block gaps, multi-call fills, a real `observe() == true` followed by the early finalize, two covers in one gap, governor and touch admission, phantom-top handling, graceful and SIGKILL restarts. No funds were at risk at any point and every vault invariant held. Two **Medium liveness bugs** were found in `backend/src` (F-1, F-2, not fixed, flagged below). They need a human decision before the real deploy: fix both (both are small, in hot paths), or deploy the canary with the mitigations in sections 7 and 10.

## 1. Setup

| Item | Value |
|:-|:-|
| Toolchain | forge, anvil 1.8.3 (cae51ad), solc 0.8.37, bun 1.3.1 |
| Fork | anvil, flag:fork-url `https://rpc-mainnet.monadinfra.com`, flag:fork-block-number head minus 60, flag:chain-id 143, flag:network monad, flag:auto-impersonate, flag:no-mining. Final run forked block 111,065,429. rpc3 was too slow (1.4 s per state read against 0.16 s) and stalled anvil |
| Mirror check | Perpl `getPerpetualInfo(1)` returns live-shaped data (pd 1, ld 5, status 4, mark and oracle fresh). The fork followed mainnet prices through the mirror below. Fork gas matched the first rehearsal to the unit (Deploy receipts 70,237 / 3,580,792 / 10,543,573 / 4,620,483 / ... / 656,143) |
| Block producer | `producer.ts`: one block per 300 ms. Timestamp is wall clock minus a fixed lag (6 s in the final configuration), so blocks share seconds like Monad. Base fee is pinned at 100 gwei every block. With this, anvil billed **gas limit x 102 gwei**, which is Monad billing. The relay balance moved by exactly the governor's settled figure (1.3 to 0.430658 MON) |
| Price mirror (fork-only lever) | `mirror.ts` reads mainnet only and replays BTC (perp 1) ops of the real Perpl price-admin `execPerpOps` txs. Marks, signed Data Streams reports and every Chainlink BTC/USD transmit are replayed from their real senders, each once the fork clock reaches its mainnet timestamp. A control file can drop BTC mark ops, BTC oracle ops or feed transmits (gap emulation); dropped reports are kept for later injection. 0 replay failures |
| RPC proxies (harness) | Port 8549 for tools and 8550 for the keeper. The keeper proxy (`proxy_keeper.json`) can add per-call delay and a lagging read node of N blocks: `latest` is rewritten, newer blocks answer "header not found", receipts above the lagged head are hidden. Sends always pass through. The proxies also serve `anvil_nodeInfo` from a cache, because anvil 1.8.3 **deadlocked** three times when cast or forge network detection raced the producer's `evm_mine` |
| monadNewHeads emulation (harness) | `headproxy.ts` republishes anvil `newHeads` as Proposed, Voted and Finalized (Finalized 2 blocks behind), the measured mainnet shape. Used for the last two rounds |
| Mainnet guard (harness) | A Bun preload blocks every host except 127.0.0.1 and `app.perpl.xyz`. `chain.ts` always appends `https://rpc3.monad.xyz` as the last fallback. The guard blocked it 20 times: 6 at boot, **14 at runtime**. Runtime hits came from reads or sync sends that timed out on slow fork blocks, plus 2 on a "header not found" from the lagging proxy. Without the guard the fork run would have sent requests, possibly signed sends, to real Monad. Any future fork run must keep this guard |
| Wallets | Throwaway fork-only keys (keccak of `gapless-fir-2026-10-06:<role>`), all empty on mainnet. MON via `anvil_setBalance` at RUNBOOK amounts (deployer 2.4, keeper 5.1, relay 1.3, LP 0.1). AUSD by impersonated `transfer` from the real holder EOA `0x8538...2e14e` (and contract `0x188d...ea8e` for whales) |

**Deploy and listing (real scripts).** `Deploy.s.sol` (RUNBOOK section 6 flags, flag:unlocked style private key for the throwaway deployer): simulation `_check` passed, 11 txs all status 1, same gas per tx as the first rehearsal. Addresses: vault `0x1238bB14D5A8C64C7BFD02ec386392De939B7A62`, manager `0x07FE18D3aE78d7E92491d7a303508ABc56b3dB83`, factory `0xcCA516B2cCf05f1aa7676Dcb0763896086576c7F`, sink `0x34309bDD6464daec6e261caC1643a0F407C1867d`, deploy block 111,065,472 (CREATE addresses are fixed by the deployer key, so they were identical on every fork attempt). `ListMarket.s.sol` run, postSigma and seed (three keys): read-back `listedPerps [1]`, config `(true,1,5,1,feed,8,0x0)`, `{marketCap 10000, maxMatchesClose 8, maxDuration 48000, sigmaMaxAge 6000, minFee 20000, maxNotional 20000000}`, sigma 27, TA 4,000,000, LP without RISK_ADMIN. Deployer left 0.268 MON.

**Backend env.** Relay: `NODE_ENV=production`, `SPONSOR_ENABLED=true`, `SPONSOR_ALLOWLIST_ONLY=true`, `SPONSOR_DEMO_OWNER=ownerA`, `SPONSOR_OWNER_ALLOWLIST=ownerB,ownerC`, `DRIP_ALLOWLIST=opA`, canary grant and spend caps, `KEEPER_INTERNAL_URL`, fresh `RELAY_INTERNAL_TOKEN`, real `PERPL_WS_URL`/`PERPL_API_URL`. Keeper: canary caps (4.6 / 2.65 / 2.0 MON), `KEEPER_HEADS=newHeads` against anvil (the last two rounds used `monadNewHeads` through the head proxy, see section 6), `LOG_LEVEL=debug`.

**Live Perpl WS against fork state.** The relay fed real mainnet market data. The keeper used it only to gate sigma posts, as designed. It produced `sigma.skip_mark_mismatch` (feed 863,400 against fork chain mark 853,200) after a synthetic crash and posted nothing on mismatched data. Arm, trigger, observe and finalize decisions came only from fork chain reads. **No wrong action came from the live feed.** The relay's `feedLagBlocks` was negative (Perpl ahead of the fork), so the market data stayed healthy.

## 2. Test A: onboarding through the real relay HTTP API

| Call | Result |
|:-|:-|
| `POST /sponsor/create` before funding | 409 `NOT_FUNDED` (fund-first rule) |
| 10 AUSD to `accountOf(ownerA)`, then `/sponsor/create` | 200 `created`, `createAccountFor` 194,048 gas (limit 900K) |
| `POST /activate` | 200 in 6.0 s: sweep opened Perpl account 5413 (288,538 gas), 0.5 MON drip to opA, wait for receipt plus 3 blocks |
| Repeat `/sponsor/create` | 200 in 3 ms, stored result, nothing sent |
| ownerB (allowlisted) create and activate | 200, Perpl 5414, `dripSkipped: not_allowlisted` |
| ownerC create (earlier fork attempt, same relay config) | 503 `BUDGET_EXHAUSTED` (see F-6) |
| `/sigma-refresh` with a foreign Origin, a second call within 60 s | 403 `FORBIDDEN_ORIGIN`, 429 `RATE_LIMITED` |

```
{"msg":"send.confirmed","label":"createAccountFor","block":"111065659","gasLimit":"900000","gasUsed":"194048"}
{"msg":"send.confirmed","label":"sweep","block":"111065662","gasLimit":"900000","gasUsed":"288538"}
{"msg":"send.confirmed","label":"drip","block":"111065666","gasLimit":"21000","gasUsed":"21000"}
```

## 3. Test B: trade and cover

Operator `tradeAndCover` (opA, 22 lots, 3x, stop 50 bps under the least favorable of mark, oracle and book top, maxGap 200, 12,000 blocks): status 1, 1,203,925 gas. Cover live with Cap 377,293, escrow 9,878, rent 20,000, `reservedTotal` = Cap. Over the run, 9 covers were bought: operator path 4, owner `trade` + `buyCover` path 5. `quote()` reverts `LotsExceedPosition` before the position exists, so the PWA cannot quote a `tradeAndCover` up front (it must pass a `maxPremiumCNS` bound).

## 4. Test C: autonomous detection, walk and close (core test)

Gap emulation: stop the feed mirror, then at the next oracle report stop BTC oracle and mark replays. Crash the mark through the stop with the real Perpl price admin, re-post it at oracle age 55 s, and let the oracle and feed lapse so the reference becomes mark-only. A whale sweep removes bids down to 848,000, so the book under the stop is empty above the step-5 floor. Until liquidity appeared the keeper only simulated: `keeper.zero_paid_skip why=no_fill`, nothing sent. 11 makers (2 lots each, 853,700 to 853,600, inside the step-3 band) were then placed. The keeper reacted on its own:

```
14:58:56.913 keeper.trigger_step step 0 limitPNS 856571 gas 1100000
14:58:59.887 send.confirmed trigger_zero block 111066727 gasUsed 327998
14:58:59.896 keeper.trigger_step step 1 limitPNS 856143
14:59:00.066 send.confirmed trigger_zero block 111066728 gasUsed 328755
14:59:00.067 keeper.chain_gap gapBlocks 1 path lane
14:59:00.349 send.confirmed trigger_zero block 111066729   chain_gap 1 lane
14:59:02.363 send.pending trigger (paying close, step 3; sync send timed out on a slow fork block, landed 111066730: 16 lots)
14:59:03.926 send.confirmed trigger block 111066733 gasUsed 1056517   chain_gap 3 cycle (remainder, 6 lots)
14:59:15.512 send.confirmed finalize block 111066772 (window end 111066770)
```

Payout = min(G_real 84,341, G_ref + A x SN = (857,485 - 857,000) x 22 + 9,432 = 20,102, Cap 377,293) = **20,102** = `paidCNS`. TA 4,000,000 - 20,102 + 29,878 - 2,987 (treasury) = 4,006,789 exact, reserved 0, manager 0 AUSD. The first fill at 8 makers used **1,774,107** gas (first rehearsal 1,728,490, +2.6%; 1.15x = 2.04M, still under `GAS.trigger` 2.2M). The only non-lane gap came from the 2 s sync-send timeout on a slow fork block. The pending path then worked as designed: blocked, resolved, no double send.

## 5. Test D: `observe()` true and finalize after observe

The first two attempts missed the 40-block window. In the first, the walk landed later than planned because a maker block took 11 s to mine on the fork. In the second, a harness bug paused block production with an injected tx pending: the keeper's observe simulated true at head 430 (ts 1250), landed in block 431 after a 125 s stall when the feed was 1 s past its 120 s max age, and returned false. That second case is correct keeper behavior. The third attempt slowed blocks to 1 s for the window (fork-only lever, 40 blocks = 40 s). A real held Data Streams report (origTs 1791299679, 865,816) was injected when it fell due, and the keeper took the rest:

```
15:14:08.031 send.confirmed trigger block 111069299 gasUsed 798076   (triggerTs 1791299642)
             report injected at fork ts 1791299679, block 111069336
15:14:47.023 send.confirmed observe  block 111069338 gasUsed 163989  -> observed true, refPostPNS 865816
15:14:48.024 send.confirmed finalize block 111069339 gasUsed 223128  -> windowEnd = 111069339: allowed only via observed && filled == lots
```

This is the real `finalize`-after-observe path (`gPost` computed, 0 because the post reference was above the stop; paid 7,918 = G_real). F6 of the first rehearsal is closed.

## 6. Test E: failure injection

**E3, two covers in one window (SE3-M2).**
- Step-0 fills (covers A2 and B1): both triggered in consecutive blocks (111068396, 111068397), each paid 7,918.
- Two walks (covers A3 and B3, 16 makers in the step-3 band): A3 walked steps 0, 1, 2 then filled 16 + 6 lots, all lane gaps 1. B3 was offered to the lane after A3's first step and refused: `keeper.touch_budget touchWei 2464000000000000000 running 1`. The day's governor spend (3.2 of 4.6 MON after five closes) could not hold both walks' remaining steps and fills. B3 started the moment A3's walk ended (5 blocks after A3's first attempt) and walked 0, 1, 2 then closed, gaps 1, lane. Both paid G_ref + A x SN = 13,614. Admission behaved as designed. The interleaving case (both walks admitted) could not be shown inside the canary budget.

**E2, lagging read node (SE3-M1).** With a 1-block lag plus 60 ms per call and `newHeads`, the lane read at the receipt block worked (proxy counted 0 "header not found"). Every receipt, however, was declared vanished and the nonce lowered: **bug F-1**. Under `monadNewHeads` (Finalized 2 behind) with a 1-block lag, the round of covers A5 and B4 sent 2 triggers and 2 finalizes with no `receipt_vanished` and no resync.

**E1, restarts.**
- Graceful SIGTERM (keeper2.env): shutdown to `keeper.started` in 0.37 s, lease released, heads resubscribed.
- SIGKILL: `signer.lease_wait` from 15:47:15.3 to 15:47:41.4, so 26.7 s of downtime (lease TTL). Nonce, governor and queue seeding were correct. During the wait, keeper `/healthz` and `/console` were unreachable and the relay proxy answered 503 `KEEPER_UNAVAILABLE`.
- 26.7 s is about 89 blocks, so a walk always restarts at step 0 (C7: gap over 10) and a 40-block remainder window always expires.
- After the graceful restart, cover B4's next attempt was planned from chain state as a new touch (correct). It logged a false `keeper.chain_gap_high` of 2239 blocks (F-3).
- A live SIGKILL in the middle of a walk could not be completed. Fork Perpl started rejecting every position-opening order (P-1), so no new cover could be opened after 15:36. The governor had also already stopped further walks that day (`trigger_zero` sub-cap).
- Restarts lose in-memory state: phantom set, touch counter, walk reservations, console ring (F-7).

**Phantom top on real Perpl code (SE2-L4).** On cover B4, the book showed 11 bids at and above the step-0 limit. The keeper sent a paying close at 2.2M; it landed `TriggerNoFill` (1,419,984 gas used). Perpl cancelled every matched maker order with code 14 (event `0x1c304023`, `(perp, makerAcct, orderId, 0, price 853100, lots 2, 0, 14, 0, taker 5414, ...)`). The keeper logged `keeper.phantom_top` and `keeper.noop_receipt`, backed off, and retried at the step limit; the governor then stopped it (`spend.cap_reached`). **Book-top levels can be unfillable at match time on mainnet Perpl.** The handling worked; the wasted call cost one `GAS.trigger`.

## 7. Bugs found (flagged, not fixed)

**F-1 (Medium, liveness): a receipt not yet visible on a lagging read node is treated as vanished, and the nonce is lowered.** `backend/src/lib/sendQueue.ts`, `reconcile()` (the `send.receipt_vanished` branch sets `needsResync = 'exact'`) and `resync(..., 'exact')`.
- On a Finalized head at or past the inclusion block, `getTransactionReceipt` from a read node that has not imported the block returns null. The send is logged as an abandoned proposal (error level).
- The exact resync then sets the local nonce from that node's stale `max(latest, pending)`. The next send reuses a spent nonce and is rejected `nonce too low`. The lane attempt is lost and falls back to the next head.
- If the raw tx reaches a lagging node that accepts it, the queue goes `pending` for up to 10 blocks.
- Reproduced with the real keeper (cover A4, 1-block lag, plain `newHeads`, so Finalized equals the head):

```
15:24:47.669 send.confirmed trigger block 111071246 nonce 26
15:24:47.742 send.receipt_vanished trigger nonce 26
15:24:47.805 send.nonce_resync after_drop exact local 27 chain 26
15:24:48.276 send.rejected trigger nonce 26 err "nonce too low"     (remainder lost from the lane)
15:24:48.614 send.confirmed trigger block 111071249 nonce 27   keeper.chain_gap 3 cycle
15:24:48.678 send.receipt_vanished trigger nonce 27 ... (every send repeats it)
```

- **Production exposure:** with `monadNewHeads`, Finalized trails Proposed by about 2 blocks. The defect needs a read node 3 or more blocks behind the WS head stream (load-balanced RPCs; the SE3-M1 premise). It did not fire at a 1-block lag under the `monadNewHeads` emulation (4 sends, 0 vanished).
- **Suggested fix:** do not lower on a missing receipt alone. Keep the send tracked for a few more Finalized heads, and declare it vanished only when the receipt stays missing **and** the node's finalized nonce is at or below the send's nonce. Otherwise resync `raise`.

**F-2 (Medium, liveness): the first sigma refresh blocks the keeper head loop for the whole mark-history fetch.** `backend/src/keeper/keeper.ts`, `maybeSigma()`: `await this.o.marks.catchUp(finalized)` runs inside `cycle()`. On the first post after a boot, `MarkHistory.catchUp` (`keeper/sigma.ts`) fetches 48,000 blocks of `MarkUpdated` logs serially.
- Measured: `/sigma-refresh` at 15:31:35. `lastCycle` stayed at head 111072558 until **15:32:59, so 84 s with no cycle** (about 280 blocks). Meanwhile the keeper `/healthz` reported `ok` and heads arrived normally.
- The fork number is inflated: chunk 100 in this env, and anvil proxies historical `eth_getLogs` to monadinfra with rate limiting. With the default chunk 1000 and a private RPC it is about 48 sequential calls, several seconds (estimate, not measured on mainnet).
- Any trigger, step (10-block chain rule) or observe (40-block window) that falls in that stall waits.
- **Suggested fix:** run catch-up in the background and post only once it has completed. Add a cycle-progress check to `/healthz`.
- **Mitigation without a code change:** after every keeper start, send one `/sigma-refresh` while no cover is live, and do not restart the keeper while a cover is live.

**F-3 (Low, observability):** `keeper.ts` `cycle()` calls `logGap` with `out.blockNumber - max(shortBlock, triggerBlock)` even when the stored `shortBlock` belongs to a dead touch. This produced `keeper.chain_gap_high gapBlocks 2239` (an error-level alert) on a fresh touch. `/console` then showed `walks.chainGapP50 = chainGapMax = 2239, laneShare 0`. Skip the sample when the gap exceeds `STEP_MAX_GAP_BLOCKS` on a non-Triggered cover.

**F-4 (Low, ops):** when Perpl itself rejects the close, the keeper logs `keeper.trigger_gas_ceiling` and `keeper.trigger_undecoded_revert` (error). Observed with selector `0x7d19aaec` at the 2 s edge where the Gapless fast path (`REF_TS_TOLERANCE_SEC` 2) still holds but Perpl's own 60 s mark age has lapsed. RUNBOOK 11.4 rule 6 tells the operator to raise gas on that log. Decode Perpl errors, or check the trace first.

**F-5 (Info):** `sigma.skip_mark_mismatch` (121 lines) and `keeper.touch_budget` (173 lines) log at warn on every head while the condition holds.

**F-6 (Info, config):** relay `GAS.createAccountFor` and `GAS.sweep` are 900K against measured 194,048 and 288,538. Monad bills the limit, so each costs 0.0918 MON. Under the 1 MON relay cap, the demo owner (0.686 with the drip) plus one more owner fit per UTC day; the third gets `BUDGET_EXHAUSTED`. 1.3x measured would be 260K and 380K.

**F-7 (Info):** restart loses the phantom set (one more full-gas close against a known phantom top), `touches` (the 2-starts-per-day cap resets per process), walk reservations, gap samples and the console `recent` ring.

**F-8 (Info):** viem `fallback` treats a JSON-RPC "header not found" and slow responses as retryable. Lane reads and timed-out sends therefore fail over to the public RPC. This is intended in production, but it means a slow private node quietly moves hot-path reads to a 1 s public endpoint.

## 8. Test F: health and console accuracy

683 monitor samples every 5 s (`logs/monitor.jsonl`):
- Relay `/healthz`: 648 x 200, 35 x 503. The 503s were all accurate: a Perpl WS reconnect, and a 2-minute chain stall I caused (`headAgeS` 66 to 126).
- Keeper `/healthz`: 626 ok, 51 degraded, 6 unreachable, all accurate: `heads_unsubscribed`/`head_stale` during the stall, `low_balance` at 1.94 MON after 7 closes, `spend_threshold`, unreachable during the SIGKILL lease wait.
- `/console` and `/api/keeper/console` tracked live covers, governor spend and exempt spend correctly.
- Exceptions: F-3 polluted the walk stats, and `/healthz` stayed ok through the F-2 stall.
- The relay head-age check is within 30 s only because the fork lag was cut to 6 s. At the initial 28 s lag it flapped.

## 9. Perpl and fork observations (not backend bugs)

- **P-1.** After about 50 minutes of synthetic crashes, fork Perpl rejected position-opening orders with `TakerOrderSettlementFailed(perp, acct, price, price, price, lots, 0, 14)` and cancelled matched maker orders with the same code. Closes still worked. Fresh asks near the last trade price did fill. This points to a Perpl settlement or price-band guard, probably reacting to fork-local state. It ended new cover purchases, and with them a live mid-walk SIGKILL.
- **Gas** (fork, per call): step no-fill 327,998 to 328,755; 1-maker fill 738,554 to 798,076; 3-maker remainder 974,435 to 1,056,517; 8-maker fill 1,683,265 and 1,774,107; observe 158,341 to 163,989; finalize 222,179 to 239,179; postSigma 51,438; owner `trade` 327,551; `buyCover` 770,586 to 841,102.
- **Synthetic crash marks pollute the onchain `MarkUpdated` series.** The keeper's sigma estimate went to 423 and `minDistanceBps` to 177. Sigma was reset to 27 with a fork-only admin grant of SIGMA_ROLE to the deployer.
- **End state:** 9 covers, all Finalized with 22/22 filled. TA = vault AUSD = 3,995,165; reserved 0; manager 0; `refundOwedTotal` 0; `liveCount` 0; treasury 27,526. Payouts matched `min(G_real, G_ref + A x SN, Cap)` on every cover: 20,102; 7,918 x3; 13,614 x2; 8,577; 162,304; 10,645.
- **Deviation from canary config.** The last two rounds ran with cap 9.2 and zero-paid 2.8 MON, after the canary 4.6 MON day was exhausted by 7 closes (3.5x design). They also used `monadNewHeads` through the head proxy.

## 10. Before the real deploy

1. Decide on F-1 and F-2: fix now (recommended, both small), or deploy with the mitigations. Mitigations: a single private keeper RPC node (no load balancer), alerting on `send.receipt_vanished`, a warm-up `/sigma-refresh` after every keeper start while no cover is live.
2. F-4: amend RUNBOOK 11.4 rule 6 to check the trace before raising gas.
3. F-6: consider 260K and 380K relay limits if more than two sponsored owners per day are expected.
4. Fork harness: keep the mainnet guard, the cached `anvil_nodeInfo` proxy and the monadinfra fork URL for any future run.

## 11. Fix round (2026-10-06)

F-1 to F-4 and F-6 are fixed in `backend/` (and RUNBOOK for F-4); F-5 and F-7 stay open (Info). Each test reproduces the fork condition on the fake chain and fails on the pre-fix code. Suite 578 to 585, typecheck clean.

- **F-1 fixed**: `sendQueue.ts reconcile()` lowers the nonce only after the finalized nonce stays at or below the send's for 10 blocks past inclusion. Test: `test/sendQueue.test.ts` "F-1: a receipt hidden by a lagging read node keeps the nonce, and the next send lands (was: nonce too low)" (plus "F-1: a missing receipt whose nonce a finalized tx already used ...").
- **F-2 fixed**: `keeper.ts maybeSigma()` no longer awaits the mark history; the fetch runs in the background and sigma decides once it is within 100 blocks of Finalized. Test: `test/keeper.test.ts` "F-2: ... a pending trigger goes while the first 48,000-block mark fetch is still running".
- **F-3 fixed**: gap samples only for a Triggered cover or a chain still alive when the attempt was planned (cycle path and lane entries). Test: `test/keeper.test.ts` "F-3: ... first attempt on a fresh touch (cycle path)" and "a dead-chain cover joining the fast lane ...".
- **F-4 fixed (docs)**: RUNBOOK 11.4 rule 6 separates gas from Perpl rejections (`0x7d19aaec` = `MarkPriceAgeExceedsMax`) and traces before raising gas.
- **F-6 fixed**: `GAS.createAccountFor` 223,156 and `GAS.sweep` 331,819 (1.15 x measured). Test: `test/sponsor.test.ts` "F-6: ... the 1 MON relay day covers the demo owner with its drip plus 7 more owners at 100 gwei, 6 at 110".

## 12. Fix round 2 (2026-10-06): F-5 and F-7

F-5 and F-7 are closed in `backend/`. With them, every finding in section 7 is closed. Each test reproduces the condition on the fake chain with a manual clock, and fails on the pre-fix `keeper.ts` (each fix was reverted alone to check). Suite 585 to 589, typecheck clean.

- **F-5 closed**: `src/lib/conditionLog.ts`. While the condition holds, the keeper logs at warn when it starts (`state: 'start'`) and again every 10 min (`state: 'persists'`, with `heldMs` and `suppressed`). The heads in between log at debug under the same name. When it clears, `<event>_resolved` logs at info. 10 min matches `keeper.low_balance`. Used by `sigma.skip_mark_mismatch` (per perp) and `keeper.touch_budget` (per cover). Tests: `test/keeper.test.ts` "F-5: ... sigma.skip_mark_mismatch: warn when it starts, again after 10 min, info when it clears" and "keeper.touch_budget: warn when a walk is refused, again after 10 min, info once admitted". In both, 700 heads at 1 s give 2 warn lines (the pre-fix code gave 699 and 700) and one info `_resolved`.
- **F-7 closed**, item by item:
  - `touches` (2 walk starts per cover per UTC day): **persisted**. Keeper migration 3 adds `keeper_touches`. It is a cost cap, and each restart used to grant two more starts. Test: "F-7: ... two walk starts, then a restart: the third start is still refused that UTC day". The next UTC day starts fresh.
  - Walk reservations: **re-derived from chain state, not stored**. Before this round, a walk running across a restart continued with no reservation, so a second walk could be admitted into its budget. A continuation with no reservation now reserves the rest of its walk from `getCover`. A SIGKILL restart (30 s lease, about 89 blocks) outlives every chain anyway. Test: "F-7: ... a walk running across a restart reserves the rest of its walk from chain state".
  - Phantom set: **memory only, accepted**. After a restart, each phantom cover can cost at most one more 2.2M-gas close, and that close still counts against the persisted per-cover and `trigger_zero` caps.
  - Gap samples and the console `recent` ring: **memory only, accepted**. They are observability only and nothing reads them to decide. The restart test asserts the gap samples start empty.
  - Also memory only, same bound: `restartMiss`, receipt backoff and `stepGasLow`. Each costs at most one extra attempt or one simulation after a restart.
