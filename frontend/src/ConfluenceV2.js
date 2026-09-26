/**
 * ConfluenceV2 — where the screens agree: stocks surfaced by at least two of
 * Mock trading (checklist), Mock trading 2 (EMA turnaround) and Weekly breakouts.
 * Shares the v2 design system. Overlap is a shortlist, NOT a proven edge — each
 * of these screens backtested flat-to-negative against its own universe.
 */
import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { FONTS, PF2_CSS } from "./PortfolioV2";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const SHORT = { mock1: "Mock 1", mock2: "Mock 2", weekly: "Weekly" };
const pct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`);
const num = (v) => (v == null ? "—" : v);

export default function ConfluenceV2() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [minScreens, setMinScreens] = useState(2);
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l); return () => { try { document.head.removeChild(l); } catch {} };
  }, []);

  const load = useCallback(() => {
    setData(null); setErr(null);
    axios.get(`${API_BASE}/confluence?min_screens=${minScreens}`)
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.detail ?? "Could not load the overlap."));
  }, [minScreens]);
  useEffect(() => { load(); }, [load]);

  const rows = data?.rows ?? [];
  const s = data?.summary;

  const body = () => {
    if (err) return <div className="empty">{err}</div>;
    if (!data) return <div className="loading">Comparing the screens…</div>;
    return (<>
      <div className="grid kpis">
        <div className="panel kpi"><div className="lbl">IN 2 OR MORE SCREENS</div>
          <div className="v num">{s.n_rows}</div><div className="m">of the three screens</div></div>
        <div className="panel kpi"><div className="lbl">IN ALL THREE</div>
          <div className={`v num ${s.n_all_three ? "pos" : ""}`}>{s.n_all_three}</div>
          <div className="m">full agreement</div></div>
        <div className="panel kpi"><div className="lbl">IN EXACTLY TWO</div>
          <div className="v num">{s.n_exactly_two}</div><div className="m">partial agreement</div></div>
        <div className="panel kpi"><div className="lbl">ALREADY HELD</div>
          <div className="v num">{s.n_in_portfolio}</div><div className="m">in your portfolio</div></div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="tbl-h">
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>Where the screens agree</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="seg">
              {[2, 3].map((n) => (
                <button key={n} className={minScreens === n ? "on" : ""} onClick={() => setMinScreens(n)}>
                  {n === 2 ? "2+ screens" : "all 3"}
                </button>
              ))}
            </div>
            <button className="btn" onClick={load}>Refresh</button>
          </div>
        </div>
        <div className="msg" style={{ paddingTop: 0, fontWeight: 400, color: "var(--muted)" }}>
          {Object.entries(data.sources).map(([k, v]) => `${SHORT[k]}: ${v.n} (${v.note})`).join(" · ")}
          {` · scanned ${data.as_of}`}
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            {minScreens === 3
              ? "No stock is in all three screens right now. Try “2+ screens”."
              : "No overlap between the screens today. They look for different things, so empty stretches are normal."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="num">
              <thead><tr>
                <th className="l">Stock</th><th className="l">In screens</th>
                <th>Close</th><th>Setup</th><th>Breakout</th><th>Week</th>
                <th>R:R</th><th>Room→R4</th><th>Stop</th><th className="l">State</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol}>
                    <td className="l"><div className="stk">
                      <div className="s">{r.symbol}
                        {r.in_portfolio && <span className="badge nse" title="already in your portfolio">HELD</span>}
                        {r.n_screens === 3 && <span className="badge fund">ALL 3</span>}
                      </div>
                      <div className="i">{r.sector || "—"}</div>
                    </div></td>
                    <td className="l"><div className="chks">
                      {["mock1", "mock2", "weekly"].map((k) => (
                        <span key={k} className={`chk ${r.screens.includes(k) ? "on" : ""}`}
                              title={data.labels[k]}>{SHORT[k]}</span>
                      ))}
                    </div></td>
                    <td>{r.close != null ? `₹${r.close}` : "—"}</td>
                    <td>{num(r.setup_score)}</td>
                    <td>{num(r.breakout_score)}</td>
                    <td className={r.week_return_pct >= 0 ? "pos" : "neg"}>{pct(r.week_return_pct)}</td>
                    <td>{num(r.rr)}</td>
                    <td className="pos">{r.room_to_r4_pct != null ? `+${r.room_to_r4_pct}%` : "—"}</td>
                    <td style={{ color: "var(--neg)" }}>{r.stop != null ? `₹${r.stop}` : "—"}</td>
                    <td className="l" style={{ color: "var(--muted)" }}>
                      {r.trigger ? <span className="badge nse">{r.trigger}</span> : (r.state || "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
              <Link to="/v2/sectors">Sectors</Link>
              <Link className="on" to="/v2/common">Common picks</Link>
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
          Mock 1 = the checklist scanner's top setups · Mock 2 = EMA-turnaround signals · Weekly = the momentum breakout screen{data?.week_ending ? ` (week ending ${data.week_ending})` : ""}.
        </div>
      </div>
    </div>
  );
}
