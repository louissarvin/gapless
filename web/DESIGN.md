# Gapless PWA design system

Status: **Proposed**, 2026-10-07, revised the same day (r2 and r3, see below), application review 2026-10-08. Author: frontend-designer. Consumers: frontend-engineer (build), security-auditor (section 9 review).
Base system: `apple` (frontend-design-systems library), extended with documented Gapless deviations (section 0.3). Inputs: `web/ARCHITECTURE.md` (read-only), `memory/web_design_research_2026-10-07.md` and its screenshots.
Notation: CSS custom properties are written by token name only (`color-bg`, `radius-lg`). In code, each one is a custom property with the standard two-hyphen prefix. This file never contains a double hyphen, so table delimiter rows use a single hyphen.

## Review 2026-10-08: phase 2 pages (`/trade`, `/vault`, `/gap-index`, `/stats`, `/proof`, `/settings/agent`)

**Why.** These six routes were built from `ARCHITECTURE_PHASE2.md` without a design pass. The r4 decisions that document asked for (its section 7) were never written, so the engineer had nothing to build the sawtooth or the ResultCard against. This entry reviews the application of r1 to r3. It changes no token, type role or motion rule. Where it specifies something new (the sawtooth, the `/proof` composition, the data-list variant), it is built only from existing tokens and roles.

**Method.** Live dev server, Chromium at 390×844 (2x) and 1920×1080, real relay and chain data. Session routes were viewed with a freshly derived owner and operator injected into the app's own session module, so `/trade` and `/settings/agent` render their real "finish setup" gate. Their unlocked states (form, position card, grant form, confirm, result) were reviewed from source, because a fresh key has no deployed account and the dev bypass must not reach `/trade` (ARCHITECTURE_PHASE2 5.1).

### R.0 Verdicts

| Route             | Verdict                 | Why, in one line                                                                                                                                        |
| :---------------- | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/trade`          | **Real rule violation** | "Review order", "Buy guarantee" and "Close position" send immediately with no confirmation sheet (9.1). Cards render at 8px. PnL is unsigned (2.4, 3.4) |
| `/vault`          | **Real rule violation** | Deposit, request redeem and claim send with no sheet (9.1). Utilization ring is `#6E54FF` on `#3A3A3C`, 2.36:1 (2.6). The TVL big card has zero padding |
| `/settings/agent` | **Real rule violation** | Big cards on a route 5.4.1 excludes by name. The grant confirm lacks the domain row and shows the agent address shortened (9.2, 3.4). `#8E8E93` on s2   |
| `/gap-index`      | Needs polish            | No rule broken in its own code. Reads as a 30-row spreadsheet: every row equal weight, three rows per metric, values wrap onto two lines                |
| `/stats`          | Needs polish            | Same list problem. Hero renders words in the number face, top-stacked over dead space. Mono used for the word "View"                                    |
| `/proof`          | Needs polish            | Centered body copy (3.3), a raw contract path with literal backticks in user copy, and a 480px column that fills 23% of a 1080p recording frame         |

Nothing on these pages adds ambient motion, animates digits, or moves the `/trade` live header. The calm `/trade` rule (8.1) holds: the header repaints in place with no transition and a steady dot.

**Single highest priority:** C6, the missing confirmation sheet. It is a fund-safety rule on a live-mainnet product, and the `/trade` button labeled "Review order" sends the order without showing one.

### R.1 Cross-cutting findings (fix once, all six pages benefit)

**C1. Tailwind radius names do not match DESIGN radius tokens (rule 4.1, 4.2).** HeroUI derives Tailwind's scale from the `radius` base (8px): `rounded-xs` is 2px, `rounded-md` 6px, `rounded-lg` 8px, `rounded-3xl` 24px. So `rounded-md` in code is not `radius-md` here. Result: every `/trade` card is 8px instead of 24px, and every nested box, field, error block and pending row on `/trade`, `/vault` and `/settings/agent` is 6px instead of 16px. The pages that use arbitrary values (`rounded-[24px]`, `rounded-[16px]` on `/gap-index` and `/stats`) are correct.
Fix: in `src/styles.css`, in the unlayered `.dark` block next to `radius`, pin the named radii to 4.1: `radius-xs` 8px, `radius-sm` 12px, `radius-md` 16px, `radius-lg` 24px, `radius-xl` 32px. Class names then equal the tokens. Same issue, outside the six pages: `PauseBanner` (6px, visible at the top of every screenshot), `/home` nested rows and skeletons, `/onboard`. They move to spec with this fix, which is a visible change on approved pages: re-screenshot `/home` and `/onboard` after. If a HeroUI component regresses, fall back to arbitrary values on the six routes only.

**C2. Fields have no focus state and no shared shape (5.2, focus ring in 2.3).** `/trade`, `/vault` and `/settings/agent` each define a local `Field` and set `outline-none` on the input with nothing in its place, so a keyboard user cannot see which field has focus. Heights vary (37px on `/settings/agent`, 46px elsewhere) against 52px. Labels sit inside the field on two pages and above it on the third.
Fix: one `src/components/Field.tsx`. Label above in `type-label` `#AEAEB2`, 12px gap. Field `#2C2C2E`, 16px radius, min height 52px, padding 0 16px, 1px `#48484A` border. Focus within: 2px `#A48FFF`, drawn as `inset 0 0 0 2px` so the height does not change. Value `type-num` (or `type-mono` for addresses), unit suffix inside in `type-label` `#AEAEB2`. Below: one reserved 18px line for the bound ("Min 15 bps from mark", "Up to 25.00 AUSD") in `type-footnote` `#AEAEB2`; an error replaces it on the same line in `#FF6165` with `circle-alert` 14px. Error border 2px `#FF6165`.

**C3. Inline banners skip the 5.8 anatomy.** `/gap-index`, `/stats` and `/vault` each define text-only `ErrorBanner` / `StaleBanner` boxes with no icon and no title. On `/stats` the keeper banner is nested inside a 24px card at a 20px inset with a 16px radius, which breaks 4.2.
Fix: one `InlineBanner` with `PauseBanner`'s anatomy (`#402F21`, 16px radius, padding 16px, `triangle-alert` 20px `#FF9230`, title `type-headline` white, one line of `type-callout` `#AEAEB2`). Place it standalone in the page column, never inside a card. Titles: "Stats are unavailable", "Data is behind" (body: "Updated 18 min ago. The jobs process may be behind."), "Keeper status unavailable".

**C4. `GroupedList` needs a data variant (5.4 applied to read-only statistics).** `GroupedList` is only used by these pages, so changing it touches nothing approved. Five changes, in order of effect:

1. **Collapse percentiles into one row.** "Mark publish interval, p50 / p90 / max" is three rows with the same label, and that repetition is most of what makes `/gap-index` read like a spreadsheet. One row per metric. The label says what it is ("Mark publish interval, median"). The value is the median. The other percentiles go in the existing `note` slot, right-aligned under the value in `type-footnote` `#8E8E93`: "p90 50.2 · max 51.0".
2. **One lead value per card, optional.** Before the rows: label `type-label` `#AEAEB2`, 8px, value `type-num-lg` white with its unit, optionally one `type-footnote` `#8E8E93` line, then 16px to the first row. One per card, full width, stacked vertically. This is not a stat grid (12). It gives each card one focal point, the way the big card does for a screen. The card stays a regular card: 24px radius, 20px padding, no highlight.
3. **Data rows: labels `#AEAEB2`, values white.** Labels stay `type-body`. With secondary labels, the values become the bright column, as on Stocks' key-statistics list. Tappable settings-style rows (with a chevron) keep white labels per 5.4.
4. **Units per 3.4.** Number in `type-num` white, then a thin space, then the unit (`s`, `bps`, `blocks`, `AUSD`, `MON`) in `type-label` `#AEAEB2`. Percent signs stay attached to the number. Rows take `{ value, unit }` instead of a preformatted string.
5. **Geometry.** Value column `shrink-0 whitespace-nowrap`, label `min-w-0`. Today "1.69 bps" and "11.94 bps" break onto two lines at 390px. Delete the title's `marginLeft: 4`: it sits 4px right of the row labels (measured at 764px vs 760px).

Missing values: no dash glyph (3.4 bans dash placeholders). Loading shows a skeleton. A real "no data yet" shows words in `type-body` `#8E8E93`: "None yet" or "No triggers yet".

**C5. Big-card anatomy (5.4.1) not followed where big cards are used.** On the `/stats` hero, the `/gap-index` live card and the `/proof` cards, label and hero are stacked at the top and the bottom of the card is empty. The rule: flex column, `justify-between`, label at the top, hero element anchored to the bottom, label to hero 8px, hero to supporting row 24px. The `/vault` TVL card has the layout right but no padding at all (`card-big` sets no padding; add `p-6`).

**C6. No confirmation sheet exists anywhere (9.1, 9.2). Highest priority.** No sheet, drawer or dialog component is in the repo. Every value-moving action on these pages goes straight from the button to `sendOperatorCall`:

| Route             | Action                                                | Today                                    |
| :---------------- | :---------------------------------------------------- | :--------------------------------------- |
| `/trade`          | Review order (plain), Buy guarantee, Close position   | Sends on press                           |
| `/vault`          | Deposit (approve plus deposit), Request redeem, Claim | Inline preview box, then sends on press  |
| `/settings/agent` | Re-grant this device (`setOperatorWithSig`)           | Inline confirm view, no network cost row |

Fix: build `ConfirmSheet` once, per 5.7 (bottom sheet on mobile, centered 480px dialog from 768px; HeroUI v3 Drawer per 11.2) and 9.1, in order: verb-phrase title, total first in `type-num-lg`, decoded rows from the exact calldata, network cost, destination with the full chunked address and `circle-check`, collapsed details, then Confirm and Cancel the same size. Confirm ignores input for 600ms after opening. Lifecycle (Sending, Confirming with hash, Done or Reverted) shows inside the sheet, never as a toast. Per action:

- `/trade` open: title "Open long" or "Open long and buy cover". With Guarantee off, add the line "This position has no guarantee" in `type-callout` `#AEAEB2`. Close: destructive variant, "Escrow refunded: X AUSD. Rent kept: Y AUSD" (ARCHITECTURE_PHASE2 5.1).
- `/vault` deposit: "Deposit 5.00 AUSD", rows: shares you receive, locked until block plus approximate time, and "Two transactions: approve, then deposit" when allowance is short. Destination: "Gapless vault" plus the full chunked `CoverVault` address. Redeem: the min(value at request, value at claim) rule as a visible row, not a footnote.
- `/settings/agent` re-grant: add the network cost rows (gas, max MON, the trading key's MON after).

**C7. Full-page reloads end the session.** `/trade` navigates with `window.location.href` ("Finish setup", and after a cover is bought). The passkey session lives in a module closure, so a reload lands the user on the unlock card. Use the router's `navigate`. Not visual, but the user sees it as "the app logged me out".

**C8. Skeletons.** `animate-pulse` is Tailwind's 2s, 1 to 0.5 pulse, and it ignores reduced motion. 5.12 is 0.5 to 0.8 over 1.6s, off under reduced motion: one `skeleton` utility in `styles.css`. Text loaders ("Loading vault…", "Loading…") become skeletons in the shape of what loads.

### R.2 `/gap-index`: needs polish

1. **Live card** (big card, 320px min). Top row as built: label left, "Live · #block" right. Then the hero, `type-num-hero` with the unit `s` in `type-label` `#AEAEB2` (3.4). Supporting row, 8px below: two pairs, each a `type-footnote` `#AEAEB2` label and a `type-num-sm` white value, 16px apart ("Oracle age 10.0 s", "Mark vs book 0.00 bps"). Then the sawtooth fills the rest of the card (`flex-1`, min 120px), 24px below the supporting row, anchored to the bottom padding (C5).
2. **Sawtooth (the r4 decision ARCHITECTURE_PHASE2 7 item 1 asked for).** Still hand-drawn SVG; see R.8 for why nothing from react-bits or a chart library.
   - Line 1.5px `#FFFFFF`, round joins and caps. Not purple: in the app, purple means "you can act" or "you are here" (12), and a measurement is neither.
   - The part of the line above the 60s threshold is drawn in `#FF9230`: the same polyline twice, each clipped to one side of the threshold y. Orange already means "stale data" (2.4), so the threshold explains itself without a legend. No gradient.
   - Threshold: 1px dashed `#3A3A3C` as built, plus the label "60 s" in `type-caption` `#8E8E93`, right-aligned, 4px above the line.
   - Current value: a 6px white dot on the last sample. Static, no pulse (7.3).
   - X axis: a fixed 600s window, each sample placed by its timestamp, not its index, so a missed second shows as a gap instead of compressing the line. Under the chart, 8px gap, `type-caption` `#8E8E93`: "10 min ago" left, "Now" right. No gridlines, no y ticks.
   - Y axis: 0 at the bottom; ceiling `max(90, highest sample rounded up to the next 30 s)`, so the scale changes in 30s steps, not on every spike.
   - Geometry: `preserveAspectRatio="none"` stretches the stroke and would turn the dot into an ellipse. Measure the container with a `ResizeObserver` and draw in real pixels; failing that, put `vector-effect="non-scaling-stroke"` on both lines and draw the dot as a positioned 6px element.
   - Cadence: one repaint per sample, no transitions. Reduced motion changes nothing; confirmed, it is data, not motion.
   - Fewer than 2 samples: draw the threshold and axis labels anyway, with "Collecting samples" in `type-caption` `#8E8E93` centered, on the card surface (no `#2C2C2E` box). The chart keeps its shape when data arrives.
3. **"This week · BTC"** (C4): lead "Typical time between mark updates" 50.0 s, footnote "p90 50.2 s · max 51.0 s". Rows: oracle publish interval, median; oracle report lag, median; mark vs oracle divergence, median (note: p99); time the mark was older than 60 s. Eight rows become four.
4. **"What native stops did"**: lead "Worst fill past the trigger" 18.11 bps, footnote "median 1.35 · p95 6.19". Rows: executions, filled in full, partially filled, filled nothing, delay (median, with "about 1 s" per 3.4 and p95 in the note), join rate. The joined-rows footnote under the card aligns to the card's 20px text inset (`px-5`), not 4px.
5. **"How often stops get hit"**: lead "Chance a 100 bps stop is hit within 12,000 blocks (about 1 h)" 2.9%. One row: mark gap through the stop, p99, with max in the note.
6. **Premium model, Method, Other markets**: fine as disclosures. Add `aria-expanded` and `aria-controls`, chevrons at 20px (11.5). Method should show each document's `method` text (ARCHITECTURE_PHASE2 5.3 item 6), not only `generatedAt`. Timestamps in `type-num-sm`.

### R.3 `/stats`: needs polish

1. **Hero.** `type-num-hero` must hold a number. Show the total ("0") anchored to the bottom (C5), then one `type-callout` `#AEAEB2` line: "No covers yet. The first one appears here within a minute of purchase." When the total is above 0, the line becomes the live count ("3 live now").
2. **Covers by status.** Chips stay (ARCHITECTURE_PHASE2 5.5). Zero counts in `#8E8E93`, non-zero in white, so the first live cover stands out against six zeros.
3. **Money, Speed, CRE, Keeper** use C4. Leads: Money "Notional covered"; Speed "Arm to trigger, median" in blocks with "about N s" in the footnote. Speed has two rows and CRE three, so merge them into one card, "Trigger pipeline" (lead arm-to-trigger median; rows: arm-to-trigger max, CRE reports, armed, triggered). Nine cards become eight, and the merged card tells one story.
4. **Vault and Native stops**: rows as specified, plus the spec's links (missing): a final tappable row "Open Vault" or "Open Gap Index" with `chevron-right` `#8E8E93`, white label, pressing to scale 0.98.
5. **Firsts**: replace the mono "View" (mono is for hex strings only, 3.1) with the short hash `0xabcd12…ef34` in `type-mono-sm` `#A48FFF` plus a 14px `external-link` icon, as in the stepper (5.13). "not yet" becomes "Not yet" in `type-body` `#8E8E93`: Open Runde, not the number face. Remove `first:pt-0` so the first row sits like every other card's.
6. **Keeper unavailable**: standalone `InlineBanner` (C3) under a `type-label` `#AEAEB2` "Keeper" header, not nested in a card.
7. **Footer (missing, spec 5.5)**: "Updated 4 min ago" in `type-footnote` `#8E8E93` under the last card, and the stale banner when `stale` is true.

### R.4 `/proof`: needs polish

The measured-mode content is honest and should stay. What it lacks is a composition: two equal-looking stacked cards, the hero number is the execution count (context, not the point), and on a 1080p recording the page is a 480px strip in the middle of a black frame.

1. **Alignment (3.3).** Title and body are centered; body copy is left-aligned outside the landing hero and statements. Left-align both. Drop `min-h-screen justify-center`: top-align at 40px. Title: "No Gapless trigger yet" (the current one leaves "yet" alone on a second line at 390px).
2. **Copy bug.** The allowance line shows the contract path `marketParams(1).slipAllowanceBps` wrapped in literal backtick characters, in user copy. Remove it. "The allowance is 5 bps today, read from the contract." says the same thing to a person.
3. **Composition.** Two big cards, the plain stop and the Gapless cover, with the same anatomy, so the eye compares like with like.
   - **Plain Perpl stop** (neutral). Label "Plain Perpl stop, this week". Hero: worst fill past the trigger, "18.11" in `type-num-hero` plus `bps` (3.4). That gap is the subject of the page; 929 executions is the sample size. Supporting line in `type-callout` `#AEAEB2`: "Across 929 stop executions. Median 1.35 bps, p95 6.19 bps. 50 filled nothing."
   - **Gapless cover**. Label "Gapless cover" with a 16px `shield-check` in `#00DAC3` (mint means protection, 2.5; it is a state color, not decoration, and avoids red against green). In measured mode there is no number, so the hero is words: "Pays the gap back" in `type-title-1`. Below it, at the 16px inset, a nested `#2C2C2E` box (16px radius, padding 12px 16px): `type-footnote` `#AEAEB2` "Pays the smallest of", then three `type-body` rows: "The real gap", "The reference gap plus a 5 bps allowance", "The cap: notional times max gap". Footnote: "This is the rule, not a result. No cover has triggered on this deployment yet."
   - **Paired mode** uses the same two cards. Both heroes are bps past the stop, in white, the same role, in the same position (ARCHITECTURE_PHASE2 5.2: lead with bps, AUSD second). Today the Gapless side shows notional, which is not comparable to slippage. "Exited at the stop" only when the residual is 0 and the cover is Finalized. Plain vs Gapless is told by label, the mint shield, and the title sentence, never by painting one side red.
   - **Downgrade header** ("Two separate events"): the page title plus its explanation, above both cards. The cards then drop any "same stop" wording.
4. **Recording size, from 1024px.** Container 960px. Title in `type-display` (48px, an existing role, used here as on a landing section head, because `/proof` is the landing's proof surface). The two cards side by side, equal height, 24px gap, 40px padding (landing big-card values, 5.4.1). Below 1024px: one column, app values (24px padding).
5. **Way out.** The tab bar is hidden here (ADR-W11). Add a 44px icon button (`chevron-left`, `#2C2C2E` circle) top-left linking to `/gap-index`, per the top bar rule in 5.6.
6. **Loading**: skeleton cards, not "Loading…".
7. Outside this route: the global pause banner spans 1880px at 1920 wide. 5.8 says "inside the page gutter"; cap it to the page container in `__root`.

### R.5 `/vault`: has real rule violations

1. **TVL card has zero padding** (visible: the label, the 4.00 AUSD and the ring all touch the card edge). Add `p-6`. Hero to supporting row: 24px (today 4px). The supporting row stays `type-footnote` `#AEAEB2`: "0.00 AUSD reserved".
2. **Ring contrast (2.6).** The arc is `#6E54FF` on a `#3A3A3C` track, 2.36:1, which 2.6 rules out explicitly. Use `#A48FFF` (4.30), the thin-progress treatment already used by the home budget bar. Track, size and centered `type-num` label are fine.
3. **No sheet for deposit, redeem or claim** (C6).
4. **Fields** (C2). The disabled reason goes directly under the button (5.1): "Enter an amount", "Minimum deposit is 1.00 AUSD", "Locked until about 14:20". Today the hint sits above the button, and the disabled primary renders as dimmed porcelain instead of the 5.1 disabled style (`#2C2C2E` fill, `#636366` text). Check `GaplessButton`'s disabled state; it is shared.
5. **Links to Stats and Gap Index.** Two loose 15px text links are the only way into those pages (ADR-W11). Make them a regular card with two tappable rows ("Protocol stats", "Gap Index", `chevron-right` `#8E8E93`, white labels, press 0.98).
6. Pending redemption rows and lifecycle boxes go to 16px (C1). "Lock status" with no shares reads "No deposit", not a dash.
7. Fine as is: the max-loss card (full card, `type-body`, every number live), the order (public data, then the unlock card), the "Your position" list.

### R.6 `/trade`: has real rule violations

1. **No confirmation sheet** (C6). "Review order" must open the review it promises.
2. **Every card is 8px** (C1): price header, open form, position card and add-guarantee card go to 24px, nested boxes to 16px.
3. **PnL is unsigned and uncolored** (2.4, 3.4). `formatCNS` prints a hyphen-minus for losses and nothing for gains. Use `formatSigned` (+ or U+2212) and `#30D158` / `#FF6165` text. Position side already pairs an arrow with the size: good.
4. **Sticky glass action bar (8.2) is missing.** The primary sits at the bottom of the form card. With Guarantee on, it scrolls under the tab bar on a phone. Spec: a `color-glass` bar pinned above the tab bar, a one-line summary in `type-footnote` `#AEAEB2` ("Long 22 lots · Guarantee off · gas paid in MON"), the disabled reason under it, then "Review order" (primary, lg).
5. **Fields** (C2). Size and Stop labels move above their fields; "Min 15 bps from mark" stays as the reserved bound line.
6. **Gate cards.** The "Finish setting up" big card is the unlock card's sibling (a session gate, not trading content), so it may stay big despite "no big cards on `/trade`". It is the only exception, and C7 applies to its button.
7. Spec gaps to note: no order book, no "Reconnecting" state on the header (8.1 rule 5). Live-zone discipline is correct: no transitions, steady dot, no ambient motion.

### R.7 `/settings/agent`: has real rule violations

1. **Big cards on a route 5.4.1 excludes by name.** The grant form, confirm, result and done views are all `card-big`. Make them regular cards (24px radius, 20px padding, no highlight). Their headings go from `type-title-1` to `type-title-2`: the page title already carries the serif, and two 34px serif lines 40px apart compete. The unlock and "Finish setting up first" gate cards stay big (unlock-card class). The latter needs 24px between its body and the button; today the text sits on the button.
2. **Grant confirm, per 9.2:**
   - The sentence stays verbatim in `type-body`, with its numbers in Open Runde (3.3). Today the two limits are 28px Inter inside a 17px sentence, which visibly breaks the line height.
   - The limits move below the sentence into a nested `#2C2C2E` row (16px radius, padding 12px 16px), two columns: `type-footnote` `#AEAEB2` "Per trade" and "Per day" over `type-num-lg` values. This is how 9.2's "limits in `type-num-lg`" and 3.3 both hold.
   - "It can never withdraw." in `type-headline` on its own line.
   - **Agent address in full**, chunked, `type-mono` (3.4: wherever the user verifies a destination). This address receives trading authority; it is shortened today.
   - **Domain row (missing):** "Verified: GaplessAccount v1, Monad 143, 0x…" with `circle-check` `#30D158`, from the same `eip712Domain()` read used to sign. A mismatch is a hard stop: error block, no Sign button (9.2).
3. **Fields** (C2). Units are `#8E8E93` on `#2C2C2E` (4.3:1; 2.2 bans tertiary text on s2): use `#AEAEB2`. Bounds move out of the labels ("Per trade (up to 25.00 AUSD)") onto the reserved line under each field ("Up to 25.00 AUSD"). The address field uses `type-mono` (15px), not `type-mono-sm`.
4. **Re-grant** sends a transaction: network cost rows (C6), and the Sending and Confirming states with the hash while it runs (9.2), not just a spinner.
5. Fine as is: the home view (current operator list, one primary and one secondary), the result view (command in `type-mono` on `#2C2C2E` with copy, QR card).

### R.8 react-bits check (2026-10-08)

Registry `https://reactbits.dev/r/registry.json` fetched directly (no react-bits MCP was connected): 214 components, 856 variants. **It has no chart component.** The closest candidates for the data pages, all rejected:

| Component                                   | Why not                                                                                                       |
| :------------------------------------------ | :------------------------------------------------------------------------------------------------------------ |
| `SloshGauge`                                | Liquid that chases the value with mass and splash: data performing (7.0 item 5). Not a fit for the vault ring |
| `CountUp`, `Counter`                        | Already banned (7.3)                                                                                          |
| `AnimatedList`                              | Staggered row entrances: bold by count, and it would stagger the money rows 7.3 keeps still                   |
| `SpotlightCard`, `GlareHover`, `BorderGlow` | Cursor-driven or decorative card effects (7.4 rejected list)                                                  |
| `MagicBento`                                | Needs GSAP (removed), and a bento grid is the stat-grid pattern 12 bans                                       |
| `StatusMark`                                | Morphing task glyph; status chips (5.5) already cover state                                                   |
| `Topography`                                | A second ambient WebGL field; one is the limit (7.0)                                                          |

A chart library (Recharts, visx) for one polyline and one ring is not worth the bundle. The sawtooth spec in R.2 is the polish, and it costs about 30 more lines than the current component.

### R.9 Diff checklist for frontend-engineer

Order is priority. Items 1 to 3 are rule violations; the rest is polish.

1. New `src/components/ConfirmSheet.tsx` (C6), wired into `/trade` (open, add guarantee, close), `/vault` (deposit, redeem, claim) and the `/settings/agent` re-grant.
2. `src/styles.css`: pin `radius-xs` to `radius-xl` in `.dark` (C1); add a `skeleton` utility (C8). Re-screenshot `/home`, `/onboard` and the pause banner.
3. `/vault`: `p-6` on the TVL card, hero to supporting row 24px; `UtilizationRing` arc to `color-accent`. `/trade`: signed and colored PnL. `/settings/agent`: regular cards, confirm anatomy (full address, domain row, limits row), unit color.
4. New `src/components/Field.tsx` (C2), replacing the three local `Field`s and `AmountInput`.
5. New `InlineBanner` (C3), replacing `ErrorBanner` and `StaleBanner` in `/gap-index`, `/stats`, `/vault`.
6. `src/components/GroupedList.tsx`: data variant, `lead`, `{ value, unit }`, nowrap values, title alignment (C4). Then restructure the `/gap-index` and `/stats` groups per R.2 and R.3.
7. `src/components/Sawtooth.tsx` per R.2 item 2; `/gap-index` live card layout per R.2 item 1.
8. `/proof` per R.4. `/stats` hero, Firsts, links, footer per R.3.
9. `/trade`: sticky glass action bar, labels above fields; router `navigate` instead of `window.location.href` (C7).

## Revision 2026-10-07 (r3): big cards, pill navigation

**Why.** The user asked for many large, minimal cards and for pill-shaped navigation. Both are layout and shape moves, so they fit r2's "bold by scale, not by count" (7.0) without adding motion or color. r2's purple and motion decisions are untouched.

**What changed.**

1. **New big card treatment** (5.4.1). `radius-xl` (32px), padding `space-6` (24px) in the app and `space-8` / `space-10` (32 / 40px) on the landing, one hero element anchored to the bottom, nested containers at a 16px inset with `radius-md`, a minimum height per surface, and one hairline top highlight (`inset 0 1px 0 rgba(255, 255, 255, 0.06)`) so a large gray slab reads as a soft object on true black instead of a hole in it.
2. **Big cards are the default for a screen's primary objects.** Home balance (240px min), home active cover (200px), cover status hero (280px), every onboarding step and the Ready card (400px), the unlock card (320px), the vault TVL card (280px), and the landing feature cards (320px, 400px from 1024px). Regular 24px cards stay for grouped lists, forms, `/trade`, sheets and settings (10).
3. **The cover status hero's amount moves from `type-num-lg` to `type-num-hero`**, because it is the one hero number on `/covers/$coverId` (12). No new type roles.
4. **Pill navigation formalized** (5.6). The architecture's top-level session routes (`/home`, `/trade`, `/vault`, `/settings`, ARCHITECTURE 4) already had a floating tab bar; r3 gives it exact geometry (64px capsule, 4px inset, 56px item pills, equal slots), a route-to-tab map for child routes, link semantics (`nav` plus `aria-current="page"`, not `tablist`), and press and hover states. The selected item keeps r2's `color-accent-tint` pill with `#A48FFF` icon and label, sliding by `layoutId` with `SPRING_SMOOTH_TWO` (7.2), unchanged.
5. **The landing nav becomes a floating glass pill** (56px, same family as the tab bar) instead of a full-width 48px bar. Same contents.
6. **Pill family table** (5.6.1): tab bar, landing nav, segmented control, onboarding progress and status chip share one geometry rule (pill in pill at an equal inset). The onboarding progress pill gets exact sizes and is specified as a non-interactive indicator, not navigation (7.6).
7. **react-bits checked, nothing adopted** (5.6.2). `PillNav` needs GSAP and `react-router-dom`; `GooeyNav` is a particle burst on every tap; `Stepper` makes step indicators clickable and removes the focus outline; `Dock` magnifies on hover; `RubberSegment` is good but is a radiogroup, not navigation. The pill nav is hand-built from TanStack Router `Link` plus a Motion `layoutId` pill, which is already how 5.6 specified the slide.

**Unchanged:** colors, type roles, motion tokens, the calm `/trade` rule, money-safety rules. `/trade` gets no big cards.

**Diff checklist for frontend-engineer.**

- `src/styles.css`: a `card-big` utility (radius, padding, highlight, `min-height` per use via a variable), section 5.4.1.
- New `src/components/TabBar.tsx` (5.6), mounted from `__root.tsx` on app routes only.
- `src/routes/index.tsx`: landing nav pill (5.6), feature cards as big cards (10).
- `src/routes/onboard.tsx`: progress pill geometry (5.6.1), step and Ready cards as big cards (10).
- `src/routes/covers/`: status hero card as a big card, amount in `type-num-hero` (10).

## Revision 2026-10-07 (r2): purple accent, bolder motion

**Why.** The user reviewed the live r1 build and asked to stay minimalist but be more visually bold and animated, and to change the blue accent to purple.

**What changed.**

1. **Accent is purple, split into two tokens**, because no single purple passes every context (2.3, full math in 2.6):
   - `color-accent` **`#A48FFF`**: text-weight uses (links, text buttons, focus ring, selected tab, field focus, thin progress bars). 7.95 / 6.44 / 5.28 on bg / s1 / s2.
   - `color-accent-fill` **`#6E54FF`** (Monad Purple, official brand kit): fills that carry white glyphs (switch on, onboarding progress, Ready mark, HeroUI fills, hero tint). White on it is 4.80.
   - The fill fails as text on dark (4.38 on bg, 2.90 on s2), and the text tint fails under white glyphs (2.64). Hence two tokens.
2. **Triggered and Observed status move from indigo to blue** (`#0091FF` dot, `#5CB8FF` text). HIG indigo `#6D7CFF` sits 8 degrees of OKLCH hue from the new fill, so a Triggered chip would read as tappable. Blue is no longer the accent, so it is free (2.5).
3. **Tab bar gets a denser glass** (`color-glass-tab`, 88% black). At 80% the selected label failed (4.22) when white content scrolled beneath (2.1, 5.6).
4. **Motion point of view: bold by scale, not by count** (7.0). One ambient motion in the product, made bigger. Larger type. Caused motion travels further.
5. **Landing hero field: Grainient is replaced by react-bits Plasma** tinted monochrome purple (7.4). Retuned Grainient stays as the fallback option.
6. **New display role `type-display-hero`** (56 / 88 / 120px, 3.2). New hero choreography and a scroll-linked hero (7.7). A recommended statement section on the landing (10).
7. **Bolder caused motion:** title-led route transitions, direction-aware onboarding steps with a continuous progress fill and a Ready moment, and micro-interactions beyond opacity (7.2, 7.8). Budget per surface in 7.9.
8. **Accent exception:** on `/` and on the onboarding Ready moment, purple may also be the brand's voice. In the app it still means "you can act" or "you are here" (1, 12).

**Unchanged:** font families, spacing and radius scales, the concentric rule, market semantics, money-safety rules (9), and the calm `/trade` rule (8). `/trade` gets no new motion. Only user-initiated control feedback (press, switch, segmented thumb) moves there, and only while the user's finger is on it.

**Diff checklist for frontend-engineer.**

- `src/styles.css`: accent tokens and HeroUI overrides (11.2), selection color (11.1), tab bar glass.
- `src/components/GaplessButton.tsx`: the text variant must read `color-accent` (`#A48FFF`). HeroUI's `accent` is now the fill `#6E54FF`, which fails as text.
- `src/components/GrainientHero.tsx`: swap Grainient for Plasma per 7.4. Delete `Grainient.tsx` once Plasma ships.
- `src/routes/index.tsx`: hero type role, italic word, reveal, scroll link (7.7), tile icons `#A48FFF`, tile reveal. Optional statement section (10).
- `src/routes/onboard.tsx`: progress pill becomes one continuous fill, step transitions, Ready moment (7.2, 10).
- `src/config/animation.ts`: add the tokens in 7.1. They are durations and staggers only; every curve is an existing one.

## 0. Decision record

### 0.1 Pick: `apple`, dark-native

The user asked for Apple-like minimal elegance with curvy, organic shapes. Three library systems came close; `apple` wins.

| Candidate            | Fit                                                                                                                                                                                     | Why not the base                                                                                                                                                                                                               |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`apple` (picked)** | Single accent, glass nav, pill CTAs, compressed headlines, "the interface retreats". Apple's own live-money surfaces (Stocks, Wallet) are the best reference for calm real-time numbers | Caps rectangle radius at 12px and bans gradients; both are relaxed on purpose (0.3)                                                                                                                                            |
| `revolut`            | Pill-everything fintech, full semantic token set, zero shadows                                                                                                                          | Billboard type (136px Aeonik) and a marketing-site feel; its semantic palette is light-mode web; Aeonik Pro is licensed                                                                                                        |
| `superhuman`         | Premium restraint, one accent, luxury tone                                                                                                                                              | Forbids pill buttons and uses only 8px and 16px radii, the opposite of "curvy"                                                                                                                                                 |
| `claude`             | Serif headlines plus sans UI, the editorial pairing the research flagged                                                                                                                | Warm paper light mode and conversational pacing; wrong for a live trading screen                                                                                                                                               |
| `kraken`             | Real trading UI                                                                                                                                                                         | 12px max radius and a dense exchange layout; reads as a generic exchange. Since r2 Gapless also has a purple accent; the difference is that ours is one concentrated accent on true black, not a brand wash over every surface |

### 0.2 Research signals and what they became

| Signal (research report, screenshots checked)                                                                                                       | Decision                                                                                                                                                     |
| :-------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serif display plus plain body on elegant finance sites: opaldex (Instrument Serif, a perp DEX), tmrw.finance (Playfair), becomeliminal (ABC Marist) | **Instrument Serif** for words at display sizes. Free (OFL), the same face opaldex uses, and the most "Apple keynote" of the three                           |
| Open Runde seen twice (nuviafinance, pivy) as type-level softness                                                                                   | **Open Runde** for all UI text. Verified: it is Inter with rounded terminals and identical metrics (x-height/UPM 0.5455 vs Inter 0.5459, cap 0.727 vs 0.728) |
| Monospace-everywhere marks the negative examples (raflux `kodeMono`, chaingpt `RobotoMono`)                                                         | Mono only for hex strings (addresses, hashes, calldata). Numbers use tabular Inter, not mono                                                                 |
| Radius tiers: sharp 0px, moderate 12 to 26px, pill 999px                                                                                            | Pill for every control, 16 to 32px for containers, **0px nowhere**                                                                                           |
| Curvy in practice means rounded chrome, rounded type and one fluid background, not blob SVGs                                                        | Exactly those three levers, plus concentric radii (4.2)                                                                                                      |
| opaldex `noise.svg` grain over a dark hero; suiperpower blue gradient glow                                                                          | One react-bits WebGL field on the landing hero only (Grainient in r1, **Plasma** since r2)                                                                   |
| Single saturated accent on neutral (pivy lime, opaldex monochrome)                                                                                  | One interactive accent, purple since r2 (`#A48FFF` text, `#6E54FF` fill; r1 was `#2997FF`). Every other hue is a state                                       |
| Negative examples: chaingpt-labs (dense card grid, mono, small radius), raflux (mono, 0px, hard edges)                                              | Banned patterns list, section 12                                                                                                                             |

### 0.3 Deviations from `apple`, each with its reason

1. **Fonts.** SF Pro may not be self-hosted for the web, and `-apple-system` renders Roboto on Android, so the brand would split by platform. Open Runde plus Inter give an SF-adjacent, platform-stable look under the CSP's `font-src 'self'`.
2. **Radius up to 32px** (Apple caps at 12px). The user asked for curvy. iOS itself uses large concentric radii on sheets and Liquid Glass surfaces, so this stays inside the Apple idiom.
3. **One fluid background** on the landing hero (Apple bans gradients). It is the single dramatic gesture and the only ambient motion in the product; app routes stay solid.
4. **Semantic colors from Apple's HIG** (iOS 26 dark values, read from Apple's HIG data on 2026-10-07), because the `apple` web file has a single accent and no state colors.
5. **Dark only.** Apple's web alternates black and light-gray sections; an app needs one mode (0.4).
6. **Purple accent anchored to Monad** (r2), not Apple Blue. Gapless runs on Monad; the accent ties the product to its chain without a logo (2.6).

### 0.4 Light or dark: dark, decided deliberately

- Apple's own trading surface, Stocks, is dark, and dark keeps green and red values bright without glare during long sessions on `/trade`.
- Darkness is not what makes chaingpt and raflux look generic; density, mono and hard corners are. opaldex and tmrw.finance prove that dark can be editorial.
- ARCHITECTURE already fixes `className="dark"` on `<html>` and dark manifest colors (ADR-W3, ADR-W8), so no cross-lane change.
- One mode halves contrast QA before the Thursday demo.
- Distinction comes from the serif, rounded type, porcelain buttons and true black, not from a light canvas.

The alternative (a light "porcelain" canvas in the becomeliminal and pivy mold) is defensible. It is listed as an open decision in section 13. Every token here is a CSS variable, so a flip is a palette swap, not a redesign.

## 1. Visual theme and atmosphere

A night gallery. True black canvas, porcelain controls, quiet gray cards with soft 24 to 32px corners. Words are set in a calm serif, the interface in a rounded sans, and every number that can change sits in a tabular face that never shifts width. The landing opens on one large, slow, purple field behind a very large serif headline; after that, the interface retreats. Color is reserved for meaning: purple says "you can act" or "you are here", every other hue says "this is the state of your money". The numbers and the decisions stay sharp.

Three rules carry the whole system:

1. **Words are serif, numbers are tabular, actions are pills.**
2. **Color means state.** No decorative color in the app. The landing and the onboarding Ready moment are the only places purple speaks for the brand.
3. **Nothing that moves money hides.** Whitespace sits around critical information, never instead of it (section 9).

## 2. Color

All values verified for contrast (WCAG 2.x relative luminance, computed 2026-10-07, r2 values recomputed the same day). AA body text needs 4.5:1; non-text UI needs 3:1.

### 2.1 Canvas and surfaces

| Token                | Hex                                                                 | Role                                                                                                                                |
| :------------------- | :------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------- |
| `color-bg`           | `#000000`                                                           | Page canvas, PWA background and theme color. Apple's black; blends into OLED and the iOS status bar                                 |
| `color-surface-1`    | `#1C1C1E`                                                           | Cards, grouped lists, sheets (HIG systemGray6 dark)                                                                                 |
| `color-surface-2`    | `#2C2C2E`                                                           | Inputs, secondary buttons, rows inside sheets (systemGray5 dark)                                                                    |
| `color-surface-3`    | `#3A3A3C`                                                           | Pressed secondary, switch track off, hairlines (systemGray4 dark)                                                                   |
| `color-thumb`        | `#636366`                                                           | Segmented control selected thumb, sheet grabber (systemGray2 dark). White on it: 6.0:1                                              |
| `color-field-border` | `#48484A`                                                           | Input border at rest (decorative; fields are identified by a persistent label)                                                      |
| `color-glass`        | `rgba(0, 0, 0, 0.8)` + `backdrop-filter: saturate(180%) blur(20px)` | Top bar on scroll, sticky action bar, landing nav (Apple nav glass, verbatim)                                                       |
| `color-glass-tab`    | `rgba(0, 0, 0, 0.88)` + the same filter                             | Tab bar only (r2). Its 12px labels are the most contrast-sensitive chrome; worst case (white content beneath) resolves to `#1F1F1F` |
| `color-scrim`        | `rgba(0, 0, 0, 0.64)`                                               | Behind sheets and dialogs                                                                                                           |

### 2.2 Text

| Token               | Hex       | On bg / s1 / s2     | Rule                                                                                |
| :------------------ | :-------- | :------------------ | :---------------------------------------------------------------------------------- |
| `text-primary`      | `#FFFFFF` | 21.0 / 17.0 / 13.9  | Default text and all primary values                                                 |
| `text-secondary`    | `#AEAEB2` | 9.5 / 7.7 / 6.3     | Labels, units, supporting copy                                                      |
| `text-tertiary`     | `#8E8E93` | 6.4 / 5.2 / **4.3** | Only on `color-bg` and `color-surface-1`. Fails AA on surface-2, never use it there |
| `text-disabled`     | `#636366` | 3.5 / 2.8 / 2.3     | Disabled controls only. Never carries information                                   |
| `text-on-porcelain` | `#1D1D1F` | 15.5 on `#F5F5F7`   | Text on the primary button and QR card                                              |

### 2.3 Interactive (r2: purple)

| Token                       | Value                           | Role                                                                                                                                                                | Contrast                                                                                                                    |
| :-------------------------- | :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------- |
| `color-accent`              | `#A48FFF`                       | Text-weight accent: links, text buttons, focus ring, field focus border, selected tab icon and label, thin progress bars, stepper tx-hash links, landing tile icons | 7.95 / 6.44 / 5.28 on bg / s1 / s2. **4.30 on s3: never text on `#3A3A3C`**                                                 |
| `color-accent-pressed`      | `#8F78FF`                       | Pressed state of text-weight accent                                                                                                                                 | 6.30 / 5.10 / 4.18 on bg / s1 / s2 (transient state)                                                                        |
| `color-accent-fill`         | `#6E54FF`                       | Fills that carry white glyphs: switch on track, onboarding progress fill, Ready mark, HeroUI accent fills, hero Plasma tint                                         | White on it **4.80**. As non-text: 4.38 on bg, 3.54 on s1, **2.90 on s2, 2.36 on s3: never the only state indicator there** |
| `color-accent-fill-pressed` | `#5B40F5`                       | Pressed fill                                                                                                                                                        | White on it 6.01                                                                                                            |
| `color-on-accent-fill`      | `#FFFFFF`                       | Any glyph on `#6E54FF`                                                                                                                                              | 4.80 (AA at 12px)                                                                                                           |
| `color-on-accent`           | `#000000`                       | Any glyph on `#A48FFF` (rare)                                                                                                                                       | 7.95. **White on `#A48FFF` is 2.64 and is not allowed**                                                                     |
| `color-accent-tint`         | `#6E54FF` at 16%                | Selected tab pill, HeroUI `accent-soft`                                                                                                                             | Resolves to `#120D29` on bg, `#292542` on s1. `#A48FFF` on it: 7.13 / 5.53                                                  |
| `color-accent-glow`         | `rgba(110, 84, 255, 0.6)`       | Primary button hover glow only (6, 7.8)                                                                                                                             | Decorative, carries nothing                                                                                                 |
| `action-primary-bg`         | `#F5F5F7`                       | Primary button fill ("porcelain")                                                                                                                                   |                                                                                                                             |
| `action-primary-pressed`    | `#EDEDF2`                       | Primary pressed (Apple button active)                                                                                                                               |                                                                                                                             |
| `action-secondary-bg`       | `#2C2C2E`                       | Secondary button fill; pressed `#3A3A3C`                                                                                                                            |                                                                                                                             |
| `focus-ring`                | `2px solid #A48FFF`, offset 2px | Every focusable element                                                                                                                                             | 7.95 on canvas. The offset keeps canvas between ring and porcelain (ring on porcelain would be 2.43)                        |

The primary button stays porcelain. Purple is not promoted to the primary fill: white on `#6E54FF` is only 4.80, porcelain is the highest-contrast object on black, and a money-moving button should look neutral and certain, not branded. Purple gets its boldness from the hero field and from scale (7.0), not from repainting the confirm button.

### 2.4 Market semantics

Source: Apple HIG system colors, iOS 26, Default (dark) and Increased contrast (dark). Unchanged in r2; the purple accent was checked against every row (2.6).

| Token             | Hex                                      | Use                                                                                               |
| :---------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------------ |
| `color-up`        | `#30D158`                                | Profit, long side, bids, price up tick. Text and fills (8.4 on s1, 6.9 on s2)                     |
| `color-down-text` | `#FF6165`                                | Loss, short side, asks, down tick, as **text**. HIG increased-contrast red (5.8 on s1, 4.7 on s2) |
| `color-down-fill` | `#FF4245`                                | Loss as **non-text** only: depth bars, icons, dots. As text it fails on s2 (4.06)                 |
| `color-depth-bid` | `#30D158` at 12% alpha (`#06190B` on bg) | Bid depth bars                                                                                    |
| `color-depth-ask` | `#FF4245` at 12% alpha (`#1F0808` on bg) | Ask depth bars                                                                                    |
| `color-warning`   | `#FF9230`                                | Pause banners, stale data, Voided, uncovered-position notice                                      |
| `color-caution`   | `#FFD600`                                | Armed                                                                                             |

Green and red have a luminance ratio of only 1.7:1 to each other, and Apple's HIG notes that red means "up" in Chinese-locale Stocks. So **direction is never color-only**: every signed value carries an explicit sign (`+` or U+2212 `−`) and, where it is a headline value, an `arrow-up-right` or `arrow-down-right` icon.

### 2.5 Cover status

Status enum from `contract/src/types/GaplessTypes.sol`. Chip background is the chip text color at 16% alpha over `color-surface-1`, precomputed below. Contrast is chip text on chip background.

| Status                        | Meaning for the user                                                                             | Dot or fill            | Chip text | Chip bg   | Contrast | Lucide icon    |
| :---------------------------- | :----------------------------------------------------------------------------------------------- | :--------------------- | :-------- | :-------- | :------- | :------------- |
| Live, warming up              | Bought; protection starts after `warmupBlocks`                                                   | `#00DAC3` ring, hollow | `#00DAC3` | `#183A38` | 6.95     | `hourglass`    |
| Live                          | Protected                                                                                        | `#00DAC3`              | `#00DAC3` | `#183A38` | 6.95     | `shield-check` |
| Armed                         | Stop crossed; trigger imminent; trading on this perp is locked (`PerpLocked`)                    | `#FFD600`              | `#FFD600` | `#403A19` | 8.09     | `shield-alert` |
| Triggered                     | Cover closed the position and paid; top-up may be owed                                           | `#0091FF`              | `#5CB8FF` | `#263542` | 5.84     | `hand-coins`   |
| Observed (Triggered sub-step) | Reference price captured; finalizing                                                             | `#0091FF`              | `#5CB8FF` | `#263542` | 5.84     | `eye`          |
| Finalized                     | Paid in full                                                                                     | `#30D158`              | `#30D158` | `#1F3927` | 6.21     | `circle-check` |
| Cancelled                     | You cancelled while Live                                                                         | `#8E8E93`              | `#AEAEB2` | `#333336` | 5.70     | `circle-slash` |
| Expired                       | Ended at expiry without a trigger; escrow refunded unless it was ever armed                      | `#8E8E93`              | `#AEAEB2` | `#333336` | 5.70     | `clock`        |
| Voided                        | Ended without payout because the position was closed, flipped, liquidated or ADL'd (`EndReason`) | `#FF9230`              | `#FF9230` | `#402F21` | 5.71     | `circle-alert` |

Triggered and Observed were indigo in r1 (`#6D7CFF` dot, `#A7AAFF` text). r2 moves them to HIG blue (`#0091FF` default dark, `#5CB8FF` increased contrast dark) because indigo sits 8 degrees of OKLCH hue from the new fill and would make the chip read as tappable. Text uses `#5CB8FF` because `#0091FF` is 3.89:1 on its own chip; the dot `#0091FF` is 5.26 on s1. Mint means protection everywhere. Neither mint nor blue is ever used for buttons or links, so a status chip never looks tappable.

### 2.6 Accent decision and contrast record (r2)

**Why this purple.** It is anchored to Monad Purple `#6E54FF` (official brand kit, monad.xyz/brand-and-media-kit, read 2026-10-07; the often-quoted `#836EF9` is the older value). OKLCH (0.576, 0.241, 282.7): a saturated violet. It is the most saturated color in the product, which is why it only appears as fills and the hero field.

The text tint `#A48FFF` is OKLCH (0.716, 0.160, 290.4). It is lighter and 7.7 degrees redder than the fill. Kept at the fill's exact hue, a tint light enough to pass on s2 drifts toward periwinkle (`#9390F7`) and starts to read as the old blue. The small redward shift keeps it unmistakably purple.

**Rejected purples.**

| Candidate                                  | Why not                                                                                                            |
| :----------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `#6E54FF` alone, as text                   | 4.38 on bg, 3.54 on s1, 2.90 on s2. Fails small text everywhere except as large text on bg                         |
| `#836EF9` (older Monad purple)             | Passes neither role: 3.69 as text on s2, 3.77 for white glyphs on it                                               |
| `#DB34F2` (HIG purple, iOS 26 dark)        | OKLCH hue 322: magenta. Only 60 degrees from loss red `#FF6165`, so it reads pink next to P&L. White on it is 3.63 |
| `#EA8DFF` (HIG purple, increased contrast) | Pink-lilac; white on it is 2.15, so it cannot carry fills                                                          |
| `#DDD7FE` (Monad light purple)             | Chroma 0.053: reads as lavender-gray, not as an accent                                                             |

**Contrast matrix (every place the r1 blue was used).**

| Pairing                                                                 | Ratio              | Needs           | Result                                                                                               |
| :---------------------------------------------------------------------- | :----------------- | :-------------- | :--------------------------------------------------------------------------------------------------- |
| `#A48FFF` text on bg `#000000`                                          | 7.95               | 4.5             | Pass (also AAA)                                                                                      |
| `#A48FFF` text on s1 `#1C1C1E`                                          | 6.44               | 4.5             | Pass                                                                                                 |
| `#A48FFF` text on s2 `#2C2C2E`                                          | 5.28               | 4.5             | Pass (r1 blue was 4.62)                                                                              |
| `#A48FFF` text on s3 `#3A3A3C`                                          | 4.30               | 4.5             | **Fail: never text on s3**                                                                           |
| `#A48FFF` on tab glass, worst case `#1F1F1F`                            | 6.24               | 4.5             | Pass                                                                                                 |
| `#A48FFF` on accent tint over tab glass worst case `#2C2743`            | 5.38               | 4.5             | Pass (at r1's 80% glass it was 4.22, hence `color-glass-tab`)                                        |
| `#A48FFF` on accent tint over bg / s1                                   | 7.13 / 5.53        | 4.5             | Pass                                                                                                 |
| `#8F78FF` pressed text on bg / s1 / s2                                  | 6.30 / 5.10 / 4.18 | 3.0 (transient) | Pass                                                                                                 |
| Focus ring `#A48FFF` on canvas                                          | 7.95               | 3.0             | Pass                                                                                                 |
| White on `#6E54FF` fill (12px caption, switch thumb, check)             | 4.80               | 4.5             | Pass                                                                                                 |
| White on `#5B40F5` pressed fill                                         | 6.01               | 4.5             | Pass                                                                                                 |
| `#6E54FF` fill vs bg / s1 (non-text)                                    | 4.38 / 3.54        | 3.0             | Pass                                                                                                 |
| `#6E54FF` fill vs s2 / s3 (non-text)                                    | 2.90 / 2.36        | 3.0             | **Fail: never the sole indicator**                                                                   |
| Switch: white thumb on `#6E54FF` track / on `#3A3A3C` off track         | 4.80 / 11.35       | 3.0             | Pass. State is carried by thumb position, as on iOS; track color alone (2.36 apart) is not relied on |
| Thin progress bar: `#A48FFF` on `#3A3A3C` track                         | 4.30               | 3.0             | Pass. **Adjusted:** the fill `#6E54FF` would be 2.36 here, so thin bars use the text-weight accent   |
| White on `#A48FFF`                                                      | 2.64               | 4.5             | **Fail: never**                                                                                      |
| Black on `#A48FFF`                                                      | 7.95               | 4.5             | Pass                                                                                                 |
| Selection: white on `#6E54FF` at 40% (`#2C2266` on bg, `#3D3278` on s1) | 13.75 / 10.90      | 4.5             | Pass                                                                                                 |
| Unselected tab label `#8E8E93` on tab glass worst case                  | 5.06               | 4.5             | Pass (was 3.88 at 80% glass)                                                                         |

**Collision check (OKLCH hue distance).**

| Against                                 | Hue           | From fill (282.7) | From text (290.4) | Verdict                                                                  |
| :-------------------------------------- | :------------ | :---------------- | :---------------- | :----------------------------------------------------------------------- |
| `color-up` `#30D158`                    | 147.0         | 135.7             | 143.4             | No conflict                                                              |
| `color-down-text` `#FF6165`             | 22.1          | 99.4              | 91.7              | No conflict. This margin is why the bluer Monad violet beats HIG magenta |
| Live mint `#00DAC3`                     | 181.6         | 101.1             | 108.8             | No conflict                                                              |
| Warning `#FF9230` / caution `#FFD600`   | 57.1 / 94.9   | 134.4 / 172.2     | 126.7 / 164.5     | No conflict                                                              |
| r1 Triggered indigo `#6D7CFF`           | 274.7         | **8.0**           | 15.7              | **Collision: moved to blue (2.5)**                                       |
| r2 Triggered blue `#0091FF` / `#5CB8FF` | 251.5 / 244.3 | 31.2 / 38.4       | 38.9 / 46.1       | Distinct, and always paired with icon and word                           |

Price, depth bars and tick cues never used blue in r1; they stay green and red. Nothing chart-related migrates.

**Migration map.**

| Where                                 | r1                             | r2                                                           |
| :------------------------------------ | :----------------------------- | :----------------------------------------------------------- |
| Links, text buttons                   | `#2997FF`, pressed `#0071E3`   | `#A48FFF`, pressed `#8F78FF`                                 |
| Focus ring, field focus border        | `#2997FF`                      | `#A48FFF`                                                    |
| Selected tab                          | `#2997FF` icon and label       | `#A48FFF` icon and label on a `color-accent-tint` pill (5.6) |
| Switch on                             | `#2997FF` track                | `#6E54FF` track, white thumb                                 |
| Onboarding progress (`onboard.tsx`)   | `#2997FF` segments, black text | One continuous `#6E54FF` fill, white captions (4.80)         |
| Home budget bar                       | `#2997FF` on `#3A3A3C`         | `#A48FFF` on `#3A3A3C` (4.30), not the fill                  |
| Stepper tx-hash links                 | accent                         | `#A48FFF`                                                    |
| Landing tile icons (`index.tsx`)      | `#2997FF`                      | `#A48FFF` (landing exception)                                |
| Text selection                        | accent at 32%                  | `#6E54FF` at 40%                                             |
| HeroUI `accent` / `accent-foreground` | `#2997FF` / `#000000`          | `#6E54FF` / `#FFFFFF`, plus overrides (11.2)                 |
| Hero WebGL tint and static fallback   | `#2997FF`                      | `#6E54FF` (7.4)                                              |
| Triggered, Observed chips             | indigo                         | blue (2.5)                                                   |

## 3. Typography

### 3.1 Families

| Role                 | Family                  | Package (exact pin)                                              | Weights loaded         | Why                                                                        |
| :------------------- | :---------------------- | :--------------------------------------------------------------- | :--------------------- | :------------------------------------------------------------------------- |
| Display (words only) | Instrument Serif        | `@fontsource/instrument-serif` 5.3.0                             | 400 normal, 400 italic | Editorial elegance; seen on opaldex, a perp DEX peer                       |
| UI and body          | Open Runde              | `@fontsource/open-runde` 5.3.0                                   | 400, 500, 600          | Rounded terminals: organic at the type level                               |
| Numbers              | Inter Variable          | `@fontsource-variable/inter` 5.3.0 (installed as ^5.2.8; pin it) | wght 100 to 900        | Has `tnum`. Same skeleton as Open Runde, so they sit inline without a seam |
| Hex strings          | JetBrains Mono Variable | `@fontsource-variable/jetbrains-mono` 5.3.0                      | wght 400               | Unambiguous `0 O 1 l` for address verification                             |

**Why numbers are not set in Open Runde.** The Fontsource build ships GSUB features `aalt case frac locl ordn zero` only: no `tnum`. Its digit advances range from 1331 to 1842 units, so a price set in it changes width on every tick and the row jitters. Inter's subset keeps `tnum` (verified in `inter-latin-wght-normal.woff2`).

Fallback stacks: Open Runde, then `"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Instrument Serif, then `Georgia, "Times New Roman", serif`. JetBrains Mono, then `ui-monospace, "SF Mono", Menlo, monospace`. All self-hosted (CSP `font-src 'self'`).

### 3.2 Roles

Open Runde and Inter tracking follow Inter's published dynamic metrics (`tracking = -0.0223 + 0.185 × e^(-0.1745 × size)` em, from rsms.me/inter), which apply because the outlines are shared. Instrument Serif tracking is set by eye at -0.01em, tightened to -0.02em at hero scale.

| Token                    | Family           | Size                                     | Weight | Line height      | Tracking                  | Use                                                     |
| :----------------------- | :--------------- | :--------------------------------------- | :----- | :--------------- | :------------------------ | :------------------------------------------------------ |
| `type-display-hero` (r2) | Instrument Serif | 56px; 88px from 768px; 120px from 1024px | 400    | 1.00; 0.96; 0.92 | -1.12px; -1.76px; -2.40px | Landing hero headline only. Max width 12ch              |
| `type-display-xl`        | Instrument Serif | 72px                                     | 400    | 1.00             | -0.72px                   | Landing statements from 1024px                          |
| `type-display`           | Instrument Serif | 48px                                     | 400    | 1.04             | -0.48px                   | Landing statements on mobile, landing section heads     |
| `type-title-1`           | Instrument Serif | 34px                                     | 400    | 1.10             | -0.34px                   | Page large titles: "Trade", "Your cover", "Vault"       |
| `type-title-2`           | Open Runde       | 22px                                     | 600    | 1.27             | -0.40px                   | Sheet titles, card headings                             |
| `type-headline`          | Open Runde       | 17px                                     | 600    | 1.29             | -0.22px                   | Row titles, emphasized labels, button labels (lg)       |
| `type-body`              | Open Runde       | 17px                                     | 400    | 1.47             | -0.22px                   | Default text                                            |
| `type-callout`           | Open Runde       | 15px                                     | 400    | 1.40             | -0.13px                   | Helper text, sheet explanations                         |
| `type-label`             | Open Runde       | 15px                                     | 500    | 1.33             | -0.13px                   | Field labels, segmented labels, button labels (md)      |
| `type-footnote`          | Open Runde       | 13px                                     | 400    | 1.38             | -0.04px                   | Fine print, disclosures (never smaller for money terms) |
| `type-caption`           | Open Runde       | 12px                                     | 500    | 1.33             | 0px                       | Tab labels, chip text                                   |
| `type-num-hero`          | Inter            | 40px                                     | 500    | 1.00             | -0.89px                   | Home balance, trade mark price                          |
| `type-num-lg`            | Inter            | 28px                                     | 500    | 1.07             | -0.59px                   | "You pay at most", payout amount, cap                   |
| `type-num`               | Inter            | 17px                                     | 500    | 1.29             | -0.22px                   | Values in rows and fields                               |
| `type-num-sm`            | Inter            | 13px                                     | 400    | 1.54             | -0.04px                   | Order book, block numbers, timestamps                   |
| `type-mono`              | JetBrains Mono   | 15px                                     | 400    | 1.47             | 0px                       | Full addresses in confirmation sheets, CLI command      |
| `type-mono-sm`           | JetBrains Mono   | 13px                                     | 400    | 1.38             | 0px                       | Tx hashes, truncated addresses, error codes             |

All `type-num*` roles set `font-variant-numeric: tabular-nums`.

### 3.3 Rules

- Serif never renders a value that changes, a control, or anything under 34px.
- Weight ceiling is 600. No 700, no all-caps labels, no letter-spaced overlines.
- Body copy is left-aligned. Only the landing hero headline and the landing statements center.
- The hero headline may set one word in Instrument Serif italic ("Stop-loss that _actually_ stops."). Italic is the only emphasis display type gets. Never color, never a gradient.
- Numbers inside running sentences stay in Open Runde. Numbers in value slots (rows, fields, headers, book) use the `type-num` roles.

### 3.4 Number formatting

| Case                        | Format                                                                                                               |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| AUSD amounts                | `1,234.56` then a thin space (U+2009) and `AUSD` in `text-secondary`, `type-label`                                   |
| Signed values (P&L, deltas) | Always signed: `+12.40`, `−3.10` with U+2212 (present in Inter and Open Runde). Zero shows `0.00` unsigned           |
| Prices                      | Exactly the market's `priceDecimals`. Never rounded in confirmation sheets                                           |
| Size                        | `22 lots` with `0.00022 BTC` in `text-secondary` beside it                                                           |
| Blocks                      | `#111,234,567` in `type-num-sm`; durations as blocks plus approximate time ("12,000 blocks, about 1 h")              |
| Percentages and bps         | `0.50%` in UI, bps only in an expandable "details" row                                                               |
| Unknown or loading          | A skeleton bar sized in `ch` to the expected digits (tabular figures make the width exact). No dash placeholders     |
| Addresses, full             | `0x` then groups of 4 separated by thin spaces: `0x B07C 20cb 5328 …`. Used wherever the user verifies a destination |
| Addresses, short            | `0xB07C20…1771` (6 after `0x`, 4 at the end). Only in passive display, always with a copy button                     |

## 4. Shape and space

### 4.1 Radius scale (the curvy lever)

| Token           | Value  | Use                                                                                                                              |
| :-------------- | :----- | :------------------------------------------------------------------------------------------------------------------------------- |
| `radius-xs`     | 8px    | Skeleton bars, tooltips, inline source tags ("onchain")                                                                          |
| `radius-sm`     | 12px   | Inner tiles inside cards, list thumbnails                                                                                        |
| `radius-md`     | 16px   | Input fields, toasts, grouped rows inside sheets, banners, containers nested in a big card (r3)                                  |
| `radius-lg`     | 24px   | Regular cards, QR card                                                                                                           |
| `radius-xl`     | 32px   | Sheet top corners, dialogs, every big card (r3, 5.4.1): cover status hero, home balance, onboarding steps, landing feature cards |
| `radius-full`   | 9999px | Every button, chip, segmented control and thumb, switch, tab bar                                                                 |
| `radius-circle` | 50%    | Icon buttons, status dots, stepper nodes, Ready mark                                                                             |

### 4.2 Concentric rule

A shape nested inside another uses `inner radius = outer radius − inset`. A card at 24px with a 8px inset holds 16px tiles; a sheet at 32px with a 16px inset holds 16px groups; a pill segmented control with a 4px inset holds a pill thumb. This is what makes stacked shapes feel organic instead of pasted together. Never use 0px corners on a container, and never use a radius that is not on the scale.

r3: a big card (32px) puts text at its 24px padding but nested containers at a 16px inset, so they take `radius-md` (32 − 16). Pills are exempt from the subtraction because their radius follows their height; a pill inside a pill sits at an equal inset on all four sides (5.6.1). A centered object that shares no corner with its parent (the QR card on the Fund step) keeps its own radius.

### 4.3 Spacing (4px base)

| Token      | Value | Typical use                                              |
| :--------- | :---- | :------------------------------------------------------- |
| `space-1`  | 4px   | Icon to label, segmented inset                           |
| `space-2`  | 8px   | Chip padding (vertical), tight stacks                    |
| `space-3`  | 12px  | Label to field, chip padding (horizontal)                |
| `space-4`  | 16px  | Row padding (vertical), sheet inset                      |
| `space-5`  | 20px  | Page gutter on mobile, card padding                      |
| `space-6`  | 24px  | Gutter from 768px, gap between cards                     |
| `space-8`  | 32px  | Section gap inside a page                                |
| `space-10` | 40px  | Large title to content                                   |
| `space-12` | 48px  | Bottom clearance above the tab bar                       |
| `space-16` | 64px  | Landing block padding on mobile, statement gap on mobile |
| `space-24` | 96px  | Landing section gap and statement gap from 1024px        |

### 4.4 Sizes

- Touch target minimum 44×44px. List rows at least 52px tall.
- Button heights: `lg` 56px (sticky action bars, sheet confirm), `md` 44px (default), `sm` 32px (inline chips and copy).
- App column max width 480px, centered from 768px up. `/trade` breaks out to two columns from 1024px (8.2). Landing container max 1120px.
- Safe areas: tab bar and sticky bars add `env(safe-area-inset-bottom)`; top bar adds `env(safe-area-inset-top)` (the manifest is `standalone`).

## 5. Components

### 5.1 Buttons (all `radius-full`)

| Variant     | Fill                  | Text                       | Pressed               | Use                                                                         |
| :---------- | :-------------------- | :------------------------- | :-------------------- | :-------------------------------------------------------------------------- |
| Primary     | `#F5F5F7`             | `#1D1D1F`, `type-headline` | `#EDEDF2`, scale 0.97 | The one main action per screen: "Review order", "Confirm", "Create account" |
| Secondary   | `#2C2C2E`             | `#FFFFFF`                  | `#3A3A3C`             | "Sign in", "Cancel" in sheets, "Copy"                                       |
| Text        | none                  | `#A48FFF`                  | `#8F78FF`             | "Show 20 levels", "View on MonadVision"                                     |
| Destructive | `#2C2C2E`             | `#FF6165`                  | `#3A3A3C`             | "Cancel cover", "Close position". Never filled red                          |
| Icon        | `#2C2C2E` circle 44px | `#FFFFFF` 20px icon        | `#3A3A3C`             | Copy, QR, close                                                             |

- One primary per screen. Two porcelain buttons side by side is a bug.
- Hover and press feedback for every variant: 7.8.
- Disabled: fill `#2C2C2E`, text `#636366`, and a one-line reason directly under it in `type-footnote` `text-secondary` ("Buys are paused by the protocol"). A disabled money button without a visible reason is not allowed. Disabled buttons get no hover feedback.
- Loading: the label stays, a 16px `loader-circle` spins at the trailing edge, width does not change, the button ignores taps.

### 5.2 Fields

- Fill `#2C2C2E`, `radius-md`, 52px tall, 1px `#48484A` border, padding 0 16px. Label above in `type-label` `text-secondary`, always visible (never placeholder-only).
- Numeric fields: value in `type-num`, unit suffix (`AUSD`, `lots`, `x`) inside the field in `text-secondary`, `inputmode="decimal"`.
- Focus: border becomes 2px `#A48FFF` (5.28 on the s2 fill). Error: border 2px `#FF6165`, message below with `circle-alert` icon (5.9). Helper and error text never shift layout: reserve one line.
- Bounds are shown, not discovered: "Min 15 bps from mark, max 2.00%" under the stop field.

### 5.3 Segmented control and switch

- Segmented: container `#1C1C1E` on bg (or `#2C2C2E` inside a card), `radius-full`, 40px, 4px inset; thumb `#636366` pill; labels `type-label`, selected `#FFFFFF`, unselected `#AEAEB2`. Long and Short carry a 14px `arrow-up-right` (`#30D158`) or `arrow-down-right` (`#FF4245`) beside the word. The thumb stays neutral: side is stated in words and icon, not by painting the control red or green, and not purple either. The thumb slides between options (7.2).
- Switch: 51×31px, track off `#3A3A3C`, on `#6E54FF`, thumb `#FFFFFF`. The label sits on the left and the consequence on the right once it is on ("Guarantee · 1.84 AUSD"). Press stretch: 7.8.

### 5.4 Cards and grouped lists

- Card: `#1C1C1E`, `radius-lg`, padding 20px, no border, no shadow.
- Grouped list (iOS inset grouped): rows inside one card, 1px `#3A3A3C` separators inset 20px from the left, label left in `type-body`, value right in `type-num`, optional `chevron-right` in `#8E8E93`.
- Tappable cards and rows press to scale 0.98 (7.8). Static cards never react.

#### 5.4.1 Big cards (r3)

A big card holds one idea at a size you can read across a room: one hero element, a lot of air, and nothing dense. It is the default container for a screen's primary objects. Everything that is a list, a form or live data stays a regular card.

| Property                  | App (`/home`, `/covers/$coverId`, `/onboard`, `/vault`, unlock card)                                                          | Landing (`/`)                                                                       |
| :------------------------ | :---------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| Radius                    | `radius-xl` 32px                                                                                                              | `radius-xl` 32px                                                                    |
| Padding                   | `space-6` 24px on all sides, every breakpoint (the app column caps at 480px, so the card never gets wide enough to need more) | `space-8` 32px; `space-10` 40px from 1024px                                         |
| Fill                      | `#1C1C1E` (or a status / Ready glow over it, 6)                                                                               | `#1C1C1E`                                                                           |
| Edge                      | Top highlight `inset 0 1px 0 rgba(255, 255, 255, 0.06)`. No border, no drop shadow                                            | Same                                                                                |
| Gap between stacked cards | `space-6` 24px                                                                                                                | `space-6` 24px                                                                      |
| Nested containers         | At a 16px (`space-4`) inset from the card edge, `radius-md` (4.2)                                                             | None: icon, title and body only, so the larger padding has no concentric constraint |
| Width                     | Full app column                                                                                                               | One column below 1024px; three equal columns from 1024px                            |

**Why the edge highlight, and only on big cards.** On true black a 24px card reads as a quiet gray shape. At 350×240px and larger, the same flat `#1C1C1E` starts to read as a gray hole in the page, the "oversized dashboard tile" look. Drop shadows are invisible on `#000000`, and a full border would outline the card like a form field. A 1px top highlight (resolves to about `#2A2A2C`) catches light where a rounded object would, so the 32px corners read as soft volume. It stays below the glass chrome's 0.08 highlight (6), so floating chrome is always the brightest edge on screen. Regular cards keep no edge at all.

**Anatomy.**

- Flex column, `justify-content: space-between`. Top: a label in `type-label` `text-secondary`, a status chip, or an icon, with an optional trailing `chevron-right` or icon button. Bottom: the hero element, then at most one supporting row.
- Exactly one hero element: a value in `type-num-hero` or `type-num-lg`, or a word in `type-title-1`. A screen has at most one `type-num-hero` (12), so a second big card on the same screen uses `type-num-lg`.
- Spacing: label to hero `space-2` (8px); hero to supporting row `space-6` (24px); supporting row to action `space-6`.
- Actions sit at the bottom padding, full width, `lg` (56px). At most one primary per screen still applies (5.1).
- More than three value rows means it is a regular card with a grouped list, not a big card.
- Height uses `min-height`, never `aspect-ratio` or a fixed height, so zoom and larger text grow the card instead of clipping it.

**Where they apply** (page specs in 10):

| Surface                                             | Min height               | Hero element                                           | Notes                                              |
| :-------------------------------------------------- | :----------------------- | :----------------------------------------------------- | :------------------------------------------------- |
| `/home` balance card                                | 240px                    | Balance, `type-num-hero`                               | Static                                             |
| `/home` active cover card                           | 200px                    | Cap or payout, `type-num-lg`                           | Status glow, tappable, links to `/covers/$coverId` |
| `/covers/$coverId` status hero                      | 280px                    | Payout or cap, `type-num-hero` (r3; was `type-num-lg`) | Status glow                                        |
| `/onboard` step card (Keys, Fund, Create, Activate) | 400px                    | Step title, `type-title-1`                             | Top-aligned content, action pinned to the bottom   |
| `/onboard` Ready card                               | 400px                    | Ready mark, then "You're ready" in `type-title-1`      | Ready glow, centered content                       |
| Unlock card (any route that needs a session)        | 320px                    | "Unlock Gapless", `type-title-1`                       | Centered content                                   |
| `/vault` TVL card                                   | 280px                    | TVL, `type-num-hero`                                   | Utilization ring top right                         |
| `/` feature cards                                   | 320px; 400px from 1024px | Title, `type-title-1`                                  | Icon top, title and body bottom                    |

**Never a big card:** anything on `/trade` (book and form stay regular cards, 8), sheets and their contents, grouped lists (`/settings`, the home session card), banners, the "Fund your trading key" card, and `/settings/agent`.

**Interaction.** Static big cards never react. A tappable big card presses to scale 0.98 like any tappable card, and on fine pointers its top highlight rises from 0.06 to 0.12 opacity (7.8). No lift and no glow in the app; the 4px lift stays a landing-only behavior.

### 5.5 Status chip

Pill, 28px tall, padding 0 12px, 14px icon plus `type-caption` at weight 500; colors from 2.5. Chips state, they never act: no hover state, no pointer cursor.

### 5.6 Navigation

- **Tab bar, the pill nav** (app routes only): floating glass pill on `color-glass-tab`, 64px tall, inset 12px from the sides and 12px plus safe area from the bottom, `radius-full`, one shadow `0 8px 30px rgba(0, 0, 0, 0.5)`. Four items: Home (`house`), Trade (`chart-candlestick`), Vault (`vault`), Settings (`settings`), 24px icons over `type-caption` labels. Selected: `#A48FFF` icon and label on a `color-accent-tint` pill inset 4px (concentric), which slides to the new tab on navigation (7.2). Others `#8E8E93`. Hidden on `/`, `/onboard`, and while a sheet is open. r3 geometry and states:

  | Property     | Spec                                                                                                                                                                                                                                                                                                                                      |
  | :----------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Container    | 64px tall, `radius-full`, 4px (`space-1`) inset on all sides. Width: viewport minus 24px below 768px; 392px centered from 768px (4 × 96px slots + 8px)                                                                                                                                                                                    |
  | Items        | Four equal slots (`grid-template-columns: repeat(4, 1fr)`), each 56px tall, `radius-full`, at least 12px (`space-3`) horizontal padding. On a 390px phone a slot is 89.5px; "Settings" at 12px needs about 48px                                                                                                                           |
  | Item content | 24px icon, `space-1` gap, `type-caption` label (weight 500 in both states, so selecting never reflows the label)                                                                                                                                                                                                                          |
  | Selected     | `color-accent-tint` pill filling the slot (`#6E54FF` at 16%); icon and label `#A48FFF` (5.38 at the worst-case glass, 2.6)                                                                                                                                                                                                                |
  | Unselected   | Icon and label `#8E8E93` (5.06 at the worst-case glass). Hover on fine pointers: `#AEAEB2`, 160ms `EASE_OUT_QUART`. No fill on hover: the fill means "you are here"                                                                                                                                                                       |
  | Press        | Icon and label scale 0.92, 120ms `EASE_OUT_QUART`. The tint pill does not scale, so the press never fights the slide                                                                                                                                                                                                                      |
  | Slide        | The tint pill is one Motion element with `layoutId`, `SPRING_SMOOTH_TWO`, the same treatment r2 gave tab and segmented highlights (7.2). It moves while the route's title-led enter runs; it gets no stretch or squash, because two expressive motions at once would compete. Reduced motion: it jumps (7.5)                              |
  | Focus        | `focus-ring` on the item pill (2px `#A48FFF`, offset 2px fits inside the 4px inset), 6.24 on the worst-case glass                                                                                                                                                                                                                         |
  | Semantics    | `<nav aria-label="Primary">` with four TanStack Router `Link`s. `Link` sets `aria-current="page"` and `data-status="active"` itself (verified in the installed 1.147.3 source); style from `data-status`. Not `role="tablist"`: tabs switch panels inside one page, these change routes. Tab key moves between links; no arrow-key roving |
  | Route to tab | `/home` Home; `/trade` Trade; `/vault` Vault; `/settings` and `/settings/agent` Settings (fuzzy match does this); `/covers/$coverId` Home, set explicitly because the path is not under `/home` and the active cover card lives there. On a session route without a session, the bar stays so the user can leave the unlock card          |

- **Top bar**: large serif title (`type-title-1`) that collapses into a 17px `type-headline` inline title once scrolled, with the glass background appearing at the same time. Back is a 44px icon button, never a text link.
- **Landing nav** (r3: a floating pill instead of Apple's full-width 48px bar): `color-glass` capsule, 56px tall, `radius-full`, glass top highlight (6), no shadow. Top offset 12px plus `env(safe-area-inset-top)`. Width: viewport minus 24px below 768px; max 560px centered from 768px, so it hugs its three items instead of spanning 1120px of empty glass. Wordmark left at 20px (`space-5`) padding. Right: "Sign in" text button, `space-2` gap, "Create account" primary (sm, 32px) at a 12px right inset, which matches its 12px vertical inset (pill in pill, 5.6.1). Over the Plasma hero the worst case beneath the glass is white, which resolves to `#333333`: `#A48FFF` on it is 4.78, white wordmark 12.6. Always glass, no scroll-linked change, so the hero choreography (7.7) stays the only motion on the page.

#### 5.6.1 Pill family (r3)

Every horizontal control container in Gapless is a pill, and every pill that holds pills uses one rule: the same inset on all four sides, so the inner capsule is concentric with the outer one.

| Pill                | Height | Inset | Inner pill                     | Role                          | Spec  |
| :------------------ | :----- | :---- | :----------------------------- | :---------------------------- | :---- |
| Tab bar             | 64px   | 4px   | 56px item, `color-accent-tint` | Navigation (links)            | 5.6   |
| Landing nav         | 56px   | 12px  | 32px sm buttons                | Navigation chrome             | 5.6   |
| Segmented control   | 40px   | 4px   | 32px `#636366` thumb           | In-page choice (`radiogroup`) | 5.3   |
| Onboarding progress | 40px   | 4px   | 32px continuous `#6E54FF` fill | Indicator, not interactive    | Below |
| Status chip         | 28px   | none  | none                           | State, never acts             | 5.5   |

**Onboarding progress pill (exact geometry for r2's spec in 10).** Container `#1C1C1E`, 40px, `radius-full`, 4px inset, full width of the onboarding column. Five equal slots (Keys, Fund, Create, Activate, Ready), labels `type-caption` centered in each slot (68px per slot on a 390px phone; "Activate" needs about 50px). The fill is one 32px pill from the first slot's leading edge to the active slot's trailing edge, springing per 7.2. It is an `<ol aria-label="Account setup">` with `aria-current="step"` on the active item. No focus stop, no hover, no pointer cursor: steps are derived from chain state and cannot be chosen (7.6), so it must not look tappable. That is also why it is not the tab bar's sliding tint: a tint pill under one label would say "you could move this".

#### 5.6.2 react-bits check (r3)

Registry `https://reactbits.dev/r/registry.json` read 2026-10-07 (214 components). Nav, pill and segmented candidates, all rejected:

| Component       | Deps                       | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| :-------------- | :------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PillNav`       | `gsap`, `react-router-dom` | GSAP is removed (7.1) and Gapless routes with TanStack Router. Its hover is a rising circle fill per item and it plays a logo spin and width reveal on load: decoration, the "bold by count" failure (7.0)                                                                                                                                                                                                                                                                                                                                           |
| `GooeyNav`      | none                       | Fires 15 randomly colored particles and an SVG goo filter on every tap, colors outside the palette. Its own `<a href>` state is not the router's                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Stepper`       | `motion`                   | Step indicators are clickable by default, the indicator sets `focus:outline-none` (no focus ring), it owns Back and Continue state that `/onboard` derives from chain reads, and it has no reduced-motion handling                                                                                                                                                                                                                                                                                                                                   |
| `Dock`          | `motion`                   | Hover magnification: desktop only, and moves icons under the pointer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RubberSegment` | `motion`                   | The best built of the set: `radiogroup` with roving tabindex, arrow keys, `useReducedMotion`, pointer capture, and a clipped second label layer so the active label color flips exactly at the thumb edge. Still wrong for navigation: radio semantics with arrow keys would change routes on every arrow press, and its stretch, squash and flick would play on top of the route transition. Not adopted for the segmented control either, since r3 leaves 5.3 as is; its clipped-label technique is the one idea worth reusing if 5.3 is revisited |

HeroUI v3 `Tabs` (installed 3.2.6, React Aria based) can render tabs as links, but keeps `role="tab"` and arrow-key selection, the same semantic problem. So the pill nav is hand-built: TanStack Router `Link` for semantics and active state, one Motion `motion.span` with `layoutId` for the tint pill, CSS for hover and press. That is about 40 lines and adds no dependency.

### 5.7 Sheets and dialogs

- Mobile: bottom sheet on `color-surface-1`, `radius-xl` top corners, grabber 36×5px `#636366` pill, scrim `rgba(0, 0, 0, 0.64)`, max height 92dvh, content scrolls, footer actions sticky on glass.
- From 768px: centered dialog, max width 480px, `radius-xl` on all corners.
- Every value-moving sheet follows the anatomy in 9.1.

### 5.8 Banners

- Global (`__root`): pause, halt, `SPONSOR_DISABLED`. Card style inside the page gutter, `radius-md`, background `#402F21`, `triangle-alert` in `#FF9230`, title `type-headline` `#FFFFFF`, one line of `type-callout` `#AEAEB2`. Not dismissible while the condition holds.
- Inline (live data stale, keeper unavailable): same anatomy, placed in the affected section.

### 5.9 Error block

`circle-alert` 20px `#FF6165`, title `type-headline` `#FF6165` (5.8:1 on s1), body `type-callout` `#FFFFFF`, then the raw code in `type-mono-sm` `#8E8E93` (for support, for example `StopTooClose(12, 15)`), then the fix as a text button when one exists ("Set stop to 15 bps"). Body copy is white, not red: long red text on black is tiring and less legible.

### 5.10 Toasts

Only for non-critical acknowledgements ("Copied"). Pill, `#2C2C2E`, `radius-full`, above the tab bar, 2 s. **Errors and transaction outcomes are never toasts.**

### 5.11 QR card

`#F5F5F7` card, `radius-lg`, modules `#000000` drawn as JSX rects from `uqr` (ARCHITECTURE 8.4), quiet zone of 4 modules, 240px square on mobile. Dark-on-light is deliberate: scanners read it reliably. The full chunked address in `type-mono` sits below it on the dark canvas, with a copy button.

### 5.12 Skeletons

`#2C2C2E` bars, `radius-xs`, width in `ch` for numbers. Opacity pulse 0.5 to 0.8 over 1.6 s, off under reduced motion. No shimmer sweep.

### 5.13 Stepper (cover lifecycle)

Vertical timeline. Node 12px circle, connector 2px `#3A3A3C`. Done nodes fill with the status color; the current node adds a soft halo (`box-shadow: 0 0 0 6px` status color at 16%). Each step shows title (`type-headline`), block (`type-num-sm`), and tx hash (`type-mono-sm`, `#A48FFF`, `external-link` icon). End states (Cancelled, Expired, Voided) terminate the line with their chip and the `EndReason` in plain words.

### 5.14 Order book

Rows 28px, `type-num-sm`. Price colored (`#30D158` bids, `#FF6165` asks), size `#AEAEB2`, numbers right-aligned on a fixed column width. Depth bar behind each row, anchored right, `color-depth-bid` or `color-depth-ask`, drawn with `transform: scaleX()`. Mobile stack: asks (reversed) on top, mid price row, bids below.

## 6. Depth and elevation

Dark interfaces show elevation through surface steps, not shadows.

| Level              | Treatment                                                                                                       | Use                                                                                                         |
| :----------------- | :-------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| 0                  | `#000000`                                                                                                       | Canvas                                                                                                      |
| 1                  | `#1C1C1E`                                                                                                       | Cards, sheets                                                                                               |
| 2                  | `#2C2C2E`                                                                                                       | Fields and controls inside level 1                                                                          |
| Big card edge (r3) | `#1C1C1E` plus `inset 0 1px 0 rgba(255, 255, 255, 0.06)`; 0.12 on hover when tappable                           | Big cards only (5.4.1). Combines with a status or Ready glow background; it is still the card's only shadow |
| Glass              | `color-glass` (tab bar: `color-glass-tab`) plus a top inner highlight `inset 0 1px 0 rgba(255, 255, 255, 0.08)` | Tab bar, top bar, sticky action bar, landing nav                                                            |
| Float              | `0 8px 30px rgba(0, 0, 0, 0.5)`                                                                                 | The floating tab bar only (Apple's single wide soft shadow, adapted for black)                              |
| Status glow        | `radial-gradient(120% 80% at 50% 0%, <status color at 20%>, transparent 70%)` over `#1C1C1E`                    | The cover status hero card only. Static CSS; cross-fades on status change (7.2)                             |
| Ready glow (r2)    | `radial-gradient(60% 50% at 50% 30%, rgba(110, 84, 255, 0.24), transparent 70%)` over `#1C1C1E`                 | The onboarding Ready card only. Static CSS                                                                  |
| Accent glow (r2)   | `0 8px 32px -8px rgba(110, 84, 255, 0.6)`                                                                       | Primary button hover on fine pointers only (7.8). Never at rest, never on touch                             |

No borders on cards; big cards get the 1px top highlight above and nothing more. No stacked shadows. No glassmorphism on cards: glass is for chrome that floats above scrolling content.

## 7. Motion

### 7.0 Point of view: bold by scale, not by count (r2)

Minimalism limits how many things compete for attention. It says nothing about how large or how confident each one is. "Animated" sites usually fail by count: sparkles on buttons, glows on cards, shimmering text, cursor trails. Each one is small; together they are noise, and on a money app noise reads as risk. Gapless gets bolder the other way: **fewer, larger, slower.**

1. **One ambient motion in the whole product: the landing hero field.** It fills the viewport, has one hue and moves slowly. It is the single thing that moves on its own. Nothing else in the product does.
2. **Type carries the volume.** The hero headline goes to 120px serif. Scale is the boldest move a minimal page has, and it costs zero frames.
3. **Everything else moves only when caused:** by arrival (a page, a step, a section scrolling in), by the user's hand (press, hover, drag), or by a real state change (cover status). Caused motion may be pronounced: longer travel (16 to 64px instead of r1's 8px), blur-to-sharp on display type, springs that visibly settle.
4. **Purple is concentrated, not sprinkled:** large in one place (the hero field), crisp in small places (what you can act on), absent everywhere else.
5. **Data never performs.** Numbers do not animate, and `/trade`'s live zones gain nothing (8).

The test for any new animation: remove it. Does the user lose information, or the sense of what caused a change? If neither, and it is not the hero field, it does not ship.

### 7.1 Libraries and tokens

| Tool                                                                                    | Decision                                                                                                                                                                          | Where                                                                                                                            |
| :-------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| **Motion** (`motion` 12, installed)                                                     | The only JS animation library in the app                                                                                                                                          | Route transitions, sheets, onboarding steps, status changes, landing reveals, landing scroll links (`useScroll`, `useTransform`) |
| CSS transitions                                                                         | Default for anything simple                                                                                                                                                       | Press states, hover, switch, depth bars, tick color cue                                                                          |
| **react-bits Plasma** (`Plasma-TS-TW`, `@react-bits` registry, depends on `ogl` 1.0.11) | Landing hero only, lazy-loaded. Replaces Grainient (r2)                                                                                                                           | `/` hero background (7.4)                                                                                                        |
| react-bits Grainient                                                                    | Removed once Plasma ships. Kept as the fallback option in 7.4                                                                                                                     | Nowhere                                                                                                                          |
| GSAP                                                                                    | **Remove.** Also rules out react-bits SplitText, ScrollReveal, ScrollFloat, MaskedHeading and AnimatedContent, which all depend on it; their patterns are rebuilt in Motion below | Nowhere                                                                                                                          |
| Lenis                                                                                   | **Remove** (ADR-W3). Smooth-scroll inertia makes live prices feel late and fights the book's own scroller and the sheets                                                          | Nowhere; native scroll everywhere                                                                                                |

Reuse the existing tokens in `src/config/animation.ts`; do not invent new curves. r2 adds durations and staggers only:

| New token           | Value                                      | Use                                              |
| :------------------ | :----------------------------------------- | :----------------------------------------------- |
| `TRANSITION_HERO`   | `{ duration: 1.2, ease: EASE_OUT_EXPO }`   | Plasma fade-in from black                        |
| `TRANSITION_REVEAL` | `{ duration: 0.9, ease: EASE_OUT_EXPO }`   | Display-type word and line reveals               |
| `TRANSITION_EXIT`   | `{ duration: 0.15, ease: EASE_OUT_QUART }` | Route and step exits                             |
| `STAGGER_LOOSE`     | `0.08` s                                   | Hero headline words, landing tiles               |
| `STAGGER_TIGHT`     | `0.06` s                                   | Title then content on route enter and step enter |

### 7.2 Where each animation lives

| Surface                               | Animation                                                                                                                                 | Spec                                                                                                       |
| :------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| Route change, app routes              | Title leads: the large serif title rises 24px and fades in; content follows 60ms later, rising 16px                                       | `SPRING_CONTENT_ENTRY`, `STAGGER_TIGHT`. Exit: opacity to 0 and 8px up, `TRANSITION_EXIT`                  |
| Route change into or out of `/trade`  | Opacity only                                                                                                                              | `TRANSITION_FAST` in, `TRANSITION_EXIT` out. No transform and no stagger on the price header or book (8.1) |
| Sheet open and close                  | Slide from bottom, scrim fade                                                                                                             | `SPRING_SMOOTH_SLIDE` (stiffness 200, damping 30)                                                          |
| Onboarding step change                | Direction-aware: next step enters from 64px right, previous exits 64px left (mirrored when going back). Step title leads the body by 60ms | `SPRING_CONTENT_ENTRY` in, `TRANSITION_EXIT` out, `AnimatePresence` with `mode="popLayout"`                |
| Onboarding progress                   | One continuous `#6E54FF` fill springs to the active step's trailing edge                                                                  | `SPRING_SMOOTH_TWO`, layout animation                                                                      |
| Onboarding Ready                      | Mark scales in, check draws, one ring expands and fades (7.8)                                                                             | Mark `SPRING_SMOOTH_ONE`; check 400ms `EASE_OUT_CUBIC`; ring 900ms `EASE_OUT_EXPO`, once                   |
| Cover status advance                  | Chip morphs (layout animation), stepper node fills, halo moves, status glow cross-fades to the new color                                  | `SPRING_SMOOTH_ONE` (0.45 s, no bounce); glow 600ms `EASE_OUT_CUBIC`                                       |
| Finalized                             | Check icon stroke draws once                                                                                                              | 400 ms `EASE_OUT_CUBIC`. No confetti, no bounce                                                            |
| Tab bar                               | Selected tint pill slides to the new tab                                                                                                  | `SPRING_SMOOTH_TWO` via `layoutId`                                                                         |
| Segmented control                     | Thumb slides to the new option                                                                                                            | `SPRING_SMOOTH_TWO` via `layoutId`                                                                         |
| Buttons, switch, copy, tappable cards | 7.8                                                                                                                                       | CSS and Motion, per 7.8                                                                                    |
| Depth bars                            | `scaleX`                                                                                                                                  | CSS 120 ms linear                                                                                          |
| Price tick cue                        | Changed trailing digits turn `#30D158` or `#FF6165`, then return to white                                                                 | Color transition 400 ms ease-out, no movement                                                              |
| Landing hero field                    | Plasma                                                                                                                                    | 7.4                                                                                                        |
| Landing hero entrance and scroll      | Field fades up from black, headline words resolve from blur, hero recedes on scroll                                                       | 7.7                                                                                                        |
| Landing statements and tiles          | Scroll-linked line reveal; tiles rise in once                                                                                             | 7.7                                                                                                        |

### 7.3 Zero-motion zones

- **Numbers never animate their digits.** No count-ups, no rolling odometers (this rules out react-bits CountUp and Counter). A rolling number displays values that never existed, which is misleading on a money screen and makes a 0.3 s chain feel slow.
- Confirmation sheet contents appear all at once, with no row stagger, so no value "arrives late" after the user has started reading.
- Errors and banners appear instantly. This includes the landing's in-app-browser and PRF banners, which never wait for the hero choreography.
- Focus rings appear instantly.
- No ambient motion outside the landing hero field: no breathing glows, pulsing dots, shimmer, cursor effects or marquees. The `/trade` freshness dot is steady (8.1).

### 7.4 Landing hero field: Plasma (r2)

**Options considered.** All three exist in the `@react-bits` registry (`https://reactbits.dev/r/registry.json`, checked 2026-10-07) and need only `ogl`, which is already pinned.

| Option                           | What it is                                                                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                          |
| :------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Plasma (recommended)**      | A raymarched, twisting column of light that rises through the frame. `color` prop tints it to a single hue (output is intensity × color) | **Pick.** It has a center of mass, so the hero gets one focal object on the headline's axis instead of a wash. Monochrome by construction, so purple stays the only hue. Best runtime hygiene in the catalog: built-in reduced-motion (static frame), IntersectionObserver pause, `visibilitychange` pause, WebGL context-loss handling, DPR cap, FPS cap, internal render scale |
| B. Grainient, retuned (fallback) | r1's grainy gradient swirl, made bolder                                                                                                  | Zero new code. Use it if Plasma drops frames on the demo phone. Props: `color1 '#000000'`, `color2 '#6E54FF'`, `color3 '#A48FFF'`, `timeSpeed 0.2`, `warpStrength 1.4`, `contrast 1.4`, `saturation 1.0`, `grainAmount 0.1`, `zoom 0.8`. Bolder than r1, but still a field with no focal point                                                                                   |
| C. Orb                           | A glowing ring that wobbles and rotates on hover                                                                                         | Not recommended. Its shader hard-codes violet, cyan and navy and only rotates hue across all three, so cyan (near Live mint) can't be removed without editing GLSL. No offscreen pause, no tab pause, no DPR cap, no reduced-motion handling                                                                                                                                     |

Also rejected, so nobody re-proposes them: SoftAurora (no offscreen or tab pause; horizontal bands fight the centered axis), Silk and LiquidEther (add `three`), MetaBalls and Strands (busier, no pause), all cursor effects (SplashCursor, GlowCursor, BlobCursor: desktop-only noise, absent on the demo phone), and small decorations (ClickSpark, Magnet, StarBorder, ElectricBorder, GlareHover, ShinyText, GradientText: the "bold by count" failure in 7.0; gradient text would also make the accent decorative). SlideCommit and HoldButton change the Confirm interaction, which 9.1 fixes as a plain button the same size as Cancel.

**Plasma spec.**

- Pull with the shadcn CLI from the `@react-bits` registry (`Plasma-TS-TW`). The source lands in the repo and gets reviewed like our own code. `ogl` stays pinned at 1.0.11.
- Starting props: `color '#6E54FF'`, `speed 0.5`, `direction 'forward'`, `scale 1.1`, `opacity 1`, `mouseInteractive false`, `renderScale 0.5`, `maxDpr 1.5`, `targetFps 30`, `iterations 60` (48 when `(pointer: coarse)` matches), `lightMode false`. Tune visually. If the column reads too dim at the edges, try `color '#A48FFF'`; stay within those two hexes. Keep `speed` at 0.6 or below: bold here means large and slow, not fast.
- Why `mouseInteractive false`: the pointer effect is tiny, absent on touch, and our hero text overlays the canvas anyway. The scroll link in 7.7 is the "it responds to me" moment, and it works on the phone.
- Composition: canvas fills the hero (`absolute inset-0`). The column stands centered on the same vertical axis as the headline. Nothing else in the hero is decorated.
- Wrapper (keep r1's `GrainientHero` pattern, renamed): dynamic import after first paint; static fallback while loading, under `prefers-reduced-motion: reduce` (no WebGL at all, lighter than Plasma's own static frame), inside the existing error boundary, and when WebGL2 is unavailable. Check `canvas.getContext('webgl2')` before mounting: Plasma's shader is GLSL `300 es`, and `ogl` silently falls back to WebGL1, where it would compile-fail to a blank canvas instead of throwing.
- Source fix on pull: Plasma's cleanup removes the canvas but never releases the GL context. Add `gl.getExtension('WEBGL_lose_context')?.loseContext()` on unmount. Browsers cap live contexts, and `/` to `/onboard` and back would otherwise leak one per visit. r1's Grainient has the same gap.
- Legibility: hero text sits over the r1 scrim `linear-gradient(to top, #000000 0%, rgba(0, 0, 0, 0) 60%)`, so headline contrast never depends on where the plasma happens to be.
- Static fallback: `radial-gradient(40% 55% at 50% 40%, rgba(110, 84, 255, 0.45), transparent 70%), radial-gradient(18% 30% at 50% 35%, rgba(164, 143, 255, 0.25), transparent 70%), #000000`. A soft centered column, so the composition holds without WebGL.

### 7.5 Reduced motion

Under `prefers-reduced-motion: reduce`:

- Transforms become 150 ms opacity fades. Layout animations jump.
- The hero shows the static fallback (no WebGL). The headline renders whole, with no word split. Scroll-linked transforms are off, and statements render at full opacity.
- Route and step transitions become opacity only. Tab and segmented pills jump.
- The Ready ring does not play; the check appears already drawn.
- Hover lift and glow stay, because they are static states, not motion. The skeleton pulse stops.
- The price tick color cue stays, because it is a color change, not motion.

### 7.6 Onboarding is a stepper, not a scroll-snap carousel

`/onboard` state is derived from chain reads (ARCHITECTURE 5.1) and the user cannot do step 3 before step 2 is funded. A swipeable scroll-snap track would let them swipe to steps they cannot act on. Instead: one step on screen, a 5-segment progress pill at the top, and the Motion step transition from 7.2. Native vertical scroll inside a step.

### 7.7 Landing choreography and scroll (r2)

**Entrance (runs once, total under 1.4 s, never blocks input):**

1. 0ms: canvas is black. Plasma (or its fallback) fades from 0 to 1 opacity, `TRANSITION_HERO`.
2. 150ms: headline words resolve one by one: from `opacity 0, y 24px, filter blur(12px)` to `opacity 1, y 0, blur(0)`, `TRANSITION_REVEAL`, `STAGGER_LOOSE` per word. Built with Motion directly, not react-bits BlurText: BlurText renders a `<p>` (the hero needs an `<h1>`) and ignores reduced motion. Keep the `<h1>` text intact for assistive tech (`aria-label` on the `h1`, word spans `aria-hidden`).
3. Headline end + 200ms: subline, then the CTA row 80ms later, each with `FADE_IN_UP`. Buttons are focusable and pressable from first paint; their fade is cosmetic.

**Scroll-linked hero (Motion `useScroll` on the hero section, offset `['start start', 'end start']`):**

- Plasma layer: `scale` 1 to 1.15, `opacity` 1 to 0 over the full range.
- Headline block: `y` 0 to -80px, `opacity` 1 to 0 by 60% of the range.
- Transform and opacity only, so it stays on the compositor. This is the bold moment on the phone: the column swells and dissolves as the user scrolls into the content.

**Statements (recommended new section, 10):** each line is its own block. Its `opacity` maps 0.16 to 1 and `y` 24px to 0 as the line moves from 90% to 40% of the viewport (`useScroll` with the line as target, offset `['start 0.9', 'start 0.4']`). Scroll-linked, so it reverses when the user scrolls back. Per line, not per word: per-word lighting is one decoration too many.

**Feature tiles:** `whileInView` once, `y` 32px to 0 and `scale` 0.98 to 1 with opacity, `SPRING_CONTENT_ENTRY`, `STAGGER_LOOSE` across the three.

### 7.8 Micro-interactions (r2)

Feedback is a change in shape or light, not just opacity. Hover styles apply only under `@media (hover: hover) and (pointer: fine)`, so touch never gets stuck hover states.

| Element                | Hover (fine pointer)                                        | Press                                                                                                                 | Spec                                                                                                                                                                                                                                        |
| :--------------------- | :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary (porcelain)    | Lifts 1px, gains `color-accent-glow` shadow (6)             | Scale 0.97, back to 0px, glow off, `#EDEDF2`                                                                          | 160ms `EASE_OUT_QUART` (CSS)                                                                                                                                                                                                                |
| Secondary, destructive | Fill `#2C2C2E` to `#3A3A3C`                                 | Scale 0.97                                                                                                            | 160ms `EASE_OUT_QUART`                                                                                                                                                                                                                      |
| Icon button            | Fill to `#3A3A3C`                                           | Scale 0.92                                                                                                            | 120ms `EASE_OUT_QUART`                                                                                                                                                                                                                      |
| Text button, link      | A 1px `#A48FFF` underline draws from left (width 0 to 100%) | Color `#8F78FF`                                                                                                       | 240ms `EASE_OUT_QUART`                                                                                                                                                                                                                      |
| Copy                   |                                                             | Icon swaps `copy` to `check` with scale 0.5 to 1, reverts after 1.6 s, plus the "Copied" toast                        | `SPRING_BOUNCE_ONE`. The only bounce in the app: copying moves no money                                                                                                                                                                     |
| Switch                 |                                                             | Thumb stretches from 27px to 34px wide toward the travel direction while held (iOS behavior); track color cross-fades | Thumb `SPRING_SMOOTH_TWO`; track 200ms `EASE_OUT_QUART`                                                                                                                                                                                     |
| Tappable card or row   |                                                             | Scale 0.98                                                                                                            | 120ms ease-out                                                                                                                                                                                                                              |
| Tappable big card (r3) | Top highlight 0.06 to 0.12 opacity                          | Scale 0.98                                                                                                            | Highlight 200ms `EASE_OUT_QUART`; press 120ms ease-out                                                                                                                                                                                      |
| Tab bar item (r3)      | Unselected icon and label `#8E8E93` to `#AEAEB2`            | Icon and label scale 0.92; tint pill does not scale                                                                   | 160ms hover, 120ms press, `EASE_OUT_QUART`. Slide: 7.2                                                                                                                                                                                      |
| Landing tile           | Lifts 4px                                                   |                                                                                                                       | 300ms `EASE_OUT_QUART`. No shadow, no glow                                                                                                                                                                                                  |
| Onboarding Ready mark  |                                                             |                                                                                                                       | 88px `#6E54FF` circle scales 0.6 to 1 (`SPRING_SMOOTH_ONE`), white 40px `check` draws (400ms `EASE_OUT_CUBIC`), one 2px `#A48FFF` ring scales 1 to 1.8 while fading 0.6 to 0 (900ms `EASE_OUT_EXPO`), once. Card carries the Ready glow (6) |

Primary hover glow on a money button is allowed: it appears only under the user's own pointer, it is static while hovered, and it says "you can act", which is what purple means. It never animates on its own and never appears on touch.

### 7.9 Motion budget by surface (r2)

| Surface                                                         | Ambient                                              | Entrance                                                       | Feedback                                                                                                   |
| :-------------------------------------------------------------- | :--------------------------------------------------- | :------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `/`                                                             | Plasma field, the only ambient motion in the product | Hero choreography, scroll-linked hero, statements, tiles (7.7) | Hover lift and glow, press (7.8)                                                                           |
| `/onboard`                                                      | None                                                 | Direction-aware steps, title leads; continuous progress fill   | Ready moment, press, copy                                                                                  |
| App routes (`/home`, `/vault`, `/settings`, `/covers/$coverId`) | None                                                 | Title-led route enter                                          | Press, switch, segmented, copy, tab pill, status advance                                                   |
| `/trade`                                                        | None                                                 | Opacity only                                                   | User-initiated only: press, switch, segmented thumb. Live zones: the tick color cue and nothing else (8.1) |
| Sheets                                                          | None                                                 | Slide up                                                       | Confirm's 600ms input guard (9.2), press                                                                   |

## 8. `/trade`: calm frame, live core

The tension: the brand is calm, but the data refreshes on every new head (about 0.3 s blocks) and the book streams over the WebSocket. The answer, modeled on Apple Stocks: **contain the motion, do not soften it.** Live data is confined to two zones and updates instantly; everything else stays perfectly still until the user acts. r2's bolder motion does not reach this route (7.9).

### 8.1 Rules

1. **Two live zones only:** the price header (mark, best bid and ask) and the order book. The form, the quote and the action bar never update unless the user changes an input or the quote refreshes.
2. **Instant values, capped repaint rate.** The header coalesces to at most one paint per 500 ms; the book coalesces to one paint per animation frame, with rows keyed by price so the DOM is reused. No transitions on numeric text.
3. **No layout shift.** Tabular figures plus fixed column widths, so a tick changes glyphs, never geometry.
4. **One quiet tick cue:** only the digits that changed take the up or down color for 400 ms (7.2). No row flashes, no background blinks.
5. **Freshness is always visible and quiet when fine.** A small "Live" label with a steady `#8E8E93` dot next to the block number (`type-num-sm`). When the socket reports `down`, a heartbeat `sn` gap appears, or the reconnect starts, the label becomes "Reconnecting" with a `#FF9230` dot, the live core dims to 40% opacity, and the values hold their last state with "Updated 12 s ago" (ARCHITECTURE 5.2, 8.7). The form stays usable because limit and mark come from chain reads.
6. **Two sources, labeled.** The header shows WebSocket prices (display). The confirmation sheet shows the onchain mark and the limit that are actually in the calldata, labeled "Onchain mark, block #N". If the two differ by more than 50 bps, the sheet says so in one line.
7. **The quote never blanks.** While a re-quote runs, the last value stays with a 12px spinner and "Updating" in `text-tertiary`. A failed quote replaces the value with the error block (5.9).
8. **Density by disclosure.** On mobile the book shows 5 levels per side; "Show 20 levels" expands it. Desktop shows 12.
9. **Native scroll only.** `overscroll-behavior: contain` on the book scroller so it never drags the page.
10. **No entrance choreography.** The route fades in (7.2); the header and book never slide, scale, blur or stagger.

### 8.2 Layout

Mobile (portrait, the demo device):

```text
[Top bar]  BTC-PERP                       Live · #111,234,567
[Header]   62,431.5          (type-num-hero)
           Bid 62,430.0  Ask 62,433.0      (type-num-sm, green/red)
[Book card, collapsed, 5 per side, "Show 20 levels"]
[Form card]
   Long | Short                          (segmented, neutral thumb)
   Size      [ 22 lots ]  0.00022 BTC
   Leverage  [ 3x ]
   Stop      [ 62,119.0 ]  Min 15 bps from mark
   Guarantee                       ( off )   -> on: "1.84 AUSD"
[Sticky glass action bar]
   Long 22 lots · Guarantee off · gas paid in MON
   [        Review order        ]   (primary, lg)
```

From 1024px: two columns inside a 1120px container. Left: header plus book (12 levels) plus the live label. Right: the form in a 400px sticky card with the action at its bottom. The tab bar stays.

## 9. Fund-safety UI rules

These implement ARCHITECTURE 8.5 ("confirmation sheet built from decoded calldata") and keep elegant minimalism from turning into hidden information.

### 9.1 Confirmation sheet anatomy (every value-moving action)

Top to bottom:

1. **Title as a plain verb phrase:** "Open long and buy cover", "Cancel cover", "Withdraw 50.00 AUSD".
2. **The total, first and largest:** "You pay at most" in `type-num-lg` with the AUSD unit, then one line with what that total contains.
3. **Decoded rows** (grouped list, `type-num` values, from decoded calldata, not form state): perp, side (word plus arrow icon), lots and BTC, limit price, stop, max premium, cover cap, expiry (blocks plus approximate time), warm-up, rent floor marked **"Non-refundable"** as a visible tag, never a tooltip.
4. **Network cost:** gas limit, max MON cost, and the trading key's MON balance after this transaction.
5. **Destination:** "Your Gapless account" plus the full chunked address (`type-mono`), with a `circle-check` once it matches `accountOf(owner)`.
6. **Footer details row (collapsed by default, one tap):** function name and selector (`tradeAndCover`, `type-mono-sm`), chain 143, data source block.
7. **Actions:** "Confirm" (primary, lg) and "Cancel" (secondary, lg), same size, side by side or stacked. Cancel is never a faint text link.

### 9.2 Rules

- **No pre-checked boxes.** The Guarantee switch starts off on every visit (the architecture allows no preference storage, and a pre-enabled paid add-on is a sneak-into-basket pattern). Open decision 13.3 covers the demo implication.
- **No countdown pressure.** Quotes go stale; that is shown as state, not as a ticking timer. When the quote is older than the freshness bound or the price has moved past the premium slack, "Confirm" becomes "Refresh quote". No progress rings, no red seconds.
- **Accidental-tap guard:** Confirm ignores input for the first 600 ms after the sheet opens, so a double-tap on "Review order" cannot confirm. No visual timer for this.
- **Everything that costs money is in the sheet.** Fees, rent, non-refundable parts, and the uncovered window of the ADR-W6 fallback ("Your position is uncovered for about a minute while the cover is bought") appear as rows before Confirm, never after.
- **Typed-data signature sheets** (`CreateAccount`, `SetOperator`, `Withdraw`) show the human fields plus a domain check row: "Verified: GaplessAccount v1, Monad 143, 0x…" with `circle-check`. If the domain check fails, the sheet becomes a hard stop with an error block and **no continue button**.
- **Agent grant** (ARCHITECTURE 7.2 step 4) uses the architecture's plain-language sentence verbatim as the sheet body, with the limits in `type-num-lg` and "It can never withdraw" in `type-headline`.
- **Transaction lifecycle is a persistent state, not a toast:** Sending, then Confirming (hash shown, link to MonadVision), then Done or Reverted with the decoded reason. While a hash is unresolved the button stays in its loading state and cannot resend (ARCHITECTURE 8.7).
- **Destructive actions** (cancel cover, close position) use the destructive button and a sheet that states what the user gets back and what they lose ("Escrow refunded: 1.20 AUSD. Rent kept: 0.40 AUSD").
- **Paused or blocked states explain themselves** with a banner and a disabled reason (5.1). Never a silently grey button.

### 9.3 Error copy

Map `error.code` and decoded revert names to copy (`src/lib/errors.ts`), never relay `message`. Each entry has a title (what happened, under 6 words), a body (why, and what it means for the user's money), and an optional fix action. Examples of tone:

| Code                     | Title                          | Body                                                                                                            |
| :----------------------- | :----------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `StopTooClose(d, min)`   | Stop is too close              | Covers need the stop at least 15 bps from the mark. Yours is 12.                                                |
| `SigmaStale`             | Pricing needs a refresh        | The volatility input for BTC is older than 30 minutes. We've asked for a fresh one, which takes about a minute. |
| `OperatorBudgetExceeded` | Daily limit reached            | This trading key can move 100 AUSD a day and has 21.40 left.                                                    |
| `NOT_ALLOWLISTED`        | Gapless is invite-only for now | Send this address to the team to get access.                                                                    |

## 10. Page blueprints

Every page needs loading, empty and error states. Every page that needs a session shows an unlock card in place (ARCHITECTURE section 4), never a redirect.

Unlock card (r3): a big card (5.4.1), 320px min, content centered: `lock-keyhole` 32px in `#AEAEB2`, "Unlock Gapless" in `type-title-1`, one line of `type-callout` `text-secondary` ("Use your passkey to see your balance and covers."), then "Unlock with passkey" (primary, lg). The tab bar stays visible beneath it.

### `/` Landing

Glass pill nav (5.6). Full-viewport hero (`100svh`): Plasma field behind (7.4), bottom scrim, then centered: headline in `type-display-hero`, "Stop-loss that _actually_ stops." with "actually" in Instrument Serif italic, white like the rest. Then one line of `type-body` in `#AEAEB2` (max 36ch), then "Create account" (primary) and "Sign in" (secondary) side by side. Under "Create account", one footnote: "Makes a new passkey. Already have one? Sign in." (a second create makes an unrelated account, ARCHITECTURE section 4). The in-app browser and PRF preflight messages render as banners above the hero buttons, instantly (7.3). Entrance and scroll behavior: 7.7.

Below the fold, on solid black:

1. **Statements (recommended, r2).** Three lines, one idea each, `type-display` on mobile and `type-display-xl` from 1024px, centered, `space-16` apart on mobile and `space-24` from 1024px, scroll-lit per 7.7. This is where the landing gets bold without decoration: big type, one line at a time. Proposed copy:
   - "A stop-loss is a request, not a promise."
   - "When price gaps through it, you fill wherever the market lands."
   - "Gapless covers the gap and pays you the difference."
2. **Three feature cards** explaining the cover in plain words, as big cards (r3, 5.4.1): `radius-xl`, `#1C1C1E` with the top highlight, padding 32px (40px from 1024px), min height 320px (400px from 1024px), one column below 1024px and three equal columns from 1024px, `space-6` gap. Icon 32px in `#A48FFF` top left (landing exception, 1); title in `type-title-1` and one or two lines of `type-body` in `#AEAEB2` (max 32ch) anchored to the bottom. These are the "tiles" in 7.7 and 7.8: reveal and hover lift unchanged.
3. Read-only links for judges.

### `/onboard`

Progress pill (Keys, Fund, Create, Activate, Ready): container `#1C1C1E`, `radius-full`, 4px inset, 40px tall (geometry and semantics in 5.6.1). One `#6E54FF` fill runs from the first segment to the active one and springs forward as steps complete (7.2). Labels on the fill are white (4.80); labels beyond it are `#8E8E93` (5.2 on s1). `space-6` below it, then one big card per step (r3, 5.4.1): 400px min, serif step title at the top, content below it, and the step's action pinned to the card's bottom padding. Keys: owner and trading key in grouped rows with copy buttons. Fund: QR card, full chunked deposit address, live AUSD balance in `type-num-lg` with "10.00 AUSD needed". Create and Activate: a single primary button and a lifecycle state (9.2). Ready: the Ready card (a big card with the Ready glow, 6; 400px min, content centered) with the Ready mark (7.8), the serif title "You're ready", then "Start trading". Ready is the progress fill completing, which is why it is purple and not Finalized green: it marks where you are, not the state of money.

### `/home`

Large title "Home". Top to bottom, `space-6` apart:

1. **Balance card** (big card, r3, 5.4.1): full width of the app column, 240px min, 24px padding. "Balance" in `type-label` `text-secondary` top left. Bottom: the balance in `type-num-hero` with `AUSD` per 3.4, then the breakdown as one nested row at the 16px inset (`#2C2C2E`, `radius-md`, padding 12px 16px): three equal columns, wallet, Perpl free, in position, each a `type-footnote` `text-secondary` label over a `type-num` value. Static.
2. **Active cover card** (big card): 200px min, status glow (6). Status chip top left, `chevron-right` `#8E8E93` top right. Bottom: cap (Live, Armed) or payout (Triggered onward) in `type-num-lg`, then one `type-callout` `text-secondary` line ("Stop 62,119.0 · ends in about 3 h"). Tappable, links to `/covers/$coverId` (7.8).
3. **Session card** (regular card): trading key expiry, per-trade cap, budget left as a thin pill progress bar (`#A48FFF` on `#3A3A3C`, 4.30; not the fill, which is 2.36 there).
4. A "Fund your trading key" card (regular) only when the drip was skipped.

Empty history: one sentence and a text button to Trade.

### `/trade`

Section 8.

### `/covers/$coverId`

Status hero card, a big card (r3, 5.4.1): `radius-xl`, status glow, 280px min, 24px padding. Chip top left. Bottom: payout or cap in `type-num-hero` (r3; was `type-num-lg`, but this is the screen's one hero number), then one `type-callout` `text-secondary` line with the stop and side. Static. `space-8` below it, the stepper (5.13). Countdowns (window, expiry) shown as blocks plus approximate time in `text-secondary`, never as urgent red. "Finalizing" until the block is final. Cancel (P1) as a destructive button with the M-03 escrow rule stated in the sheet. "Keeper status unavailable" as an inline banner while the stepper keeps working from chain reads.

### `/settings`

Grouped lists: Session (key, expiry, caps, usage), Account (withdraw, close position), Security (export phrase, P2). Withdraw follows 9.1 with an owner signature sheet. Export phrase: fresh ceremony, words blurred until tapped, no auto-copy (ARCHITECTURE 8.3).

### `/settings/agent`

Current operator card, agent address field (validated with an inline reason for each refusal), limits form with bounds shown under each field, plain-language grant sheet (9.2), then the output card: signature and the full `mm gapless link …` command in `type-mono` on `#2C2C2E` with copy, plus a QR card of the command.

### `/vault`

Large title "Vault". TVL card, a big card (r3, 5.4.1), 280px min: "Total value locked" label top left, utilization as an 88px ring gauge top right (curved shape that also carries data), TVL in `type-num-hero` at the bottom, reserved amount as the supporting row. The max-loss disclosure is a full card with `type-body` text at normal size, directly under the numbers, never a footnote.

## 11. Implementation mapping (for frontend-engineer)

### 11.1 Packages

Add (exact pins): `@fontsource/open-runde` 5.3.0, `@fontsource/instrument-serif` 5.3.0, `@fontsource-variable/jetbrains-mono` 5.3.0, `ogl` 1.0.11. Pin `@fontsource-variable/inter` at 5.3.0. Remove: `gsap`, `lenis` (plus the starter's `AnimateComponent` and `LenisSmoothScrollProvider`). Delete `html { scroll-behavior: smooth }` from `styles.css`. Replace the starter's neutral palette, scrollbar and selection styles with these tokens (selection: `#6E54FF` at 40% alpha behind `#FFFFFF`). r2: pull `Plasma-TS-TW` from `@react-bits`; delete `Grainient.tsx` once Plasma ships (`ogl` stays).

### 11.2 HeroUI: flip to v3 (ADR-W3, Q6)

I read the v3 theming handbook (heroui.com/docs/react/getting-started/theming): v3 is Tailwind 4 native with semantic CSS variables (`background`, `accent`, `accent-foreground`, `surface`, `surface-foreground`, `success`, `warning`, `danger`, `muted`, `border`, `separator`, `focus`), a radius scale derived from one base `radius`, a separate `field-radius`, and a Drawer component. That maps one to one onto this file's tokens; v2's JS plugin offers only three radius steps. No Gapless component exists yet, so the switch is cheapest now. Use BUILD_PLAN's pin, `@heroui/react` 3.2.6. Verify exact variable names against the v3 docs when wiring.

r2 note: in the installed `@heroui/styles` build, `accent` is painted almost only as a fill (switch, slider, checkbox, radio, progress bar, meter, tabs indicator, accent badge and chip). So HeroUI `accent` maps to the fill `#6E54FF`. Its dark theme derives three text-like variables from `accent`; each must be overridden, or purple text lands at 2.90 to 4.38.

| HeroUI v3 variable                       | Value                                                                                           |
| :--------------------------------------- | :---------------------------------------------------------------------------------------------- |
| `background`                             | `#000000`                                                                                       |
| `foreground`                             | `#FFFFFF`                                                                                       |
| `surface` / `surface-foreground`         | `#1C1C1E` / `#FFFFFF`                                                                           |
| `accent` / `accent-foreground`           | `#6E54FF` / `#FFFFFF`                                                                           |
| `accent-hover`                           | `#6E54FF` (HeroUI's default mixes in 10% foreground; a lighter fill drops white text below 4.5) |
| `accent-soft` / `accent-soft-foreground` | `#6E54FF` at 16% / `#A48FFF` (override: the default is `accent`)                                |
| `focus`                                  | `#A48FFF` (override: the default is `accent`)                                                   |
| `link`                                   | `#A48FFF`                                                                                       |
| `success`                                | `#30D158`                                                                                       |
| `warning`                                | `#FF9230`                                                                                       |
| `danger`                                 | `#FF6165`                                                                                       |
| `muted`                                  | `#AEAEB2`                                                                                       |
| `border`                                 | `#48484A`                                                                                       |
| `separator`                              | `#3A3A3C`                                                                                       |
| `radius` base                            | so that cards resolve to 24px and sheets to 32px                                                |
| `field-radius`                           | 16px                                                                                            |

The porcelain primary button is a custom Button variant (HeroUI's accent fill would make it purple). Buttons get `radius-full` everywhere. The text button variant reads `color-accent` (`#A48FFF`) or `link`, never `accent`. Spinners inherit `currentColor`; never give a HeroUI Spinner `color="accent"` (`#6E54FF` is 2.90 on s2).

### 11.3 Tailwind 4 `@theme`

Expose every token in sections 2 to 4 under `@theme` with the names used here (`color-bg`, `color-surface-1`, `color-accent`, `color-accent-fill`, `text-secondary`, `radius-lg`, `space-5` and so on), plus font families `font-display` (Instrument Serif), `font-sans` (Open Runde), `font-num` (Inter Variable), `font-mono` (JetBrains Mono). Typography roles become utility classes (`type-num-hero`, `type-display-hero` and so on) defined once in `styles.css`. No raw Tailwind palette classes (`bg-neutral-900`, `text-violet-400`) anywhere in app code, and no raw purple hexes in components either: read the tokens.

### 11.4 Manifest and head

`theme_color` and `background_color` `#000000`; `<meta name="theme-color" content="#000000">`; `apple-mobile-web-app-status-bar-style` `black-translucent` with safe-area padding (4.4). Unchanged in r2: the status bar stays black, not purple.

### 11.5 Icons

Lucide (installed), 20px default, 24px in the tab bar, stroke 1.75. Names used in this file were checked against the installed `lucide-react`: `house`, `chart-candlestick`, `vault`, `settings`, `shield`, `shield-check`, `shield-alert`, `hourglass`, `hand-coins`, `eye`, `circle-check`, `circle-slash`, `clock`, `circle-alert`, `triangle-alert`, `arrow-up-right`, `arrow-down-right`, `copy`, `check`, `qr-code`, `external-link`, `chevron-right`, `loader-circle`, `x`.

## 12. Do and don't

### Do

- Keep one primary (porcelain) action per screen.
- Use `#A48FFF` for purple text, icons and rings; `#6E54FF` only for fills under white glyphs.
- In the app, use purple only for what the user can act on or where they are (selected tab, progress, focus). On `/` and the Ready moment it may also speak for the brand.
- Make bold things bigger, not more numerous: one moving field, one very large headline (7.0).
- Use Inter tabular figures for every value slot; give skeletons `ch` widths.
- Apply the concentric radius rule whenever shapes nest.
- Put each screen's primary object in a big card with one hero element and a lot of air (5.4.1). Size comes from `min-height`, never fixed heights.
- Build navigation as pills inside pills at an equal inset (5.6.1), with links and `aria-current`, not tabs.
- Pair every up or down color with a sign and, for headline values, an arrow.
- Put the total cost first in every confirmation sheet.
- State why anything is disabled, paused or stale, in words, where it happens.

### Don't

- Don't use mono for numbers, labels or headings (raflux, chaingpt).
- Don't build dense stat-card grids; use grouped lists and one hero number per screen (chaingpt).
- Don't use big cards on `/trade`, in sheets, or for grouped lists, and don't put more than three value rows in one. Don't give a big card a border or a drop shadow.
- Don't make the onboarding progress pill focusable or hoverable; it reports chain state and cannot be chosen.
- Don't use 0px corners or off-scale radii.
- Don't animate digits, stagger confirmation rows, or add smooth-scroll.
- Don't add ambient motion anywhere except the landing hero field: no breathing glows, pulsing dots, shimmer, cursor effects, particles or marquees.
- Don't add transforms, blur or stagger to anything on `/trade` beyond user-initiated control feedback.
- Don't use red or green as decoration, or paint the Long and Short control in red, green or purple.
- Don't use the serif for values, controls or anything under 34px. Don't color or gradient display type.
- Don't put gradients, glows or WebGL anywhere except the landing hero, the cover status card, the Ready card and the primary hover glow.
- Don't use toasts for errors or transaction results.
- Don't use white text on `#A48FFF`, `#6E54FF` as text on any dark surface, `#A48FFF` as text on `#3A3A3C`, `#8E8E93` text on `#2C2C2E`, or `#FF4245` / `#0091FF` as small text.
- Don't pre-enable paid options, show countdown pressure, or make Cancel smaller than Confirm.

## 13. Open decisions for the user

1. **Dark only (recommended) or a light "porcelain" canvas.** Section 0.4. Dark matches Stocks, the architecture and the trading use; light would be more distinctive from crypto sites. Flipping later is a palette swap.
2. **HeroUI v3 (decided here per ADR-W3).** If frontend-engineer judges the migration too costly before Thursday, v2 works: the tokens stay the same, only the wiring changes.
3. **Guarantee switch starts off.** This is the honest default, but it adds one tap to the RUNBOOK step 5 demo. The alternative, default on with the premium shown inline, is a sneak-into-basket pattern on a paid add-on. Recommendation: keep it off.
4. **Wordmark.** None exists. Proposal: "Gapless" set in Instrument Serif 400 for the landing and the PWA icon (a white serif "G" on black), Open Runde 600 in the app top bar.
5. **Hero field (r2): Plasma (recommended) or retuned Grainient.** Judge on the demo phone. If Plasma holds 30 fps with `iterations 48`, ship it; otherwise option B in 7.4 is a prop edit away.
6. **Purple family (r2): Monad violet (chosen) or Apple magenta.** Monad violet ties Gapless to its chain and keeps 99 degrees of hue from loss red. Apple's `#DB34F2` is more "pink-purple" and sits 60 degrees from loss red. Swapping is two token edits plus a contrast recheck.
7. **Statement section copy (r2).** The three lines in 10 are a proposal; the section works with any three short sentences of one idea each.
