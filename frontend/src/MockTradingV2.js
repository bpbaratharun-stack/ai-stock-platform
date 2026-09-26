/**
 * MockTradingV2 — a paper-trading sandbox to test the technical strategy.
 * Left: the strategy scanner (ranked NSE setups on the checklist). Right/below:
 * the virtual book (open positions with live P&L, closed trades with R-multiples).
 * Shares the v2 design system (PF2_CSS / FONTS) with PortfolioV2. Not advice.
 */
import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { FONTS, PF2_CSS } from "./PortfolioV2";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const inr = (v) => "₹" + Math.round(v).toLocaleString("en-IN");
const signedINR = (v) => (v >= 0 ? "+" : "−") + inr(Math.abs(v));
const scoreCls = (s) => (s >= 85 ? "hi" : s >= 70 ? "mid" : "lo");

// Two paper books, two rules. "checklist" = the discretionary scorecard (Mock 1);
// "turnaround" = the Chartink EMA scan (Mock 2): weekly EMA20/50/200 all rising for
// 25 weeks with EMA20 < EMA200 30 weeks ago (a fresh Stage-2 turnaround), entered on
// a daily trigger — EMA20/50 cross, a pullback to EMA20, or an EMA50/200 cross.
const VARIANTS = {
  checklist: { title: "Mock trading", path: "/v2/mock", scanTitle: "Strategy scanner",
    desc: null },
  turnaround: { title: "Mock trading 2", path: "/v2/mock2", scanTitle: "EMA turnaround scan",
    desc: "Weekly EMA20 / 50 / 200 all rising for 25 weeks, and EMA20 was below EMA200 30 weeks ago (a fresh turnaround, not an old leader). Shown when a daily trigger fires: EMA20 crosses EMA50, a pullback that touches EMA20 and closes above it, or EMA50 crosses EMA200." },
};
const TRIGGER_LABEL = { "cross20/50": "EMA20 ↗ EMA50", "pullback20": "Pullback to EMA20", "cross50/200": "EMA50 ↗ EMA200" };

export default function MockTradingV2({ variant = "checklist" }) {
  const V = VARIANTS[variant] ?? VARIANTS.checklist;
  const isTurn = variant === "turnaround";
  const hasSignalCol = isTurn;
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);
  const [book, setBook] = useState(null);
  const [minRr, setMinRr] = useState(2);
  const [size, setSize] = useState(100000);
  const [theme, setTheme] = useState("light");
  const [busy, setBusy] = useState(null);          // id/symbol currently mutating
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l); return () => { try { document.head.removeChild(l); } catch {} };
  }, []);

  const loadScan = useCallback(() => {
    setScan(null); setScanErr(null);
    axios.get(`${API_BASE}/strategy-scan?top=30&min_rr=${minRr}&variant=${variant}`)
      .then((r) => setScan(r.data))
      .catch((e) => setScanErr(e?.response?.data?.detail ?? "Scan failed."));
  }, [minRr, variant]);
  const loadBook = useCallback(() => {
    axios.get(`${API_BASE}/paper?strategy=${variant}`).then((r) => setBook(r.data)).catch(() => {});
  }, [variant]);
  useEffect(() => { loadScan(); }, [loadScan]);
  useEffect(() => { loadBook(); }, [loadBook]);

  const paperBuy = async (c) => {
    setBusy(c.symbol); setMsg(null);
    try {
      await axios.post(`${API_BASE}/paper`, {
        symbol: c.symbol, exchange: "NSE", notional_inr: Number(size),
        target: c.target_r4, stop: c.stop, score: c.score,
        strategy: variant, trigger: c.trigger ?? null,
      });
      setMsg({ err: false, text: `Paper bought ${c.symbol} — ${inr(size)} at live price, target R4 ${c.target_r4}, stop ${c.stop}.` });
      loadBook();
    } catch (e) { setMsg({ err: true, text: e?.response?.data?.detail ?? "Could not open paper trade." }); }
    finally { setBusy(null); }
  };
  const closeTrade = async (t) => {
    if (!window.confirm(`Close paper ${t.symbol} at the live price?`)) return;
    setBusy(t.id); setMsg(null);
    try {
      await axios.post(`${API_BASE}/paper/${t.id}/close`, {});
      setMsg({ err: false, text: `Closed ${t.symbol}.` }); loadBook();
    } catch (e) { setMsg({ err: true, text: e?.response?.data?.detail ?? "Could not close." }); }
    finally { setBusy(null); }
  };
  const delTrade = async (t) => {
    if (!window.confirm(`Delete paper ${t.symbol} from the book?`)) return;
    setBusy(t.id); setMsg(null);
    try { await axios.delete(`${API_BASE}/paper/${t.id}`); loadBook(); }
    catch (e) { setMsg({ err: true, text: e?.response?.data?.detail ?? "Could not delete." }); }
    finally { setBusy(null); }
  };

  const Chk = ({ ok, label, warn }) => <span className={`chk ${ok ? "on" : warn ? "warn" : ""}`}>{label}</span>;
  const open = (book?.trades ?? []).filter((t) => t.status === "open");
  const closed = (book?.trades ?? []).filter((t) => t.status === "closed");
  const bs = book?.summary;

  return (
    <div className="pf" data-pf-theme={theme}>
      <style>{PF2_CSS}</style>
      <div className="wrap">
        <header className="top">
          <div className="brand">
            <h1>Portfolio</h1>
            <nav className="nav"><Link to="/">Overview</Link><Link to="/v2/booked">Booking</Link><Link className={variant === "checklist" ? "on" : ""} to="/v2/mock">Mock trading</Link><Link className={isTurn ? "on" : ""} to="/v2/mock2">Mock trading 2</Link><Link to="/v2/sectors">Sectors</Link><Link to="/v2/common">Common picks</Link></nav>
          </div>
          <div className="controls">
            <button className="icon" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">◐</button>
            <Link className="icon" to="/profile" title="Research terminal">Research</Link>
          </div>
        </header>

        {msg && <div className={`msg ${msg.err ? "neg" : "pos"}`} style={{ padding: "10px 0" }}>{msg.text}</div>}

        {/* ---- paper book summary ---- */}
        <div className="grid kpis">
          <div className="panel kpi"><div className="lbl">OPEN POSITIONS</div><div className="v num">{bs ? bs.n_open : "…"}</div><div className="m">{bs ? `${signedINR(bs.unrealized_inr)} unrealized` : ""}</div></div>
          <div className="panel kpi"><div className="lbl">REALIZED (CLOSED)</div><div className={`v num ${bs && bs.realized_inr >= 0 ? "pos" : "neg"}`}>{bs ? signedINR(bs.realized_inr) : "…"}</div><div className="m">{bs ? `${bs.n_closed} closed` : ""}</div></div>
          <div className="panel kpi"><div className="lbl">WIN RATE</div><div className="v num">{bs && bs.win_rate != null ? `${bs.win_rate}%` : "—"}</div><div className="m">{bs ? `${bs.wins}W · ${bs.losses}L` : ""}</div></div>
          <div className="panel kpi"><div className="lbl">AVG R MULTIPLE</div><div className={`v num ${bs && bs.avg_r >= 0 ? "pos" : "neg"}`}>{bs && bs.avg_r != null ? `${bs.avg_r}R` : "—"}</div><div className="m">realized per unit risk</div></div>
        </div>

        {/* ---- strategy scanner ---- */}
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="tbl-h">
            <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>{V.scanTitle}</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label className="check" style={{ gap: 5 }}>min R:R
                <input value={minRr} onChange={(e) => setMinRr(e.target.value)} style={{ width: 52 }} inputMode="decimal" /></label>
              <label className="check" style={{ gap: 5 }}>size ₹
                <input value={size} onChange={(e) => setSize(e.target.value)} style={{ width: 90 }} inputMode="numeric" /></label>
              <button className="btn" onClick={loadScan}>Rescan</button>
            </div>
          </div>
          <div className="msg" style={{ paddingTop: 0 }}>
            {scan ? `As of ${scan.as_of} · ${hasSignalCol ? `${scan.n_scored} signals fired today` : `${scan.n_scored} stocks scored · top ${scan.candidates.length} setups`} · VCP chip = the weekly VCP screen (${scan.vcp_week ?? "n/a"}: ${scan.vcp_symbols?.length ?? 0} genuine breakouts) · ATR↓ = 10-day range contracting` : scanErr ? "" : "Scoring the universe…"}
          </div>
          {V.desc && <div className="msg" style={{ paddingTop: 0, fontWeight: 400, color: "var(--muted)" }}>{V.desc}</div>}
          {scanErr && <div className="empty">{scanErr}</div>}
          {scan && scan.candidates.length === 0 && <div className="empty">No signals fired today — this rule waits for a fresh trigger, so empty days are normal.</div>}
          {scan && (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr>
                  <th>Score</th><th className="l">Stock</th>{hasSignalCol && <th className="l">Trigger</th>}<th className="l">Checklist</th>
                  <th>Close</th><th>Stop</th><th>R4 target</th><th>Room→R4</th><th>R:R</th><th></th>
                </tr></thead>
                <tbody>
                  {scan.candidates.map((c) => {
                    const k = c.checklist;
                    return (
                      <tr key={c.symbol}>
                        <td><span className={`score ${scoreCls(c.score)}`}>{Math.round(c.score)}</span></td>
                        <td className="l"><div className="stk"><div className="s">{c.symbol}</div><div className="i">{c.sector || "—"}</div></div></td>
                        {isTurn && <td className="l"><span className="badge nse" title={`EMA20 ${c.ema20} · EMA50 ${c.ema50} · EMA200 ${c.ema200}`}>{TRIGGER_LABEL[c.trigger] ?? c.trigger ?? "—"}</span></td>}
                        <td className="l"><div className="chks">
                          <Chk ok={k.sma_stack === 4} warn={k.sma_stack >= 2 && k.sma_stack < 4} label={`SMA ${k.sma_stack}/4`} />
                          <Chk ok={k.trend} label="Trend" />
                          <Chk ok={k.rsi} label="RSI" />
                          <Chk ok={k.macd} label="MACD" />
                          <Chk ok={k.volume} label="Vol" />
                          <Chk ok={k.atr_contracting} label="ATR↓" />
                          <Chk ok={k.vcp} label="VCP" />
                          <Chk ok={k.breakout} label="Brk" />
                          <Chk ok={k.risk_reward} label="R:R" />
                        </div></td>
                        <td className="num">₹{c.close}</td>
                        <td className="num" style={{ color: "var(--neg)" }}>₹{c.stop}</td>
                        <td className="num">₹{c.target_r4}</td>
                        <td className="num pos">+{c.room_to_r4_pct}%</td>
                        <td className={`num ${c.rr >= minRr ? "pos" : ""}`}>{c.rr}</td>
                        <td><button className="btn primary" disabled={busy === c.symbol} onClick={() => paperBuy(c)}>{busy === c.symbol ? "…" : "Paper buy"}</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---- open positions ---- */}
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="tbl-h"><h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>Open paper positions</h3>
            <span className="eyebrow">{open.length} open</span></div>
          {open.length === 0 ? (
            <div className="empty">No open paper trades. Use “Paper buy” on a scanner setup to start testing.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="num">
                <thead><tr><th className="l">Stock</th><th>Entry</th><th>LTP</th><th>Qty</th><th>P&amp;L</th><th>To target</th><th>To stop</th><th>R:R</th><th></th></tr></thead>
                <tbody>
                  {open.map((t) => (
                    <tr key={t.id}>
                      <td className="l"><div className="stk"><div className="s">{t.symbol}{t.hit_target && <span className="badge nse">TARGET</span>}{t.hit_stop && <span className="badge us">STOP</span>}</div>{(t.score != null || t.trigger) ? <div className="i">{t.trigger ? (TRIGGER_LABEL[t.trigger] ?? t.trigger) : `setup ${t.score}`}</div> : null}</div></td>
                      <td>₹{t.entry_price}</td>
                      <td>₹{t.mark}</td>
                      <td>{t.qty}</td>
                      <td className={t.pnl_inr >= 0 ? "pos" : "neg"}>{signedINR(t.pnl_inr)}<div className={`i ${t.pnl_pct >= 0 ? "pos" : "neg"}`}>{t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct}%</div></td>
                      <td className={t.to_target_pct != null && t.to_target_pct <= 0 ? "pos" : ""}>{t.to_target_pct != null ? `+${t.to_target_pct}%` : "—"}</td>
                      <td className={t.to_stop_pct != null && t.to_stop_pct <= 0 ? "neg" : ""}>{t.to_stop_pct != null ? `${t.to_stop_pct}%` : "—"}</td>
                      <td>{t.rr_planned ?? "—"}</td>
                      <td><button className="btn" disabled={busy === t.id} onClick={() => closeTrade(t)}>Close</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---- closed trades ---- */}
        {closed.length > 0 && (
          <section className="panel">
            <div className="tbl-h"><h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>Closed paper trades</h3>
              <span className="eyebrow">{closed.length} closed</span></div>
            <div style={{ overflowX: "auto" }}>
              <table className="num">
                <thead><tr><th className="l">Stock</th><th>Entry</th><th>Exit</th><th>Qty</th><th>Realized</th><th>R</th><th className="l">Result</th><th></th></tr></thead>
                <tbody>
                  {closed.map((t) => (
                    <tr key={t.id}>
                      <td className="l"><div className="s">{t.symbol}</div></td>
                      <td>₹{t.entry_price}</td>
                      <td>₹{t.exit_price}</td>
                      <td>{t.qty}</td>
                      <td className={t.pnl_inr >= 0 ? "pos" : "neg"}>{signedINR(t.pnl_inr)}<div className={`i ${t.pnl_pct >= 0 ? "pos" : "neg"}`}>{t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct}%</div></td>
                      <td className={t.r_multiple >= 0 ? "pos" : "neg"}>{t.r_multiple != null ? `${t.r_multiple}R` : "—"}</td>
                      <td className="l"><span className={`badge ${t.outcome === "win" ? "nse" : "us"}`}>{t.outcome}</span></td>
                      <td><button className="del" title="Delete" disabled={busy === t.id} onClick={() => delTrade(t)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div className="foot">Paper trading is a virtual sandbox — no real orders. The scanner is a mechanical scorecard, not advice; backtest before trusting. Entry marks are live; realized figures assume you filled at the marked price.</div>
      </div>
    </div>
  );
}
