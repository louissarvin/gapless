# S1 notes: CoverVault, GaplessFactory, GaplessAccount, Deploy, CRE sink (2026-10-05)

Scope per `INTERFACES.md` section 10. OZ 5.6.1 only; no frozen file edited (requests in `CHANGE_REQUESTS.md`).

> Historical S1 record. Lines marked *superseded* were replaced by C4 to C7 (`docs/C4_FIXES.md`, `docs/C5_FIXES.md`); the code and `INTERFACES.md` are current.

## Files

| File | Purpose |
|:-|:-|
| `src/CoverVault.sol` | ERC-4626 (offset 6, dead seed), async redeem, reserve, per-block payout cap |
| `src/GaplessAccount.sol` | Clone implementation: Perpl account owner, trading, covers, payouts |
| `src/GaplessFactory.sol` | CREATE2 clones (salt = owner), registry, EIP-712 `CreateAccount` |
| `src/cre/GaplessCreReceiver.sol`, `src/cre/GaplessCreSink.sol` | Simulation CRE receiver (stretch) |
| `script/Deploy.s.sol` | Section 3 order, steps 1 to 7, then the sink; `_check` asserts wiring |
| `test/utils/GaplessFixture.sol` | Mocks on chain 143, then the stack through `Deploy.s.sol` (`useRealManager` switch for S2) |
| `test/unit/stubs/ManagerStub.sol` | Interim ICoverManager subset; selectors pinned by `ManagerStubSelectorsTest` |

## Design choices

**Vault**
- `totalAssets` is internal accounting (`_assets`): deposit +, claim -, payout -, `notifyPremium` + LP share. Donations never move the price; escrow and rent stay outside until `notifyPremium`.
- Invariant kept by construction: `totalAssets >= reservedTotal >= reserved[perp]` (claims are capped at `freeAssets`, payouts consume reservation 1:1).
- Non-transferable shares via `_update` (only mint and burn). Request escrow calls `ERC20._update` directly, so `transfer(vault, x)` still reverts.
- `claimRedeem` pays `min(assetsAtRequest, convertToAssets(shares))` floor, capped by `freeAssets` (`InsufficientFree`, request stays open). The excess over `assetsAtRequest` stays with the remaining LPs.
- Rounding: shares on deposit floor, mint assets ceil, request snapshot floor, claim floor, treasury cut floor (toward LPs), per-block cap floor, utilization error ceil.
- `payCapped`: `min(amount, snapshot cap remaining, reserved[perp])`, snapshot `totalAssets x bps` at the first payout in the block; `bps` clamped to 1e4. `reserve` clamps `marketCapBps` to 1e4 too.
- `notifyPremium` checks `balanceOf(vault) >= totalAssets + amount` (the manager really transferred) and sends the treasury cut with `trySafeTransfer`: a frozen treasury falls back to LPs, so finalize and cancel can never brick.
- Pause covers `deposit` and `mint` only; `maxDeposit`/`maxMint` read 0 while paused. Exits and settlement never pause.
- `Settling()` on `deposit`, `mint`, `requestRedeem`, `claimRedeem` (skipped before `setManager`).

**Account**
- Implementation locked by `owner = 0xdEaD` in its constructor; `initialize` requires `msg.sender == FACTORY` and `owner == 0`. Custom check instead of OZ `Initializable` so the frozen `AlreadyInitialized`/`NotFactory` errors are what callers see.
- EIP-712 per clone: OZ `EIP712` rebuilds the separator when `address(this) != _cachedThis`, so each clone signs over its own address and `block.chainid`. Signatures go through `SignatureChecker.isValidSignatureNowCalldata` (ECDSA low-s enforced, or ERC-1271 by staticcall).
- Premium funding (spec 2.1): wallet AUSD first, then `withdrawCollateral(shortfall)` after checking Perpl free balance, then re-read the wallet (`PremiumUnfunded`). Exact `forceApprove(manager, need)`, `openCover`, `forceApprove(manager, 0)`.
- `closeForCover` (spec 3.8): returns a zero result if inactive, no position, wrong side or `lots == 0`; clamps lots to the position (no `CloseOrderExceedsPosition`); V1 `execOrder` IOC, leverage 0, maxNegPnl 0, `lastExecutionBlock = block.number`; every field from re-read storage (zero-fill IOC returns a zero result). Funding share floors toward the vault. Fee tier index clamped to 7.
- `creditToPerpl` never reverts on Perpl failure: `try depositCollateral`, AUSD stays in the wallet, `Credited(amt, false)`. Amount clamped to the wallet balance.
- Perpl errors in `closeForCover` bubble (no try/catch): a caught out-of-gas would let anyone turn `trigger` into `TriggerNoFill` with a low gas limit.
- Factory `createAccount` sweeps without try/catch: a Perpl failure (whitelisting, halt) reverts the whole creation, so funds never land in a half-made account. `createAccountFor` moves no funds.

**CRE sink**: forwarder-only `onReport`, chain selector check, per-kind monotonic `seq` (*superseded* by the C4 L-04 seen-set keyed by report hash), at most 3 `try arm` and 3 `try trigger`, `nonReentrant`, holds nothing.

## Deviations from the frozen text (ABI unchanged)

1. `CloseResult.realizedCNS` = delta of `balanceCNS + lockedBalanceCNS`, not `balanceCNS` alone (CR1). Found by test: a resting bid of the trader's own, cleared by self-match during the close, was counted as proceeds and cut the payout by 4.31 AUSD.
2. Operator notional cap also applies to order type 6 Change (CR2).
3. `setOperator` and `revokeOperator` bump `opNonce`, invalidating pending signed `SetOperator`/`Withdraw` (CR3).
4. Sink ignores `seq` above now per kind (CR4).
5. `requestRedeem(0)` or above balance reverts OZ `ERC4626ExceededMaxRedeem` (no frozen zero-amount error on the vault).
6. `notifyPremium` underfunding reuses `InsufficientFree(need, balance)`.
7. `GaplessCreSink` constructor declares `ZeroAddress()` (deploy-time only, outside `IGaplessCreSink`).
8. `Deploy.s.sol` reads `KEEPER` from env (added to `.env.example`, names only).

## Tests (183 S1 tests; full repo 374, all green on default and `ci`)

| Suite | Tests | Covers |
|:-|:-|:-|
| `GaplessAccount.t.sol` | 82 | init and impl lock, sweep threshold, permit (relay, front-run, wrong domain name), trade auth and operator scope (cap, Change cap, expiry boundary), PerpLocked, sync, premium wallet then Perpl, PremiumUnfunded, PremiumTooHigh, withdraw paths, EIP-712 (replay, expiry, wrong signer, cross-clone, wrong chain, high-s, ERC-1271), nonce invalidation, closeForCover G0 behaviors (full, zero fill, clamp, wrong side, partial, maxMatches dust, stale refs, funding floor, fee tier, own-order unlock, halt), creditToPerpl (inactive, halted, frozen), 2 fuzz |
| `GaplessAccountAttacks.t.sol` | 12 | A9 hostile manager re-entry (buy, sync, cancel), settling read-only reentrancy, C5 lock griefing, stranger sweep, operator exfiltration, A5 front-run lock, D13 recipients, payout into Perpl |
| `GaplessFactory.t.sol` | 21 | prediction, registry, deposit and prefunded sweep, atomic failure, relayed create, tampered grant, wrong signer or chain, replay, ERC-1271 (and static re-entry), clone front-run, rogue clone not registered, 1 fuzz |
| `CoverVault.t.sol` | 41 | seed, every LP and manager revert path, sync exits disabled, non-transferable, redeem min rule, InsufficientFree, block cap snapshot, NotAccount (zero, EOA, impl), frozen account deferral, premium split and frozen treasury, bounded config, roles, donation |
| `VaultInflation.t.sol` | 7 fuzz | inflation and donation, no dilution, redeem min, cooldown loss sharing, random reserve, release and pay sequences (I1, I7), per-block cap (O2 shape) |
| `GaplessCreSink.t.sol` | 13 | forwarder, chain, seq replay and future bound, MAX_IDS, failures skipped, metadata length, re-entry, 1 fuzz |
| `Deploy.t.sol` | 7 | wiring, roles, seed, nonce order, bad config, `run()` on etched mainnet addresses, chain guard, stub selectors |

Gas snapshot: `.gas-snapshot-s1` (`forge snapshot` with flag:snap `.gas-snapshot-s1` over the S1 suites). Deploy also verified against S2's real `CoverManager` (local probe, not committed).

## Sizes (Monad limit 128 KB runtime, 256 KB initcode)

| Contract | Runtime B | Initcode B |
|:-|-:|-:|
| CoverVault | 14,266 | 17,756 |
| GaplessAccount | 15,246 | 16,735 |
| GaplessFactory (embeds impl initcode) | 4,077 | 22,178 |
| GaplessCreSink | 2,291 | 2,600 |

## Gas (mock Perpl, `network = "monad"`, median / max)

| Function | Median | Max |
|:-|-:|-:|
| `factory.createAccount` (with activation) | 155,752 | 440,304 |
| `factory.createAccountFor` | 47,379 | 192,770 |
| `account.trade` | 184,449 | 522,069 |
| `account.tradeAndCover` | 876,587 | 930,701 |
| `account.buyCover` | 185,332 | 472,915 |
| `account.closeForCover` | 209,431 | 319,989 |
| `account.creditToPerpl` | 29,689 | 146,031 |
| `vault.deposit` | 187,092 | 187,092 |
| `vault.requestRedeem` | 216,018 | 216,042 |
| `vault.claimRedeem` | 173,923 | 201,723 |
| `vault.payCapped` | 67,787 | 173,315 |
| `vault.reserve` | 81,637 | 81,649 |
| `sink.onReport` | 150,028 | 196,069 |

Mock Perpl gas is not mainnet gas; trigger and close limits come from canary receipts (BUILD_PLAN 0).

## Open risks

- **Operator trading power.** A live operator can trade badly (including into a colluding account's resting orders) within the per-trade notional cap and expiry. It cannot withdraw, change the operator or touch manager hooks. Keep expiry short and cap tight.
- **`depositWithPermit` with a standing allowance.** If the owner ever approves the clone, anyone can pull up to that allowance from the owner into the owner's own account (funds stay the owner's). Advise permit-only.
- **EIP-7702 owners.** An owner EOA with a 7702 delegation has code, so signatures go through ERC-1271 on the delegate. Delegates without 1271 cannot use `withdrawWithSig`, `setOperatorWithSig` or `createAccountFor` (direct calls still work).
- **Perpl revert in `closeForCover` blocks that trigger.** Deterministic venue reverts (price out of range, halt) bubble to the manager; S2 owns limit computation and venue checks.
- **Rent not vested.** Premium enters `totalAssets` at `notifyPremium`; JIT capture is bounded by the 48,300-block deposit lock, not by UPR vesting (05 section 3.2 suggestion, not in spec).
- **CRE sink liveness.** Through the permissionless mock forwarder, a griefer can still keep `lastSeq` at "now" with repeated reports and delay DON reports; it cannot freeze a kind, and arm and trigger stay callable by anyone (C15).
- **AUSD assumptions.** No fee on transfer and no hooks (verified implementation, mock-modeled). A future AUSD upgrade that adds either breaks internal accounting assumptions; watch `Upgraded`.
- **Fee tier index.** Tiers above 7 are clamped to `taker[7]`; Perpl publishes 8 tiers.
- **Mainnet deploy cost.** Not measured here (no fork); the Wed `cast estimate` item still stands.
