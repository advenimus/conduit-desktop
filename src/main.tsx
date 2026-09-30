import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { bootIconPack } from "./lib/icons";
import "./index.css";

void bootIconPack();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
