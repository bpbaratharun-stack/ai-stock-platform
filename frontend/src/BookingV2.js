/**
 * BookingV2 — Snowball-inspired reskin of the Profit Booking (realized P&L) view.
 * Shares the light-default design system (PF2_CSS / FONTS) with PortfolioV2.
 * Consumes /booked (GET/POST/DELETE) and /portfolio (for holding prefill).
 */
import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { FONTS, PF2_CSS } from "./PortfolioV2";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const EMPTY = { symbol: "", exchange: "NSE", qty: "", buy_price: "", sell_price: "", date: "", note: "", reduce_holding: true };

export default function BookingV2() {
  const [data, setData] = useState(null);
  const [held, setHeld] = useState({});
  const [fxRate, setFxRate] = useState(1);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [disp, setDisp] = useState("INR");
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l); return () => { try { document.head.removeChild(l); } catch {} };
  }, []);

  const load = useCallback(async () => {
    try { const { data: res } = await axios.get(`${API_BASE}/booked`); setData(res); } catch {}
  }, []);
  const loadHeld = useCallback(async () => {
    try {
      const { data: res } = await axios.get(`${API_BASE}/portfolio`);
      const m = {};
      (res.holdings ?? []).forEach((h) => { m[h.symbol.toUpperCase()] = { exchange: h.exchange, avg_price: h.avg_price }; });
      setHeld(m);
      if (res.fx?.rate) setFxRate(res.fx.rate);
    } catch {}
  }, []);
  useEffect(() => { load(); loadHeld(); }, [load, loadHeld]);

  const fx = fxRate; // /booked figures are INR; convert to USD with the live rate from /portfolio
  const base = (inr) => disp === "INR"
    ? "₹" + Math.round(inr).toLocaleString("en-IN")
    : "$" + Math.round(inr / fx).toLocaleString("en-US");
  const signed = (inr) => (inr >= 0 ? "+" : "−") + base(Math.abs(inr));

  const onSymbol = (v) => {
    const sym = v.toUpperCase();
    const h = held[sym.replace(/\.NS$/, "")];
    setForm((f) => ({ ...f, symbol: sym, ...(h ? { exchange: h.exchange, buy_price: String(h.avg_price) } : {}) }));
  };

  const submit = async (e) => {
    e?.preventDefault();
    const qty = parseFloat(form.qty), buy = parseFloat(form.buy_price), sell = parseFloat(form.sell_price);
    if (!form.symbol.trim() || !(qty > 0) || !(buy > 0) || !(sell > 0)) {
      setMsg({ err: true, text: "Enter a symbol, quantity, and positive buy and sell prices." }); return;
    }
    setSaving(true); setMsg(null);
    try {
      const body = { symbol: form.symbol.trim(), exchange: form.exchange, qty, buy_price: buy, sell_price: sell, note: form.note, reduce_holding: form.reduce_holding };
      if (form.date) body.date = form.date;
      const { data: res } = await axios.post(`${API_BASE}/booked`, body);
      const rs = res.reduced?.status;
      const redMsg = rs === "reduced" ? ` · holding reduced to ${res.reduced.remaining_qty}` : rs === "closed" ? " · holding fully closed" : rs === "not_held" ? " · (no matching holding found)" : "";
      setForm((f) => ({ ...EMPTY, exchange: f.exchange, reduce_holding: f.reduce_holding }));
      setMsg({ err: false, text: `Booked ${res.trade.symbol}: ${signed(res.trade.realized_inr)} realized (${res.trade.realized_pct >= 0 ? "+" : ""}${res.trade.realized_pct}%)${redMsg}.` });
      await load(); await loadHeld();
    } catch (err) { setMsg({ err: true, text: err?.response?.data?.detail ?? "Could not book the trade." }); }
    finally { setSaving(false); }
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete booked ${t.symbol} (${t.date})? This only edits the ledger — it won't restore the holding.`)) return;
    try { await axios.delete(`${API_BASE}/booked/${t.id}`); await load(); }
    catch (err) { setMsg({ err: true, text: err?.response?.data?.detail ?? "Could not delete." }); }
  };

  const shell = (body) => (
    <div className="pf" data-pf-theme={theme}>
      <style>{PF2_CSS}</style>
      <div className="wrap">
        <header className="top">
          <div className="brand">
            <h1>Portfolio</h1>
            <nav className="nav"><Link to="/">Overview</Link><Link className="on" to="/v2/booked">Booking</Link></nav>
          </div>
          <div className="controls">
            <div className="seg">
              {["INR", "USD"].map((x) => <button key={x} className={disp === x ? "on" : ""} onClick={() => setDisp(x)}>{x === "INR" ? "₹ INR" : "$ USD"}</button>)}
            </div>
            <button className="icon" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">◐</button>
            <Link className="icon" to="/profile" title="Research terminal">Research</Link>
          </div>
        </header>
        {body}
        <div className="foot">Realized P&amp;L ledger · figures locked at the USDINR captured when each trade was booked.<br />Not investment advice — a personal record of past trades.</div>
      </div>
    </div>
  );

  if (!data) return shell(<div className="loading">Loading your booked trades…</div>);

  const s = data.summary;
  const trades = data.trades ?? [];

  const kpis = [
    { lbl: "Total realized", v: signed(s.realized_inr), cls: s.realized_inr >= 0 ? "pos" : "neg", m: `on ${base(s.cost_inr)} deployed` },
    { lbl: "Trades booked", v: String(s.n), m: `${s.wins} up · ${s.losses} down` },
    { lbl: "Win rate", v: s.win_rate == null ? "—" : `${s.win_rate}%`, m: "profitable exits" },
    { lbl: "Best book", v: s.best ? signed(s.best.realized_inr) : "—", m: s.best ? s.best.symbol : "no trades yet" },
  ];

  return shell(<>
    <div className="grid kpis">
      {kpis.map((k, i) => (
        <div key={i} className="panel kpi">
          <div className="lbl">{k.lbl}</div>
          <div className={`v num ${k.cls || ""}`}>{k.v}</div>
          <div className="m">{k.m}</div>
        </div>
      ))}
    </div>

    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="cardh"><h3>Book a sale</h3></div>
      <form className="form" onSubmit={submit}>
        <div className="field"><label>Symbol</label>
          <input value={form.symbol} onChange={(e) => onSymbol(e.target.value)} placeholder="e.g. TMCV" style={{ width: 120 }} list="held-syms" />
          <datalist id="held-syms">{Object.keys(held).map((h) => <option key={h} value={h} />)}</datalist>
        </div>
        <div className="field"><label>Exchange</label>
          <select value={form.exchange} onChange={(e) => setForm((f) => ({ ...f, exchange: e.target.value }))}>
            <option value="NSE">NSE</option><option value="US">US</option>
          </select>
        </div>
        <div className="field"><label>Qty</label>
          <input value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} placeholder="0" style={{ width: 80 }} inputMode="decimal" />
        </div>
        <div className="field"><label>Buy price</label>
          <input value={form.buy_price} onChange={(e) => setForm((f) => ({ ...f, buy_price: e.target.value }))} placeholder="0" style={{ width: 100 }} inputMode="decimal" />
        </div>
        <div className="field"><label>Sell price</label>
          <input value={form.sell_price} onChange={(e) => setForm((f) => ({ ...f, sell_price: e.target.value }))} placeholder="0" style={{ width: 100 }} inputMode="decimal" />
        </div>
        <div className="field"><label>Date</label>
          <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} style={{ width: 140 }} />
        </div>
        <div className="field"><label>Note</label>
          <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="optional" style={{ width: 150 }} />
        </div>
        <label className="check">
          <input type="checkbox" checked={form.reduce_holding} onChange={(e) => setForm((f) => ({ ...f, reduce_holding: e.target.checked }))} />
          Reduce holding
        </label>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? "Booking…" : "Book sale"}</button>
      </form>
      {msg && <div className={`msg ${msg.err ? "neg" : "pos"}`}>{msg.text}</div>}
    </div>

    <div className="panel">
      <div className="tbl-h"><h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>Realized ledger</h3>
        <span className="eyebrow">{trades.length} trade{trades.length === 1 ? "" : "s"}</span></div>
      {trades.length === 0 ? (
        <div className="empty">No booked trades yet. Record a sale above to start tracking realized P&amp;L.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr>
              <th className="l">Stock</th><th>Qty</th><th>Buy</th><th>Sell</th>
              <th>Realized</th><th>Return</th><th className="l">Date</th><th></th>
            </tr></thead>
            <tbody>
              {trades.map((t) => {
                const sym = t.currency === "USD" ? "$" : "₹";
                return (
                  <tr key={t.id}>
                    <td className="l"><div className="stk">
                      <span className="s">{t.symbol}<span className={`badge ${t.exchange === "US" ? "us" : "nse"}`}>{t.exchange}</span></span>
                      {t.note ? <span className="i">{t.note}</span> : null}
                    </div></td>
                    <td className="num">{t.qty}</td>
                    <td className="num">{sym}{t.buy_price}</td>
                    <td className="num">{sym}{t.sell_price}</td>
                    <td className={`num ${t.realized_inr >= 0 ? "pos" : "neg"}`}>{signed(t.realized_inr)}</td>
                    <td className={`num ${t.realized_pct >= 0 ? "pos" : "neg"}`}>{t.realized_pct >= 0 ? "+" : ""}{t.realized_pct}%</td>
                    <td className="l" style={{ color: "var(--muted)" }}>{t.date}</td>
                    <td><button className="del" onClick={() => remove(t)} title="Delete from ledger">✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </>);
}
