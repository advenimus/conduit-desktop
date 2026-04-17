import React from "react";
import ReactDOM from "react-dom/client";
import CredentialPickerApp from "./components/picker/CredentialPickerApp";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CredentialPickerApp />
  </React.StrictMode>
);
