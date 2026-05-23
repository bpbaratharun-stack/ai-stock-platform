import React, { useEffect, useState } from "react";
import axios from "axios";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from "recharts";

function App() {

  const [data, setData] = useState(null);

  useEffect(() => {

    axios
      .get("http://127.0.0.1:8000/predict/RELIANCE.NS")
      .then((res) => {
        setData(res.data);
      });

  }, []);

  const chartData = [
    {
      name: "Current",
      price: data?.current_price
    },
    {
      name: "Predicted",
      price: data?.predicted_price
    }
  ];

  return (
    <div
      style={{
        background: "#0d1117",
        minHeight: "100vh",
        color: "white",
        padding: "30px",
        fontFamily: "Arial"
      }}
    >

      <h1>📈 AI Stock Dashboard</h1>

      {data && (
        <div
          style={{
            display: "flex",
            gap: "20px",
            marginTop: "30px",
            flexWrap: "wrap"
          }}
        >

          <div
            style={{
              background: "#161b22",
              padding: "20px",
              borderRadius: "10px",
              width: "220px"
            }}
          >
            <h3>Stock</h3>
            <h2>{data.symbol}</h2>
          </div>

          <div
            style={{
              background: "#161b22",
              padding: "20px",
              borderRadius: "10px",
              width: "220px"
            }}
          >
            <h3>Current Price</h3>
            <h2>₹ {data.current_price}</h2>
          </div>

          <div
            style={{
              background: "#161b22",
              padding: "20px",
              borderRadius: "10px",
              width: "220px"
            }}
          >
            <h3>Predicted Price</h3>
            <h2>₹ {data.predicted_price}</h2>
          </div>

          <div
            style={{
              background: "#161b22",
              padding: "20px",
              borderRadius: "10px",
              width: "220px"
            }}
          >
            <h3>Signal</h3>
            <h2>{data.signal}</h2>
          </div>

        </div>
      )}

      <div
        style={{
          background: "#161b22",
          marginTop: "40px",
          padding: "20px",
          borderRadius: "10px"
        }}
      >

        <h2>Prediction Chart</h2>

        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={chartData}>
            <CartesianGrid stroke="#333" />
            <XAxis dataKey="name" stroke="white" />
            <YAxis stroke="white" />
            <Tooltip />
            <Line
              type="monotone"
              dataKey="price"
              stroke="#00d4ff"
              strokeWidth={3}
            />
          </LineChart>
        </ResponsiveContainer>

      </div>

    </div>
  );
}

export default App;