/**
 * PortfolioV2 — Snowball-inspired clean reskin of the portfolio view.
 * Light-default (dark toggle), deep-teal accent, serif hero numbers (Fraunces).
 * Consumes the existing endpoints; the classic dark dashboard is untouched.
 */
import React, { useState, useEffect } from "react";
import axios from "axios";
import { Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
export const FONTS = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap";

const SECTOR_COLORS = ["#0E7C71", "#3B6FE0", "#C77A12", "#5E63C9", "#8A94A3",
  "#0E9AA7", "#B2506E", "#2FA36B", "#9A7BD1", "#D98C3A", "#4C9F70", "#7C8794"];

// ---- tiny chart maths ------------------------------------------------------
function arc(cx, cy, r, rin, a1, a2) {
  const lg = a2 - a1 > Math.PI ? 1 : 0;
  const p = [cx + r * Math.cos(a1), cy + r * Math.sin(a1), cx + r * Math.cos(a2), cy + r * Math.sin(a2),
             cx + rin * Math.cos(a2), cy + rin * Math.sin(a2), cx + rin * Math.cos(a1), cy + rin * Math.sin(a1)];
  return `M${p[0]} ${p[1]}A${r} ${r} 0 ${lg} 1 ${p[2]} ${p[3]}L${p[4]} ${p[5]}A${rin} ${rin} 0 ${lg} 0 ${p[6]} ${p[7]}Z`;
}
function worst(row, side) {
  if (!row.length) return Infinity;
  const s = row.reduce((a, b) => a + b.area, 0);
  const mx = Math.max(...row.map((r) => r.area)), mn = Math.min(...row.map((r) => r.area));
  return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
}
function squarify(items, W, H) {
  const data = items.filter((i) => i.value > 0).map((i) => ({ ...i }));
  const total = data.reduce((s, n) => s + n.value, 0) || 1;
  const scale = (W * H) / total;
  data.forEach((n) => { n.area = n.value * scale; });
  const out = [];
  let rect = { x: 0, y: 0, w: W, h: H }, i = 0;
  while (i < data.length) {
    let row = [data[i]]; i++;
    let side = Math.min(rect.w, rect.h);
    while (i < data.length && worst(row, side) >= worst([...row, data[i]], side)) { row.push(data[i]); i++; }
    const rowArea = row.reduce((s, n) => s + n.area, 0);
    if (rect.w >= rect.h) {
      const thick = rowArea / rect.h; let off = 0;
      row.forEach((n) => { const len = n.area / thick; out.push({ ...n, x: rect.x, y: rect.y + off, w: thick, h: len }); off += len; });
      rect = { x: rect.x + thick, y: rect.y, w: rect.w - thick, h: rect.h };
    } else {
      const thick = rowArea / rect.w; let off = 0;
      row.forEach((n) => { const len = n.area / thick; out.push({ ...n, x: rect.x + off, y: rect.y, w: len, h: thick }); off += len; });
      rect = { x: rect.x, y: rect.y + thick, w: rect.w, h: rect.h - thick };
    }
  }
  return out;
}
function linePts(vals, W, H, pad) {
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = (mx - mn) || 1;
  const X = (idx) => pad.l + (idx / (vals.length - 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - mn) / rng) * (H - pad.t - pad.b);
  const pts = vals.map((v, idx) => `${X(idx).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  return { pts, X, Y, zero: mn < 0 && mx > 0 ? Y(0) : null, base: Y(mn < 0 ? 0 : mn) };
}

export const PF2_CSS = `
.pf{--bg:#F4F6F8;--panel:#FFFFFF;--panel2:#FAFBFC;--line:#E6E9EF;--line2:#EEF1F5;
  --ink:#14202E;--muted:#65717F;--faint:#98A2AF;--brand:#0E7C71;--brandbg:#E4F2EF;
  --pos:#0FA05A;--posbg:#E7F6EE;--neg:#E14742;--negbg:#FCEBEA;--warn:#B9770B;--warnbg:#FBF1DE;
  --sh:0 1px 2px rgba(20,32,46,.04),0 6px 20px rgba(20,32,46,.05);
  --ser:"Fraunces",Georgia,serif;--sans:"Inter",system-ui,sans-serif;
  background:var(--bg);color:var(--ink);font-family:var(--sans);min-height:100vh;font-size:14px;line-height:1.5}
.pf[data-pf-theme="dark"]{--bg:#0C0F14;--panel:#151A21;--panel2:#1A2029;--line:#242C37;--line2:#1E2530;
  --ink:#E9EEF4;--muted:#9AA6B4;--faint:#697585;--brand:#2FBFAE;--brandbg:rgba(47,191,174,.14);
  --pos:#31C777;--posbg:rgba(49,199,119,.13);--neg:#F0736E;--negbg:rgba(240,115,110,.13);--warn:#E3A44A;--warnbg:rgba(227,164,74,.13);
  --sh:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.28)}
.pf *{box-sizing:border-box}
.pf .wrap{max-width:1120px;margin:0 auto;padding:26px 24px 64px}
.pf .num{font-variant-numeric:tabular-nums}
.pf .pos{color:var(--pos)}.pf .neg{color:var(--neg)}
.pf .eyebrow{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);font-weight:600}
.pf .top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.pf .brand{display:flex;align-items:baseline;gap:12px}
.pf .brand h1{font-family:var(--ser);font-weight:500;font-size:26px;margin:0;letter-spacing:-.01em}
.pf .brand .as{color:var(--muted);font-size:12.5px}
.pf .controls{display:flex;align-items:center;gap:8px}
.pf .seg{display:inline-flex;background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:3px}
.pf .seg button{border:0;background:transparent;color:var(--muted);font:inherit;font-weight:600;font-size:12px;padding:5px 13px;border-radius:999px;cursor:pointer}
.pf .seg button.on{background:var(--panel);color:var(--ink);box-shadow:0 1px 2px rgba(20,32,46,.08)}
.pf .icon{height:34px;min-width:34px;padding:0 10px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--muted);cursor:pointer;display:inline-grid;place-items:center;font-size:13px;font-weight:600;text-decoration:none}
.pf .icon:hover{color:var(--ink)}
.pf .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh)}
.pf .grid{display:grid;gap:16px}
.pf .hero{display:grid;grid-template-columns:1.05fr 1fr;gap:8px;padding:22px 24px;margin-bottom:16px}
.pf .hero .lbl{color:var(--muted);font-size:12.5px;margin-bottom:6px}
.pf .hero .big{font-family:var(--ser);font-weight:500;font-size:46px;line-height:1;letter-spacing:-.02em}
.pf .hero .ret{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap}
.pf .pill{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px;padding:4px 10px;border-radius:999px}
.pf .pill.up{background:var(--posbg);color:var(--pos)}.pf .pill.down{background:var(--negbg);color:var(--neg)}
.pf .hero .sub{color:var(--muted);font-size:12.5px;margin-top:14px;display:flex;gap:20px;flex-wrap:wrap}
.pf .hero .sub b{color:var(--ink);font-weight:600}
.pf .chartwrap{align-self:stretch;display:flex;flex-direction:column;justify-content:flex-end;min-width:0}
.pf .legend{display:flex;gap:16px;justify-content:flex-end;font-size:11.5px;color:var(--muted);margin-bottom:4px}
.pf .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.pf .kpis{grid-template-columns:repeat(4,1fr);margin-bottom:16px}
.pf .kpi{padding:16px 18px}
.pf .kpi .lbl{color:var(--muted);font-size:11.5px;font-weight:600}
.pf .kpi .v{font-size:22px;font-weight:600;margin-top:9px;letter-spacing:-.01em}
.pf .kpi .m{font-size:12px;color:var(--muted);margin-top:5px}
.pf .alert{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 18px;margin-bottom:16px;border-color:color-mix(in srgb,var(--neg) 34%,var(--line))}
.pf .alert .hd{display:flex;align-items:center;gap:9px;font-weight:600;color:var(--neg)}
.pf .alert .dot{width:8px;height:8px;border-radius:50%;background:var(--neg)}
.pf .alert .desc{color:var(--muted);font-size:13px}
.pf .chips{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.pf .chip{font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:7px;background:var(--negbg);color:var(--neg)}
.pf .chip.more{background:var(--panel2);color:var(--muted)}
.pf .two{grid-template-columns:1fr 1fr;margin-bottom:16px}
.pf .cardh{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px}
.pf .cardh h3{margin:0;font-size:14.5px;font-weight:600;letter-spacing:-.01em}
.pf .cardb{padding:4px 20px 20px}
.pf .alloc{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center}
.pf .donutc{position:relative;display:grid;place-items:center}
.pf .donutc .ctr{position:absolute;text-align:center}
.pf .donutc .ctr .n{font-family:var(--ser);font-size:22px;font-weight:500;line-height:1}
.pf .donutc .ctr .t{font-size:10.5px;color:var(--muted);margin-top:2px}
.pf .seclist{display:flex;flex-direction:column;gap:9px}
.pf .secrow{display:grid;grid-template-columns:10px 1fr auto;gap:9px;align-items:center;font-size:12.5px}
.pf .secrow i{width:9px;height:9px;border-radius:3px}
.pf .secrow .pc{color:var(--muted);font-weight:600}
.pf .risk{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:6px}
.pf .risk .k{font-size:11px;color:var(--muted);font-weight:600}
.pf .risk .val{font-size:19px;font-weight:600;margin-top:4px}
.pf .risknote{font-size:11.5px;color:var(--faint);margin-top:14px}
.pf .tm rect{stroke:var(--panel);stroke-width:1.5;cursor:default}
.pf .tm text{fill:#fff;font-weight:600}
.pf .tbl-h{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 6px}
.pf table{width:100%;border-collapse:collapse}
.pf th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:600;text-align:right;padding:9px 14px;border-bottom:1px solid var(--line)}
.pf th.l{text-align:left}
.pf td{padding:12px 14px;border-bottom:1px solid var(--line2);text-align:right;font-size:13px}
.pf tr:last-child td{border-bottom:0}.pf td.l{text-align:left}
.pf .stk .s{font-weight:600;display:flex;align-items:center;gap:7px}
.pf .stk .i{font-size:11px;color:var(--muted)}
.pf .wcell{display:flex;align-items:center;gap:9px;justify-content:flex-end}
.pf .wbar{width:52px;height:6px;border-radius:4px;background:var(--line);overflow:hidden}
.pf .wbar span{display:block;height:100%;background:var(--brand);border-radius:4px}
.pf .dma{font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:5px;background:var(--negbg);color:var(--neg)}
.pf .dma.f{background:var(--warnbg);color:var(--warn)}
.pf .foot{color:var(--faint);font-size:11.5px;margin-top:18px;text-align:center;line-height:1.6}
.pf .loading{padding:80px;text-align:center;color:var(--muted)}
.pf .nav{display:flex;gap:3px}
.pf .nav a{text-decoration:none;color:var(--muted);font-weight:600;font-size:12.5px;padding:6px 12px;border-radius:9px}
.pf .nav a.on{background:var(--brandbg);color:var(--brand)}
.pf .form{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;padding:16px 20px}
.pf .field label{display:block;font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
.pf input,.pf select{height:36px;padding:0 11px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:9px;font:inherit;font-size:13px}
.pf input:focus,.pf select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brandbg)}
.pf .btn{height:36px;padding:0 16px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit;font-weight:600;font-size:13px;cursor:pointer}
.pf .btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
.pf .btn.primary:hover{filter:brightness(1.05)}
.pf .btn:disabled{opacity:.5;cursor:default}
.pf .check{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);cursor:pointer}
.pf .empty{padding:52px;text-align:center;color:var(--muted)}
.pf .msg{font-size:12.5px;font-weight:600;padding:2px 20px 12px}
.pf .del{background:transparent;border:0;color:var(--faint);cursor:pointer;font-size:14px}
.pf .del:hover{color:var(--neg)}
.pf .badge{display:inline-flex;align-items:center;gap:5px;font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:6px;text-transform:uppercase;letter-spacing:.03em}
.pf .badge.nse{background:var(--brandbg);color:var(--brand)}
.pf .badge.us{background:var(--warnbg);color:var(--warn)}
@media(max-width:820px){.pf .hero,.pf .two{grid-template-columns:1fr}.pf .kpis{grid-template-columns:repeat(2,1fr)}.pf .alloc{grid-template-columns:1fr}}
`;

export default function PortfolioV2() {
  const [data, setData] = useState(null);
  const [alloc, setAlloc] = useState(null);
  const [div, setDiv] = useState(null);
  const [hist, setHist] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [booked, setBooked] = useState(null);
  const [disp, setDisp] = useState("INR");
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS;
    document.head.appendChild(l); return () => { try { document.head.removeChild(l); } catch {} };
  }, []);
  useEffect(() => {
    const g = (u, s) => axios.get(`${API_BASE}${u}`).then((r) => s(r.data)).catch(() => {});
    g("/portfolio", setData); g("/allocation", setAlloc); g("/dividends", setDiv);
    g("/portfolio-history?months=6", setHist); g("/alerts?dma=50&confirm=2", setAlerts); g("/booked", setBooked);
  }, []);

  const fx = data?.fx?.rate ?? 1;
  const base = (inr) => disp === "INR"
    ? "₹" + Math.round(inr).toLocaleString("en-IN")
    : "$" + Math.round(inr / fx).toLocaleString("en-US");
  const signed = (inr) => (inr >= 0 ? "+" : "−") + base(Math.abs(inr));

  if (!data?.summary) {
    return <div className="pf" data-pf-theme={theme}><style>{PF2_CSS}</style>
      <div className="wrap"><div className="loading">Loading your portfolio…</div></div></div>;
  }
  const s = data.summary;
  const realized = booked?.summary?.realized_inr ?? 0;
  const divInc = div?.summary?.annual_income_inr ?? 0;
  const totRet = s.pnl_inr + realized + divInc;
  const totRetPct = s.invested_inr ? (totRet / s.invested_inr) * 100 : 0;

  // charts data
  const curve = hist?.curve ?? [];
  const port = curve.map((p) => p.port_return_pct);
  const nifty = curve.map((p) => p.nifty_return_pct);
  const sectors = (alloc?.by_sector ?? []).map((x, i) => [x.name, x.pct, SECTOR_COLORS[i % SECTOR_COLORS.length]]);
  const tmData = (data.holdings ?? []).slice(0, 24).map((h) => ({ value: h.value_inr, sym: h.symbol, day: h.day_change_pct }));
  const alertBy = {}; (alerts?.below ?? []).forEach((a) => { alertBy[a.symbol] = a; });

  const dayColor = (d) => d >= 0
    ? `rgba(15,160,90,${Math.min(0.35 + Math.abs(d) / 6, 0.95)})`
    : `rgba(225,71,66,${Math.min(0.35 + Math.abs(d) / 6, 0.95)})`;

  const donut = () => {
    const cx = 75, cy = 75, r = 58, rin = 40, tot = sectors.reduce((a, b) => a + b[1], 0) || 1;
    let a = -Math.PI / 2;
    return sectors.map(([, pc, col], i) => {
      const a2 = a + (pc / tot) * 2 * Math.PI; const d = arc(cx, cy, r, rin, a, a2); a = a2;
      return <path key={i} d={d} fill={col} stroke="var(--panel)" strokeWidth="2" />;
    });
  };

  const Line = ({ w, h }) => {
    if (curve.length < 2) return <div className="risknote">building history…</div>;
    const P = linePts(port, w, h, { l: 6, r: 8, t: 10, b: 12 });
    const N = linePts(nifty, w, h, { l: 6, r: 8, t: 10, b: 12 });
    // share a common scale by concatenating both
    const all = [...port, ...nifty], mn = Math.min(...all), mx = Math.max(...all), rng = (mx - mn) || 1;
    const X = (i) => 6 + (i / (curve.length - 1)) * (w - 14);
    const Y = (v) => 10 + (1 - (v - mn) / rng) * (h - 22);
    const pp = port.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const np = nifty.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const zy = mn < 0 && mx > 0 ? Y(0) : null;
    return (
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        {zy != null && <line x1="6" y1={zy} x2={w - 8} y2={zy} stroke="var(--line)" strokeDasharray="3 4" />}
        <polygon points={`6,${Y(mn < 0 ? 0 : mn)} ${pp} ${w - 8},${Y(mn < 0 ? 0 : mn)}`} fill="var(--brand)" opacity="0.1" />
        <polyline points={np} fill="none" stroke="var(--faint)" strokeWidth="1.5" opacity="0.85" strokeLinejoin="round" />
        <polyline points={pp} fill="none" stroke="var(--brand)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={X(port.length - 1)} cy={Y(port[port.length - 1])} r="3" fill="var(--brand)" />
      </svg>
    );
  };

  const c = alloc?.concentration;
  return (
    <div className="pf" data-pf-theme={theme}>
      <style>{PF2_CSS}</style>
      <div className="wrap">
        <header className="top">
          <div className="brand">
            <h1>Portfolio</h1>
            <nav className="nav"><Link className="on" to="/v2">Overview</Link><Link to="/v2/booked">Booking</Link></nav>
          </div>
          <div className="controls">
            <div className="seg">
              {["INR", "USD"].map((x) => <button key={x} className={disp === x ? "on" : ""} onClick={() => setDisp(x)}>{x === "INR" ? "₹ INR" : "$ USD"}</button>)}
            </div>
            <button className="icon" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Toggle theme">◐</button>
            <Link className="icon" to="/portfolio" title="Classic view">Classic</Link>
          </div>
        </header>

        <section className="panel hero">
          <div>
            <div className="lbl">Total value</div>
            <div className="big num">{base(s.value_inr)}</div>
            <div className="ret">
              <span className={`pill ${totRet >= 0 ? "up" : "down"}`}>{totRet >= 0 ? "▲" : "▼"} {signed(totRet)} · {totRetPct >= 0 ? "+" : ""}{totRetPct.toFixed(1)}%</span>
              <span className="num" style={{ color: "var(--muted)", fontSize: 12.5 }}>today <b className={s.day_change_inr >= 0 ? "pos" : "neg"}>{signed(s.day_change_inr)} ({s.day_change_pct >= 0 ? "+" : ""}{s.day_change_pct}%)</b></span>
            </div>
            <div className="sub num">
              <span>Invested <b>{base(s.invested_inr)}</b></span>
              <span>Unrealised <b className={s.pnl_inr >= 0 ? "pos" : "neg"}>{signed(s.pnl_inr)}</b></span>
              <span>Realised <b className={realized >= 0 ? "pos" : "neg"}>{signed(realized)}</b></span>
              <span>Dividends <b className="pos">{signed(divInc)}</b></span>
            </div>
          </div>
          <div className="chartwrap">
            <div className="legend"><span><i style={{ background: "var(--brand)" }} />Portfolio</span><span><i style={{ background: "var(--faint)" }} />Nifty 50</span></div>
            <Line w={520} h={150} />
          </div>
        </section>

        <section className="grid kpis">
          <div className="panel kpi"><div className="lbl">TOTAL RETURN</div><div className={`v num ${totRet >= 0 ? "pos" : "neg"}`}>{totRetPct >= 0 ? "+" : ""}{totRetPct.toFixed(1)}%</div><div className="m">unrealised + realised + dividends</div></div>
          <div className="panel kpi"><div className="lbl">EST. ANNUAL DIVIDEND</div><div className="v num">{base(divInc)}</div><div className="m">{div?.summary ? `${div.summary.portfolio_yield_pct}% yield · ${div.summary.n_payers} payers` : "…"}</div></div>
          <div className="panel kpi"><div className="lbl">RETURN vs NIFTY</div><div className={`v num ${(hist?.risk?.total_return_pct ?? 0) >= 0 ? "pos" : "neg"}`}>{hist?.risk ? `${hist.risk.total_return_pct >= 0 ? "+" : ""}${hist.risk.total_return_pct}%` : "…"}</div><div className="m">{hist?.risk ? `Nifty ${hist.risk.nifty_return_pct}% · β ${hist.risk.beta} · vol ${hist.risk.volatility_annual_pct}%` : ""}</div></div>
          <div className="panel kpi"><div className="lbl">DIVERSIFICATION</div><div className="v">{c ? c.hhi_label : "…"}</div><div className="m">{c ? `${c.n_holdings} holdings · top-5 ${c.top5_pct}% · HHI ${c.hhi}` : ""}</div></div>
        </section>

        {alerts?.summary?.n_confirmed > 0 && (
          <section className="panel alert">
            <div className="hd"><span className="dot" />50-DMA sell signals</div>
            <div className="desc num"><b style={{ color: "var(--ink)" }}>{alerts.summary.n_confirmed} confirmed</b> (2+ closes below) · {base(alerts.summary.value_confirmed_inr)} at risk</div>
            <div className="chips num">
              {alerts.below.filter((a) => a.confirmed).slice(0, 5).map((a) => <span key={a.symbol} className="chip">{a.symbol} {a.pct_from_dma}%</span>)}
              {alerts.summary.n_confirmed > 5 && <span className="chip more">+{alerts.summary.n_confirmed - 5} more</span>}
            </div>
          </section>
        )}

        <section className="grid two">
          <div className="panel">
            <div className="cardh"><h3>Allocation by sector</h3><span className="eyebrow">by market value</span></div>
            <div className="cardb">
              <div className="alloc">
                <div className="donutc">
                  <svg viewBox="0 0 150 150" width="150" height="150">{donut()}</svg>
                  <div className="ctr"><div className="n num">{c ? c.n_sectors : ""}</div><div className="t">sectors</div></div>
                </div>
                <div className="seclist">
                  {sectors.slice(0, 7).map(([nm, pc, col], i) => (
                    <div className="secrow" key={i}><i style={{ background: col }} /><span>{nm}</span><span className="pc num">{pc.toFixed(1)}%</span></div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="cardh"><h3>Performance &amp; risk</h3><span className="eyebrow num">{hist ? `${hist.start} → ${hist.end}` : ""}</span></div>
            <div className="cardb">
              <div className="risk">
                <div><div className="k">BETA vs NIFTY</div><div className="val num">{hist?.risk?.beta ?? "—"}</div></div>
                <div><div className="k">VOLATILITY (ANN.)</div><div className="val num">{hist?.risk ? hist.risk.volatility_annual_pct + "%" : "—"}</div></div>
                <div><div className="k">MAX DRAWDOWN</div><div className="val num neg">{hist?.risk ? hist.risk.max_drawdown_pct + "%" : "—"}</div></div>
              </div>
              <div style={{ marginTop: 14 }}><Line w={480} h={126} /></div>
              <div className="risknote">Current holdings valued at historical prices — a reconstruction, not your actual past positions.</div>
            </div>
          </div>
        </section>

        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="cardh"><h3>Holdings map</h3><span className="eyebrow">box = weight · colour = today's move</span></div>
          <div className="cardb">
            <svg className="tm" viewBox="0 0 1000 320" width="100%" height="320" preserveAspectRatio="none">
              {squarify(tmData, 1000, 320).map((n, i) => {
                const big = n.w > 62 && n.h > 30;
                return (
                  <g key={i}>
                    <rect x={n.x} y={n.y} width={n.w} height={n.h} fill={dayColor(n.day)} rx="2" />
                    {big && <text x={n.x + 7} y={n.y + 18} fontSize="12">{n.sym}</text>}
                    {big && n.h > 46 && <text x={n.x + 7} y={n.y + 33} fontSize="10.5" opacity="0.9">{n.day >= 0 ? "+" : ""}{n.day}%</text>}
                  </g>
                );
              })}
            </svg>
          </div>
        </section>

        <section className="panel">
          <div className="tbl-h"><h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>Holdings</h3><span className="eyebrow">{s.n_holdings} positions · by value</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="num">
              <thead><tr><th className="l">Stock</th><th>Value</th><th>Weight</th><th>Day</th><th>P&amp;L</th><th>Div/yr</th></tr></thead>
              <tbody>
                {(data.holdings ?? []).slice(0, 12).map((h) => {
                  const ind = alloc?.industries?.[h.symbol] || "—";
                  const wt = alloc?.total_value_inr ? (h.value_inr / alloc.total_value_inr) * 100 : 0;
                  const dv = div?.holdings?.find((x) => x.symbol === h.symbol);
                  const al = alertBy[h.symbol];
                  return (
                    <tr key={h.symbol + h.exchange}>
                      <td className="l"><div className="stk"><div className="s">{h.symbol}{al?.confirmed && <span className={`dma${al.fresh ? " f" : ""}`}>▼50D</span>}</div><div className="i">{ind}</div></div></td>
                      <td>{base(h.value_inr)}</td>
                      <td><div className="wcell"><div className="wbar"><span style={{ width: `${Math.min(wt / (c?.largest?.pct || 10) * 100, 100)}%` }} /></div>{wt.toFixed(1)}%</div></td>
                      <td className={h.day_change_pct >= 0 ? "pos" : "neg"}>{h.day_change_pct >= 0 ? "+" : ""}{h.day_change_pct}%</td>
                      <td className={h.pnl_inr >= 0 ? "pos" : "neg"}>{signed(h.pnl_inr)}<div className={`i ${h.pnl_pct >= 0 ? "pos" : "neg"}`}>{h.pnl_pct >= 0 ? "+" : ""}{h.pnl_pct}%</div></td>
                      <td style={{ color: "var(--muted)" }}>{dv && dv.annual_income_inr > 0 ? base(dv.annual_income_inr) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="foot">Snowball-inspired reskin · live data · descriptive reporting only — not investment advice.</div>
      </div>
    </div>
  );
}
