---
name: jhf-strategy-scout
description: Scout a single equity/ETF ticker through the JHF 8-stage diagnostic pipeline (identity → fundamentals → technicals → risk → strategy fit → backtest cross-check → cost/liquidity → portfolio fit → verdict). Emits a PASS / WATCH / REJECT verdict and emails a styled HTML + PDF report to the requester. Invoked by the Scout button in the JHF screener UI (`server/routers/screener.ts:scout`) but also runs standalone.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  invoked-by:
    - jackson-heritage-finance:server/routers/screener.ts (Scout button)
    - manual /zo/ask sessions ("scout TICKER")
---

# JHF Strategy Scout — 8-stage diagnostic

Invoke this skill when a single ticker needs a fast, decision-grade snapshot for the JHF / Aventurine investment process. The 8 stages are: 1 Identity, 2 Fundamentals, 3 Technicals, 4 Risk, 5 Strategy fit, 6 Backtest cross-check, 7 Cost / liquidity, 8 Portfolio fit → verdict email.

This is **not** a research deep-dive. It is a fast, repeatable triage that produces a verdict the user can act on (PASS / WATCH / REJECT) and an artifact (PDF) they can file.

---

## Inputs

- `TICKER` — required, uppercase, 1-10 alpha/`.`/`-` chars (e.g. `AAPL`, `BRK.B`, `SPY`).
- `REQUESTER_EMAIL` — required, where the verdict email is delivered.
- `SOURCE` — optional, free-text provenance (e.g. `"Manual scout from JHF screener UI"`); included in the email.

---

## Protocol

### Step 1 — Fetch deterministic data (single script call)

Run the data fetcher. It does Stages 1-7 in one shot from real APIs (FMP `stable`, Alpaca market data, Finnhub for earnings + news), and emits a single JSON blob on stdout.

```bash
source /root/.zo_secrets 2>/dev/null
bun /home/workspace/Skills/jhf-strategy-scout/scripts/scout-data.ts <TICKER>
```

If the script exits non-zero, the stdout is a JSON error envelope: `{error: true, stage, message}`. **Do not proceed with synthesis.** Skip directly to Step 4 (Fail-loud email) — send a `❌ JHF Scout — TICKER — FAILED` email containing the error envelope verbatim.

The JSON on success contains keys: `ticker`, `generated_at`, `fundamentals`, `technicals`, `risk`, `backtest`, `portfolio`, `cost`, `strategy_fit`.

### Step 2 — Synthesise the verdict

Apply the verdict rubric (see `references/verdict-rubric.md`):

- **REJECT** if any of: `actively_trading == false`, `earnings_within_14d == true`, `liquidity_tier == "thin"`, `golden_cross == false` AND `rsi_14 > 70`, `current_concentration_pct > 5` (already over-allocated).
- **WATCH** if: `rsi_14 >= 75` (overbought), `proximity_52w_high_pct >= 95` AND `recent_news_14d_count >= 4` (extension + noise), or fundamentals show shrinking revenue/margins from the FMP profile/quote signal.
- **PASS** otherwise.

The strategy_fit values from the script (`donchian_trend`, `etf_mean_reversion_basket`, `options_income_wheel_pmcc_ic`) feed the "strategy fit" section of the email; do not override their `FIT/CHECK/NO` labels unless you have a hard reason (e.g. a backtest verdict says `FAIL`).

### Step 3 — Render the email

Compose **two** outgoing messages:

**Message A — primary report (Gmail):**
- Subject: `🎯 JHF Scout — <TICKER> — <VERDICT>` (verdict ∈ `PASS` | `WATCH` | `REJECT`).
- Body: rich HTML with sections (1) Identity, (2) Fundamentals snapshot, (3) Technicals snapshot, (4) Risk flags, (5) Strategy fit, (6) Backtest cross-check, (7) Cost / liquidity, (8) Portfolio fit & verdict. Use the template in `references/email-template.html` as a starting point.
- Send via `use_app_gmail` action `gmail-send-email` to `REQUESTER_EMAIL`.

**Message B — PDF companion (Zo email):**
- Generate a styled PDF using wkhtmltopdf or weasyprint. Save at `/home/workspace/Projects/jhf-trading-platform/scout-reports/scout-<ticker-lower>-report-<YYYY-MM-DD>.pdf`.
- Send via `send_email_to_user` with subject `📎 JHF Scout — <TICKER> — <VERDICT> (PDF attached)` and the PDF attached.

### Step 4 — Fail-loud email (ONLY if script failed)

If `scout-data.ts` exited non-zero:

- Subject: `❌ JHF Scout — <TICKER> — FAILED`
- Body: includes the JSON error envelope verbatim, the ticker, the timestamp, and the requester source.
- Send via `use_app_gmail` (preferred) or `send_email_to_user`.

**Never end the session silently.** Either a PASS/WATCH/REJECT email lands, or a FAILED email lands.

---

## Outputs

- One Gmail message with the HTML verdict report.
- One Zo email with the PDF report attached.
- A persisted PDF at `Projects/jhf-trading-platform/scout-reports/`.
- (On failure) one Gmail/Zo email describing the failure mode.

## Notes

- The fetcher uses FMP `stable` endpoints (Starter tier compatible) for quote + profile, Alpaca IEX bars for RSI/realised vol, and Finnhub for earnings + news. IEX volume is a fraction of consolidated volume — `liquidity_tier` uses dollar-volume thresholds (deep > $50M/day, medium > $5M/day, thin otherwise) and tends to under-report on megacaps, but the tier labelling stays correct.
- The fetcher is deterministic. Do not augment its outputs with LLM-generated numbers; if the script omitted a field, omit it from the email rather than hallucinating a value.
- Stage 6 backtest cross-check is a glob over `Projects/jhf-trading-platform/**/verdict.json`. If no ticker-specific result exists, simply note "No JHF-specific backtest on file" — do not invent one.
- Stage 8 portfolio fit reads live Alpaca positions. If `current_concentration_pct > 5`, flag it loudly per the user's position-sizing rule.

## References

- `references/verdict-rubric.md` — the PASS/WATCH/REJECT decision tree.
- `references/email-template.html` — the styled HTML email layout.
