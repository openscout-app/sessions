import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRuntime,
  createScoutThinHttpHandler,
  createScoutThinServer,
  discoverLocalTranscripts,
  runScoutThinCli,
  runtimeUrl,
  sendJson,
  serveScoutThinServer,
  type ScoutThinServerOptions,
} from "scout-app/thin-server";

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const HELP = `Usage:
  scout-sessions [--port <n>] [--no-open]
      Serve Scout Sessions from prebuilt HTML on http://127.0.0.1:4805,
      discovering Claude Code, Codex, Antigravity, and Kimi sessions.

  scout-sessions setup
      Install and start Scout's local runtime via the Scout CLI for live
      session tailing.

  scout-sessions status [--json]
      Report runtime status and discovered session counts.`;

async function discoverCombined() {
  const base = runtimeUrl();
  const up = await checkRuntime(base);
  if (up) {
    try {
      const res = await fetch(`${base}/v1/tail/discover`, {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (res.ok) {
        const snapshot = (await res.json()) as { transcripts?: unknown[]; processes?: unknown[] };
        if (Array.isArray(snapshot?.transcripts)) {
          return { up: true, base, snapshot };
        }
      }
    } catch {}
  }
  const transcripts = discoverLocalTranscripts();
  return { up, base, snapshot: { transcripts, processes: [] } };
}

const SERVER_OPTIONS: ScoutThinServerOptions = {
  packageName: "@openscout/sessions",
  product: "Sessions",
  distDir: DIST,
  getStatus: async () => {
    const combined = await discoverCombined();
    return { discovered: combined.snapshot.transcripts.length };
  },
  apiHandler: async (req, res, { url, pathname, runtimeBase }) => {
    if (req.method === "GET" && pathname === "/api/tail/discover") {
      const combined = await discoverCombined();
      sendJson(res, 200, combined.snapshot);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/tail/recent") {
      if (await checkRuntime(runtimeBase)) {
        try {
          const upstream = await fetch(`${runtimeBase}/v1/tail/recent${url.search}`, {
            signal: AbortSignal.timeout(2500),
            redirect: "error",
          });
          if (upstream.ok) {
            sendJson(res, 200, await upstream.json());
            return true;
          }
        } catch {}
      }
      sendJson(res, 200, { events: [] });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/terminal-sessions") {
      sendJson(res, 200, { sessions: [] });
      return true;
    }

    return false;
  },
};

export const handle = createScoutThinHttpHandler(SERVER_OPTIONS);

export function createSessionsServer() {
  return createScoutThinServer(SERVER_OPTIONS);
}

export function serve(port: number, host = "127.0.0.1") {
  return serveScoutThinServer(createSessionsServer, port, host);
}

export function cli(argv = process.argv.slice(2)) {
  return runScoutThinCli(
    {
      binName: "scout-sessions",
      packageName: "@openscout/sessions",
      product: "Sessions",
      defaultPort: 4805,
      portEnvVar: "SCOUT_SESSIONS_PORT",
      distDir: DIST,
      help: HELP,
      createServer: createSessionsServer,
      getStatus: async () => {
        const url = runtimeUrl();
        const runtimeUp = await checkRuntime(url);
        const discovered = discoverLocalTranscripts().length;
        return {
          json: { runtimeUp, runtimeUrl: url, discovered },
          lines: [
            `Runtime:    ${runtimeUp ? `up at ${url}` : "not running (run scout-sessions setup to start it)"}`,
            `Discovered: ${discovered} local transcripts`,
          ],
        };
      },
    },
    argv,
  );
}
