/**
 * ResultsV2 — upcoming quarterly-results dates for the stocks you hold, with the
 * position at stake and how that stock has historically moved on results day.
 * Shares the v2 design system. Dates are company intimations to NSE and can move;
 * the historical move is a gauge of what is at stake, not a prediction.
 */
import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { FONTS, PF2_CSS } from "./PortfolioV2";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const inr = (v) => "₹" + Math.round(v).toLocaleString("en-IN");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dlabel = (iso) => { const [y, m, d] = iso.split("-"); return `${+d} ${MON[+m - 1]}`; };
const away = (n) => (n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n}d`);

export default function ResultsV2() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [days, setDays] = useState(60);
  const [showAwaiting, setShowAwaiting] = useState(false);
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l); return () => { try { document.head.removeChild(l); } catch {} };
  }, []);

  const load = useCallback(() => {
    setData(null); setErr(null);
    axios.get(`${API_BASE}/upcoming-results?days=${days}`)
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.detail ?? "Could not load the results calendar."));
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const rows = data?.rows ?? [];
  const s = data?.summary;

  const body = () => {
    if (err) return <div className="empty">{err}</div>;
    if (!data) return <div className="loading">Checking NSE for scheduled board meetings…</div>;
    return (<>
      <div className="grid kpis">
        <div className="panel kpi"><div className="lbl">REPORTING THIS WEEK</div>
          <div className={`v num ${s.n_next_7d ? "neg" : ""}`}>{s.n_next_7d}</div>
          <div className="m">{inr(s.value_next_7d_inr)} at stake</div></div>
        <div className="panel kpi"><div className="lbl">SCHEDULED</div>
          <div className="v num">{s.n_scheduled}</div>
          <div className="m">within {data.window_days} days</div></div>
        <div className="panel kpi"><div className="lbl">SHARE OF BOOK</div>
          <div className="v num">{s.pct_of_book_reporting}%</div>
          <div className="m">{inr(s.value_reporting_inr)} reporting</div></div>
        <div className="panel kpi"><div className="lbl">NO DATE YET</div>
          <div className="v num">{s.n_awaiting}</div>
          <div className="m">of {s.n_holdings} NSE holdings</div></div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="tbl-h">
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>Upcoming results</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="seg">
              {[30, 60, 90].map((n) => (
                <button key={n} className={days === n ? "on" : ""} onClick={() => setDays(n)}>{n}d</button>
              ))}
            </div>
            <button className="btn" onClick={load}>Refresh</button>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No results dates announced for your holdings in the next {data.window_days} days.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="num">
              <thead><tr>
                <th className="l">Date</th><th className="l">Stock</th>
                <th>Your position</th><th>Weight</th><th>P&amp;L</th>
                <th>Typical move</th><th>Up rate</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const soon = r.days_away <= 7;
                  return (
                    <tr key={r.symbol} style={soon ? { background: "var(--negbg)" } : undefined}>
                      <td className="l"><div className="stk">
                        <div className="s">{dlabel(r.results_date)}</div>
                        <div className="i">{away(r.days_away)}</div>
                      </div></td>
                      <td className="l"><div className="stk">
                        <div className="s">{r.symbol}</div>
                        <div className="i">{r.company || r.industry || "—"}</div>
                      </div></td>
                      <td>{inr(r.value_inr)}<div className="i">{r.qty} sh</div></td>
                      <td>{r.weight_pct}%</td>
                      <td className={r.pnl_pct >= 0 ? "pos" : "neg"}>
                        {r.pnl_pct == null ? "—" : `${r.pnl_pct >= 0 ? "+" : ""}${r.pnl_pct}%`}</td>
                      <td title={r.hist_n ? `median absolute move across ${r.hist_n} past results` : "no past results in the cache for this stock"}>
                        {r.hist_median_abs_pct != null ? `±${r.hist_median_abs_pct}%` : "—"}</td>
                      <td className={r.hist_up_rate_pct != null && r.hist_up_rate_pct >= 50 ? "pos" : ""}
                          title="share of past results where the stock rose">
                        {r.hist_up_rate_pct != null ? `${r.hist_up_rate_pct}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(data.awaiting ?? []).length > 0 && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="tbl-h">
            <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>No date announced yet</h3>
            <button className="btn" onClick={() => setShowAwaiting((v) => !v)}>
              {showAwaiting ? "Hide" : `Show ${data.awaiting.length}`}
            </button>
          </div>
          {showAwaiting && (
            <div style={{ overflowX: "auto" }}>
              <table className="num">
                <thead><tr><th className="l">Stock</th><th>Your position</th><th>Weight</th>
                  <th className="l">Last reported</th><th>Typical move</th></tr></thead>
                <tbody>
                  {data.awaiting.map((r) => (
                    <tr key={r.symbol}>
                      <td className="l"><div className="s">{r.symbol}</div></td>
                      <td>{inr(r.value_inr)}</td>
                      <td>{r.weight_pct}%</td>
                      <td className="l" style={{ color: "var(--muted)" }}>{r.last_results_date || "—"}</td>
                      <td>{r.hist_median_abs_pct != null ? `±${r.hist_median_abs_pct}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>);
  };

  return (
    <div className="pf" data-pf-theme={theme}>
      <style>{PF2_CSS}</style>
      <div className="wrap">
        <header className="top">
          <div className="brand">
            <h1>Portfolio</h1>
            <nav className="nav">
              <Link to="/">Overview</Link><Link to="/v2/booked">Booking</Link>
              <Link to="/v2/mock">Mock trading</Link><Link to="/v2/mock2">Mock trading 2</Link>
              <Link to="/v2/sectors">Sectors</Link><Link to="/v2/common">Common picks</Link>
              <Link className="on" to="/v2/results">Results</Link>
            </nav>
          </div>
          <div className="controls">
            <button className="icon" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">◐</button>
            <Link className="icon" to="/profile" title="Research terminal">Research</Link>
          </div>
        </header>
        {body()}
        <div className="foot">
          {data?.note}<br />
          NSE-listed holdings only — US stocks and mutual funds file no NSE board-meeting intimation.
          Across the whole universe the results-day move is up only ~44% of the time, so a date here is a risk to plan around, not an opportunity.
        </div>
      </div>
    </div>
  );
}
