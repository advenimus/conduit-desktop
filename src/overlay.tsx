import React from "react";
import ReactDOM from "react-dom/client";
import OverlayApp from "./components/overlay/OverlayApp";
import { bootIconPack } from "./lib/icons";
import "./index.css";

void bootIconPack();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>
);
