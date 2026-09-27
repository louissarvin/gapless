# SA4: delta audit after C6 and C7

Date 2026-10-06. Target: Monad mainnet (chain 143), real AUSD, Perpl Exchange 1.7.5 (implementation `0xa9ab97a4...`). Last contract gate before the single canary deploy.
Auditor: solidity-auditor (SA4). `src/` unmodified. New PoCs: `test/audit/SA4Audit.t.sol` (9 tests, real stack: GaplessAccount, GaplessFactory, CoverVault, CoverManager over the C0 mocks).

## 1. Scope and method

| Item | Value |
|:-|:-|
| In scope | Everything since SA3: C6 (arm at or after expiry, fast-path `TooEarly`, SA3-02 `_bookThin`, `floorSlack >= 2A`, operator checkpointing, ListMarket `_envUint`), C7 (`STEP_MAX_GAP_BLOCKS` 10 from the most recent attempt, `_hold` / `_advance` / `_heldBlock`, same-block retry, `Deploy._check` additions, named-constant refactor, NatSpec), and the keeper's use of these rules (`backend/src/keeper`, read only) |
| Docs read | `audit/SA3_REPORT.md`, `docs/C5_FIXES.md` (C6, C7), `test/audit/C7Audit.t.sol`, `INTERFACES.md` section 4, `audit/CODE_REVIEW.md`, `memory/security_audit_backend_se2_2026-10-06.md`, `RUNBOOK.md` section 11, `docs/CANARY_PARAMS.md` |
| Tests | `forge test`: **494 passed, 0 failed** before SA4; SA4 adds 9 (all pass). Deep invariant chunk `GaplessInvariantTest`, 32 runs x 500, fresh seed `0x53413401`: pass |
| Mainnet evidence (read only, rpc.monad.xyz, blocks 110,827,300 to 110,830,325) | `eth_getLogs` for Perpl `MakerOrderFilledV2` and `ImmediateOrCancelExecuted`; `debug_traceTransaction` (callTracer) for the true gas of the Perpl implementation frame. No transaction, no fork |

Run: `forge test` with flag:match-contract `SA4AuditTest` and `-vv` for the logged numbers.

## 2. Summary

| ID | Severity | Title |
|:-|:-|:-|
| SA4-01 | **High (operational: keeper and params; contracts unaffected)** | The 1.5M trigger budget does not hold on Perpl: about 8 maker fills already exceed it, a 16-match close needs about 2.4M, and the keeper then never sends |
| SA4-02 | Low (runbook) | RUNBOOK section 11 cannot calibrate gas: Monad receipts report `gasUsed == gasLimit`, and the per-match slope it assumes (50K) is half the mainnet one |
| SA4-03 | Low (keeper) | A step sent at `GAS.triggerStep` (700K) that meets a new bid at landing needs about 0.8M to 0.85M and reverts; the revert also backs off zero-paid retries for 8 blocks |
| SA4-I1 | Info | `_heldBlock` and the hold rules are sound: no stale read, one step per block in every order, no underflow |
| SA4-I2 | Info | Chain carry-over across a recovery is the disclosed 10 blocks; in practice nobody ends it on an Armed cover either, because the keeper skips disarm-only sends (SE1 H-1) |
| SA4-I3 | Info | Holds let thin attempts of one long touch be any distance apart (attempts every 10 blocks or less); `INTERFACES` says "each within 10 blocks of the previous one". No faster widening |
| SA4-I4 | Info | NatSpec and comments: `MAX_MATCHES_CLOSE` comment "trigger gas stays under 1.5M" is false on mainnet; C7's "new worst trigger 1,484,336" is a stub-stack, same-maker figure |

No Critical, High or Medium in the contracts. The C6 and C7 code changes are correct. SA4-01 is the one item that gates selling the first cover.

## 3. Findings

### SA4-01 High (operational): trigger gas on Perpl exceeds the keeper's fixed 1.5M at about 8 maker fills

**Location**: `backend/src/lib/gas.ts:13` (`trigger: 1_500_000n`), `backend/src/keeper/keeper.ts:856` (a non-custom simulation revert is only logged), `src/Constants.sol:203` (`MAX_MATCHES_CLOSE = 16; // C4: trigger gas stays under 1.5M`), `CoverManager._closeCall` (`p.maxMatchesClose`, read live).

**Root cause**: every gas figure behind the 1.5M budget comes from the mocks, with stubs for the account and vault and with every matched order owned by one maker account. Real books match orders from different accounts, and each new maker costs cold storage on Monad (8,100 per cold page, 10,100 per cold account). That cost is much larger than the mock's.

**Evidence, mainnet Perpl 1.7.5** (inner `DELEGATECALL` frame `gasUsed`; the receipt and the top frame only show the limit, see SA4-02):

| Tx | Order | Fills / distinct makers | Perpl gas |
|:-|:-|:-|:-|
| `0xcf3345e2...` | IOC, no fill | 0 / 0 | 83,521 |
| `0xe465892d...` | IOC | 1 / 1 | 266,309 |
| `0x24a69be3...` | BTC **CloseLong IOC, maxMatches 15**, 1,226 lots (the Gapless close shape) | 9 / 9 | 1,173,276 |
| `0xbc02be6e...` | IOC | 9 / 6 | 1,162,740 |
| `0xd450faf0...` | IOC | 11 / 10 | 1,322,009 |
| `0x8201a392...` | IOC | 24 / 14 | 2,520,838 |

So Perpl costs about 266K for the first fill plus about 105K to 110K for each further fill.

**Evidence, real stack on the mocks** (`SA4Audit.t.sol`; each top-level call starts cold under this config, as `test_SA4_probe_eachTopLevelCallStartsCold` shows):

| Path | Tx gas |
|:-|:-|
| C7 worst case (16-match hold on a running chain, first fill), real account and vault instead of stubs | **1,539,268** (CoverManagerGas reports 1,484,336 on stubs, without intrinsic gas) |
| Same hold, 16 one-lot bids from 16 distinct accounts | **2,996,793** |
| Full fill, distinct makers, `maxMatchesClose` 16 / 12 / 8 | 2,924,132 / 2,327,910 / 1,744,776 |
| Full fill, 16 matches from one maker account | 1,456,607 |

In the trace, the manager side outside `execOrder` is about 775K. About 195K of that is the mock's O(n) `getPerpetualInfo` scan (225,786 cold), which Perpl does in O(1), so about 580K remains. **Mainnet estimate**: 580K + 266K + 105K x (fills - 1), which is about 0.85M at 1 fill, about 1.48M at 7, about 1.58M at 8, and about 2.4M at 16.

**Attack path / failure mode**:
1. A touch happens, and the closing side's top holds 8 or more orders from different accounts. This is a normal fragmented book in a gap. A third party can also force it with 8 one-lot bids from 8 Perpl accounts (80 AUSD of minimum deposits, recoverable).
2. The keeper simulates `trigger` at `GAS.trigger` 1.5M, runs out of gas, and logs `keeper.trigger_undecoded_revert`. Nothing is sent, and no path retries at a higher limit.
3. As long as the shape persists, the keeper never closes the cover. The contract would close it for anyone who sends more gas (`trigger` is permissionless), but no one does. The trader is left exposed below the stop. An Armed cover's escrow is forfeited at expiry.
4. If the shape appears between simulation and landing, the landed send runs out of gas and the 1.5M limit is billed (0.153 MON at 102 gwei).

**Impact**: the product's guarantee (close at or near the stop) fails for exactly the books gaps produce. No funds are stolen. The vault is unaffected (no close means no payout). The canary demo cover (22 lots) usually matches 1 to 3 orders and would fit, so this is not certain to show up on the demo. That is why it must be fixed before the first sale rather than discovered on it.

**Recommended mitigation** (no contract change; `maxMatchesClose` is read live and is RISK_ADMIN-settable after deploy):
```ts
// backend/src/lib/gas.ts: size from Perpl's measured slope, not the mock (SA4-01).
// O 650K manager side (RUNBOOK upper bound), Perpl 266K first fill + 115K per further fill, x1.15.
trigger: 2_100_000n,      // with maxMatchesClose 8: 1.15 x (650K + 266K + 7 x 115K) = 1.98M
triggerStep: 1_100_000n,  // SA4-03: 1.15 x (650K + 266K), so a step that meets one bid still lands
```
```ts
// keeper.ts: a non-custom simulation revert at GAS.trigger is retried once at a ceiling before giving up.
if (out.reason === 'simulation_reverted' && !CUSTOM_ERROR.test(out.detail ?? '')) {
  return this.o.queue.send({ ...req, gas: GAS.triggerCeiling /* 3_500_000n */ });
}
```
And `setMarketParams(BTC, p with maxMatchesClose = 8)` before the first cover (or list with 8). At 22 lots that is at most 3 fill calls, each landing within the 10-block gap, which C7 and the fast lane already handle. If 16 is kept, `GAS.trigger` must be at least 3.1M (1.15 x (650K + 266K + 15 x 115K); 0.32 MON per trigger at 102 gwei). Update `KEEPER_HOTPATH_RESERVE_WEI` per RUNBOOK 11.3.

**References**: SWC-128 (DoS with block gas limit, here the sender's gas limit); Monad docs, opcode pricing (cold account 10,100, cold storage 8,100 per page) and gas charged on the limit; SA2 condition 4 and SA3 condition 3, which this measurement now answers.

### SA4-02 Low (runbook): the gas calibration loop reads a number Monad does not report

**Location**: `RUNBOOK.md:249-253` (rules 1 and 2), line 241 (`cast receipt <trigger tx> gasUsed`).

- All 12 sampled Perpl receipts and their callTracer top frames show `gasUsed == gasLimit`. Rule 2 (`GAS.trigger = ceil50k(1.3 x worst)` with worst taken from receipts) therefore learns only its own limit and grows it by 30% per paying trigger.
- Rule 1 calibrates from `C_fill`, which is the current book's top, usually 1 or 2 fills for 22 lots, so it never sees the 16-match case. Rule 2 extrapolates at "50,000 per match, the mock's slope", while mainnet is about 110K.
- True consumption is visible read-only: `debug_traceTransaction <tx> {"tracer":"callTracer"}` on rpc.monad.xyz, using the inner frames' `gasUsed`. For a `trigger` tx the manager is the top frame, so take `CoverManager -> account.closeForCover` and the vault and account frames, or `cast estimate` the same call at the same head.

**Fix**: replace rules 1 and 2 with the SA4-01 formula (`O + 266K + 115K x (maxMatchesClose - 1)`, x1.15) and use traces or estimates, never receipts.

### SA4-03 Low (keeper): a 700K step that fills at landing reverts

**Location**: `backend/src/lib/gas.ts:16` (`triggerStep: 700_000n`), `keeper.ts:526` (any reverted trigger bumps the backoff).

A step is sent because the mirror expects no fill at its limit. If any bid at or above that limit appears between the head read and landing (makers re-quoting in a gap, or a third party), the attempt fills and settles. That needs 777,970 on the real-stack mocks (`test_SA4_01_stepThatFillsOneLot_realStack_cold`) and about 0.85M on mainnet (SA4-01 model). The step runs out of gas and the 700K limit is billed. The chain does not advance, because the revert undoes the attempt. A paying close is not gated by the backoff and goes at the next head. A zero-paid one (fill at or above the stop) waits 8 blocks, and a second such revert (16 blocks) outlasts the 10-block gap and restarts the walk at step 0. This is liveness and MON only: the floor never loosens. **Fix**: `triggerStep` 1.1M (SA4-01), or do not bump the backoff on a reverted step.

### SA4-I1 Info: hold state machine verified

Invariant: `_heldBlock[id] == block.number` implies `shortBlock == block.number`, and it implies a hold happened in this block with no reset or advance since. `_hold` is the only writer and sets both at once. `_advance` in the same block deletes it. `_resetChain` deletes it when `shortBlock == block.number`. `shortBlock` cannot return to a past block. A stale value from an earlier block is therefore never compared equal (`test_SA4_staleHeldBlock_ignoredInLaterBlock`). Cover ids are unique per account nonce, so nothing crosses covers.

Every in-block ordering was traced:
- `hold, hold`: the second is a no-op.
- `hold, thin`: advances once.
- `hold, thin, thin`: advances once (`test_SA4_holdThinThin_sameBlock_oneStep`).
- `thin, hold`: no-op.
- `hold, reset, thin`: a new chain at 1, the retry runs at 0 (C7 test).
- `arm` after a zero-fill hold on a Live cover: reset deletes the hold.

`shortBlock != 0` implies `shortSteps >= 1` on every path (`_hold` needs k = shortSteps >= 1; `_advance` stores >= 1), so `shortSteps - 1` cannot underflow and brick a trigger. A hold or advance with a gap over 10 (k = 0) leaves a stale `shortBlock`, which `_step` already treats as no chain. The hold's cold SSTORE adds about 25K, small next to SA4-01. After the first fill, holds are bounded by the 40-block window (`test_SA4_holdChainBoundedByWindow`).

### SA4-I2 Info: recovery carry-over in practice

C7 lets a chain survive 10 blocks (about 3 s) of recovery with no executed attempt (disclosed). INTERFACES adds "on an Armed cover any caller ends it during a recovery". That is true, but the keeper deliberately does not send disarm-only or no-fill triggers (SE1 H-1, `zeroPaidTriggerCloses` returns `disarm_only` / `no_fill`, and `booking` skips them). So no honest party does, and a re-touch within 10 blocks resumes at step k on Armed and Live covers alike. The bound is unchanged: step k had to be reached by k thin attempts with R through, which is the N-04 economics. Holds cannot bridge a recovery because they need R through. **Doc fix**: say that the keeper does not end chains during recoveries.

### SA4-I3 Info: holds and the N-04 wording

A hold restarts the gap, so the thin attempts of one long touch can be any distance apart as long as some attempt (thin or match-limited, with R through) lands every 10 blocks or less. After the first fill this is capped by `windowBlocks`. Before it, a hold needs matches that do not fill: self-matches by the trader's own orders, or expired orders if Perpl counts them (unverified, the C6 residual). Widening speed is unchanged: one step per block, floorSlack at the 6th attempt block, and each step still needs the book empty above its floor (`test_C7_hunt_dustHoldsNeverWiden`, `test_C7_hunt_N04_gap10_sameEconomicsAsGap1` re-run). No trader harm beyond N-04. **Doc fix** (`INTERFACES.md` section 4 residual): "each within 10 blocks of the touch's previous attempt (thin or match-limited)".

### SA4-I4 Info: comments and claims

- `Constants.sol:203` `// C4: trigger gas stays under 1.5M`: false on Perpl (SA4-01). Bytecode-neutral to fix.
- `docs/C5_FIXES.md` C7 results and `CANARY_PARAMS.md` section 3 "Mock worst case for one trigger at 16 matches: 1,484,336": stub stack, one maker, no intrinsic gas. Point to SA4-01.
- NatSpec checked and accurate for the C7 meaning of `Cover.shortBlock` / `shortSteps`, `ICoverManager.arm` / `trigger`, `_step`, `_advance`, `_hold`, `_bookThin`, `PayoutMath.closeLimitPNS`, and the CoverManager header.

## 4. Delta review (no findings)

| Change | Verdict |
|:-|:-|
| `arm` reverts `CoverExpired` at `block >= expiryBlock` (`:314`), `_watchKind` mirror (`:1059`) | Correct; SA3-01 closed. Order after the warm-up check is harmless |
| Fast path skips `TooEarly`, `NotArmer` and the re-check in the arm block (`:346-356`) | Correct; the chain was just reset by `arm`, so the fast path runs at step 0 |
| `_bookThin` after the close (`:728`) | Fresh read after the IOC; long `book < limit`, short `book > limit`, empty side is thin. Errs toward not widening |
| `floorSlack >= 2 x A` (`:1156`, index 34) | Correct; with A at most 50 this forces floorSlack >= 100 |
| Operator checkpoint (`GaplessAccount:327`, `_setOperator`, `revokeOperator`) | Correct: decays at the outgoing cap, freezes while revoked, the new cap applies from now; the `used == 0` skip is safe (decay floors at 0); uint128 bound holds |
| ListMarket `_envUint` | Rejects overrides above the type maximum before the cast; `SEED_DEPOSIT_CNS` stays uint256 |
| `Deploy._check` | Adds keeper `SIGMA_ROLE` and `vault.config().treasury`; both right |
| Named constants | `F_*` 0 to 28 match `MarketParams` declaration order; `C_*` match `VaultConfig`. `SETTLING_SLOT` is folded at compile time (32-byte constant in the code data section, no runtime KECCAK; preimage matches CR1). Full C6 bytecode equality could not be re-checked: no C6 source or git history on disk |
| Keeper mirror (`actions.ts closeStep`, `landingBlock`) | Matches `_step` for every landing after `shortBlock`; the mirror never needs `_heldBlock` because the keeper never targets `shortBlock` itself, and a third party's same-block attempt (thin or hold) leaves the landing step equal to the mirror's |

## 5. Hunter questions (asked in scope)

| Question | Answer |
|:-|:-|
| Can the 10-block gap plus holds widen faster? | No. One advance per block in any caller mix and order (SA4-I1); 5 thin blocks to reach floorSlack, as before |
| Can a hunter keep a chain alive across a genuine recovery? | Only for the disclosed 10 blocks with no attempt. Holds need R through, so they cannot run during a recovery. In practice nobody ends the chain early (SA4-I2) |
| Trader harm beyond N-04? | None found. Every widened step still needs an empty book above its floor with R through (re-run: hunter PnL identical at gap 1 and 10) |
| `_heldBlock` stale state, reorder within a block | None (SA4-I1) |
| Gas over 1.5M on a reachable path | Yes, on the real stack and with distinct makers; mainnet data confirms it (SA4-01) |
| Keeper wasted or reverting sends | SA4-01 (no send, or one billed OOG when the book changes after simulation), SA4-03 (700K steps that meet a bid) |

## 6. Tests

| Run | Result |
|:-|:-|
| `forge test` (default), before SA4 | 494 passed, 0 failed |
| `SA4AuditTest` | 9 passed |
| Deep invariant chunk (`FOUNDRY_PROFILE=deep`, 32 x 500, seed `0x53413401`) | Pass: all 13 invariants incl. I14 (C7 chain model) and O3 (stop hunts), 139 s |

## 7. Go / no-go

**GO for the single canary deploy.** The C6 and C7 contract changes are correct, and nothing in `src/` needs to change before the address freeze. SA4-01 is fixed off-chain plus one live parameter, and `maxMatchesClose` stays adjustable after the freeze.

**Must-fix before the first cover is sold** (not before deploy):
1. SA4-01: `maxMatchesClose` 8 via `setMarketParams` (RISK_ADMIN), keeper `GAS.trigger` at least 2.1M, a one-shot retry at a ceiling (about 3.5M) on a non-custom simulation revert, and `KEEPER_HOTPATH_RESERVE_WEI` and the cap table updated (RUNBOOK 11.3). If 16 is kept: `GAS.trigger` at least 3.1M.
2. SA4-02: RUNBOOK section 11 rewritten to measure with `cast estimate` and `debug_traceTransaction` inner frames, never receipt `gasUsed`.

**Should fix**: SA4-03 (`triggerStep` 1.1M or no backoff on a reverted step); doc items SA4-I2, SA4-I3, SA4-I4.

SA3 canary conditions 1, 2, 4 and 5 stand. Condition 3 (measure trigger gas on Perpl) is answered by SA4-01; confirm on the first real trigger with a trace.
