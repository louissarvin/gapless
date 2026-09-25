"""Independent PayoutMath reference (spec 3.7, INTERFACES section 7). Pure integers, no FFI at test time.
Run from contract/: python3 test/fixtures/gen_payout_vectors.py > test/fixtures/payout_vectors.json"""
import json
import random

BPS, PPM = 10_000, 1_000_000
U32 = 2**32 - 1
rng = random.Random(0x6761706C657373)


def ceil_div(a, b):
    return -(-a // b)


def close_limit(stop, ref, max_gap, slack, is_long):
    if is_long:
        base = min(stop, ref) if ref > 0 else stop * (BPS - max_gap) // BPS
        return base * (BPS - slack) // BPS
    base = max(stop, ref) if ref > 0 else ceil_div(stop * (BPS + max_gap), BPS)
    return ceil_div(base * (BPS + slack), BPS)


def g_real(filled, released, realized, entry, funding, fee, stop, scale, is_long):
    if filled == 0:
        return 0
    fee = min(fee, PPM)
    stop_n = stop * filled * scale
    entry_n = entry * filled * scale
    x = realized - released - funding
    if is_long:
        g = stop_n * (PPM - fee) // PPM - entry_n - x
    else:
        g = entry_n - ceil_div(stop_n * (PPM + fee), PPM) - x
    return max(g, 0)


def g_ref(stop, ref, lots, scale, is_long):
    if ref == 0:
        return 0
    d = stop - ref if is_long else ref - stop
    return max(d, 0) * lots * scale


def bound(g_cum, gref, sn, a, max_gap):
    return min(g_cum, gref + sn * a // BPS, sn * max_gap // BPS)


cols = {}


def push(k, v):
    cols.setdefault(k, []).append(str(v))


N = 2000
for i in range(N):
    is_long = rng.random() < 0.5
    scale = rng.choice([1, 1, 10, 100, 1000])
    stop = rng.randint(1_000, 4_000_000_000 // max(1, scale // 10))
    stop = min(stop, U32)
    lots = rng.randint(1, 2**30)
    filled = rng.randint(0, lots) if rng.random() < 0.9 else lots
    entry = max(1, min(U32, int(stop * rng.uniform(0.8, 1.2))))
    # exit between a deep gap and a favorable fill relative to the stop
    exit_px = max(1, min(U32, int(stop * rng.uniform(0.95, 1.05))))
    fee = rng.choice([0, 345, 300, 125, rng.randint(0, 2000)])
    deposit = rng.randint(0, entry * filled * scale // 5 + 1)
    funding = rng.randint(-10**9, 10**9) if rng.random() < 0.5 else 0
    pnl = (exit_px - entry) * filled * scale * (1 if is_long else -1)
    fee_cns = ceil_div(exit_px * filled * scale * fee, PPM)
    realized = deposit + pnl - fee_cns + funding
    if rng.random() < 0.1:
        realized += rng.randint(-10**8, 10**8)  # off-model noise exercises the clamp
    ref = 0 if rng.random() < 0.15 else max(1, min(U32, int(stop * rng.uniform(0.97, 1.03))))
    max_gap = rng.randint(50, 500)
    slack = rng.randint(10, 300)
    a = rng.randint(5, 50)
    escrow = rng.randint(0, 2**79)
    cap = rng.randint(0, 2**79)
    new_lots = rng.randint(0, lots)

    gr = g_real(filled, deposit, realized, entry, funding, fee, stop, scale, is_long)
    gf = g_ref(stop, ref, filled, scale, is_long)
    sn = stop * filled * scale
    to_vault = ceil_div(escrow * filled, lots)

    for k, v in [("isLong", int(is_long)), ("scale", scale), ("stop", stop), ("lots", lots), ("filled", filled),
                 ("entry", entry), ("fee", fee), ("released", deposit), ("realized", realized),
                 ("funding", funding), ("ref", ref), ("maxGap", max_gap), ("slack", slack), ("a", a),
                 ("escrow", escrow), ("cap", cap), ("newLots", new_lots),
                 ("outLimit", close_limit(stop, ref, max_gap, slack, is_long)), ("outGReal", gr), ("outGRef", gf),
                 ("outBound", bound(gr, gf, sn, a, max_gap)), ("outToVault", to_vault),
                 ("outRefund", escrow - to_vault), ("outNewCap", ceil_div(cap * new_lots, lots)),
                 ("outNewEscrow", ceil_div(escrow * new_lots, lots))]:
        push(k, v)

print(json.dumps({"source": "test/fixtures/gen_payout_vectors.py", "n": N, **cols}))
