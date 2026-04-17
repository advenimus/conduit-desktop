import React from "react";
import ReactDOM from "react-dom/client";
import OverlayApp from "./components/overlay/OverlayApp";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>
);
