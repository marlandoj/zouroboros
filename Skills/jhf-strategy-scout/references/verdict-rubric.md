# JHF Scout — verdict rubric

The scout produces one of three verdicts. Apply the gates in order; first matching gate wins.

## REJECT — any of:

1. `fundamentals.actively_trading == false` → ticker is suspended / delisted.
2. `risk.earnings_within_14d == true` → uninvestable inside the catalyst window without a deliberate IV-crush thesis (rejected for *manual* scout; a separate flow handles earnings plays).
3. `cost.liquidity_tier == "thin"` → bid-ask + slippage would dominate any edge.
4. `technicals.golden_cross == false` AND `technicals.rsi_14 > 70` → downtrend with overextended bounce.
5. `portfolio.current_concentration_pct > 5` AND `fundamentals.is_diversified_index_etf == false` → already over the 5% single-name cap (firm rule). Diversified-index ETFs (SPY/QQQ/VTI/IWM/etc.) are exempt because the 5% cap targets single-name idiosyncratic risk; a broad-market index fund is inherently diversified across hundreds of underlying names. Sector/thematic ETFs (XLE, XLF, ARKK, etc.) are **not** exempt and still trigger this gate.

## WATCH — any of (and none of the REJECT gates):

1. `technicals.rsi_14 >= 75` → momentum extension; wait for a pullback.
2. `technicals.proximity_52w_high_pct >= 95` AND `risk.recent_news_14d_count >= 4` → extended + noisy.
3. Quarterly revenue or EPS trending negative (use fundamentals quarterly_income if available; otherwise note as a question, do not invent).
4. `backtest.ticker_specific_backtests` contains any entry with `verdict: "FAIL"`.

## PASS — none of the REJECT or WATCH gates trigger.

## Strategy fit rules (independent of verdict)

These are emitted by `scout-data.ts` as `strategy_fit` and propagated unchanged to the email:

- `donchian_trend`: FIT if `golden_cross == true` AND `rsi_14 < 75`; NO if `golden_cross == false`; CHECK otherwise.
- `etf_mean_reversion_basket`: NO unless the ticker is an ETF (`is_etf == true`); even then CHECK — the basket is curated, not auto-include.
- `options_income_wheel_pmcc_ic`: FIT if `liquidity_tier == "deep"` AND not `earnings_within_14d`; CHECK otherwise.

Disjoint-universe rule (per the JHF decorrelation contract): a single-name equity must not also be eligible for the ETF mean-reversion basket. The mechanical rules above enforce this; do not override.
