# Monad Metropolis: Research and Build Folder

Status 2026-10-01: **final pick is Gapless (Track 01)**. **G0 fork gate passed** (contract-owned Perpl account settles in the same tx). The authoritative build spec is `gapless/00_GAPLESS_TECH_SPEC.md`; `08` holds the pick rationale, bounties, demo and pitch. Everything else here is supporting research. **Soft Seal (Track 04)** is planned as a time-boxed **second submission**, gated on organizers confirming that one team may submit two projects; its authoritative spec is `softseal/00_SOFTSEAL_TECH_SPEC.md` ("Lite"). A maximized blueprint, `softseal/00_SOFTSEAL_MAX_SPEC.md`, extends it as an operator-hour ladder; rungs above the Lite cap need added hours and are the user's call, never Gapless time.

## Key deadlines

| Event | UTC | WIB (UTC+7) |
|:-|:-|:-|
| Submission window opens | 2026-10-02 03:59 | Fri Oct 2, 10:59 |
| Fork gate G0 (Perpl contract account + same-tx settle) | | Thu Oct 1: **PASSED** |
| Address freeze (mainnet v1) | | Mon Oct 5 |
| First real mainnet cover triggered (G1) | | Sat Oct 3 |
| Singapore activation / DeltaV Demo Day | 2026-10-06 | Tue Oct 6 |
| Scope freeze (G2) | | Wed Oct 7 |
| Code freeze (G3) | | Sat Oct 10 |
| **Internal submit target** | | **Mon Oct 12** |
| **Hard lock** (Oct 13 23:59 ET) | **2026-10-14 03:59** | **Wed Oct 14, 10:59** |
| Judging | Oct 14 to Oct 27 | |
| Winners announced | 2026-11-03 17:00 | Nov 4, 00:00 |

## Files

| File | One line |
|:-|:-|
| `00_source_page_extract.md` | Raw extract of the monad.xyz Metropolis page: tracks, perks, bounties, judges, mentors |
| `01_hackathon_overview_rules_judging.md` | Rules, timeline, prize structure, platform mechanics, judge theses, Monad tech facts, Mera and DeltaV |
| `02_sponsor_bounties_trading_payments.md` | Kuru, Perpl, Agora, Aurora, Cleanverse, CRE, Mercuryo, Envio, Nansen: requirements, addresses, EV ranking |
| `03_sponsor_bounties_identity_ai_consumer.md` | Privy, Dynamic, MetaMask plugin, Mera bounties, AI credits, perks, Track 04 building blocks (8004, P256, 7702, x402, C2PA) |
| `04_past_monad_hackathons_winners.md` | Every Monad-hosted competition and winner, Blitz category stats, saturation map, live app-hub inventory |
| `05_comparable_hackathon_winners_and_playbook.md` | Comparable 2025 to 2026 winners per track, judging rubrics elsewhere, Metropolis playbook and repo sample |
| `06_winning_strategy_synthesis.md` | Inferred rubric, 12 case studies, winner formula, saturation and white-space maps, the shared 100-point idea rubric |
| `07a_ideas_track01_finance_trading.md` | T01 ideas: Gapless 82, Crossbar 81, Fathom 75, Propline 72, Glide 68 |
| `07b_ideas_track02_consumer_payments.md` | T02 ideas: Ambil! 83, Wali 76, Tarik 73, Pintu 72, Nyala 71 |
| `07c_ideas_track03_social_culture.md` | T03 ideas: Tawa 83, Saksi 76, Siaran 72, Putar 69, Buwuh 66 |
| `07d_ideas_track04_trust_identity_ai.md` | T04 ideas: Soft Seal 79, Bouncer 75, Actuary 73, IDTap 72, Veto 71 |
| `08_final_pick_and_build_plan.md` | **Final decision**: cross-track re-scoring, Gapless spec, bounty stack, architecture, security, day plan, demo, pitch, risks, backup. §18 points to the corrections in `gapless/` |

### `gapless/` (build folder)

| File | One line |
|:-|:-|
| `gapless/00_GAPLESS_TECH_SPEC.md` | **Authoritative build spec**: decisions log D1 to D50, system diagram and data flows, final Solidity interfaces, constants, payout math, Perpl call recipes, invariants, keeper, relay, Envio, CRE, MetaMask plugin, frontend, repo layout, versions, test plan, day-by-day agent plan, external asks, open questions |
| `gapless/01_perpl_technical_reference.md` | Perpl Exchange: contract map, account model, `OrderDesc`, settlement semantics, prices, funding, native stops (1% IOC), API, G0 results |
| `gapless/02_monad_chain_kuru_ausd_reference.md` | Monad execution differences (gas on limit, reserve balance, finality states), Foundry 1.8, viem, RPCs, AUSD facts, Kuru (now roadmap only) |
| `gapless/03_mera_agora_frontend_reference.md` | Mera API and owner/operator key design, MON drip, Agora bounty and AUSD acquisition, TanStack/Serwist/HeroUI stack, CSP and passkey security |
| `gapless/04_chainlink_envio_metamask_reference.md` | CRE workflow and forwarders (mock is permissionless), Chainlink Data Feeds, Envio HyperIndex/HyperSync scope and limits, MetaMask Agent Wallet plugin |
| `gapless/05_mechanism_pricing_security_reference.md` | GSLO precedent (IG, CMC), empirical gap data, premium formula, vault design, attack table A1 to A15, invariant test plan |
| `gapless/perpl-fork-gate/` | Foundry fork tests proving same-tx settlement and Perpl semantics (G0) |

### `softseal/` (second project, Track 04)

| File | One line |
|:-|:-|
| `softseal/00_SOFTSEAL_TECH_SPEC.md` | **Authoritative build spec**: positioning vs Grain/ROOTED/KINETK, honest claims, re-score (65/100, judge 53), decisions S1 to S55, diagrams and flows, `SealRegistry` interface, sealer/API/Privy/MCP/SDK/Envio/investigator, frontend and CSP, versions, eval plan, Oct 1 to 12 plan interleaved with Gapless, asks, open questions |
| `softseal/01_watermark_fingerprint_reference.md` | TrustMark Q BCH_5 measured robustness (20/20 simulated WhatsApp), false decodes, PDQ limits, tiered content check, payload layout |
| `softseal/02_c2pa_reference.md` | C2PA 2.4 essentials, Soft Binding API and Federated Lookup `describe()`, CAWG, signing and trust anchors, SDK versions, regulation (EU Art 50, CA SB 942) |
| `softseal/03_onchain_identity_reference.md` | P256 precompile and OZ WebAuthn on Monad (gas, high-s), ERC-8004 v2.0.0 facts, Mera Many Keys design, registry gas measurements, Envio schema |
| `softseal/04_sponsors_dx_distribution_reference.md` | Privy, Qwen, Kimi, Many Keys; SDK/MCP/PyPI plan; traction targets; Grain competitor scan |
| `softseal/05_threat_model_security_reference.md` | Watermark and PDQ attacks, honest UX states, onchain and identity threats, OWASP, evaluation plan, Foundry invariants |
| `softseal/06_distribution_channels_reference.md` | Telegram Guest Mode bot, WhatsApp Cloud API bot (deterministic only, Meta AI-provider clause), share sheet PWA + iOS Shortcut, Chrome extension (stretch), Bahasa verdict copy, Indonesian stats, CekSumber/Mafindo, platform round trip |
| `softseal/07_integrations_ecosystem_reference.md` | Track 04 idea text, Vercel AI SDK middleware, ComfyUI V3 node, LangChain, Replicate/fal, MCP 2026-07-28 + Registry, ERC-8004 feedback griefing, Verdict, x402 scope, 16 integrator candidates, Grain/ROOTED interop, ERC draft path, 9 spec deltas |
| `softseal/08_media_expansion_monad_native_reference.md` | Stream Seal (per-second live provenance with session key), finalized-before-delivery at generator scale, cross-chain gas and cost, video/audio watermark roadmap, honest camera claims |
| `softseal/09_market_pitch_judging_reference.md` | Market comps, EU Code signatories and non-signatory wedge, SB 942, Indonesia, unit economics (Privy $0.01/sig), judge map, pitch and demo scripts, 16 VC objections |
| `softseal/00_SOFTSEAL_MAX_SPEC.md` | **Maximized blueprint** (superset of the Lite spec, which stays the fallback): re-score (shared 65 to 72, judge 53 to 69 base), Core/Max/Stretch/Roadmap tiers, decisions X01 to X53, `StreamRegistry` and `resolve()` interfaces, bots/share sheet/AI SDK/ComfyUI/MCP/federation specs, traction plan, pitch package, operator-hour ladder vs Gapless, day-one drafts |
| `softseal/bench/`, `softseal/p256-harness/` | Reproducible watermark/fingerprint bench and P256/WebAuthn gas harness |

## Per-track picks

| Track | Pick | Self-score (07x) | Re-score, 100-pt rubric (08) | Judge rubric /100 (08) | Realistic EV (08) |
|:-|:-|:-|:-|:-|:-|
| 01 Onchain Finance & Trading | Gapless | 82 | 80 (fused spec: **85**) | 64 (fused: **69**) | ~$7.2K |
| 02 Consumer Products & Payments | Ambil! | 83 | 72 | 61 | ~$3.9K |
| 03 Social, Attention & Culture | Tawa | 83 | 70 | 61 | ~$3.6K |
| 04 Trust, Identity & AI Infra | Soft Seal | 79 | 73 (with Grain: **65**) | 60 (with Grain: **53**) | ~$3.4K (now ~$2.0K) |
| Runner-ups re-checked | Crossbar / Wali / Saksi | 81 / 76 / 76 | 77 / 69 / 66 | 57 / 54 / 57 | ~$3.9K / ~$3.5K / ~$2.8K |

## Final pick

**Gapless (Track 01):** guaranteed stop-losses on Perpl. An AUSD underwriting vault pays the gap in the same Monad tx that closes the position. Payouts are bounded by a median external reference, so self-made gaps pay at most a 5 bps allowance. G0 passed, so the Kuru adapter is roadmap only.
- Bounty stack, all on the core path: Agora Mobile $10K, Perpl API $2.5K, Perpl Analytics $1K, MetaMask plugin $2.5K, Chainlink CRE $3K, Mera UX $2.5K, Envio $1K, Community $5K (Ethereum Jakarta member) = **$27.5K nominal**. Plus the T01 $10K and the $25K Grand Champion.
- Second project: **Soft Seal (T04)**, built in parallel as "Soft Seal Lite" (about 38 operator hours, at most 8 before the Oct 5 Gapless freeze), only if two submissions per team are allowed. Bounties: Privy, Mera Many Keys, Qwen, Kimi (no overlap with Gapless). MAX option (`softseal/00_SOFTSEAL_MAX_SPEC.md`): rung 0 fits the same 38 h; full MAX needs about 61 to 67 op h (+23 to +29), re-scored 72/100 shared and 69 judge (base).

## Corrections log
- 2026-10-01: `07d` and `08` claimed Soft Seal had zero Metropolis competitors. [Grain](https://github.com/Musaga-Technology/Grain) builds the same primitive on Monad testnet. Both files carry a correction note; `softseal/00_SOFTSEAL_TECH_SPEC.md` §1 repositions and re-scores (73 to 65; judge 60 to 53).
- 2026-10-01: `gapless/` research corrected several `08` details (testnet collateral, funding interval, HyperRPC, MON drip size, CRE mock forwarder, payout reference rule). See `gapless/00_GAPLESS_TECH_SPEC.md §1` and `08 §18`.
- 2026-10-01: `03 §2.1` and `06` claimed the ERC-8004 Validation Registry was undeployed on Monad, an open gap. In fact [Verdict](https://github.com/vladhacketh/verdict) runs a Validation registry on Monad mainnet and testnet (`0x46c295395c4A146FB6B7faD8a362502843A1d897`). Both files now carry a correction note.
