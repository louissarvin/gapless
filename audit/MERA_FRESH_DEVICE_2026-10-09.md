# Mera fresh-device passkey reconstruction, verified

Run: 2026-10-09, against the real local dev server (`http://localhost:3200`), real onboarding UI,
real `@category-labs/mera` PRF ceremonies. No source changes, no test bypass, no stubbed logic.

## Method
Chrome's CDP `WebAuthn.addVirtualAuthenticator` (`ctap2_1`, `hasResidentKey: true`,
`hasUserVerification: true`, `hasPrf: true`) attaches a software authenticator that exercises the
exact same deterministic HKDF-based WebAuthn PRF construction a real platform authenticator (Touch
ID, Windows Hello, a hardware key) uses. This is the standard way Chromium itself tests WebAuthn
flows. It does not fake Mera's derivation logic in any way — it drives the real
`createPasskeyWithPrfOutput`/`getPasskeyPrfOutput` calls in `web/src/lib/account/keys.ts` through the
real `/onboard` route.

## Steps and evidence
1. `01-landing.png` — landing page.
2. `02-onboard-unlock-card.png` — onboard, no session yet.
3. Clicked **Create account** -> real `navigator.credentials.create()` PRF ceremony -> derived owner
   `0x6864dA...3C96`. `03-onboard-keys-step-first-device.png`.
4. Confirmed `localStorage` holds only the public credential hint (`gapless.credential.v1`:
   credentialId + transport), no key material — matches the architecture doc's claim.
5. Simulated a fresh device: cleared cookies, `localStorage`, `sessionStorage`, and every IndexedDB
   database for the origin.
6. Reloaded. App correctly fell back to the unlock card (no session, no stored hint).
   `04-fresh-device-unlock-card.png`.
7. Clicked **Sign in** -> real `navigator.credentials.get()` PRF ceremony, with **no credential hint
   available** (relying purely on the authenticator's resident/discoverable credential, the same path
   a real device-synced passkey takes) -> re-derived keys.
8. Owner address reappeared as `0x6864dA...3C96` — **identical** to step 3, confirmed byte-for-byte in
   the automation script's own assertion (`MATCH: true`). `05-onboard-after-reauth.png`.

## What this proves, and what it doesn't
Proves: deterministic key re-derivation from the same WebAuthn PRF credential, which is the
cryptographic core of the bounty's claim ("identity/access must fully reconstruct from the passkey").

Does not cover: CREATE2 account deployment, on-chain positions, or live covers reappearing — blocked
today by `CoverManager` buys being paused on mainnet and no demo account funded yet, not by anything
in Mera itself. Once that's unblocked, the same reconstruction will also need to confirm the
GaplessAccount, positions and covers reappear via `factory.accountOf(owner)` (deterministic by
construction, already confirmed readable on-chain).

Screenshots: `audit/mera-fresh-device-2026-10-09/`.
