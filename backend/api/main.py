from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import yfinance as yf
import pandas as pd
import ta
import joblib

# -----------------------------------------------------------------------------
# FASTAPI APP
# -----------------------------------------------------------------------------

app = FastAPI()

# -----------------------------------------------------------------------------
# ENABLE CORS
# -----------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------------------
# LOAD TRAINED MODEL
# -----------------------------------------------------------------------------

model = joblib.load("models/xgb_model.pkl")

# -----------------------------------------------------------------------------
# HOME ROUTE
# -----------------------------------------------------------------------------

@app.get("/")
def home():

    return {
        "message": "AI Stock API Running Successfully"
    }

# -----------------------------------------------------------------------------
# PREDICTION ROUTE
# -----------------------------------------------------------------------------

@app.get("/predict/{symbol}")
def predict(symbol: str):

    try:

        # ---------------------------------------------------------------------
        # DOWNLOAD STOCK DATA
        # ---------------------------------------------------------------------

        df = yf.download(
            symbol,
            period="6mo",
            auto_adjust=True,
            progress=False
        )

        # ---------------------------------------------------------------------
        # EMPTY DATA CHECK
        # ---------------------------------------------------------------------

        if df.empty:

            return {
                "error": f"No stock data found for {symbol}"
            }

        # ---------------------------------------------------------------------
        # FIX MULTIINDEX COLUMNS
        # ---------------------------------------------------------------------

        if isinstance(df.columns, pd.MultiIndex):

            df.columns = df.columns.get_level_values(0)

        # ---------------------------------------------------------------------
        # CLOSE PRICE SERIES
        # ---------------------------------------------------------------------

        close = df["Close"]

        # ---------------------------------------------------------------------
        # TECHNICAL INDICATORS
        # ---------------------------------------------------------------------

        # RSI
        df["RSI"] = ta.momentum.RSIIndicator(close).rsi()

        # MACD
        macd = ta.trend.MACD(close)

        df["MACD"] = macd.macd()

        # SMA20
        df["SMA20"] = ta.trend.sma_indicator(
            close,
            window=20
        )

        # SMA50
        df["SMA50"] = ta.trend.sma_indicator(
            close,
            window=50
        )

        # RETURNS
        df["Return"] = close.pct_change()

        # ---------------------------------------------------------------------
        # REMOVE NULLS
        # ---------------------------------------------------------------------

        df.dropna(inplace=True)

        # ---------------------------------------------------------------------
        # CHECK DATA AFTER INDICATORS
        # ---------------------------------------------------------------------

        if len(df) == 0:

            return {
                "error": "Not enough data after feature engineering"
            }

        # ---------------------------------------------------------------------
        # LATEST ROW
        # ---------------------------------------------------------------------

        latest = df.iloc[-1]

        # ---------------------------------------------------------------------
        # FEATURES EXACTLY MATCHING TRAINING MODEL
        # ---------------------------------------------------------------------

        features = pd.DataFrame([{
            "RSI": float(latest["RSI"]),
            "MACD": float(latest["MACD"]),
            "SMA20": float(latest["SMA20"]),
            "SMA50": float(latest["SMA50"]),
            "Volume": float(latest["Volume"]),
            "Return": float(latest["Return"]),
        }])

        # ---------------------------------------------------------------------
        # MODEL PREDICTION
        # ---------------------------------------------------------------------

        pred = model.predict(features)[0]

        # ---------------------------------------------------------------------
        # CURRENT PRICE
        # ---------------------------------------------------------------------

        current = float(latest["Close"])

        # ---------------------------------------------------------------------
        # SIGNAL
        # ---------------------------------------------------------------------

        signal = "BUY" if pred > current else "SELL"

        # ---------------------------------------------------------------------
        # FINAL RESPONSE
        # ---------------------------------------------------------------------

        return {
            "symbol": symbol,
            "current_price": round(current, 2),
            "predicted_price": round(float(pred), 2),
            "signal": signal
        }

    except Exception as e:

        return {
            "error": str(e)
        }