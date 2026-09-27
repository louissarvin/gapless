#!/usr/bin/env bash
# Exports the frozen interface ABIs for packages/shared, the keeper, relay, indexer, CRE and plugin.
set -euo pipefail
cd "$(dirname "$0")/.."
forge build
mkdir -p abi
for c in ICoverManager ICoverVault IGaplessAccount IGaplessFactory IGaplessCreSink IGaplessInherited IPerplMin IPerplErrors IPerplEvents IAUSD; do
  jq '.abi' "out/$c.sol/$c.json" > "abi/$c.json"
done
echo "exported $(ls abi | wc -l | tr -d ' ') ABIs to abi/"
