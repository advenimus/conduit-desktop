// Primitive gallery (spec 4.1): served by the Vite dev server at /gallery.html, never built.
import React from "react";
import ReactDOM from "react-dom/client";
import { GalleryApp } from "./components/ui/gallery/GalleryApp";
import { bootIconPack } from "./lib/icons";
import "./index.css";

void bootIconPack();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GalleryApp />
  </React.StrictMode>,
);
