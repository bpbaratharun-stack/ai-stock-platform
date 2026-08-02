/**
 * NSE FACTOR SCREENER & RESEARCH TERMINAL  (frontend)
 * Honest factor screener — descriptive rankings, no buy/sell.
 * Screener now supports client-side filtering (band, RSI, trend, ticker, sector*)
 * and click-to-sort columns. Includes the Gemini "Explain this profile" button.
 * (*sector filter appears automatically once sector data is present.)
 * Endpoints: /profile, /screener, /sector-factors, /explain.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import axios from "axios";
import Chart from "react-apexcharts";
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

const pctColor = (p) => {
  if (p == null) return "#475569";
  const t = Math.max(0, Math.min(100, p)) / 100;
  return `hsl(180, 55%, ${30 + t * 35}%)`;
};
const rsiColor = (v) => (v > 70 ? "#ff4d4d" : v < 30 ? "#00e396" : "#94a3b8");

function useDebounce(fn, wait) {
  const t = useRef(null);
  return useCallback((...a) => { clearTimeout(t.current); t.current = setTimeout(() => fn(...a), wait); }, [fn, wait]);
}

const COMMON_X = { type: "datetime",
  labels: { style: { colors: "#64748b", fontFamily: "JetBrains Mono", fontSize: "10px" } },
  axisBorder: { show: false }, axisTicks: { show: false } };

// ---------------------------------------------------------------------------
function Disclaimer() {
  return (
    <div style={{ background: "rgba(148,163,184,0.08)", border: "1px solid #334155",
      color: "#94a3b8", padding: "10px 14px", borderRadius: 6, fontSize: 11,
      fontFamily: "JetBrains Mono", marginBottom: 18, lineHeight: 1.5 }}>
      ⓘ Factor rankings are descriptive screening metrics — not buy/sell advice or return forecasts.
      Backtesting found no return-predictive edge in these signals. Do your own research.
    </div>
  );
}

function StatCard({ label, value, accent, badge }) {
  return (
    <div style={{ background: "#0b0f19", padding: 16, borderRadius: 10, border: "1px solid #1e293b" }}>
      <span style={{ color: "#64748b", fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 17, fontFamily: "JetBrains Mono", color: accent ?? "#f8fafc", fontWeight: 700 }}>{value}</span>
        {badge && <span style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b", background: "rgba(245,158,11,0.12)", padding: "2px 7px", borderRadius: 4 }}>{badge}</span>}
      </div>
    </div>
  );
}

function ErrorBanner({ message }) {
  return <div style={{ background: "rgba(255,77,77,0.1)", border: "1px solid #ff4d4d", color: "#ff4d4d", padding: "12px 16px", borderRadius: 6, fontSize: 12, fontFamily: "JetBrains Mono", fontWeight: 600, marginBottom: 16 }}>⚠ {message}</div>;
}

function ScoredChip({ date }) {
  if (!date) return null;
  return <span style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", background: "rgba(56,189,248,0.1)", padding: "3px 9px", borderRadius: 4, fontFamily: "JetBrains Mono" }}>● AS OF {date}</span>;
}

function BandChip({ band, percentile }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 800, fontFamily: "JetBrains Mono", color: "#0b0f19",
      background: pctColor(percentile), padding: "4px 12px", borderRadius: 4 }}>
      {band}{percentile != null ? ` · ${percentile}%ile` : ""}
    </span>
  );
}

// ---------------------------------------------------------------------------
function Navbar() {
  const loc = useLocation();
  const link = (p, l) => {
    const a = loc.pathname === p;
    return <Link to={p} style={{ color: a ? "#00d4ff" : "#94a3b8", textDecoration: "none", fontWeight: 700, fontSize: 11, padding: "9px 18px", background: a ? "rgba(0,212,255,0.1)" : "rgba(30,41,59,0.4)", borderRadius: 6, border: `1px solid ${a ? "#00d4ff" : "#1e293b"}`, fontFamily: "JetBrains Mono", whiteSpace: "nowrap" }}>{l}</Link>;
  };
  return <div style={{ display: "flex", gap: 10, flexWrap: "wrap", background: "#0b0f19", padding: "12px 16px", borderRadius: 8, border: "1px solid #1e293b", marginBottom: 24 }}>
    {link("/portfolio", "🧮 MY PORTFOLIO")}{link("/booked", "💰 PROFIT BOOKING")}{link("/", "🔎 FACTOR PROFILE")}{link("/screener", "🛰 UNIVERSE SCREENER")}{link("/breakouts", "🚀 WEEKLY BREAKOUTS")}{link("/top", "🏆 TOP PERFORMERS")}{link("/vcp", "🔬 VCP BREAKOUTS")}
  </div>;
}

// ============================================================= FACTOR PROFILE
function ProfileView() {
  const [symbol, setSymbol] = useState("ICICIBANK.NS");
  const symRef = useRef("ICICIBANK.NS");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sugg, setSugg] = useState([]);
  const [explain, setExplain] = useState(null);
  const [exLoading, setExLoading] = useState(false);
  const ctrlRef = useRef(null);

  useEffect(() => { symRef.current = symbol; }, [symbol]);
  useEffect(() => { setExplain(null); }, [data?.symbol]);

  const run = useCallback(async (override) => {
    if (ctrlRef.current) ctrlRef.current.abort();
    const ctrl = new AbortController(); ctrlRef.current = ctrl;
    setLoading(true); setError(null);
    try {
      const { data: res } = await axios.get(`${API_BASE}/profile/${override ?? symRef.current}`, { signal: ctrl.signal });
      setData(res);
    } catch (e) { if (!axios.isCancel(e)) setError(e?.response?.data?.detail ?? "Failed to fetch. Is the backend running?"); }
    finally { if (!ctrl.signal.aborted) { setLoading(false); ctrlRef.current = null; } }
  }, []);

  useEffect(() => { run("ICICIBANK.NS"); return () => ctrlRef.current?.abort(); }, [run]);

  const getExplain = async () => {
    if (!data?.symbol) return;
    setExLoading(true); setExplain(null);
    try {
      const { data: res } = await axios.get(`${API_BASE}/explain/${data.symbol}`);
      setExplain(res.explanation);
    } catch (e) {
      setExplain(e?.response?.data?.detail ?? "Explanation unavailable right now.");
    } finally { setExLoading(false); }
  };

  const fetchSugg = useCallback(async (q) => {
    if (q.length < 2) { setSugg([]); return; }
    try { const { data: r } = await axios.get(`${API_BASE}/stocks/search?q=${encodeURIComponent(q.replace(/\.NS$/i, ""))}`); setSugg(r ?? []); } catch {}
  }, []);
  const debounced = useDebounce(fetchSugg, 300);

  const gaugeOpts = useMemo(() => ({
    chart: { type: "radialBar", background: "transparent", toolbar: { show: false } }, theme: { mode: "dark" },
    plotOptions: { radialBar: { startAngle: -130, endAngle: 130, hollow: { size: "60%" },
      track: { background: "#1e293b", strokeWidth: "100%" },
      dataLabels: { name: { show: true, color: "#64748b", fontSize: "10px", offsetY: 14 },
        value: { show: true, color: "#f8fafc", fontSize: "22px", fontWeight: 700, offsetY: -8, fontFamily: "JetBrains Mono" } } } },
    fill: { type: "solid", colors: ["#2dd4bf"] }, labels: ["FACTOR %ILE"],
  }), []);

  const candleOpts = useMemo(() => ({
    chart: { type: "line", toolbar: { show: false }, background: "transparent", animations: { enabled: false } },
    theme: { mode: "dark" }, stroke: { width: [1, 2, 2], curve: "smooth" }, colors: ["#f8fafc", "#f59e0b", "#a855f7"],
    xaxis: COMMON_X, yaxis: { labels: { style: { colors: "#64748b", fontFamily: "JetBrains Mono", fontSize: "10px" }, formatter: (v) => `₹${v?.toFixed(0)}` } },
    grid: { borderColor: "#1e293b" }, tooltip: { theme: "dark" }, legend: { show: true, position: "top", labels: { colors: "#94a3b8" } },
  }), []);

  const pct = data?.factor_profile?.percentile ?? 0;
  const notRanked = data && data.meta?.in_universe === false;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, background: "#0b0f19", padding: 16, borderRadius: 8, border: "1px solid #1e293b", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 13, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono" }}>SINGLE-ASSET FACTOR PROFILE</h2>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>Where this name sits in the universe on momentum/technical factors {data?.factor_profile?.scored_date && <ScoredChip date={data.factor_profile.scored_date} />}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input value={symbol} onChange={(e) => { const u = e.target.value.toUpperCase(); setSymbol(u); debounced(u); }} onKeyDown={(e) => e.key === "Enter" && run()} placeholder="Search ticker…" list="sugg"
            style={{ padding: "9px 13px", borderRadius: 6, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontWeight: 600, width: 190, fontFamily: "JetBrains Mono", fontSize: 12 }} />
          <datalist id="sugg">{sugg.map((s) => <option key={s.symbol} value={s.symbol}>{s.name}</option>)}</datalist>
          <button onClick={() => run()} disabled={loading} style={{ background: loading ? "#1e293b" : "#00d4ff", color: loading ? "#64748b" : "#020617", border: "none", padding: "9px 20px", borderRadius: 6, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{loading ? "LOADING…" : "LOAD"}</button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {notRanked && <ErrorBanner message={`${data.symbol} is not in the ranked universe (illiquid or insufficient history).`} />}

      {loading && <div style={{ padding: 80, textAlign: "center", color: "#00d4ff", background: "#0b0f19", borderRadius: 8, border: "1px solid #1e293b", fontFamily: "JetBrains Mono", fontSize: 12 }}>Loading {symbol}…</div>}

      {!loading && data && (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 }}>
          <StatCard label="SYMBOL" value={`${data.symbol}  ₹${data.meta?.current_price}`} />
          <StatCard label="RSI (14)" value={data.meta?.rsi ?? "—"} accent={rsiColor(data.meta?.rsi)} />
          <StatCard label="INDIA VIX" value={`${data.vix_snapshot?.current} (${data.vix_snapshot?.change_pct > 0 ? "+" : ""}${data.vix_snapshot?.change_pct}%)`} accent="#38bdf8" badge={data.vix_snapshot?.is_fallback ? "FALLBACK" : null} />
          <StatCard label="VOLATILITY REGIME" value={data.meta?.market_regime?.replace(/_/g, " ")} accent="#f59e0b" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 14, marginBottom: 18 }}>
          <div style={{ background: "#0b0f19", padding: 16, borderRadius: 10, border: "1px solid #1e293b", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <Chart options={gaugeOpts} series={[pct]} type="radialBar" height={160} />
            <BandChip band={data.factor_profile?.band} percentile={data.factor_profile?.percentile} />
            <span style={{ fontSize: 11, fontFamily: "JetBrains Mono", color: data.meta?.factor_trend === "RISING" ? "#2dd4bf" : "#94a3b8" }}>
              {data.meta?.factor_trend === "RISING" ? "▲ percentile rising" : "▼ percentile falling"}
            </span>
            <span style={{ fontSize: 11, color: "#64748b", fontFamily: "JetBrains Mono" }}>3M return: <b style={{ color: data.factors?.ret_3m_pct >= 0 ? "#00e396" : "#ff4d4d" }}>{data.factors?.ret_3m_pct ?? "—"}%</b></span>
          </div>
          <div style={{ background: "#0b0f19", padding: 16, borderRadius: 10, border: "1px solid #1e293b" }}>
            {data.analytics?.ohlc?.length > 0 ? (
              <Chart options={candleOpts} type="line" height={220} series={[
                { name: "OHLC", type: "candlestick", data: data.analytics.ohlc.map((d) => ({ x: d.x, y: d.y })) },
                { name: "EMA 20", type: "line", data: data.analytics.ohlc.map((d) => ({ x: d.x, y: d.ema20 })) },
                { name: "EMA 50", type: "line", data: data.analytics.ohlc.map((d) => ({ x: d.x, y: d.ema50 })) }]} />
            ) : <div style={{ padding: "70px 0", textAlign: "center", color: "#64748b", fontSize: 11, fontFamily: "JetBrains Mono" }}>Chart data unavailable</div>}
          </div>
        </div>

        {data.factor_profile?.composite_score != null && (
          <div style={{ background: "#020617", border: "1px solid #1e293b", borderRadius: 8, padding: "14px 18px", fontFamily: "JetBrains Mono", fontSize: 11, color: "#64748b", display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 }}>
            {[{ k: "COMPOSITE SCORE", v: data.factor_profile.composite_score?.toFixed(3), c: "#2dd4bf" },
              { k: "PERCENTILE", v: `${data.factor_profile.percentile}th`, c: "#f8fafc" },
              { k: "POSITION", v: data.factor_profile.band, c: "#94a3b8" },
              { k: "RANKED AS OF", v: data.factor_profile.scored_date ?? "—", c: "#94a3b8" }].map(({ k, v, c }) => (
              <div key={k}><span style={{ display: "block", marginBottom: 3 }}>{k}</span><span style={{ color: c, fontWeight: 700, fontSize: 13 }}>{v}</span></div>))}
          </div>
        )}

        {data.factor_breakdown?.length > 0 && (
          <div style={{ background: "#0b0f19", border: "1px solid #1e293b", borderRadius: 8, padding: 16, marginBottom: 18 }}>
            <div style={{ fontSize: 11, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono", marginBottom: 12, letterSpacing: "0.05em" }}>
              FACTOR BREAKDOWN — WHAT'S BEHIND THE RANK
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
              {data.factor_breakdown.map((f) => {
                const tc = f.tone === "pos" ? "#00e396" : f.tone === "neg" ? "#ff4d4d" : "#94a3b8";
                const val = f.value == null ? "—" : `${f.value > 0 && f.unit === "%" ? "+" : ""}${f.value}${f.unit}`;
                return (
                  <div key={f.label} style={{ background: "#020617", border: "1px solid #1e293b", borderRadius: 6, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9, color: "#64748b", fontFamily: "JetBrains Mono", letterSpacing: "0.05em", marginBottom: 4 }}>{f.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "JetBrains Mono", color: tc }}>{val}</div>
                    <div style={{ fontSize: 9, color: "#475569", fontFamily: "JetBrains Mono", marginTop: 3 }}>{f.hint}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "#475569", fontFamily: "JetBrains Mono", marginTop: 10 }}>
              Computed live from this stock's price history · descriptive readings, not predictions.
            </div>
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          <button onClick={getExplain} disabled={exLoading || !data?.factor_profile?.composite_score}
            style={{ background: "#1e293b", color: "#2dd4bf", border: "1px solid #2dd4bf",
              padding: "9px 18px", borderRadius: 6, fontWeight: 700,
              cursor: exLoading ? "wait" : (!data?.factor_profile?.composite_score ? "not-allowed" : "pointer"),
              fontSize: 11, fontFamily: "JetBrains Mono", opacity: !data?.factor_profile?.composite_score ? 0.5 : 1 }}>
            {exLoading ? "GENERATING…" : "🤖 EXPLAIN THIS PROFILE"}
          </button>
          {explain && (
            <div style={{ marginTop: 12, background: "#0b0f19", border: "1px solid #1e293b", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 10, color: "#64748b", fontFamily: "JetBrains Mono", marginBottom: 8 }}>AI-GENERATED · DESCRIPTIVE, NOT ADVICE</div>
              <p style={{ margin: 0, color: "#cbd5e1", fontSize: 13, lineHeight: 1.6 }}>{explain}</p>
            </div>
          )}
        </div>

        <Disclaimer />
      </>)}
    </div>
  );
}

// ============================================================ UNIVERSE SCREENER
const TABS = ["UNIVERSE", "NIFTY50", "BANKNIFTY"];
const BANDS = ["ALL", "TOP QUINTILE", "UPPER", "MIDDLE", "LOWER", "BOTTOM QUINTILE"];
const TRENDS = ["ALL", "RISING", "FALLING"];

function ScreenerView() {
  const [active, setActive] = useState("UNIVERSE");
  const [rows, setRows] = useState([]);
  const [scoredDate, setScoredDate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [sectorF, setSectorF] = useState("ALL");
  const [bandF, setBandF] = useState("ALL");
  const [trendF, setTrendF] = useState("ALL");
  const [rsiMin, setRsiMin] = useState("");
  const [rsiMax, setRsiMax] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("percentile");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    let off = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const { data } = await axios.get(`${API_BASE}/screener/${active}`);
        if (!off) { setRows(data.results ?? []); setScoredDate(data.scored_date ?? null); }
      } catch (e) { if (!off) { setRows([]); setError(e?.response?.data?.detail ?? "Screener fetch failed."); } }
      finally { if (!off) setLoading(false); }
    })();
    return () => { off = true; };
  }, [active]);

  const sectors = useMemo(() => {
    const s = Array.from(new Set(rows.map((r) => r.sector).filter((x) => x && x !== "UNKNOWN"))).sort();
    return ["ALL", ...s];
  }, [rows]);
  const hasSectors = sectors.length > 1;

  const view = useMemo(() => {
    const mn = rsiMin === "" ? -Infinity : parseFloat(rsiMin);
    const mx = rsiMax === "" ? Infinity : parseFloat(rsiMax);
    const q = search.trim().toUpperCase();
    let out = rows.filter((r) =>
      (sectorF === "ALL" || r.sector === sectorF) &&
      (bandF === "ALL" || r.band === bandF) &&
      (trendF === "ALL" || r.factor_trend === trendF) &&
      (r.rsi >= mn && r.rsi <= mx) &&
      (q === "" || r.symbol.includes(q))
    );
    const dir = sortDir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    return out;
  }, [rows, sectorF, bandF, trendF, rsiMin, rsiMax, search, sortKey, sortDir]);

  const setSort = (key, numeric) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(numeric ? "desc" : "asc"); }
  };
  const clearFilters = () => { setSectorF("ALL"); setBandF("ALL"); setTrendF("ALL"); setRsiMin(""); setRsiMax(""); setSearch(""); };

  const COLS = [
    { key: "symbol", label: "TICKER", numeric: false },
    { key: "price", label: "PRICE", numeric: true },
    { key: "rsi", label: "RSI", numeric: true },
    { key: "percentile", label: "FACTOR %ILE", numeric: true },
    { key: "band", label: "POSITION", numeric: false, noSort: true },
    { key: "relative_strength", label: "3M α vs NIFTY", numeric: true },
    { key: "factor_trend", label: "TREND", numeric: false, noSort: true },
  ];

  const inp = { padding: "7px 10px", borderRadius: 5, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 11 };
  const lab = { fontSize: 9, color: "#64748b", fontFamily: "JetBrains Mono", display: "block", marginBottom: 4, letterSpacing: "0.05em" };

  return (
    <div style={{ background: "#0b0f19", padding: 20, borderRadius: 10, border: "1px solid #1e293b" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 13, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono", display: "flex", alignItems: "center", gap: 10 }}>🛰 UNIVERSE FACTOR SCREENER — {active} <ScoredChip date={scoredDate} /></h3>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>Filter and sort the universe by factor percentile, RSI, position, and trend · descriptive only.</p>
        </div>
        <div style={{ display: "flex", gap: 4, background: "#020617", padding: 3, borderRadius: 5, border: "1px solid #1e293b" }}>
          {TABS.map((i) => <button key={i} onClick={() => setActive(i)} style={{ background: active === i ? "#00d4ff" : "transparent", color: active === i ? "#020617" : "#94a3b8", border: "none", padding: "6px 14px", borderRadius: 4, fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "JetBrains Mono" }}>{i}</button>)}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      <Disclaimer />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", background: "#020617", padding: 14, borderRadius: 6, border: "1px solid #1e293b", marginBottom: 16 }}>
        {hasSectors && (
          <div>
            <label style={lab}>SECTOR</label>
            <select value={sectorF} onChange={(e) => setSectorF(e.target.value)} style={{ ...inp, minWidth: 130 }}>
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        <div>
          <label style={lab}>POSITION</label>
          <select value={bandF} onChange={(e) => setBandF(e.target.value)} style={{ ...inp, minWidth: 140 }}>
            {BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label style={lab}>TREND</label>
          <select value={trendF} onChange={(e) => setTrendF(e.target.value)} style={inp}>
            {TRENDS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label style={lab}>RSI MIN</label>
          <input value={rsiMin} onChange={(e) => setRsiMin(e.target.value)} placeholder="0" inputMode="numeric" style={{ ...inp, width: 64 }} />
        </div>
        <div>
          <label style={lab}>RSI MAX</label>
          <input value={rsiMax} onChange={(e) => setRsiMax(e.target.value)} placeholder="100" inputMode="numeric" style={{ ...inp, width: 64 }} />
        </div>
        <div>
          <label style={lab}>TICKER</label>
          <input value={search} onChange={(e) => setSearch(e.target.value.toUpperCase())} placeholder="search…" style={{ ...inp, width: 110 }} />
        </div>
        <button onClick={clearFilters} style={{ ...inp, color: "#94a3b8", cursor: "pointer", fontWeight: 700 }}>CLEAR</button>
        <div style={{ marginLeft: "auto", fontSize: 11, color: "#2dd4bf", fontFamily: "JetBrains Mono", fontWeight: 700 }}>
          {view.length} of {rows.length} names
        </div>
      </div>

      {loading && !rows.length ? <p style={{ color: "#00d4ff", fontSize: 11, padding: "20px 0", fontFamily: "JetBrains Mono" }}>Loading ranked universe…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "JetBrains Mono" }}>
            <thead><tr style={{ borderBottom: "1px solid #1e293b" }}>
              {COLS.map((c) => (
                <th key={c.key} onClick={() => !c.noSort && setSort(c.key, c.numeric)}
                  style={{ padding: "0 10px 8px", textAlign: "left", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em",
                    cursor: c.noSort ? "default" : "pointer", userSelect: "none", whiteSpace: "nowrap",
                    color: sortKey === c.key ? "#00d4ff" : "#64748b" }}>
                  {c.label}{!c.noSort && sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>))}
            </tr></thead>
            <tbody>
              {view.map((r) => (
                <tr key={r.symbol} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "11px 10px", fontWeight: 700, color: "#00d4ff" }}>{r.symbol}</td>
                  <td style={{ padding: "11px 10px" }}>₹{r.price}</td>
                  <td style={{ padding: "11px 10px", color: rsiColor(r.rsi) }}>{r.rsi}</td>
                  <td style={{ padding: "11px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ height: 4, width: `${Math.max(r.percentile, 4) * 0.8}px`, maxWidth: 80, background: pctColor(r.percentile), borderRadius: 2 }} />
                      <span>{r.percentile}</span>
                    </div>
                  </td>
                  <td style={{ padding: "11px 10px", color: pctColor(r.percentile), fontWeight: 700 }}>{r.band}</td>
                  <td style={{ padding: "11px 10px", fontWeight: 700, color: r.relative_strength >= 0 ? "#00e396" : "#ff4d4d" }}>{r.relative_strength >= 0 ? "+" : ""}{r.relative_strength}%</td>
                  <td style={{ padding: "11px 10px", color: r.factor_trend === "RISING" ? "#2dd4bf" : "#94a3b8", fontWeight: 700 }}>{r.factor_trend === "RISING" ? "▲" : "▼"} {r.factor_trend}</td>
                </tr>))}
              {!view.length && !loading && (
                <tr><td colSpan={COLS.length} style={{ padding: "24px 10px", textAlign: "center", color: "#64748b", fontFamily: "JetBrains Mono", fontSize: 11 }}>No names match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================ WEEKLY BREAKOUTS
const num = (v, suffix = "", plus = false) => (v == null ? "—" : `${plus && v >= 0 ? "+" : ""}${v}${suffix}`);

function WeeklyBreakoutsView() {
  const [data, setData] = useState(null);
  const [week, setWeek] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState("score");
  const [sortDir, setSortDir] = useState("desc");
  const [addKey, setAddKey] = useState(null);
  const [addQty, setAddQty] = useState("");
  const [addMsg, setAddMsg] = useState(null);

  const load = useCallback(async (w) => {
    setLoading(true); setError(null);
    try {
      const { data: res } = await axios.get(`${API_BASE}/weekly-breakouts${w ? `?week=${w}` : ""}`);
      setData(res); setWeek(res.week_ending); setAddKey(null);
    } catch (e) { setError(e?.response?.data?.detail ?? "Failed to load weekly breakouts."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setSort = (key, numeric) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(numeric ? "desc" : "asc"); }
  };

  const view = useMemo(() => {
    const rows = data?.breakouts ?? [];
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }, [data, sortKey, sortDir]);

  const highlight = useMemo(() => {
    const t = (data?.breakouts ?? []).filter((b) => b.since_pct != null);
    if (!t.length) return null;
    return {
      best: t.reduce((a, b) => (b.since_pct > a.since_pct ? b : a)),
      worst: t.reduce((a, b) => (b.since_pct < a.since_pct ? b : a)),
    };
  }, [data]);

  const startAdd = (b) => { setAddKey(b.symbol); setAddQty(""); setAddMsg(null); };
  const cancelAdd = () => { setAddKey(null); };
  const confirmAdd = async (b) => {
    const qty = parseFloat(addQty);
    if (!(qty > 0)) { setAddMsg({ err: true, text: "Enter a positive quantity." }); return; }
    try {
      await axios.post(`${API_BASE}/portfolio/positions`, { symbol: b.symbol, exchange: "NSE", qty, avg_price: b.current_price });
      setAddKey(null);
      setAddMsg({ err: false, text: `Added ${b.symbol} × ${qty} to portfolio at ₹${b.current_price} (live price). Adjust the buy price on the Portfolio tab if you bought elsewhere.` });
    } catch (e) {
      setAddMsg({ err: true, text: e?.response?.data?.detail ?? "Could not add to portfolio." });
    }
  };

  const COLS = [
    { key: "symbol", label: "SYMBOL", numeric: false },
    { key: "score", label: "SCORE*", numeric: true },
    { key: "state", label: "STATE", numeric: false },
    { key: "breakout_close", label: "BREAKOUT ₹", numeric: true },
    { key: "current_price", label: "NOW ₹", numeric: true },
    { key: "high_since", label: "HIGH ₹", numeric: true },
    { key: "since_pct", label: "SINCE %", numeric: true },
    { key: "rule_pct", label: "RULE %", numeric: true },
    { key: "week_return_pct", label: "WK RET %", numeric: true },
    { key: "vol_surge", label: "VOL ×", numeric: true },
    { key: "ret_4w", label: "4W %", numeric: true },
    { key: "ret_12w", label: "12W %", numeric: true },
    { key: "from_52w_high", label: "52W HIGH %", numeric: true },
    { key: "gates", label: "GATES*", numeric: false },
  ];
  const STATE_STYLE = {
    ACTIVE: { color: "#00d4ff", bg: "rgba(0,212,255,0.12)" },
    EXTENDED: { color: "#00e396", bg: "rgba(0,227,150,0.12)" },
    FAILED: { color: "#ff4d4d", bg: "rgba(255,77,77,0.12)" },
  };
  const rightCols = new Set(COLS.filter((c) => c.numeric).map((c) => c.key));
  const s = data?.summary;

  return (
    <div style={{ background: "#0b0f19", padding: 20, borderRadius: 10, border: "1px solid #1e293b" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 4px", fontSize: 13, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono", display: "flex", alignItems: "center", gap: 10 }}>🚀 WEEKLY MOMENTUM BREAKOUTS {week && <ScoredChip date={week} />}</h4>
          <p style={{ margin: 0, color: "#64748b", fontSize: 11 }}>Stocks that broke out this week, tracked live since the breakout close · descriptive screen, not advice.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data?.available_weeks?.length > 0 && (
            <select value={week ?? ""} onChange={(e) => load(e.target.value)} style={{ padding: "8px 11px", borderRadius: 6, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 12 }}>
              {data.available_weeks.map((w) => <option key={w} value={w}>Week ending {w}</option>)}
            </select>
          )}
          <button onClick={() => load(week)} disabled={loading} style={{ background: loading ? "#1e293b" : "#00d4ff", color: loading ? "#64748b" : "#020617", border: "none", padding: "9px 16px", borderRadius: 6, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{loading ? "…" : "↻"}</button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {s && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, fontSize: 11, fontFamily: "JetBrains Mono" }}>
          <span style={{ background: "rgba(0,212,255,0.1)", color: "#00d4ff", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>{s.n} BREAKOUTS</span>
          <span style={{ background: "rgba(148,163,184,0.1)", color: s.avg_since_pct >= 0 ? "#00e396" : "#ff4d4d", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>AVG SINCE {num(s.avg_since_pct, "%", true)}</span>
          <span style={{ background: "rgba(0,212,255,0.1)", color: "#00d4ff", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>{s.active} ACTIVE</span>
          <span style={{ background: "rgba(0,227,150,0.1)", color: "#00e396", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>{s.extended} EXTENDED</span>
          <span style={{ background: "rgba(255,77,77,0.1)", color: "#ff4d4d", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>{s.failed} FAILED</span>
        </div>
      )}

      {highlight && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          {[{ lab: "BEST SINCE BREAKOUT", b: highlight.best, c: "#00e396" }, { lab: "WORST SINCE BREAKOUT", b: highlight.worst, c: "#ff4d4d" }].map(({ lab, b, c }) => (
            <div key={lab} style={{ background: "#020617", border: `1px solid ${c}44`, borderRadius: 8, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <div style={{ fontSize: 9, color: "#64748b", fontFamily: "JetBrains Mono", letterSpacing: "0.05em", marginBottom: 4 }}>{lab}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#00d4ff", fontFamily: "JetBrains Mono" }}>{b.symbol}</div>
                <div style={{ fontSize: 10, color: "#64748b", fontFamily: "JetBrains Mono", marginTop: 2 }}>₹{b.breakout_close} → ₹{b.current_price}</div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: c, fontFamily: "JetBrains Mono", whiteSpace: "nowrap" }}>{b.since_pct >= 0 ? "+" : ""}{b.since_pct}%</div>
            </div>
          ))}
        </div>
      )}

      {addMsg && <div style={{ fontSize: 11, fontFamily: "JetBrains Mono", fontWeight: 700, color: addMsg.err ? "#ff4d4d" : "#00e396", marginBottom: 12, lineHeight: 1.5 }}>{addMsg.text}</div>}

      <Disclaimer />

      {loading && !data ? <p style={{ color: "#00d4ff", fontSize: 11, fontFamily: "JetBrains Mono", padding: "16px 0" }}>Loading breakouts & live prices…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "JetBrains Mono", whiteSpace: "nowrap" }}>
            <thead><tr style={{ borderBottom: "1px solid #1e293b" }}>
              {COLS.map((c) => (
                <th key={c.key} onClick={() => setSort(c.key, c.numeric)}
                  style={{ padding: "0 10px 8px", textAlign: rightCols.has(c.key) ? "right" : "left", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", cursor: "pointer", userSelect: "none", color: sortKey === c.key ? "#00d4ff" : "#64748b" }}>
                  {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>))}
              <th style={{ padding: "0 10px 8px", textAlign: "center", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", color: "#64748b" }}>1M TREND</th>
              <th style={{ padding: "0 10px 8px", textAlign: "center", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", color: "#64748b" }}>ADD TO PF</th>
            </tr></thead>
            <tbody>
              {view.map((b) => (
                <tr key={b.symbol} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "10px", fontWeight: 700, color: "#00d4ff" }}>{b.symbol}</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 700 }} title={`as of ${week} scan — not re-evaluated live`}>{num(b.score)}</td>
                  <td style={{ padding: "10px" }}>
                    {b.state ? <span style={{ background: (STATE_STYLE[b.state] || {}).bg, color: (STATE_STYLE[b.state] || {}).color, padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 800, letterSpacing: "0.03em" }}>{b.state}</span> : <span style={{ color: "#475569" }}>—</span>}
                  </td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }}>{num(b.breakout_close)}</td>
                  <td style={{ padding: "10px", textAlign: "right" }}>{b.stale ? <span style={{ color: "#f59e0b" }} title="live price unavailable">n/a</span> : num(b.current_price)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }} title="highest price reached since the breakout">{num(b.high_since)}</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 800, color: b.since_pct == null ? "#475569" : pnlColor(b.since_pct) }}>{num(b.since_pct, "%", true)}</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: b.rule_pct == null ? "#475569" : pnlColor(b.rule_pct) }} title={`next-open entry, ${data?.rule?.horizon_td ?? 20}-day horizon${b.rule_open ? " — still open, marked to latest close" : " — realized"}`}>{num(b.rule_pct, "%", true)}{b.rule_open && b.rule_pct != null ? <span style={{ color: "#64748b", fontSize: 9 }}> ○</span> : ""}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: pnlColor(b.week_return_pct) }}>{num(b.week_return_pct, "%", true)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: b.vol_surge >= 30 ? "#ff4d4d" : "#f59e0b" }} title={b.vol_surge >= 30 ? "extreme surge — verify for corporate action / thin volume base" : ""}>{num(b.vol_surge, "×")}{b.vol_surge >= 30 ? " ⚠" : ""}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: pnlColor(b.ret_4w) }}>{num(b.ret_4w, "%", true)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: pnlColor(b.ret_12w) }}>{num(b.ret_12w, "%", true)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }}>{num(b.from_52w_high, "%")}</td>
                  <td style={{ padding: "10px", color: "#94a3b8" }} title={`as of ${week} scan — not re-evaluated live`}>{b.gates}</td>
                  <td style={{ padding: "8px 10px", textAlign: "center" }}><span style={{ display: "inline-block", verticalAlign: "middle" }}><Spark data={b.spark} /></span></td>
                  <td style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                    {b.stale || b.current_price == null ? (
                      <span style={{ color: "#475569" }}>—</span>
                    ) : addKey === b.symbol ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <input value={addQty} onChange={(e) => setAddQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") confirmAdd(b); if (e.key === "Escape") cancelAdd(); }} inputMode="decimal" placeholder="qty" autoFocus style={{ width: 50, padding: "4px 6px", borderRadius: 4, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 11, textAlign: "right" }} />
                        <button onClick={() => confirmAdd(b)} title={`Add at ₹${b.current_price}`} style={{ background: "transparent", border: "none", color: "#00e396", cursor: "pointer", fontSize: 14, fontFamily: "JetBrains Mono" }}>✓</button>
                        <button onClick={cancelAdd} title="Cancel" style={{ background: "transparent", border: "none", color: "#ff4d4d", cursor: "pointer", fontSize: 12, fontFamily: "JetBrains Mono" }}>✕</button>
                      </span>
                    ) : (
                      <button onClick={() => startAdd(b)} title={`Add ${b.symbol} to portfolio at ₹${b.current_price}`} style={{ background: "transparent", border: "1px solid #1e293b", color: "#00d4ff", cursor: "pointer", fontSize: 10, fontFamily: "JetBrains Mono", padding: "4px 9px", borderRadius: 4, fontWeight: 700 }}>+ PF</button>
                    )}
                  </td>
                </tr>))}
              {!view.length && !loading && (
                <tr><td colSpan={COLS.length + 2} style={{ padding: "24px 10px", textAlign: "center", color: "#64748b", fontSize: 11 }}>No breakouts in this week's file.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 10, color: "#475569", fontFamily: "JetBrains Mono", marginTop: 12, lineHeight: 1.6 }}>
        <b style={{ color: "#64748b" }}>STATE</b> (live, vs breakout close {week}): FAILED ≤ {data?.rule?.state_fail_pct ?? -5}% · ACTIVE between · EXTENDED ≥ +{data?.rule?.state_ext_pct ?? 10}%.
        {" "}<b style={{ color: "#64748b" }}>RULE %</b> = mechanical rule — buy the first session's open after the breakout, hold {data?.rule?.horizon_td ?? 20} trading days; ○ = horizon not elapsed, marked to latest close (not yet realized).
        {" "}<b style={{ color: "#64748b" }}>SCORE* / GATES*</b> are snapshots from the breakout scan, not re-checked live — the STATE column is the live re-evaluation.
        {" "}<b style={{ color: "#f59e0b" }}>⚠</b> flags an extreme volume surge (verify for a corporate action or thin base).
        <br />⚠ <b style={{ color: "#94a3b8" }}>Survivorship:</b> this list only shows names that broke out <i>and still pass all gates</i> — failed/dropped triggers aren't in the file, so it is not a forward-return test. RS-vs-market is omitted (within one week it's just 4W% minus a constant, so it can't re-rank).
      </div>
    </div>
  );
}

// ========================================================== VCP BREAKOUTS
function VCPBreakoutsView() {
  const [data, setData] = useState(null);
  const [week, setWeek] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState("adtv");
  const [sortDir, setSortDir] = useState("desc");

  const load = useCallback(async (w) => {
    setLoading(true); setError(null);
    try {
      const { data: res } = await axios.get(`${API_BASE}/vcp-breakouts${w ? `?week=${w}` : ""}`);
      setData(res); setWeek(res.week_ending);
    } catch (e) { setError(e?.response?.data?.detail ?? "Failed to load VCP breakouts."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setSort = (key, numeric) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(numeric ? "desc" : "asc"); }
  };

  const view = useMemo(() => {
    const rows = data?.breakouts ?? [];
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }, [data, sortKey, sortDir]);

  const COLS = [
    { key: "symbol", label: "SYMBOL", numeric: false },
    { key: "breakout_close", label: "BREAKOUT ₹", numeric: true },
    { key: "current_price", label: "NOW ₹", numeric: true },
    { key: "since_pct", label: "SINCE %", numeric: true },
    { key: "base_high", label: "PIVOT ₹", numeric: true },
    { key: "ext_above_pivot_pct", label: "EXT %", numeric: true },
    { key: "base_depth_pct", label: "DEPTH %", numeric: true },
    { key: "vol_mult", label: "VOL ×", numeric: true },
    { key: "close_strength", label: "CLOSE STR", numeric: true },
    { key: "tr_contraction", label: "TR CONTR", numeric: true },
    { key: "adtv", label: "ADTV cr", numeric: true },
    { key: "near_results", label: "NEAR EARN", numeric: false },
  ];
  const rightCols = new Set(COLS.filter((c) => c.numeric).map((c) => c.key));
  const s = data?.summary;

  return (
    <div style={{ background: "#0b0f19", padding: 20, borderRadius: 10, border: "1px solid #1e293b" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 4px", fontSize: 13, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono", display: "flex", alignItems: "center", gap: 10 }}>🔬 VCP / STAGE-2 BREAKOUTS {week && <ScoredChip date={week} />}</h4>
          <p style={{ margin: 0, color: "#64748b", fontSize: 11 }}>Weinstein Stage-2 breakouts from a contracting base · research view, backtested to no edge.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data?.available_weeks?.length > 0 && (
            <select value={week ?? ""} onChange={(e) => load(e.target.value)} style={{ padding: "8px 11px", borderRadius: 6, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 12 }}>
              {data.available_weeks.map((w) => <option key={w} value={w}>Week ending {w}</option>)}
            </select>
          )}
          <button onClick={() => load(week)} disabled={loading} style={{ background: loading ? "#1e293b" : "#00d4ff", color: loading ? "#64748b" : "#020617", border: "none", padding: "9px 16px", borderRadius: 6, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{loading ? "…" : "↻"}</button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {data?.verdict && (
        <div style={{ background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.35)", borderRadius: 8, padding: "11px 14px", marginBottom: 14, fontSize: 11, lineHeight: 1.55, color: "#fca5a5", fontFamily: "JetBrains Mono" }}>
          <b style={{ color: "#ff4d4d" }}>⚠ NO PROVEN EDGE.</b> {data.verdict}
        </div>
      )}

      {s && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, fontSize: 11, fontFamily: "JetBrains Mono" }}>
          <span style={{ background: "rgba(0,212,255,0.1)", color: "#00d4ff", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>{s.n} SIGNALS</span>
          {s.avg_since_pct != null && <span style={{ background: "rgba(148,163,184,0.1)", color: s.avg_since_pct >= 0 ? "#00e396" : "#ff4d4d", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>AVG SINCE {num(s.avg_since_pct, "%", true)}</span>}
        </div>
      )}

      {loading && !data ? <p style={{ color: "#00d4ff", fontSize: 11, fontFamily: "JetBrains Mono", padding: "16px 0" }}>Loading VCP signals & live prices…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "JetBrains Mono", whiteSpace: "nowrap" }}>
            <thead><tr style={{ borderBottom: "1px solid #1e293b" }}>
              {COLS.map((c) => (
                <th key={c.key} onClick={() => setSort(c.key, c.numeric)}
                  style={{ padding: "0 10px 8px", textAlign: rightCols.has(c.key) ? "right" : "left", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", cursor: "pointer", userSelect: "none", color: sortKey === c.key ? "#00d4ff" : "#64748b" }}>
                  {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>))}
              <th style={{ padding: "0 10px 8px", textAlign: "center", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", color: "#64748b" }}>1M TREND</th>
            </tr></thead>
            <tbody>
              {view.map((b) => (
                <tr key={b.symbol} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "10px", fontWeight: 700, color: "#00d4ff" }}>{b.symbol}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }}>{num(b.breakout_close)}</td>
                  <td style={{ padding: "10px", textAlign: "right" }}>{b.stale ? <span style={{ color: "#f59e0b" }} title="live price unavailable">n/a</span> : num(b.current_price)}</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 800, color: b.since_pct == null ? "#475569" : pnlColor(b.since_pct) }}>{num(b.since_pct, "%", true)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }} title="base high / breakout pivot">{num(b.base_high)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }} title="close vs pivot; >25% is rejected">{num(b.ext_above_pivot_pct, "%")}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }} title="base depth; ≤35% required">{num(b.base_depth_pct, "%")}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: b.vol_mult >= 20 ? "#ff4d4d" : "#f59e0b" }} title="breakout volume vs 20w avg">{num(b.vol_mult, "×")}{b.vol_mult >= 20 ? " ⚠" : ""}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }} title="close position in weekly range; ≥0.6 required">{num(b.close_strength)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }} title="mean TR last 4 wks / first 4 wks of base; <1 = contraction">{num(b.tr_contraction)}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }}>{num(b.adtv)}</td>
                  <td style={{ padding: "10px", textAlign: "left" }} title="breakout within ±1 week of a quarterly-results date — i.e. possibly earnings drift, not a technical breakout">
                    {b.near_results == null ? <span style={{ color: "#475569" }}>?</span>
                      : b.near_results ? <span style={{ color: "#f59e0b", fontWeight: 700 }}>⚡ earnings</span>
                      : <span style={{ color: "#00e396" }}>technical</span>}
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "center" }}><span style={{ display: "inline-block", verticalAlign: "middle" }}><Spark data={b.spark} /></span></td>
                </tr>))}
              {!view.length && !loading && (
                <tr><td colSpan={COLS.length + 1} style={{ padding: "24px 10px", textAlign: "center", color: "#64748b", fontSize: 11 }}>No VCP signals in this week's file.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 10, color: "#475569", fontFamily: "JetBrains Mono", marginTop: 12, lineHeight: 1.6 }}>
        <b style={{ color: "#64748b" }}>PIVOT</b> = base high (breakout level). <b style={{ color: "#64748b" }}>EXT %</b> = close above pivot (entries &gt;25% rejected). <b style={{ color: "#64748b" }}>DEPTH %</b> = base depth (≤35%). <b style={{ color: "#64748b" }}>TR CONTR</b> &lt; 1 confirms volatility contraction (VCP). <b style={{ color: "#f59e0b" }}>NEAR EARN</b> = breakout within ±1 wk of a quarterly-results date (⚡ = likely earnings-driven, not a clean technical breakout; ? = no earnings data). Gates: liquid ≥ ₹2 cr/wk, price ≥ ₹30, listed ≥ 60 wk, close &gt; rising 30-wk SMA, volume ≥ 1.5× 20-wk avg, close in top 40% of range. Base window 20 wk (--base-len, spec range 8–40).
      </div>
    </div>
  );
}

// ============================================================== MY PORTFOLIO
const fmtINR = (v) => "₹" + Math.round(v).toLocaleString("en-IN");
const fmtUSD = (v) => "$" + Math.round(v).toLocaleString("en-US");
const signed = (fn) => (v) => (v >= 0 ? "+" : "−") + fn(Math.abs(v)).replace(/^[+−-]/, "");
const nativePx = (v, ccy) => (ccy === "USD" ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const pnlColor = (v) => (v >= 0 ? "#00e396" : "#ff4d4d");

// SHA-256 hex of a string (crypto.subtle works on localhost — a secure context).
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function Spark({ data }) {
  if (!data || data.length < 2) return <span style={{ color: "#475569", fontSize: 10 }}>—</span>;
  const w = 82, h = 22, pad = 2;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const x = (i) => pad + (i / (data.length - 1)) * (w - 2 * pad);
  const y = (v) => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = data[data.length - 1] >= data[0];
  const color = up ? "#00e396" : "#ff4d4d";
  return (
    <svg width={w} height={h} style={{ display: "block" }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r="1.8" fill={color} />
    </svg>
  );
}

function PortfolioView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [disp, setDisp] = useState("INR");
  const [sortKey, setSortKey] = useState("value_inr");
  const [sortDir, setSortDir] = useState("desc");
  const [form, setForm] = useState({ symbol: "", exchange: "NSE", qty: "", avg_price: "" });
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState(null);
  const [editKey, setEditKey] = useState(null);
  const [editVals, setEditVals] = useState({ qty: "", avg_price: "" });
  const [pinHash, setPinHash] = useState(() => localStorage.getItem("pfPinHash"));
  const [unlocked, setUnlocked] = useState(() => !localStorage.getItem("pfPinHash") || sessionStorage.getItem("pfUnlocked") === "1");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [setupMode, setSetupMode] = useState(false);
  const [lockMsg, setLockMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data: res } = await axios.get(`${API_BASE}/portfolio`);
      setData(res);
    } catch (e) { setError(e?.response?.data?.detail ?? "Failed to load portfolio. Is the backend running and holdings.json present?"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (unlocked) load(); }, [load, unlocked]);

  const doUnlock = async () => {
    if ((await sha256(pin)) === pinHash) { setUnlocked(true); sessionStorage.setItem("pfUnlocked", "1"); setPin(""); setLockMsg(null); }
    else setLockMsg("Incorrect PIN.");
  };
  const doSetup = async () => {
    if (!/^\d{4,8}$/.test(pin)) { setLockMsg("PIN must be 4–8 digits."); return; }
    if (pin !== pin2) { setLockMsg("PINs do not match."); return; }
    const h = await sha256(pin);
    localStorage.setItem("pfPinHash", h); setPinHash(h);
    sessionStorage.setItem("pfUnlocked", "1"); setUnlocked(true);
    setSetupMode(false); setPin(""); setPin2(""); setLockMsg("Lock enabled.");
  };
  const lockNow = () => { sessionStorage.removeItem("pfUnlocked"); setUnlocked(false); setPin(""); setLockMsg(null); };
  const resetLock = () => { localStorage.removeItem("pfPinHash"); sessionStorage.removeItem("pfUnlocked"); setPinHash(null); setUnlocked(true); setPin(""); setLockMsg("Lock removed."); };

  const rate = data?.fx?.rate ?? 1;
  const base = useCallback((inr) => (disp === "INR" ? fmtINR(inr) : fmtUSD(inr / rate)), [disp, rate]);
  const baseSigned = useCallback((inr) => (inr >= 0 ? "+" : "−") + base(Math.abs(inr)), [base]);

  const view = useMemo(() => {
    if (!data?.holdings) return [];
    const dir = sortDir === "asc" ? 1 : -1;
    return [...data.holdings].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }, [data, sortKey, sortDir]);

  const setSort = (key, numeric) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(numeric ? "desc" : "asc"); }
  };

  const movers = useMemo(() => {
    const hs = (data?.holdings ?? []).filter((h) => !h.stale && typeof h.day_change_pct === "number");
    const gainers = hs.filter((h) => h.day_change_pct > 0).sort((a, b) => b.day_change_pct - a.day_change_pct).slice(0, 5);
    const losers = hs.filter((h) => h.day_change_pct < 0).sort((a, b) => a.day_change_pct - b.day_change_pct).slice(0, 5);
    return { gainers, losers };
  }, [data]);

  const addPosition = async (e) => {
    e?.preventDefault();
    const symbol = form.symbol.trim().toUpperCase();
    const qty = parseFloat(form.qty), avg_price = parseFloat(form.avg_price);
    if (!symbol || !(qty > 0) || !(avg_price > 0)) {
      setFormMsg({ err: true, text: "Enter a symbol and a positive quantity and buy price." });
      return;
    }
    setSaving(true); setFormMsg(null);
    try {
      await axios.post(`${API_BASE}/portfolio/positions`, { symbol, exchange: form.exchange, qty, avg_price });
      setForm((f) => ({ symbol: "", exchange: f.exchange, qty: "", avg_price: "" }));
      setFormMsg({ err: false, text: `${symbol} saved.` });
      await load();
    } catch (err) {
      setFormMsg({ err: true, text: err?.response?.data?.detail ?? "Could not add position." });
    } finally { setSaving(false); }
  };

  const removePosition = async (h) => {
    if (!window.confirm(`Remove ${h.symbol} (${h.exchange}) from your portfolio?`)) return;
    try {
      await axios.delete(`${API_BASE}/portfolio/positions/${encodeURIComponent(h.symbol)}?exchange=${h.exchange}`);
      await load();
    } catch (err) { setError(err?.response?.data?.detail ?? "Could not remove position."); }
  };

  const startEdit = (h) => { setEditKey(`${h.symbol}|${h.exchange}`); setEditVals({ qty: String(h.qty), avg_price: String(h.avg_price) }); };
  const cancelEdit = () => { setEditKey(null); };
  const saveEdit = async (h) => {
    const qty = parseFloat(editVals.qty), avg_price = parseFloat(editVals.avg_price);
    if (!(qty > 0) || !(avg_price > 0)) { setError("Quantity and buy price must be positive."); return; }
    try {
      await axios.put(`${API_BASE}/portfolio/positions/${encodeURIComponent(h.symbol)}`, { qty, avg_price, exchange: h.exchange });
      setEditKey(null); setError(null);
      await load();
    } catch (err) { setError(err?.response?.data?.detail ?? "Could not update position."); }
  };

  const finp = { padding: "8px 11px", borderRadius: 5, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 12 };
  const flab = { fontSize: 9, color: "#64748b", fontFamily: "JetBrains Mono", display: "block", marginBottom: 4, letterSpacing: "0.05em" };

  const s = data?.summary;
  const hasHoldings = data?.holdings?.length > 0;
  const COLS = [
    { key: "symbol", label: "SYMBOL", numeric: false },
    { key: "exchange", label: "MKT", numeric: false },
    { key: "qty", label: "QTY", numeric: true },
    { key: "avg_price", label: "AVG BUY", numeric: true },
    { key: "last_price", label: "LTP", numeric: true },
    { key: "invested_inr", label: "INVESTED", numeric: true },
    { key: "value_inr", label: "VALUE", numeric: true },
    { key: "pnl_inr", label: "P&L", numeric: true },
    { key: "pnl_pct", label: "P&L %", numeric: true },
    { key: "day_change_pct", label: "DAY %", numeric: true },
  ];
  const rightCols = new Set(["qty", "avg_price", "last_price", "invested_inr", "value_inr", "pnl_inr", "pnl_pct", "day_change_pct"]);

  if (pinHash && !unlocked) {
    return (
      <div style={{ maxWidth: 380, margin: "56px auto", background: "#0b0f19", border: "1px solid #1e293b", borderRadius: 12, padding: 30, textAlign: "center", fontFamily: "JetBrains Mono" }}>
        <div style={{ fontSize: 30, marginBottom: 10 }}>🔒</div>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#00d4ff", marginBottom: 6 }}>PORTFOLIO LOCKED</div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 18 }}>Enter your PIN to view holdings.</div>
        <input type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && doUnlock()} inputMode="numeric" autoFocus placeholder="••••"
          style={{ width: 170, textAlign: "center", letterSpacing: "0.4em", padding: "11px 12px", borderRadius: 8, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 18 }} />
        <div style={{ marginTop: 16 }}>
          <button onClick={doUnlock} style={{ background: "#00d4ff", color: "#020617", border: "none", padding: "10px 28px", borderRadius: 8, fontWeight: 800, cursor: "pointer", fontSize: 12, fontFamily: "JetBrains Mono" }}>UNLOCK</button>
        </div>
        {lockMsg && <div style={{ marginTop: 12, fontSize: 11, color: "#ff4d4d", fontWeight: 700 }}>{lockMsg}</div>}
        <div onClick={resetLock} title="Removes the PIN — this is a casual local lock, not real security" style={{ marginTop: 20, fontSize: 10, color: "#475569", cursor: "pointer" }}>Forgot PIN? Reset lock</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, background: "#0b0f19", padding: 16, borderRadius: 8, border: "1px solid #1e293b", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 13, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono" }}>MY PORTFOLIO — NSE + US</h2>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>
            Live cost-basis vs. market price across both markets, rolled into ₹{data?.fx ? ` · USDINR ${rate}${data.fx.is_fallback ? " (fallback)" : ""}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4, background: "#020617", padding: 3, borderRadius: 6, border: "1px solid #1e293b" }}>
            {["INR", "USD"].map((c) => (
              <button key={c} onClick={() => setDisp(c)} style={{ background: disp === c ? "#00d4ff" : "transparent", color: disp === c ? "#020617" : "#94a3b8", border: "none", padding: "6px 14px", borderRadius: 4, fontWeight: 800, fontSize: 11, cursor: "pointer", fontFamily: "JetBrains Mono" }}>{c === "INR" ? "₹ INR" : "$ USD"}</button>
            ))}
          </div>
          <button onClick={load} disabled={loading} style={{ background: loading ? "#1e293b" : "#00d4ff", color: loading ? "#64748b" : "#020617", border: "none", padding: "9px 18px", borderRadius: 6, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{loading ? "…" : "↻ REFRESH"}</button>
          <button onClick={pinHash ? lockNow : () => { setSetupMode((v) => !v); setLockMsg(null); }} title={pinHash ? "Lock this tab now" : "Set a PIN to lock this tab"} style={{ background: "transparent", color: "#94a3b8", border: "1px solid #1e293b", padding: "9px 14px", borderRadius: 6, fontWeight: 800, cursor: "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{pinHash ? "🔒 LOCK" : "🔒 SET PIN"}</button>
        </div>
      </div>

      {setupMode && !pinHash && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", background: "#0b0f19", padding: 14, borderRadius: 10, border: "1px solid rgba(0,212,255,0.27)", marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono", alignSelf: "center", marginRight: 4 }}>🔒 SET A PIN</div>
          <div>
            <label style={flab}>NEW PIN (4–8 DIGITS)</label>
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} inputMode="numeric" style={{ ...finp, width: 120, letterSpacing: "0.2em" }} />
          </div>
          <div>
            <label style={flab}>CONFIRM PIN</label>
            <input type="password" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && doSetup()} inputMode="numeric" style={{ ...finp, width: 120, letterSpacing: "0.2em" }} />
          </div>
          <button onClick={doSetup} style={{ background: "#00e396", color: "#020617", border: "none", padding: "9px 18px", borderRadius: 6, fontWeight: 800, cursor: "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>SAVE PIN</button>
          <button onClick={() => { setSetupMode(false); setPin(""); setPin2(""); setLockMsg(null); }} style={{ ...finp, cursor: "pointer", color: "#94a3b8" }}>CANCEL</button>
          {lockMsg && <span style={{ fontSize: 11, fontFamily: "JetBrains Mono", color: lockMsg === "Lock enabled." ? "#00e396" : "#ff4d4d", fontWeight: 700 }}>{lockMsg}</span>}
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {data?.stale_symbols?.length > 0 && <ErrorBanner message={`Live price unavailable for: ${data.stale_symbols.join(", ")} — showing cost basis for these.`} />}

      {loading && !data && <div style={{ padding: 80, textAlign: "center", color: "#00d4ff", background: "#0b0f19", borderRadius: 8, border: "1px solid #1e293b", fontFamily: "JetBrains Mono", fontSize: 12 }}>Fetching live prices…</div>}

      {data && (
        <form onSubmit={addPosition} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", background: "#0b0f19", padding: 14, borderRadius: 10, border: "1px solid #1e293b", marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono", alignSelf: "center", marginRight: 4 }}>+ ADD POSITION</div>
          <div>
            <label style={flab}>SYMBOL</label>
            <input value={form.symbol} onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))} placeholder={form.exchange === "US" ? "AAPL" : "RELIANCE"} style={{ ...finp, width: 130 }} />
          </div>
          <div>
            <label style={flab}>EXCHANGE</label>
            <select value={form.exchange} onChange={(e) => setForm((f) => ({ ...f, exchange: e.target.value }))} style={finp}>
              <option value="NSE">NSE</option>
              <option value="US">US</option>
            </select>
          </div>
          <div>
            <label style={flab}>QUANTITY</label>
            <input value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} inputMode="decimal" placeholder="0" style={{ ...finp, width: 90 }} />
          </div>
          <div>
            <label style={flab}>AVG BUY PRICE ({form.exchange === "US" ? "$" : "₹"})</label>
            <input value={form.avg_price} onChange={(e) => setForm((f) => ({ ...f, avg_price: e.target.value }))} inputMode="decimal" placeholder="0.00" style={{ ...finp, width: 120 }} />
          </div>
          <button type="submit" disabled={saving} style={{ background: saving ? "#1e293b" : "#00e396", color: saving ? "#64748b" : "#020617", border: "none", padding: "9px 20px", borderRadius: 6, fontWeight: 800, cursor: saving ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{saving ? "SAVING…" : "ADD"}</button>
          {formMsg && <span style={{ fontSize: 11, fontFamily: "JetBrains Mono", color: formMsg.err ? "#ff4d4d" : "#00e396", fontWeight: 700 }}>{formMsg.text}</span>}
        </form>
      )}

      {hasHoldings && s && (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
          <StatCard label="TOTAL INVESTED" value={base(s.invested_inr)} />
          <StatCard label="CURRENT VALUE" value={base(s.value_inr)} />
          <StatCard label="TOTAL P&L" value={`${baseSigned(s.pnl_inr)}  ${s.pnl_pct >= 0 ? "▲" : "▼"}${Math.abs(s.pnl_pct)}%`} accent={pnlColor(s.pnl_inr)} />
          <StatCard label="DAY'S CHANGE" value={`${baseSigned(s.day_change_inr)}  ${s.day_change_pct >= 0 ? "▲" : "▼"}${Math.abs(s.day_change_pct)}%`} accent={pnlColor(s.day_change_inr)} />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 16, fontSize: 11, fontFamily: "JetBrains Mono" }}>
          <span style={{ background: "rgba(0,212,255,0.1)", color: "#00d4ff", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>NSE {data.allocation?.NSE ?? 0}%</span>
          <span style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>US {data.allocation?.US ?? 0}%</span>
          <div style={{ flex: 1, minWidth: 120, height: 6, background: "#f59e0b", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${data.allocation?.NSE ?? 0}%`, height: "100%", background: "#00d4ff" }} />
          </div>
          {s.best && <span style={{ color: "#64748b" }}>BEST <b style={{ color: "#00e396" }}>{s.best.symbol} +{s.best.pnl_pct}%</b></span>}
          {s.worst && <span style={{ color: "#64748b" }}>WORST <b style={{ color: pnlColor(s.worst.pnl_pct) }}>{s.worst.symbol} {s.worst.pnl_pct >= 0 ? "+" : ""}{s.worst.pnl_pct}%</b></span>}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {[
            { key: "g", title: "▲ TODAY'S GAINERS", rows: movers.gainers, color: "#00e396" },
            { key: "l", title: "▼ TODAY'S LOSERS", rows: movers.losers, color: "#ff4d4d" },
          ].map((col) => (
            <div key={col.key} style={{ background: "#0b0f19", border: "1px solid #1e293b", borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: col.color, fontFamily: "JetBrains Mono", letterSpacing: "0.05em", marginBottom: 8 }}>{col.title}</div>
              {col.rows.length === 0 ? (
                <div style={{ fontSize: 11, color: "#475569", fontFamily: "JetBrains Mono", padding: "6px 0" }}>None today.</div>
              ) : col.rows.map((h) => (
                <div key={h.symbol + h.exchange} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #0f172a" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ color: "#00d4ff", fontWeight: 700, fontFamily: "JetBrains Mono", fontSize: 12 }}>{h.symbol}</span>
                    <span style={{ background: h.exchange === "US" ? "rgba(245,158,11,0.12)" : "rgba(0,212,255,0.1)", color: h.exchange === "US" ? "#f59e0b" : "#00d4ff", padding: "1px 6px", borderRadius: 3, fontSize: 8, fontWeight: 700, fontFamily: "JetBrains Mono" }}>{h.exchange}</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "JetBrains Mono", fontSize: 12 }}>
                    <span style={{ color: col.color, fontWeight: 700 }}>{h.day_change_pct >= 0 ? "+" : ""}{h.day_change_pct}%</span>
                    <span style={{ color: "#64748b", fontSize: 11, minWidth: 80, textAlign: "right" }}>{baseSigned(h.day_change_inr)}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ background: "#0b0f19", border: "1px solid #1e293b", borderRadius: 10, padding: 14, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "JetBrains Mono", whiteSpace: "nowrap" }}>
            <thead><tr style={{ borderBottom: "1px solid #1e293b" }}>
              {COLS.map((c) => (
                <th key={c.key} onClick={() => setSort(c.key, c.numeric)}
                  style={{ padding: "0 10px 8px", textAlign: rightCols.has(c.key) ? "right" : "left", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", cursor: "pointer", userSelect: "none", color: sortKey === c.key ? "#00d4ff" : "#64748b" }}>
                  {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>))}
              <th style={{ padding: "0 10px 8px", textAlign: "center", fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", color: "#64748b" }}>1M TREND</th>
              <th style={{ padding: "0 10px 8px" }}></th>
            </tr></thead>
            <tbody>
              {view.map((h) => {
                const editing = editKey === `${h.symbol}|${h.exchange}`;
                const cellEdit = { ...finp, width: 74, textAlign: "right", padding: "5px 8px", fontSize: 11 };
                const iconBtn = { background: "transparent", border: "none", cursor: "pointer", fontSize: 13, fontFamily: "JetBrains Mono" };
                return (
                <tr key={h.symbol + h.exchange} style={{ borderBottom: "1px solid #0f172a", background: editing ? "rgba(0,212,255,0.04)" : "transparent" }}>
                  <td style={{ padding: "11px 10px", fontWeight: 700, color: "#00d4ff" }}>{h.symbol}</td>
                  <td style={{ padding: "11px 10px" }}>
                    <span style={{ background: h.exchange === "US" ? "rgba(245,158,11,0.12)" : "rgba(0,212,255,0.1)", color: h.exchange === "US" ? "#f59e0b" : "#00d4ff", padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>{h.exchange}</span>
                  </td>
                  <td style={{ padding: "11px 10px", textAlign: "right" }}>
                    {editing
                      ? <input value={editVals.qty} onChange={(e) => setEditVals((v) => ({ ...v, qty: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") saveEdit(h); if (e.key === "Escape") cancelEdit(); }} inputMode="decimal" autoFocus style={cellEdit} />
                      : h.qty}
                  </td>
                  <td style={{ padding: "11px 10px", textAlign: "right", color: editing ? "#f8fafc" : "#94a3b8" }}>
                    {editing
                      ? <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 3 }}>
                          <span style={{ color: "#64748b" }}>{h.currency === "USD" ? "$" : "₹"}</span>
                          <input value={editVals.avg_price} onChange={(e) => setEditVals((v) => ({ ...v, avg_price: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") saveEdit(h); if (e.key === "Escape") cancelEdit(); }} inputMode="decimal" style={cellEdit} />
                        </span>
                      : nativePx(h.avg_price, h.currency)}
                  </td>
                  <td style={{ padding: "11px 10px", textAlign: "right" }}>{nativePx(h.last_price, h.currency)}</td>
                  <td style={{ padding: "11px 10px", textAlign: "right", color: "#94a3b8" }}>{base(h.invested_inr)}</td>
                  <td style={{ padding: "11px 10px", textAlign: "right" }}>{base(h.value_inr)}</td>
                  <td style={{ padding: "11px 10px", textAlign: "right", fontWeight: 700, color: pnlColor(h.pnl_inr) }}>{baseSigned(h.pnl_inr)}</td>
                  <td style={{ padding: "11px 10px", textAlign: "right", fontWeight: 700, color: pnlColor(h.pnl_pct) }}>{h.pnl_pct >= 0 ? "+" : ""}{h.pnl_pct}%</td>
                  <td style={{ padding: "11px 10px", textAlign: "right", color: pnlColor(h.day_change_pct) }}>{h.day_change_pct >= 0 ? "+" : ""}{h.day_change_pct}%</td>
                  <td style={{ padding: "8px 10px", textAlign: "center" }}><span style={{ display: "inline-block", verticalAlign: "middle" }}><Spark data={h.spark} /></span></td>
                  <td style={{ padding: "11px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                    {editing ? (<>
                      <button onClick={() => saveEdit(h)} title="Save" style={{ ...iconBtn, color: "#00e396", fontSize: 15, marginRight: 8 }}>✓</button>
                      <button onClick={cancelEdit} title="Cancel" style={{ ...iconBtn, color: "#ff4d4d" }}>✕</button>
                    </>) : (<>
                      <button onClick={() => startEdit(h)} title={`Edit ${h.symbol}`} style={{ ...iconBtn, color: "#475569", marginRight: 10 }}>✎</button>
                      <button onClick={() => removePosition(h)} title={`Remove ${h.symbol}`} style={{ ...iconBtn, color: "#475569" }}>✕</button>
                    </>)}
                  </td>
                </tr>);
              })}
            </tbody>
          </table>
        </div>

        <div style={{ fontSize: 10, color: "#475569", fontFamily: "JetBrains Mono", marginTop: 12 }}>
          Per-share AVG BUY / LTP shown in native currency · INVESTED / VALUE / P&L rolled into {disp} at USDINR {rate} · LTP from yfinance (may lag ~15m) · positions from data/holdings.json. Factual reporting of your cost basis vs. latest price — not advice.
        </div>
      </>)}

      {data && !loading && !hasHoldings && (
        <div style={{ padding: 60, textAlign: "center", color: "#64748b", background: "#0b0f19", borderRadius: 10, border: "1px solid #1e293b", fontFamily: "JetBrains Mono", fontSize: 12 }}>
          No positions yet. Add your first holding above to start tracking P&L.
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ============================================================ PROFIT BOOKING
const signedINR = (v) => `${v >= 0 ? "+" : "−"}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;

function BookedView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [held, setHeld] = useState({});
  const [form, setForm] = useState({ symbol: "", exchange: "NSE", qty: "", buy_price: "", sell_price: "", date: "", note: "", reduce_holding: true });
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const { data: res } = await axios.get(`${API_BASE}/booked`); setData(res); }
    catch (e) { setError(e?.response?.data?.detail ?? "Failed to load booked trades."); }
    finally { setLoading(false); }
  }, []);
  const loadHeld = useCallback(async () => {
    try {
      const { data: res } = await axios.get(`${API_BASE}/portfolio`);
      const m = {};
      (res.holdings ?? []).forEach((h) => { m[h.symbol.toUpperCase()] = { exchange: h.exchange, avg_price: h.avg_price }; });
      setHeld(m);
    } catch { /* holdings optional for prefill */ }
  }, []);
  useEffect(() => { load(); loadHeld(); }, [load, loadHeld]);

  const onSymbol = (v) => {
    const sym = v.toUpperCase();
    const h = held[sym.replace(/\.NS$/, "")];
    setForm((f) => ({ ...f, symbol: sym, ...(h ? { exchange: h.exchange, buy_price: String(h.avg_price) } : {}) }));
  };

  const submit = async (e) => {
    e?.preventDefault();
    const qty = parseFloat(form.qty), buy = parseFloat(form.buy_price), sell = parseFloat(form.sell_price);
    if (!form.symbol.trim() || !(qty > 0) || !(buy > 0) || !(sell > 0)) { setFormMsg({ err: true, text: "Enter a symbol, quantity, and positive buy and sell prices." }); return; }
    setSaving(true); setFormMsg(null);
    try {
      const body = { symbol: form.symbol.trim(), exchange: form.exchange, qty, buy_price: buy, sell_price: sell, note: form.note, reduce_holding: form.reduce_holding };
      if (form.date) body.date = form.date;
      const { data: res } = await axios.post(`${API_BASE}/booked`, body);
      const rs = res.reduced?.status;
      const redMsg = rs === "reduced" ? ` · holding reduced to ${res.reduced.remaining_qty}` : rs === "closed" ? " · holding fully closed" : rs === "not_held" ? " · (no matching holding found to reduce)" : "";
      setForm((f) => ({ symbol: "", exchange: f.exchange, qty: "", buy_price: "", sell_price: "", date: "", note: "", reduce_holding: f.reduce_holding }));
      setFormMsg({ err: false, text: `Booked ${res.trade.symbol}: ${signedINR(res.trade.realized_inr)} realized (${res.trade.realized_pct >= 0 ? "+" : ""}${res.trade.realized_pct}%)${redMsg}.` });
      await load(); await loadHeld();
    } catch (err) { setFormMsg({ err: true, text: err?.response?.data?.detail ?? "Could not book the trade." }); }
    finally { setSaving(false); }
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete booked ${t.symbol} (${t.date})? This only edits the ledger — it won't restore the holding.`)) return;
    try { await axios.delete(`${API_BASE}/booked/${t.id}`); await load(); }
    catch (err) { setError(err?.response?.data?.detail ?? "Could not delete."); }
  };

  const finp = { padding: "8px 11px", borderRadius: 5, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 12 };
  const flab = { fontSize: 9, color: "#64748b", fontFamily: "JetBrains Mono", display: "block", marginBottom: 4, letterSpacing: "0.05em" };
  const s = data?.summary;
  const trades = data?.trades ?? [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, background: "#0b0f19", padding: 16, borderRadius: 8, border: "1px solid #1e293b", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 13, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono" }}>PROFIT BOOKING — REALIZED P&L</h2>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>Ledger of booked (sold) trades · realized ₹ locked at the sale (US converted at the day's USDINR).</p>
        </div>
        <button onClick={() => { load(); loadHeld(); }} disabled={loading} style={{ background: loading ? "#1e293b" : "#00d4ff", color: loading ? "#64748b" : "#020617", border: "none", padding: "9px 18px", borderRadius: 6, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{loading ? "…" : "↻ REFRESH"}</button>
      </div>

      {error && <ErrorBanner message={error} />}

      {s && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
          <StatCard label="TOTAL REALIZED P&L" value={s.n ? signedINR(s.realized_inr) : "—"} accent={s.realized_inr >= 0 ? "#00e396" : "#ff4d4d"} />
          <StatCard label="BOOKED TRADES" value={s.n} />
          <StatCard label="WIN RATE" value={s.win_rate == null ? "—" : `${s.win_rate}%`} accent="#38bdf8" badge={s.n ? `${s.wins}W · ${s.losses}L` : null} />
          <StatCard label="BEST BOOK" value={s.best ? `${s.best.symbol}  ${signedINR(s.best.realized_inr)}` : "—"} accent="#00e396" />
        </div>
      )}

      <form onSubmit={submit} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", background: "#0b0f19", padding: 14, borderRadius: 10, border: "1px solid #1e293b", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#00e396", fontWeight: 800, fontFamily: "JetBrains Mono", alignSelf: "center", marginRight: 4 }}>+ BOOK A SALE</div>
        <div>
          <label style={flab}>SYMBOL</label>
          <input value={form.symbol} onChange={(e) => onSymbol(e.target.value)} placeholder={form.exchange === "US" ? "NVDA" : "TCS"} list="held-syms" style={{ ...finp, width: 120 }} />
          <datalist id="held-syms">{Object.keys(held).map((k) => <option key={k} value={k} />)}</datalist>
        </div>
        <div>
          <label style={flab}>EXCHANGE</label>
          <select value={form.exchange} onChange={(e) => setForm((f) => ({ ...f, exchange: e.target.value }))} style={finp}>
            <option value="NSE">NSE</option><option value="US">US</option>
          </select>
        </div>
        <div>
          <label style={flab}>QTY SOLD</label>
          <input value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} inputMode="decimal" placeholder="0" style={{ ...finp, width: 80 }} />
        </div>
        <div>
          <label style={flab}>BUY PRICE ({form.exchange === "US" ? "$" : "₹"})</label>
          <input value={form.buy_price} onChange={(e) => setForm((f) => ({ ...f, buy_price: e.target.value }))} inputMode="decimal" placeholder="0.00" style={{ ...finp, width: 100 }} />
        </div>
        <div>
          <label style={flab}>SELL PRICE ({form.exchange === "US" ? "$" : "₹"})</label>
          <input value={form.sell_price} onChange={(e) => setForm((f) => ({ ...f, sell_price: e.target.value }))} inputMode="decimal" placeholder="0.00" style={{ ...finp, width: 100 }} />
        </div>
        <div>
          <label style={flab}>DATE</label>
          <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} style={{ ...finp, width: 140 }} />
        </div>
        <div>
          <label style={flab}>NOTE</label>
          <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="optional" style={{ ...finp, width: 130 }} />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#94a3b8", fontFamily: "JetBrains Mono", cursor: "pointer", alignSelf: "center" }}>
          <input type="checkbox" checked={form.reduce_holding} onChange={(e) => setForm((f) => ({ ...f, reduce_holding: e.target.checked }))} />
          reduce holding
        </label>
        <button type="submit" disabled={saving} style={{ background: saving ? "#1e293b" : "#00e396", color: saving ? "#64748b" : "#020617", border: "none", padding: "9px 20px", borderRadius: 6, fontWeight: 800, cursor: saving ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{saving ? "BOOKING…" : "BOOK"}</button>
        {formMsg && <span style={{ fontSize: 11, fontFamily: "JetBrains Mono", color: formMsg.err ? "#ff4d4d" : "#00e396", fontWeight: 700, flexBasis: "100%" }}>{formMsg.text}</span>}
      </form>

      {loading && !data ? <p style={{ color: "#00d4ff", fontSize: 11, fontFamily: "JetBrains Mono", padding: "16px 0" }}>Loading ledger…</p> : trades.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", color: "#64748b", background: "#0b0f19", borderRadius: 10, border: "1px solid #1e293b", fontFamily: "JetBrains Mono", fontSize: 12 }}>
          No booked trades yet. Record a sale above to start tracking realized profits.
        </div>
      ) : (
        <div style={{ background: "#0b0f19", border: "1px solid #1e293b", borderRadius: 10, padding: 14, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "JetBrains Mono", whiteSpace: "nowrap" }}>
            <thead><tr style={{ borderBottom: "1px solid #1e293b", color: "#64748b", fontSize: 10, letterSpacing: "0.05em" }}>
              {["DATE", "SYMBOL", "MKT", "QTY", "BUY", "SELL", "REALIZED ₹", "RET %", "NOTE", ""].map((h, i) => (
                <th key={i} style={{ padding: "0 10px 8px", textAlign: i >= 3 && i <= 7 ? "right" : "left", fontWeight: 600 }}>{h}</th>))}
            </tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "10px", color: "#94a3b8" }}>{t.date}</td>
                  <td style={{ padding: "10px", fontWeight: 700, color: "#00d4ff" }}>{t.symbol}</td>
                  <td style={{ padding: "10px" }}><span style={{ background: t.exchange === "US" ? "rgba(245,158,11,0.12)" : "rgba(0,212,255,0.1)", color: t.exchange === "US" ? "#f59e0b" : "#00d4ff", padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>{t.exchange}</span></td>
                  <td style={{ padding: "10px", textAlign: "right" }}>{t.qty}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }}>{nativePx(t.buy_price, t.currency)}</td>
                  <td style={{ padding: "10px", textAlign: "right" }}>{nativePx(t.sell_price, t.currency)}</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 800, color: pnlColor(t.realized_inr) }}>{signedINR(t.realized_inr)}</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: pnlColor(t.realized_pct) }}>{t.realized_pct >= 0 ? "+" : ""}{t.realized_pct}%</td>
                  <td style={{ padding: "10px", color: "#64748b", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{t.note}</td>
                  <td style={{ padding: "10px", textAlign: "center" }}><button onClick={() => remove(t)} title="Delete ledger entry" style={{ background: "transparent", border: "none", color: "#475569", cursor: "pointer", fontSize: 13, fontFamily: "JetBrains Mono" }}>✕</button></td>
                </tr>))}
            </tbody>
          </table>
          <div style={{ fontSize: 10, color: "#475569", fontFamily: "JetBrains Mono", marginTop: 12 }}>
            REALIZED ₹ = (sell − buy) × qty, in INR (US booked at that day's USDINR, so it doesn't drift with today's rate) · "reduce holding" subtracts the sold qty from the matching position on the Portfolio tab. Records your own trades — not advice.
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================ TOP PERFORMERS
function TopPerformersView() {
  const [data, setData] = useState(null);
  const [week, setWeek] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (w) => {
    setLoading(true); setError(null);
    try {
      const { data: res } = await axios.get(`${API_BASE}/top-performers${w ? `?week=${w}` : ""}`);
      setData(res); setWeek(res.week_ending);
    } catch (e) { setError(e?.response?.data?.detail ?? "Failed to load top performers (is the panel built?)."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = data?.rows ?? [];
  const yes = (color, text) => <span style={{ background: `${color}22`, color, padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 800, fontFamily: "JetBrains Mono" }}>{text}</span>;
  const dash = <span style={{ color: "#475569" }}>–</span>;

  return (
    <div style={{ background: "#0b0f19", padding: 20, borderRadius: 10, border: "1px solid #1e293b" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 4px", fontSize: 13, color: "#00d4ff", fontWeight: 800, fontFamily: "JetBrains Mono", display: "flex", alignItems: "center", gap: 10 }}>🏆 PREVIOUS WEEK — TOP PERFORMERS {week && <ScoredChip date={week} />}</h4>
          <p style={{ margin: 0, color: "#64748b", fontSize: 11 }}>Best weekly returns across the tradeable universe · whether each is in your portfolio / the breakout screen, and which momentum gates it passed.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data?.available_weeks?.length > 0 && (
            <select value={week ?? ""} onChange={(e) => load(e.target.value)} style={{ padding: "8px 11px", borderRadius: 6, border: "1px solid #1e293b", background: "#020617", color: "#f8fafc", fontFamily: "JetBrains Mono", fontSize: 12 }}>
              {data.available_weeks.map((w) => <option key={w} value={w}>Week ending {w}</option>)}
            </select>
          )}
          <button onClick={() => load(week)} disabled={loading} style={{ background: loading ? "#1e293b" : "#00d4ff", color: loading ? "#64748b" : "#020617", border: "none", padding: "9px 16px", borderRadius: 6, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "JetBrains Mono" }}>{loading ? "…" : "↻"}</button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {data && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, fontSize: 11, fontFamily: "JetBrains Mono" }}>
          <span style={{ background: "rgba(148,163,184,0.1)", color: "#94a3b8", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>TOP {rows.length} of {data.n_universe} NAMES</span>
          <span style={{ background: "rgba(0,227,150,0.1)", color: "#00e396", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>{data.summary?.in_portfolio ?? 0} IN YOUR PORTFOLIO</span>
          <span style={{ background: "rgba(0,212,255,0.1)", color: "#00d4ff", padding: "5px 11px", borderRadius: 4, fontWeight: 700 }}>{data.screen_available ? `${data.summary?.in_screen} CAUGHT BY BREAKOUT SCREEN` : "screen n/a for this week"}</span>
        </div>
      )}

      <Disclaimer />

      {loading && !data ? <p style={{ color: "#00d4ff", fontSize: 11, fontFamily: "JetBrains Mono", padding: "16px 0" }}>Ranking the universe from the weekly panel…</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "JetBrains Mono", whiteSpace: "nowrap" }}>
            <thead><tr style={{ borderBottom: "1px solid #1e293b", color: "#64748b", fontSize: 10, letterSpacing: "0.05em" }}>
              {["#", "SYMBOL", "WK RET %", "CLOSE ₹", "4W %", "VOL ×", "SCORE", "IN PORTFOLIO", "IN SCREEN", "CHECKS PASSED"].map((h, i) => (
                <th key={i} style={{ padding: "0 10px 8px", textAlign: i >= 2 && i <= 6 ? "right" : "left", fontWeight: 600 }}>{h}</th>))}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.symbol} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "10px", color: "#64748b", fontWeight: 700 }}>{i + 1}</td>
                  <td style={{ padding: "10px", fontWeight: 700, color: "#00d4ff" }}>{r.symbol}</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 800, color: "#00e396" }}>+{r.week_return_pct}%</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#94a3b8" }}>₹{r.close}</td>
                  <td style={{ padding: "10px", textAlign: "right", color: pnlColor(r.ret_4w) }}>{r.ret_4w >= 0 ? "+" : ""}{r.ret_4w}%</td>
                  <td style={{ padding: "10px", textAlign: "right", color: "#f59e0b" }}>{r.vol_surge}×</td>
                  <td style={{ padding: "10px", textAlign: "right", fontWeight: 700 }}>{r.score}</td>
                  <td style={{ padding: "10px" }}>{r.in_portfolio ? yes("#00e396", "✓ HELD") : dash}</td>
                  <td style={{ padding: "10px" }}>{r.in_screen == null ? <span style={{ color: "#475569" }}>—</span> : r.in_screen ? yes("#00d4ff", "✓ YES") : dash}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: r.gates_passed === r.gates_total ? "#00e396" : r.gates_passed >= 7 ? "#f59e0b" : "#94a3b8" }}>{r.gates_passed}/{r.gates_total}</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, maxWidth: 300 }}>
                        {r.gates.map((g, gi) => (
                          <span key={gi} title={g.passed ? "passed" : "failed"} style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 3, fontFamily: "JetBrains Mono", background: g.passed ? "rgba(0,227,150,0.14)" : "transparent", color: g.passed ? "#00e396" : "#475569", border: g.passed ? "none" : "1px solid #1e293b" }}>{g.passed ? "✓" : "✕"} {g.label}</span>
                        ))}
                      </div>
                    </div>
                  </td>
                </tr>))}
              {!rows.length && !loading && (
                <tr><td colSpan={10} style={{ padding: "24px 10px", textAlign: "center", color: "#64748b", fontSize: 11 }}>No qualifying stocks for this week.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 10, color: "#475569", fontFamily: "JetBrains Mono", marginTop: 12, lineHeight: 1.6 }}>
        Top {rows.length} by weekly return among tradeable names (price ≥ ₹20, median turnover ≥ ₹1cr/day, ≥40 weeks history) · <b style={{ color: "#64748b" }}>IN SCREEN</b> = also flagged by the weekly breakout screen that week · <b style={{ color: "#64748b" }}>CHECKS PASSED</b> = the momentum gates (green = passed) — a big weekly gain often fails "Not a spike", which is why raw top performers aren't all breakout-quality. Descriptive, not advice.
      </div>
    </div>
  );
}

// ============================================================================
export default function App() {
  return (
    <Router>
      <div style={{ background: "#020617", minHeight: "100vh", color: "#f8fafc", padding: 24, fontFamily: "Inter, system-ui, sans-serif", boxSizing: "border-box" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0, fontFamily: "JetBrains Mono", color: "#f8fafc" }}>NSE FACTOR SCREENER</h1>
          <p style={{ color: "#334155", fontSize: 11, margin: "3px 0 0", fontFamily: "JetBrains Mono" }}>Research & screening terminal · descriptive factor rankings · not a signal engine · v5.3.0</p>
        </div>
        <Navbar />
        <Routes>
          <Route path="/portfolio" element={<PortfolioView />} />
          <Route path="/booked" element={<BookedView />} />
          <Route path="/" element={<ProfileView />} />
          <Route path="/screener" element={<ScreenerView />} />
          <Route path="/breakouts" element={<WeeklyBreakoutsView />} />
          <Route path="/top" element={<TopPerformersView />} />
          <Route path="/vcp" element={<VCPBreakoutsView />} />
        </Routes>
      </div>
    </Router>
  );
}
