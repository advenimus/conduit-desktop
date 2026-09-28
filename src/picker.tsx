import React from "react";
import ReactDOM from "react-dom/client";
import CredentialPickerApp from "./components/picker/CredentialPickerApp";
import { bootIconPack } from "./lib/icons";
import "./index.css";

void bootIconPack();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CredentialPickerApp />
  </React.StrictMode>
);
