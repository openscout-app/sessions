import {
  checkRuntime,
  discoverLocalTranscripts,
  parseSessionObserve,
  runtimeUrl,
  runScoutSetup,
} from "./sessions.mjs";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isLoopbackHost(req) {
  return LOCAL_HOST.test(req.headers.host || "");
}

export function isLocalRequest(req) {
  const host = req.headers.host || "";
  if (!isLoopbackHost(req)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

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
        const snapshot = await res.json();
        if (Array.isArray(snapshot?.transcripts)) {
          return { up: true, base, snapshot };
        }
      }
    } catch {}
  }
  const transcripts = discoverLocalTranscripts();
  return { up, base, snapshot: { transcripts, processes: [] } };
}

export async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) return false;

  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: "Loopback requests from this page only." });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/identity") {
    sendJson(res, 200, { app: "@openscout/sessions" });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    const combined = await discoverCombined();
    sendJson(res, 200, {
      runtimeUp: combined.up,
      runtimeUrl: combined.base,
      discovered: combined.snapshot.transcripts.length,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup") {
    try {
      runScoutSetup();
      const base = runtimeUrl();
      sendJson(res, 200, { ok: true, runtimeUp: await checkRuntime(base) });
    } catch (err) {
      sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/tail/discover") {
    const combined = await discoverCombined();
    sendJson(res, 200, combined.snapshot);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/tail/recent") {
    const base = runtimeUrl();
    if (await checkRuntime(base)) {
      try {
        const upstream = await fetch(`${base}/v1/tail/recent${url.search}`, {
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

  if (req.method === "GET" && (pathname === "/v1/tail/events" || pathname === "/v1/events/stream")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
    res.write(": connected\n\n");
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => clearInterval(keepAlive));
    return true;
  }

  const refMatch = /^\/api\/session-ref\/(.+)$/.exec(pathname);
  if (req.method === "GET" && refMatch?.[1]) {
    const requested = decodeURIComponent(refMatch[1]).replace(/^session:[^:]+:/, "");
    const combined = await discoverCombined();
    const hit = combined.snapshot.transcripts.find((t) =>
      t.sessionId === requested
      || (t.transcriptPath && t.transcriptPath.includes(requested)),
    ) || discoverLocalTranscripts().find((t) =>
      t.sessionId === requested || t.transcriptPath.includes(requested),
    );
    if (!hit) {
      sendJson(res, 404, { error: "Session transcript not found." });
      return true;
    }
    const data = parseSessionObserve(hit);
    sendJson(res, 200, {
      kind: "observe",
      refId: hit.sessionId || requested,
      observe: {
        kind: "history",
        refId: hit.sessionId || requested,
        sessionId: hit.sessionId || requested,
        source: "history",
        fidelity: "timestamped",
        updatedAt: hit.mtimeMs,
        data,
      },
    });
    return true;
  }

  sendJson(res, 404, { error: "Unknown Sessions API route." });
  return true;
}
