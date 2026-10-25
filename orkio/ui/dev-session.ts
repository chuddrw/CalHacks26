/**
 * ui/dev-session.ts
 *
 * WHAT IT'S FOR
 *   A Vite dev-server plugin that lets the dashboard sign in as whoever is signed in on this laptop.
 *   GET /__cowork/session answers {"token": "..."} from `spacetime login show --token` (through
 *   shared/src/session-token.ts), only to a page on this same laptop. Part C's rule holds: no token
 *   in .env, in source, or in the built bundle; the page keeps it in memory.
 *
 * OWNER: A (written for D's live mode). USED BY: ui/vite.config.ts. The page side is ui/src/session.ts.
 *
 * WHO GETS THE TOKEN
 *   - a GET from a loopback address (the dev server listens on localhost by default),
 *   - with Host localhost / 127.0.0.1 / ::1 (a DNS-rebinding page has a different Host),
 *   - with the x-cowork-dashboard header (another site's page can't add it without a CORS preflight,
 *     and this endpoint never answers one),
 *   - and, if the browser sends an Origin, a localhost one.
 *   Anything else gets 403. Use a teammate account for the dashboard laptop, not the database owner's.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { sessionToken } from "../shared/src/session-token.ts";
import { SESSION_HEADER, SESSION_PATH } from "./src/session.ts";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostname(hostHeader: string): string {
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.replace(/:\d+$/, "");
}

export function allowSessionRequest(req: Pick<IncomingMessage, "method" | "headers"> & { socket: { remoteAddress?: string } }): boolean {
  if (req.method !== "GET") return false;
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) return false;
  if (!LOCAL_HOSTS.has(hostname(req.headers.host ?? ""))) return false;
  if (req.headers[SESSION_HEADER] !== "1") return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function coworkSession(): Plugin {
  return {
    name: "cowork-session",
    configureServer(server) {
      server.middlewares.use(SESSION_PATH, (req: IncomingMessage, res: ServerResponse) => {
        if (!allowSessionRequest(req)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        void sessionToken().then((token) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ token }));
        });
      });
    },
  };
}
