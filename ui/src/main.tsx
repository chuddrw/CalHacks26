/**
 * ui/src/main.tsx
 *
 * WHAT IT'S FOR
 *   The dashboard's entry point: opens the SpacetimeDB connection (stdb.ts), loads the styles and
 *   mounts <App /> into index.html's root element.
 *
 * OWNER: D.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./stdb";
import "./styles.css";
import "./overview.css";

const disconnect = connect();
import.meta.hot?.dispose(disconnect);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
