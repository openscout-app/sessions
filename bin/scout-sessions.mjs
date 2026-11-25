#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkRuntime, discoverLocalTranscripts, runtimeUrl, runScoutSetup } from "../server/sessions.mjs";
import { DIST, serve } from "../server/serve.mjs";

const FIRST_PORT = 4805;
const args = process.argv.slice(2);
const opt = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const HELP = `Usage:
  scout-sessions [--port <n>] [--no-open]
      Serve Scout Sessions from prebuilt HTML on http://127.0.0.1:4805,
      discovering Claude Code, Codex, Antigravity, and Kimi sessions.

  scout-sessions setup
      Install and start Scout's local runtime via the Scout CLI for live
      session tailing.

  scout-sessions status [--json]
      Report runtime status and discovered session counts.`;

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

if (args[0] === "setup") {
  try {
    runScoutSetup();
    console.log(`Scout runtime is ready at ${runtimeUrl()}.`);
    process.exit(0);
  } catch (err) {
    console.error(`scout-sessions: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (args[0] === "status") {
  const url = runtimeUrl();
  const up = await checkRuntime(url);
  const discovered = discoverLocalTranscripts().length;
  if (args.includes("--json")) {
    console.log(JSON.stringify({ runtimeUp: up, runtimeUrl: url, discovered }, null, 2));
  } else {
    console.log(`Runtime:    ${up ? `up at ${url}` : "not running (run scout-sessions setup to start it)"}`);
    console.log(`Discovered: ${discovered} local transcripts`);
  }
  process.exit(0);
}

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("scout-sessions: dist/index.html is missing. Run `npm run build` first.");
  process.exit(1);
}

const requested = Number(opt("--port") ?? process.env.SCOUT_SESSIONS_PORT ?? 0);
const startPort = requested || FIRST_PORT;
const open = !args.includes("--no-open");

function openBrowser(url) {
  if (!open) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", url] : [url];
  execFile(cmd, cmdArgs, () => {});
}

for (let port = startPort; port < startPort + (requested ? 1 : 10); port++) {
  try {
    await serve(port);
    const url = `http://127.0.0.1:${port}`;
    console.log(`Scout Sessions: ${url}`);
    openBrowser(url);
    break;
  } catch (err) {
    if (err?.code === "EADDRINUSE") {
      try {
        const check = await fetch(`http://127.0.0.1:${port}/api/identity`, { signal: AbortSignal.timeout(800) });
        if (check.ok && (await check.json()).app === "@openscout/sessions") {
          const url = `http://127.0.0.1:${port}`;
          console.log(`Scout Sessions is already running at ${url}`);
          openBrowser(url);
          process.exit(0);
        }
      } catch {}
      if (!requested) continue;
    }
    console.error(`scout-sessions: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
