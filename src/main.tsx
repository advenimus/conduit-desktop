import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { bootIconPack } from "./lib/icons";
import { installConnectionHistoryRecorder } from "./lib/connectionHistoryRecorder";
import "./index.css";

void bootIconPack();
installConnectionHistoryRecorder();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
