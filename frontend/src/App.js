import React, { useState, useEffect } from "react";
import axios from "axios";
import Chart from "react-apexcharts";

function App() {
  // --- STATE LAYER MATRIX ---
  const [symbol, setSymbol] = useState("RELIANCE.NS"); // Default inspected asset
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const [activeIndex, setActiveIndex] = useState("NIFTY50");
  const [scannerData, setScannerData] = useState([]);
  const [scannerLoading, setScannerLoading] = useState(false);

  // --- CORE PREDICTIVE INFERENCE TRIGGER ---
  // Fixes the async state update bug by accepting a direct ticker string override
  const runAnalysis = async (tickerOverride = null) => {
    try {
      setLoading(true);
      setData(null);
      
      const targetSymbol = tickerOverride || symbol;
      const response = await axios.get(`http://127.0.0.1:8000/predict/${targetSymbol}`);
      
      setData(response.data);
      setLoading(false);
    } catch (error) {
      console.error("API Error during asset prediction sequence:", error);
      setLoading(false);
    }
  };

  // --- BATCH SCANNER EXECUTOR ENGINE ---
  const executeScan = async (indexName) => {
    try {
      setScannerLoading(true);
      const response = await axios.get(`http://127.0.0.1:8000/scanner/${indexName}`);
      setScannerData(response.data.results);
      setScannerLoading(false);
    } catch (error) {
      console.error("API Error during index batch processing scanning loop:", error);
      setScannerLoading(false);
    }
  };

  // Automatic baseline boot scans
  useEffect(() => {
    executeScan(activeIndex);
    runAnalysis("RELIANCE.NS");
  }, [activeIndex]);

  // --- AUTOMATIC TIME DOCK REFRESH CYCLE (30 SECONDS) ---
  useEffect(() => {
    const refreshInterval = setInterval(() => {
      if (data && !loading) {
        axios.get(`http://127.0.0.1:8000/predict/${symbol}`).then(res => setData(res.data));
      }
      executeScan(activeIndex);
    }, 30000); // 30,000ms = 30 seconds

    return () => clearInterval(refreshInterval);
  }, [symbol, data, loading, activeIndex]);


  // --- INTERACTIVE APEX CHARTS STYLE SUITE LAYOUTS ---
  const getTechnicalSuiteOptions = () => {
    const commonXAxis = { 
      type: "datetime", 
      labels: { style: { colors: "#64748b" } }, 
      axisBorder: { show: false }, 
      axisTicks: { show: false } 
    };

    return {
      mainOptions: {
        chart: { id: "candles", toolbar: { show: false }, background: "transparent" },
        theme: { mode: "dark" },
        stroke: { width: 1 },
        xaxis: commonXAxis,
        yaxis: { labels: { style: { colors: "#64748b" }, formatter: (val) => `₹${val.toFixed(2)}` } },
        grid: { borderColor: "#1e293b" },
        plotOptions: { 
          candlestick: { 
            colors: { upward: "#00e396", downward: "#ff4d4d" }, 
            wick: { useFillColor: true } 
          } 
        }
      },
      gaugeOptions: {
        chart: { type: "radialBar", background: "transparent" },
        theme: { mode: "dark" },
        plotOptions: {
          radialBar: {
            startAngle: -135,
            endAngle: 135,
            hollow: { size: "65%" },
            track: { background: "#1e293b", strokeWidth: "100%" },
            dataLabels: {
              name: { show: true, color: "#64748b", fontSize: "11px", offsetY: 15 },
              value: { show: true, color: "#fff", fontSize: "24px", fontWeight: "700", offsetY: -10 }
            }
          }
        },
        fill: { 
          type: "solid", 
          colors: [data?.signals.recommendation === "BUY" ? "#00e396" : (data?.signals.recommendation === "SELL" ? "#ff4d4d" : "#ffaa00")] 
        },
        labels: ["AI SCORING ENGINE"]
      }
    };
  };

  const options = getTechnicalSuiteOptions();

  // Helper macro class styling badges
  const getRegimeColor = (regime) => {
    switch(regime) {
      case "BULL_MARKET_STABLE": return "#00e396";
      case "RISK_OFF_VOLATILE": return "#ff4d4d";
      case "BEARISH_TREND_CHURN": return "#f59e0b";
      default: return "#38bdf8";
    }
  };

  return (
    <div style={{ background: "#020617", minHeight: "100vh", color: "#f8fafc", padding: "24px", fontFamily: "Inter, system-ui, sans-serif" }}>
      
      {/* GLOBAL HEADER CONTROLLER LAYER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", borderBottom: "1px solid #1e293b", paddingBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "24px", fontWeight: "800", margin: 0, letterSpacing: "-0.5px" }}>
            QUANTITATIVE AI MARKET TERMINAL <span style={{ color: "#00d4ff", fontSize: "12px", border: "1px solid #00d4ff", padding: "2px 6px", borderRadius: "4px", marginLeft: "10px" }}>LIVE REFRESH ENGINE</span>
          </h1>
          <p style={{ color: "#64748b", fontSize: "12px", margin: "2px 0 0 0" }}>Systematic Event Analysis Layers & Multi-Threaded Index Pipeline Scanner</p>
        </div>

        <div style={{ display: "flex", gap: "10px" }}>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. RELIANCE.NS"
            style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid #1e293b", background: "#0f172a", color: "white", fontWeight: "600", fontSize: "14px", width: "150px" }}
          />
          <button 
            onClick={() => runAnalysis(symbol)} 
            disabled={loading} 
            style={{ background: "#00d4ff", color: "#020617", border: "none", padding: "8px 16px", borderRadius: "6px", fontWeight: "700", cursor: "pointer", fontSize: "14px" }}
          >
            {loading ? "Analyzing..." : "Verify Security"}
          </button>
        </div>
      </div>

      {/* CORE DISPLAY SECTION GRID SPLIT */}
      <div style={{ display: "grid", gridTemplateColumns: "3.2fr 1fr", gap: "20px" }}>
        
        {/* LEFT COMPUTE COLUMN LAYOUT */}
        <div>
          {data ? (
            <>
              {/* PRIMARY STATISTICAL KPI CORE BANNER STRIP */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "14px", marginBottom: "20px" }}>
                <div style={{ background: "#0b0f19", padding: "16px", borderRadius: "10px", border: "1px solid #1e293b" }}>
                  <span style={{ color: "#64748b", fontSize: "10px", fontWeight: "700", letterSpacing: "0.5px" }}>ASSET SPECIFICATION</span>
                  <h3 style={{ margin: "4px 0 0 0", fontSize: "18px" }}>{data.symbol} : ₹{data.meta.current_price}</h3>
                </div>

                <div style={{ background: "#0b0f19", padding: "16px", borderRadius: "10px", border: "1px solid #1e293b" }}>
                  <span style={{ color: "#64748b", fontSize: "10px", fontWeight: "700", letterSpacing: "0.5px" }}>RELATIVE STRENGTH INDICATION</span>
                  <h3 style={{ margin: "4px 0 0 0", fontSize: "18px", color: data.meta.rsi > 65 ? "#ff4d4d" : (data.meta.rsi < 35 ? "#00e396" : "#fff") }}>{data.meta.rsi}</h3>
                </div>
                
                {/* --- REAL-TIME MACRO VOLATILITY DOCK (INDIA VIX FEAR GAUGE) --- */}
                <div style={{ background: "#0b0f19", padding: "16px", borderRadius: "10px", border: "1px solid #1e293b", position: "relative" }}>
                  <span style={{ color: "#38bdf8", fontSize: "10px", fontWeight: "700", letterSpacing: "0.5px" }}>⚡ INDIA VIX (FEAR INDEX)</span>
                  <h3 style={{ margin: "4px 0 0 0", fontSize: "18px", color: "#fff" }}>
                    {data.vix_snapshot?.current} 
                    <span style={{ fontSize: "11px", color: "#ff4d4d", marginLeft: "6px" }}>+{data.vix_snapshot?.change_pct}%</span>
                  </h3>
                  <span style={{ position: "absolute", right: "12px", bottom: "12px", fontSize: "8px", background: "rgba(255,77,77,0.1)", color: "#ff4d4d", padding: "2px 4px", borderRadius: "3px", fontWeight: "700" }}>
                    {data.vix_snapshot?.status}
                  </span>
                </div>

                {/* --- MACRO SYSTEM REGIME CLASSIFIER BLOCK --- */}
                <div style={{ background: "#0b0f19", padding: "16px", borderRadius: "10px", border: "1px solid #1e293b" }}>
                  <span style={{ color: "#64748b", fontSize: "10px", fontWeight: "700", letterSpacing: "0.5px" }}>MACRO SYSTEM ENVIRONMENT</span>
                  <h3 style={{ margin: "4px 0 0 0", fontSize: "14px", fontWeight: "800", color: getRegimeColor(data.meta.market_regime) }}>
                    {data.meta.market_regime?.replace(/_/g, " ")}
                  </h3>
                </div>
              </div>

              {/* --- ADVANCED INSTITUTIONAL MACRO NEWS CONTEXT OUTFLOW RADAR ALERT BANNER --- */}
              <div style={{ background: "rgba(239, 68, 68, 0.03)", border: "1px solid rgba(239, 68, 68, 0.15)", padding: "16px", borderRadius: "10px", marginBottom: "20px" }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: "12px", color: "#ff4d4d", fontWeight: "800", letterSpacing: "0.5px" }}>
                  ⚠️ SYSTEMATIC PORTFOLIO RISK & INSTITUTIONAL FLOW TRACKER ALERT
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {data.news_impact_suite?.systematic.map((news, idx) => (
                    <div key={idx} style={{ fontSize: "12px", borderLeft: "2px solid #ff4d4d", paddingLeft: "10px" }}>
                      <b style={{ color: "#fff" }}>{news.event}</b> — <span style={{ color: "#ff4d4d", fontSize: "10px", fontWeight: "700" }}>{news.impact_type}</span>
                      <p style={{ margin: "2px 0 0 0", color: "#94a3b8" }}>{news.description}</p>
                    </div>
                  ))}
                  
                  {data.news_impact_suite?.idiosyncratic.map((news, idx) => (
                    <div key={idx} style={{ fontSize: "12px", borderLeft: "2px solid #00e396", paddingLeft: "10px", background: "rgba(0,227,150,0.02)", padding: "8px", borderRadius: "0 4px 4px 0" }}>
                      <b style={{ color: "#fff" }}>{news.event}</b> — <span style={{ color: "#00e396", fontSize: "10px", fontWeight: "700" }}>{news.impact_type}</span>
                      <p style={{ margin: "2px 0 0 0", color: "#94a3b8" }}>{news.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* TRAILING PORTFOLIO QUANT BACKTEST SANDBOX PANEL */}
              <div style={{ background: "#0b0f19", padding: "20px", borderRadius: "12px", border: "1px solid #1e293b", marginBottom: "20px" }}>
                <h4 style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#00d4ff", fontWeight: "700" }}>🔬 CORE BACKTEST SANDBOX METRICS (45-SESSION TRAILING COMPARTMENT RUN)</h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
                  <div style={{ background: "#020617", padding: "14px", borderRadius: "8px", border: "1px solid #1e293b", textAlign: "center" }}>
                    <p style={{ margin: 0, color: "#64748b", fontSize: "11px", fontWeight: "600" }}>STRATEGY CUMULATIVE ROI</p>
                    <h2 style={{ margin: "6px 0 0 0", color: data.backtest_sandbox_analytics?.total_roi_pct >= 0 ? "#00e396" : "#ff4d4d" }}>{data.backtest_sandbox_analytics?.total_roi_pct}%</h2>
                  </div>
                  <div style={{ background: "#020617", padding: "14px", borderRadius: "8px", border: "1px solid #1e293b", textAlign: "center" }}>
                    <p style={{ margin: 0, color: "#64748b", fontSize: "11px", fontWeight: "600" }}>RISK ADJUSTED SHARPE RATIO</p>
                    <h2 style={{ margin: "6px 0 0 0", color: "#38bdf8" }}>{data.backtest_sandbox_analytics?.sharpe_ratio_score}</h2>
                  </div>
                  <div style={{ background: "#020617", padding: "14px", borderRadius: "8px", border: "1px solid #1e293b", textAlign: "center" }}>
                    <p style={{ margin: 0, color: "#64748b", fontSize: "11px", fontWeight: "600" }}>MAXIMUM PEAK-TO-TROUGH DRAWDOWN</p>
                    <h2 style={{ margin: "6px 0 0 0", color: "#ff4d4d" }}>{data.backtest_sandbox_analytics?.max_drawdown_pct}%</h2>
                  </div>
                </div>
              </div>

              {/* TWO COLUMN INFERENCE BLOCK: SPEEDOMETER VS CANDLESUITE */}
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 2fr", gap: "16px", marginBottom: "20px" }}>
                
                {/* RADIAL RADAR GAUGE */}
                <div style={{ background: "#0b0f19", padding: "16px", borderRadius: "10px", border: "1px solid #1e293b", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
                  <Chart options={options.gaugeOptions} series={[data.signals.confidence_percentage]} type="radialBar" height={180} />
                  <div style={{ textAlign: "center", fontSize: "12px", marginTop: "-10px" }}>
                    <span style={{ color: "#64748b" }}>Horizon Prediction Close Target: </span>
                    <b style={{ color: "#00e396", fontSize: "14px" }}>₹{data.signals.lstm_target_price}</b>
                  </div>
                  <div style={{ marginTop: "12px", fontSize: "15px", fontWeight: "800", color: data.signals.recommendation === "BUY" ? "#00e396" : "#ff4d4d" }}>
                    RECOMMENDATION: {data.signals.recommendation}
                  </div>
                </div>

                {/* REAL-TIME HIGH RES CANDLESTICK GRAPH CHASSIS */}
                <div style={{ background: "#0b0f19", padding: "16px", borderRadius: "10px", border: "1px solid #1e293b" }}>
                  <Chart options={options.mainOptions} series={[{ name: "Market Candles", type: "candlestick", data: data.analytics.ohlc }]} type="candlestick" height={210} />
                </div>
              </div>

              {/* --- CORE AI EXPLAINABILITY INSIGHT PANEL (“WHY PANEL”) --- */}
              <div style={{ background: "#0b0f19", padding: "18px", borderRadius: "10px", border: "1px solid #1e293b", marginBottom: "24px" }}>
                <h3 style={{ margin: "0 0 12px 0", fontSize: "13px", color: "#00d4ff", fontWeight: "700", letterSpacing: "0.5px" }}>
                  🧠 MULTI-FACTOR ENSEMBLE EXPLAINABILITY DIAGNOSTICS (“WHY PANEL”)
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {data.explainability_why_panel?.map((insight, idx) => (
                    <div key={idx} style={{ fontSize: "12px", color: "#94a3b8", display: "flex", gap: "8px", alignItems: "flex-start" }}>
                      <span style={{ color: "#00d4ff", fontWeight: "bold" }}>•</span>
                      <span>{insight}</span>
                    </div>
                  ))}
                  {data.explainability_why_panel?.length === 0 && (
                    <span style={{ fontSize: "12px", color: "#64748b" }}>All statistical indicators sitting in stable equilibrium bands. Baseline confidence parameters enforced.</span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div style={{ background: "#0b0f19", padding: "80px", borderRadius: "10px", border: "1px solid #1e293b", textAlign: "center", marginBottom: "24px" }}>
              <h3 style={{ color: "#64748b", margin: 0 }}>Select or run analysis mapping sequences to initialize the quantitative tracking monitors.</h3>
            </div>
          )}

          {/* --- FIXED AUTOMATED MULTI-THREADED SCANNER SHEET GRID --- */}
          <div style={{ background: "#0b0f19", padding: "20px", borderRadius: "10px", border: "1px solid #1e293b" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "13px", color: "#00d4ff", fontWeight: "700", letterSpacing: "0.5px" }}>🛰️ REAL-TIME AUTOMATED MULTI-THREADED INDEX SCANNER ENGINE</h3>
              
              <div style={{ display: "flex", gap: "6px", background: "#020617", padding: "3px", borderRadius: "5px", border: "1px solid #1e293b" }}>
                {["NIFTY50", "BANKNIFTY", "MIDCAP100"].map((idx) => (
                  <button 
                    key={idx} 
                    onClick={() => setActiveIndex(idx)} 
                    style={{ background: activeIndex === idx ? "#00d4ff" : "transparent", color: activeIndex === idx ? "#020617" : "#64748b", border: "none", padding: "6px 12px", borderRadius: "4px", fontWeight: "700", fontSize: "11px", cursor: "pointer" }}
                  >
                    {idx}
                  </button>
                ))}
              </div>
            </div>

            {scannerLoading ? (
              <p style={{ color: "#00d4ff", fontSize: "13px", padding: "10px 0" }}>Deploying parallel matrix multi-threading worker nodes...</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px", textAlign: "left" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #1e293b", color: "#64748b" }}>
                      <th style={{ padding: "0 10px 8px 10px" }}>TICKER ENGINE</th>
                      <th style={{ padding: "0 10px 8px 10px" }}>VALUATION</th>
                      <th style={{ padding: "0 10px 8px 10px" }}>RSI (14)</th>
                      <th style={{ padding: "0 10px 8px 10px" }}>AI HORIZON SCANS</th>
                      <th style={{ padding: "0 10px 8px 10px" }}>CONVICTION VELOCITY</th>
                    </tr>
                  </thead>
                  {/* --- FIX COMPLETE: MAPPED ENTIRE DATA ARRAY MATRIX SECURELY --- */}
                  <tbody>
                    {scannerData.map((row, i) => (
                      <tr 
                        key={i} 
                        onClick={() => { 
                          const combinedTickerStr = `${row.symbol}.NS`;
                          setSymbol(combinedTickerStr); 
                          runAnalysis(combinedTickerStr); // Fixed dynamic injection bypasses state latency
                        }} 
                        style={{ borderBottom: "1px solid #0f172a", cursor: "pointer" }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#0f172a"}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                      >
                        <td style={{ padding: "12px 10px", fontWeight: "700", color: "#00d4ff" }}>{row.symbol}</td>
                        <td style={{ padding: "12px 10px" }}>₹{row.price.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: "12px 10px", color: row.rsi > 65 ? "#ff4d4d" : row.rsi < 35 ? "#00e396" : "#94a3b8" }}>{row.rsi}</td>
                        <td style={{ padding: "12px 10px", fontWeight: "700", color: row.signal === "BUY" ? "#00e396" : "#ff4d4d" }}>{row.signal}</td>
                        <td style={{ padding: "12px 10px", fontWeight: "700" }}>{row.confidence}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* FINANCIAL BROADCAST STREAM WIRE FEED PANEL SIDEBAR */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ background: "#0b0f19", padding: "16px", borderRadius: "10px", border: "1px solid #1e293b", height: "fit-content" }}>
            <h4 style={{ margin: "0 0 4px 0", fontSize: "13px", color: "#00d4ff", fontWeight: "700" }}>📰 FINANCIAL WIRE NEWS FEED</h4>
            <p style={{ margin: "0 0 14px 0", color: "#64748b", fontSize: "11px" }}>Real-time word mapping context evaluations</p>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {data?.live_news_feed_stream?.map((news, idx) => (
                <div key={idx} style={{ background: "#020617", padding: "12px", borderRadius: "6px", border: "1px solid #1e293b", fontSize: "11.5px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span style={{ fontSize: "9px", background: news.sentiment === "BULLISH" ? "rgba(0,227,150,0.12)" : (news.sentiment === "BEARISH" ? "rgba(255,77,77,0.12)" : "rgba(100,116,139,0.12)"), color: news.sentiment === "BULLISH" ? "#00e396" : (news.sentiment === "BEARISH" ? "#ff4d4d" : "#64748b"), padding: "1px 5px", borderRadius: "3px", fontWeight: "700" }}>
                      {news.sentiment}
                    </span>
                  </div>
                  <b style={{ color: "#fff", display: "block", marginBottom: "2px" }}>{news.headline}</b>
                  <span style={{ color: "#64748b", fontSize: "11px" }}>{news.summary}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;