import yfinance as yf
import pandas as pd
import ta
import joblib

from xgboost import XGBRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_squared_error

print("Downloading stock data...")

# Download Indian stock data
df = yf.download(
    "RELIANCE.NS",
    period="5y",
    auto_adjust=True
)

# Flatten columns if MultiIndex
if isinstance(df.columns, pd.MultiIndex):
    df.columns = df.columns.get_level_values(0)

# Use 1D close series
close = df["Close"].squeeze()

# ─────────────────────────────────────────────
# Technical Indicators
# ─────────────────────────────────────────────

# RSI
df["RSI"] = ta.momentum.RSIIndicator(close).rsi()

# MACD
macd = ta.trend.MACD(close)

df["MACD"] = macd.macd()

# Moving averages
df["SMA20"] = ta.trend.sma_indicator(close, window=20)

df["SMA50"] = ta.trend.sma_indicator(close, window=50)

# Returns
df["Return"] = close.pct_change()

# Remove null rows
df.dropna(inplace=True)

# ─────────────────────────────────────────────
# Features & Target
# ─────────────────────────────────────────────

features = [
    "RSI",
    "MACD",
    "SMA20",
    "SMA50",
    "Volume",
    "Return"
]

X = df[features]

y = df["Close"]

# ─────────────────────────────────────────────
# Train/Test Split
# ─────────────────────────────────────────────

X_train, X_test, y_train, y_test = train_test_split(
    X,
    y,
    test_size=0.2,
    shuffle=False
)

print("Training XGBoost model...")

# ─────────────────────────────────────────────
# XGBoost Model
# ─────────────────────────────────────────────

model = XGBRegressor(
    n_estimators=200,
    max_depth=5,
    learning_rate=0.05,
    objective="reg:squarederror",
    random_state=42
)

model.fit(X_train, y_train)

# ─────────────────────────────────────────────
# Predictions
# ─────────────────────────────────────────────

preds = model.predict(X_test)

rmse = mean_squared_error(y_test, preds) ** 0.5

print(f"RMSE: {rmse:.2f}")

# ─────────────────────────────────────────────
# Save Model
# ─────────────────────────────────────────────

joblib.dump(model, "models/xgb_model.pkl")

print("Model saved successfully!")