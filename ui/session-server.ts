/** WHAT IT'S FOR: loopback-only bridge to this laptop's own CLI login. No stored or shared tokens. */
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const sessionPath = "/__cowork/session";
type Request = Pick<IncomingMessage, "method" | "headers" | "socket">;

/** Reject cross-origin pages, DNS rebinding and remote callers before looking up credentials. */
export function permitsSessionRequest(request: Request, port: number): boolean {
  const remote = request.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? ""))
    return false;
  if (request.method !== "POST" || request.headers["x-cowork-session"] !== "1")
    return false;
  const host = request.headers.host;
  if (
    ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
      host ?? "",
    )
  )
    return false;
  if (request.headers.origin !== `http://${host}`) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}

export function cliSession(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      process.env.SPACETIME_CLI || "spacetime",
      ["login", "show", "--token"],
      { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        // Never log CLI output, errors, or credentials. Refresh on every connection attempt.
        resolve(
          error
            ? ""
            : (/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.exec(
                stdout,
              )?.[0] ?? ""),
        );
      },
    );
  });
}

export function sessionHandler(port: () => number, lookup = cliSession) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    if (req.url?.split("?")[0] !== sessionPath) return next();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!permitsSessionRequest(req, port())) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "local_session_only" }));
      return;
    }
    let token = "";
    try {
      token = await lookup();
    } catch {
      /* fixed response, never raw auth errors */
    }
    res.statusCode = token ? 200 : 401;
    res.end(JSON.stringify(token ? { token } : { error: "sign_in_required" }));
  };
}

export function localSessionPlugin(): Plugin {
  return {
    name: "cowork-local-session",
    configureServer(server) {
      server.middlewares.use(
        sessionHandler(() => {
          const address = server.httpServer?.address();
          return address && typeof address === "object" ? address.port : 0;
        }),
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use(
        sessionHandler(() => {
          const address = server.httpServer.address();
          return address && typeof address === "object" ? address.port : 0;
        }),
      );
    },
  };
}
