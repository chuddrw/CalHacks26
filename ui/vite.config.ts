/**
 * ui/vite.config.ts
 *
 * WHAT IT'S FOR
 *   Vite settings for the dashboard. Three things differ from the default template:
 *   - envDir "..": read the VITE_* settings from the .env at the repo root, the same file
 *     everything else uses.
 *   - server.fs.allow "..": let the UI import ../shared (schema types and generated bindings).
 *   - localSessionPlugin: loopback-only access to this laptop's own CLI sign-in for live reads.
 *
 * OWNER: D.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localSessionPlugin } from "./session-server.ts";

export default defineConfig({
  plugins: [react(), localSessionPlugin()],
  envDir: "..",
  server: {
    fs: { allow: [".."] },
  },
});
