# AI use disclosure

Honest account of how AI tooling was used in building Gapless, for the hackathon's AI-use disclosure requirement.

## What was used

**Claude Code** (Anthropic) was used throughout the build as a development tool — writing and reviewing Solidity, TypeScript, and configuration across the contract, backend, and web packages, running test suites, and assisting with research (official documentation lookups, market-sizing research, security review).

## How it was used

- **Contract development**: Solidity contracts, Foundry tests (unit, fuzz, invariant), and deployment scripts were written with AI assistance, always checked against OpenZeppelin's own documentation and security patterns, and verified by running the actual test suite and reading real test output before anything was accepted.
- **Backend development**: the relay, keeper, and jobs services (Node/Bun/TypeScript) were built with AI assistance, verified by running real test suites and live health checks against the actual deployed infrastructure.
- **Frontend development**: the PWA (TanStack Start/React) was built with AI assistance, verified with real browser automation (Playwright) against the live dev server and real on-chain/relay data wherever possible.
- **Security review**: a dedicated AI-assisted security review pass was run on both the backend routes and the frontend transaction-signing code, using OWASP-style methodology, with findings verified via real proof-of-concept reproduction before being reported as confirmed — not just asserted.
- **Research**: technical documentation (Chainlink CRE SDK, Monad docs), market-sizing data (perpetual futures trading volume, stop-loss usage rates), and hackathon judging criteria were researched using live web search and official sources, cited in `PITCH_DECK.md` and `SUBMISSION_COPY.md`.

## What was not AI-generated

- The core architectural decision — guaranteed stop-losses on Perpl, funded by a public AUSD vault, settled same-transaction via a keeper — is the project's own idea, not AI-suggested.
- All business decisions (premium share, market focus, roadmap priorities) were made by the project's author.
- All deployment actions that move real funds or sign real transactions (mainnet deploys, role grants, fund transfers) were executed by the author directly, from their own keys, never autonomously by AI tooling.

## Verification standard applied throughout

Every claim in this repository's documentation that could be checked was checked against something real before being written down: live contract state (via `cast call` against the deployed mainnet addresses), actual test suite output, actual measured data from the project's own Gap Index rather than assumed numbers. Where a number could not be verified (e.g. market-sizing estimates with no published industry figure), it is explicitly labeled as an estimate with its calculation method shown, not presented as a fact — see `PITCH_DECK.md` section "Slide 5: Market size" for the clearest example of this standard in practice.
