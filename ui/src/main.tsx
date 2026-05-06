import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
// Patches navigator.clipboard at module-load time so Monaco's built-in
// clipboard actions (and any other consumer) route through the Tauri
// clipboard plugin on webkit2gtk. Must run before any clipboard use.
import "./lib/monacoClipboard";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
