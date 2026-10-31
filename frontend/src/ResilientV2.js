/**
 * ResilientV2 — which stocks are holding up while the market falls. The question
 * a breakout screen cannot answer in a selloff (VCP goes to zero signals). The
 * benchmark is the median liquid stock, not a cap-weighted index.
 * Descriptive and NOT yet backtested for forward returns.
 */
import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { FONTS, PF2_CSS } from "./PortfolioV2";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const pct = (v, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);

export default function ResilientV2() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [weeks, setWeeks] = useState(4);
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l); return () => { try { document.head.removeChild(l); } catch {} };
  }, []);

  const load = useCallback(() => {
    setData(null); setErr(null);
    axios.get(`${API_BASE}/resilient?weeks=${weeks}&top=40`)
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.detail ?? "Could not load the screen."));
  }, [weeks]);
  useEffect(() => { load(); }, [load]);

  const body = () => {
    if (err) return <div className="empty">{err}</div>;
    if (!data) return <div className="loading">Measuring the market…</div>;
    const falling = data.market_ret_pct < 0;
    return (<>
      <div className="grid kpis">
        <div className="panel kpi"><div className="lbl">THE TYPICAL STOCK</div>
          <div className={`v num ${falling ? "neg" : "pos"}`}>{pct(data.market_ret_pct, 2)}</div>
          <div className="m">median of {data.n_universe.toLocaleString("en-IN")} liquid stocks</div></div>
        <div className="panel kpi"><div className="lbl">WINDOW</div>
          <div className="v num">{data.n_sessions}d</div>
          <div className="m">{data.start} → {data.end}</div></div>
        <div className="panel kpi"><div className="lbl">DOWN DAYS</div>
          <div className="v num">{data.n_down_days}</div>
          <div className="m">of {data.n_sessions} sessions</div></div>
        <div className="panel kpi"><div className="lbl">ROSE AS MARKET FELL</div>
          <div className="v num pos">{data.rows.filter((r) => r.down_capture < 0).length}</div>
          <div className="m">negative down-capture, top {data.rows.length}</div></div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="tbl-h">
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>Holding up best</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="seg">
              {[2, 4, 12].map((n) => (
                <button key={n} className={weeks === n ? "on" : ""} onClick={() => setWeeks(n)}>{n}w</button>
              ))}
            </div>
            <button className="btn" onClick={load}>Refresh</button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="num">
            <thead><tr>
              <th className="l">Stock</th><th>Close</th><th>Return</th><th>vs market</th>
              <th>Down capture</th><th>Beat on down days</th><th>Max drop</th>
              <th>From 52w high</th><th>₹ cr/day</th>
            </tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.symbol}>
                  <td className="l"><div className="s">{r.symbol}</div></td>
                  <td>₹{r.close}</td>
                  <td className={r.ret_pct >= 0 ? "pos" : "neg"}>{pct(r.ret_pct, 2)}</td>
                  <td className="pos" style={{ fontWeight: 600 }}>{pct(r.rel_pct, 2)}</td>
                  <td title="its average move on days the market fell, divided by the market's — below 1 is resilient, below 0 means it rose">
                    {r.down_capture == null ? "—"
                      : <span className={`chk ${r.down_capture < 0 ? "on" : r.down_capture < 1 ? "" : "warn"}`}>
                          {r.down_capture.toFixed(2)}</span>}
                  </td>
                  <td>{r.beat_down_pct == null ? "—" : `${r.beat_down_pct}%`}</td>
                  <td className="neg">{r.max_dd_pct == null ? "—" : `${r.max_dd_pct}%`}</td>
                  <td style={{ color: "var(--muted)" }}>{r.from_52w_high == null ? "—" : `${r.from_52w_high}%`}</td>
                  <td style={{ color: "var(--muted)" }}>{r.adtv_cr}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
              <Link to="/v2/sectors">Sectors</Link><Link to="/v2/common">Common picks</Link>
              <Link to="/v2/results">Results</Link>
              <Link className="on" to="/v2/holding-up">Holding up</Link>
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
          A companion to the VCP screen, which correctly goes empty in a selloff — nothing is breaking out to new highs.
          This one has <b>not been backtested</b> for forward returns; every screen here that has been came out flat-to-negative against its own universe. A map of what is holding up, not a buy list.
        </div>
      </div>
    </div>
  );
}
