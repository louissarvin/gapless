# Gapless contracts

Foundry 1.8.3, solc 0.8.37 (osaka), OpenZeppelin 5.6.1, `network = "monad"`. No fork tests by design.

    foundryup -i 1.8.3
    forge build
    forge test                      # unit, fuzz (256 runs), invariant (64 x 200)
    FOUNDRY_PROFILE=ci forge test   # 1024 fuzz runs, invariant 64 x 200
    FOUNDRY_PROFILE=deep forge test # invariant 256 x 500 (gate: run as 8 chunks of 32 runs, docs/C5_FIXES.md)
    ./script/export-abi.sh          # frozen interface ABIs to abi/

Frozen interfaces, constants, the Cover state machine and the S1/S2 work split are in `INTERFACES.md`.
Test doubles for Perpl, AUSD and Chainlink live in `test/mocks/` with conformance tests.
