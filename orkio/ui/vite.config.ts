/**
 * ui/vite.config.ts
 *
 * WHAT IT'S FOR
 *   Vite settings for the dashboard. Two things differ from the default template:
 *   - envDir "..": read the VITE_* settings from the .env at the repo root, the same file
 *     everything else uses.
 *   - server.fs.allow "..": let the UI import ../shared (schema types and generated bindings).
 *   - coworkSession(): the dashboard signs in with this laptop's `spacetime login` (ui/dev-session.ts).
 *
 * OWNER: D.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { coworkSession } from "./dev-session.ts";

export default defineConfig({
  plugins: [react(), coworkSession()],
  envDir: "..",
  server: {
    fs: { allow: [".."] },
  },
});
