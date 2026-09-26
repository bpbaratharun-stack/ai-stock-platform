/**
 * SectorsV2 — which sectors have the wind behind them and which are fighting it,
 * measured as the NSE sector index versus the Nifty 50 (a sector falling less than
 * a falling market still has a relative tailwind), plus the news behind the move
 * and how much of your own book sits in each. Shares the v2 design system.
 * Descriptive — not advice.
 */
import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { FONTS, PF2_CSS } from "./PortfolioV2";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const inr = (v) => "₹" + Math.round(v).toLocaleString("en-IN");
const pct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

function ago(iso) {
  if (!iso) return "";
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return "just now";
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

export default function SectorsV2() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);            // sector name whose news is open
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l); return () => { try { document.head.removeChild(l); } catch {} };
  }, []);

  const load = useCallback(() => {
    setData(null); setErr(null);
    axios.get(`${API_BASE}/sectors`).then((r) => {
      setData(r.data);
      const first = [...(r.data.sectors ?? [])].sort((a, b) => b.your_weight_pct - a.your_weight_pct)[0];
      setSel((s) => s ?? first?.sector ?? null);   // open the sector you own most of
    }).catch((e) => setErr(e?.response?.data?.detail ?? "Could not load sectors."));
  }, []);
  useEffect(() => { load(); }, [load]);

  const secs = data?.sectors ?? [];
  const tail = secs.filter((s) => s.wind === "tailwind");
  const head = secs.filter((s) => s.wind === "headwind");
  const neutral = secs.filter((s) => s.wind === "neutral");
  const chosen = secs.find((s) => s.sector === sel);

  const Row = ({ s }) => {
    const on = s.sector === sel;
    const up = s.rel_1m >= 0;
    return (
      <button className={`secw${on ? " on" : ""}`} onClick={() => setSel(s.sector)}
              title={`${s.sector} (${s.ticker}) vs Nifty 50 — 1w ${pct(s.rel_1w)}, 1m ${pct(s.rel_1m)}, 3m ${pct(s.rel_3m)}`}>
        <span className="nm">{s.sector}</span>
        <span className={`rel num ${up ? "pos" : "neg"}`}>{pct(s.rel_1m)}</span>
        <span className="abs num">{pct(s.ret_1m)}</span>
        <span className="own num">{s.your_weight_pct > 0
          ? <span className="chk on" title={`${inr(s.your_value_inr)} of your book`}>you {s.your_weight_pct}%</span>
          : <span className="chk">—</span>}</span>
      </button>
    );
  };

  const body = () => {
    if (err) return <div className="empty">{err}</div>;
    if (!data) return <div className="loading">Reading the sector indices…</div>;
    const b = data.benchmark;
    return (<>
      <section className="panel" style={{ padding: "16px 20px", marginBottom: 16 }}>
        <div className="eyebrow">Measured against</div>
        <div style={{ display: "flex", gap: 22, alignItems: "baseline", flexWrap: "wrap", marginTop: 6 }}>
          <div style={{ fontFamily: "var(--ser)", fontSize: 22 }}>{b.name}</div>
          {[["1 week", b.ret_1w], ["1 month", b.ret_1m], ["3 months", b.ret_3m]].map(([k, v]) => (
            <div key={k} style={{ fontSize: 13, color: "var(--muted)" }}>
              {k} <b className={`num ${v >= 0 ? "pos" : "neg"}`}>{pct(v)}</b>
            </div>
          ))}
          <div style={{ marginLeft: "auto" }}><button className="btn" onClick={load}>Refresh</button></div>
        </div>
      </section>

      <section className="grid two">
        <div className="panel">
          <div className="cardh"><h3>🌤 Tailwinds</h3><span className="eyebrow">beating the Nifty</span></div>
          <div className="cardb">
            {tail.length ? tail.map((s) => <Row key={s.sector} s={s} />)
              : <div className="risknote">No sector is beating the Nifty by more than 3% this month.</div>}
          </div>
        </div>
        <div className="panel">
          <div className="cardh"><h3>🌧 Headwinds</h3><span className="eyebrow">lagging the Nifty</span></div>
          <div className="cardb">
            {head.length ? head.map((s) => <Row key={s.sector} s={s} />)
              : <div className="risknote">No sector is lagging the Nifty by more than 3% this month.</div>}
          </div>
        </div>
      </section>

      {neutral.length > 0 && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="cardh"><h3>Neither</h3><span className="eyebrow">within ±3% of the Nifty</span></div>
          <div className="cardb">{neutral.map((s) => <Row key={s.sector} s={s} />)}</div>
        </section>
      )}

      {chosen && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="tbl-h">
            <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>{chosen.sector} — what's in the news</h3>
            <span className="eyebrow">
              {pct(chosen.rel_1m)} vs Nifty · 1m {pct(chosen.ret_1m)} · 3m {pct(chosen.ret_3m)}
              {chosen.your_weight_pct > 0 ? ` · ${chosen.your_weight_pct}% of your book` : ""}
            </span>
          </div>
          <div className="cardb">
            {chosen.news?.length ? chosen.news.map((n, i) => (
              <a className="news" key={i} href={n.url} target="_blank" rel="noopener noreferrer">
                <div className="h">{n.title}</div>
                {n.summary ? <div className="s">{n.summary}</div> : null}
                <div className="m">{n.publisher}{n.published ? ` · ${ago(n.published)}` : ""}
                  {n.source_ticker ? ` · via ${n.source_ticker}` : ""}</div>
              </a>
            )) : <div className="risknote">No recent stories found for this sector.</div>}
          </div>
        </section>
      )}
    </>);
  };

  return (
    <div className="pf" data-pf-theme={theme}>
      <style>{PF2_CSS}</style>
      <style>{`
        .pf .secw{display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;width:100%;
          text-align:left;background:transparent;border:0;border-bottom:1px solid var(--line2);
          padding:10px 8px;cursor:pointer;font:inherit;border-radius:8px}
        .pf .secw:last-child{border-bottom:0}
        .pf .secw:hover{background:var(--panel2)}
        .pf .secw.on{background:var(--brandbg)}
        .pf .secw .nm{font-weight:600;font-size:13px}
        .pf .secw .rel{font-weight:700;font-size:14px;min-width:62px;text-align:right}
        .pf .secw .abs{color:var(--muted);font-size:12px;min-width:58px;text-align:right}
        .pf .secw .own{min-width:74px;text-align:right}
        .pf a.news{display:block;text-decoration:none;color:inherit;padding:11px 8px;border-bottom:1px solid var(--line2)}
        .pf a.news:last-child{border-bottom:0}
        .pf a.news:hover{background:var(--panel2)}
        .pf a.news .h{font-weight:600;font-size:13.5px;line-height:1.4}
        .pf a.news .s{color:var(--muted);font-size:12.5px;margin-top:4px;line-height:1.5}
        .pf a.news .m{color:var(--faint);font-size:11.5px;margin-top:5px}
      `}</style>
      <div className="wrap">
        <header className="top">
          <div className="brand">
            <h1>Portfolio</h1>
            <nav className="nav">
              <Link to="/">Overview</Link><Link to="/v2/booked">Booking</Link>
              <Link to="/v2/mock">Mock trading</Link><Link to="/v2/mock2">Mock trading 2</Link>
              <Link className="on" to="/v2/sectors">Sectors</Link><Link to="/v2/common">Common picks</Link>
            </nav>
          </div>
          <div className="controls">
            <button className="icon" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">◐</button>
            <Link className="icon" to="/profile" title="Research terminal">Research</Link>
          </div>
        </header>
        {body()}
        <div className="foot">
          {data?.note}<br />Sector news is pooled from each sector's bellwether stocks (Yahoo carries none for an index itself) — headlines are context, not a recommendation.
        </div>
      </div>
    </div>
  );
}
