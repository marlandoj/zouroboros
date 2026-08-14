#!/usr/bin/env bun
/**
 * scout-data.ts — Deterministic data-fetch helper for the jhf-strategy-scout skill.
 *
 * Usage:
 *   bun scout-data.ts <TICKER>
 *
 * Emits a single JSON document on stdout containing the inputs to stages 1-7
 * of the scout pipeline. Stage 8 (synthesis + email) is performed by the calling
 * Zo session using the data this script returns.
 *
 * Exits non-zero with a JSON error envelope on the first hard failure so the
 * caller can surface a fail-loud email per skill protocol.
 *
 * Required env: FMP_API_KEY, ALPACA_API_KEY, ALPACA_API_SECRET.
 * Optional env: FINNHUB_API_KEY (used for news + earnings cross-check).
 */

type Json = Record<string, unknown>;

const FMP = "https://financialmodelingprep.com/stable";
const ALPACA_DATA = "https://data.alpaca.markets/v2";
const FINNHUB = "https://finnhub.io/api/v1";

// Broad-market index ETFs exempt from the 5% single-name concentration cap.
// Inclusion criteria: tracks a diversified index (S&P 500, Russell 2000, total market,
// Nasdaq 100, Dow, broad international, broad bond). Sector/thematic ETFs are NOT exempt.
const DIVERSIFIED_INDEX_ETFS = new Set([
  // US large cap (S&P 500)
  "SPY", "VOO", "IVV", "SPLG",
  // US total market
  "VTI", "ITOT", "SCHB",
  // US small cap (Russell 2000)
  "IWM", "VTWO",
  // US mid cap
  "IJH", "VO",
  // Nasdaq 100
  "QQQ", "QQQM",
  // Dow
  "DIA",
  // International developed
  "VEA", "IEFA", "EFA",
  // International emerging
  "VWO", "IEMG", "EEM",
  // Total bond
  "AGG", "BND", "SCHZ",
]);

const FMP_API_KEY = process.env.FMP_API_KEY;
const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SEC = process.env.ALPACA_API_SECRET;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

function die(stage: string, message: string, extra: Json = {}): never {
  console.log(
    JSON.stringify({ error: true, stage, message, ...extra }, null, 2),
  );
  process.exit(2);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: bun scout-data.ts <TICKER>\n\nFetches market data for the given ticker from FMP, Alpaca, and Finnhub.");
  process.exit(0);
}

async function jget(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    throw new Error(`${url.replace(/apikey=[^&]+/, "apikey=<REDACTED>")} → ${r.status} ${r.statusText}`);
  }
  return r.json();
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function sma(values: number[], window: number): number | null {
  if (values.length < window) return null;
  const slice = values.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / window;
}

async function fundamentals(ticker: string): Promise<Json> {
  const q = encodeURIComponent(ticker);
  const profileArr = (await jget(`${FMP}/profile?symbol=${q}&apikey=${FMP_API_KEY}`)) as Json[];
  const quoteArr = (await jget(`${FMP}/quote?symbol=${q}&apikey=${FMP_API_KEY}`)) as Json[];
  if (!profileArr?.[0]) die("fundamentals", `No FMP profile for ${ticker}`);
  const p = profileArr[0] as any;
  const qd = (quoteArr?.[0] ?? {}) as any;
  return {
    company: p.companyName,
    sector: p.sector,
    industry: p.industry,
    exchange: p.exchange,
    is_etf: Boolean(p.isEtf),
    is_fund: Boolean(p.isFund),
    is_diversified_index_etf: DIVERSIFIED_INDEX_ETFS.has(ticker),
    actively_trading: Boolean(p.isActivelyTrading),
    ipo_date: p.ipoDate,
    price: qd.price ?? p.price,
    previous_close: qd.previousClose ?? null,
    change_pct: qd.changePercentage ?? null,
    market_cap: qd.marketCap ?? p.marketCap,
    beta: p.beta,
    day_low: qd.dayLow ?? null,
    day_high: qd.dayHigh ?? null,
    year_high: qd.yearHigh ?? null,
    year_low: qd.yearLow ?? null,
    fmp_price_avg_50: qd.priceAvg50 ?? null,
    fmp_price_avg_200: qd.priceAvg200 ?? null,
    avg_volume_fmp: qd.avgVolume ?? null,
  };
}

async function technicals(ticker: string): Promise<Json> {
  // 250 trading days of daily bars from Alpaca.
  const end = new Date();
  const start = new Date(end.getTime() - 1000 * 60 * 60 * 24 * 380);
  const url = `${ALPACA_DATA}/stocks/${ticker}/bars?timeframe=1Day&start=${start.toISOString()}&end=${end.toISOString()}&limit=400&adjustment=split&feed=iex`;
  const data = (await jget(url, {
    "APCA-API-KEY-ID": ALPACA_KEY!,
    "APCA-API-SECRET-KEY": ALPACA_SEC!,
  })) as { bars?: Array<{ c: number; v: number; t: string; h: number; l: number }> };
  const bars = data.bars ?? [];
  if (bars.length < 50) die("technicals", `Alpaca returned only ${bars.length} bars for ${ticker}`);
  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v);
  const last = closes[closes.length - 1];
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const avgVol20 = sma(vols, 20);
  const recentVol = vols[vols.length - 1];
  const high252 = Math.max(...closes.slice(-252));
  const low252 = Math.min(...closes.slice(-252));
  const range = high252 - low252;
  const proximityHigh = range > 0 ? (last - low252) / range : 0;
  // 20-day annualised realised vol
  const rets: number[] = [];
  for (let i = closes.length - 21; i < closes.length - 1; i++) rets.push(Math.log(closes[i + 1] / closes[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1);
  const realised_vol_20d = Math.sqrt(variance * 252);
  return {
    last_close: last,
    sma_50: sma50,
    sma_200: sma200,
    rsi_14: rsi14,
    golden_cross: sma50 != null && sma200 != null ? sma50 > sma200 : null,
    price_vs_sma50_pct: sma50 ? ((last - sma50) / sma50) * 100 : null,
    price_vs_sma200_pct: sma200 ? ((last - sma200) / sma200) * 100 : null,
    recent_volume: recentVol,
    avg_volume_20d: avgVol20,
    volume_surge_ratio: avgVol20 ? recentVol / avgVol20 : null,
    high_52w: high252,
    low_52w: low252,
    proximity_52w_high_pct: proximityHigh * 100,
    realised_vol_20d_annualised: realised_vol_20d,
    bars_used: bars.length,
  };
}

async function risk(ticker: string): Promise<Json> {
  let nextEarnings: string | null = null;
  let news: Json[] = [];
  if (FINNHUB_API_KEY) {
    try {
      // Finnhub earnings calendar: scan ±90 days for the next event for this ticker
      const today = new Date();
      const back = new Date(today.getTime() - 1000 * 60 * 60 * 24 * 7);
      const ahead = new Date(today.getTime() + 1000 * 60 * 60 * 24 * 120);
      const fromS = back.toISOString().slice(0, 10);
      const toS = ahead.toISOString().slice(0, 10);
      const cal = (await jget(`${FINNHUB}/calendar/earnings?from=${fromS}&to=${toS}&symbol=${ticker}&token=${FINNHUB_API_KEY}`)) as any;
      const events: any[] = cal?.earningsCalendar ?? [];
      for (const ev of events) {
        const d = new Date(ev.date);
        if (d >= today) { nextEarnings = ev.date; break; }
      }
    } catch {/* non-fatal */}
    try {
      const today = new Date();
      const from = new Date(today.getTime() - 1000 * 60 * 60 * 24 * 14);
      const toS = today.toISOString().slice(0, 10);
      const fromS = from.toISOString().slice(0, 10);
      const items = (await jget(`${FINNHUB}/company-news?symbol=${ticker}&from=${fromS}&to=${toS}&token=${FINNHUB_API_KEY}`)) as Json[];
      news = (items ?? []).slice(0, 5).map((n) => ({ headline: (n as any).headline, datetime: (n as any).datetime, source: (n as any).source, url: (n as any).url }));
    } catch {/* non-fatal */}
  }

  const earningsWithin14d = nextEarnings ? (new Date(nextEarnings).getTime() - Date.now()) / 86400000 <= 14 : null;
  return {
    next_earnings_date: nextEarnings,
    earnings_within_14d: earningsWithin14d,
    recent_news_14d_count: news.length,
    recent_news_14d_sample: news,
  };
}

async function backtestRef(ticker: string): Promise<Json> {
  // Look for any verdict.json under Projects/jhf-trading-platform/* that mentions the ticker.
  const root = "/home/workspace/Projects/jhf-trading-platform";
  const proc = Bun.spawnSync(["find", root, "-maxdepth", "3", "-name", "verdict.json"]);
  const files = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
  const hits: Json[] = [];
  for (const f of files) {
    try {
      const v = JSON.parse(await Bun.file(f).text()) as Json;
      const txt = JSON.stringify(v).toLowerCase();
      if (txt.includes(ticker.toLowerCase())) {
        hits.push({ path: f.replace(root + "/", ""), verdict: v });
      }
    } catch {/* skip */}
  }
  return { ticker_specific_backtests: hits, total_jhf_verdicts_indexed: files.length };
}

async function portfolioFit(ticker: string): Promise<Json> {
  try {
    const base = process.env.ALPACA_PAPER === "false"
      ? "https://api.alpaca.markets/v2"
      : "https://paper-api.alpaca.markets/v2";
    const positions = (await jget(`${base}/positions`, {
      "APCA-API-KEY-ID": ALPACA_KEY!,
      "APCA-API-SECRET-KEY": ALPACA_SEC!,
    })) as Array<Json>;
    const totalEquity = positions.reduce((s, p) => s + Number((p as any).market_value || 0), 0);
    const existing = positions.find((p) => ((p as any).symbol || "").toUpperCase() === ticker);
    const concentration = existing && totalEquity > 0 ? Number((existing as any).market_value) / totalEquity : 0;
    return {
      held_in_alpaca: Boolean(existing),
      current_position_value: existing ? Number((existing as any).market_value) : 0,
      current_concentration_pct: concentration * 100,
      portfolio_total_equity: totalEquity,
      positions_count: positions.length,
    };
  } catch (e) {
    return { held_in_alpaca: null, error: String((e as Error).message) };
  }
}

async function main() {
  const ticker = (process.argv[2] || "").toUpperCase();
  if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) die("input", `Invalid ticker '${ticker}'`);
  if (!FMP_API_KEY) die("env", "FMP_API_KEY missing");
  if (!ALPACA_KEY || !ALPACA_SEC) die("env", "Alpaca credentials missing");

  const stages: Json = { ticker, generated_at: new Date().toISOString() };
  try { stages.fundamentals = await fundamentals(ticker); } catch (e) { die("fundamentals", String((e as Error).message)); }
  try { stages.technicals = await technicals(ticker); } catch (e) { die("technicals", String((e as Error).message)); }
  try { stages.risk = await risk(ticker); } catch (e) { stages.risk = { error: String((e as Error).message) }; }
  try { stages.backtest = await backtestRef(ticker); } catch (e) { stages.backtest = { error: String((e as Error).message) }; }
  try { stages.portfolio = await portfolioFit(ticker); } catch (e) { stages.portfolio = { error: String((e as Error).message) }; }

  // Cost/slippage proxy from technicals
  const t = stages.technicals as Json;
  stages.cost = {
    avg_dollar_volume_20d: ((t.avg_volume_20d as number) ?? 0) * ((t.last_close as number) ?? 0),
    realised_vol_annualised: t.realised_vol_20d_annualised,
    liquidity_tier: ((t.avg_volume_20d as number) ?? 0) * ((t.last_close as number) ?? 0) > 50_000_000
      ? "deep"
      : ((t.avg_volume_20d as number) ?? 0) * ((t.last_close as number) ?? 0) > 5_000_000
      ? "medium"
      : "thin",
  };

  // Mechanical strategy-fit scoring
  const isEtf = (stages.fundamentals as Json).is_etf as boolean;
  const goldenCross = (t.golden_cross as boolean | null);
  const rsi14 = (t.rsi_14 as number | null);
  const liquidityTier = (stages.cost as Json).liquidity_tier as string;
  const earningsRisk = (stages.risk as Json).earnings_within_14d as boolean | null;
  stages.strategy_fit = {
    donchian_trend: goldenCross === true && rsi14 != null && rsi14 < 75 ? "FIT" : goldenCross === false ? "NO" : "CHECK",
    etf_mean_reversion_basket: isEtf ? "CHECK" : "NO",
    options_income_wheel_pmcc_ic: liquidityTier === "deep" && earningsRisk !== true ? "FIT" : "CHECK",
  };

  console.log(JSON.stringify(stages, null, 2));
}

main().catch((e) => die("uncaught", String((e as Error).message)));
