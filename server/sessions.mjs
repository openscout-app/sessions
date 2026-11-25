import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WINDOW_MS = 14 * 24 * 3_600_000;

export function homeDir() {
  return process.env.SCOUT_SESSIONS_HOME || os.homedir();
}

export function runtimeUrl() {
  const explicit = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(homeDir(), ".openscout", "config.json"), "utf8"));
    if (cfg?.port) return `http://127.0.0.1:${cfg.port}`;
  } catch {}
  return "http://127.0.0.1:43110";
}

export function scoutBin() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  try {
    const pkg = require.resolve("@openscout/scout/package.json");
    const candidate = path.join(path.dirname(pkg), "bin", "scout");
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  const which = spawnSync("which", ["scout"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}

export function findBun() {
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}

export async function checkRuntime(base = runtimeUrl()) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    return res.ok;
  } catch {
    return false;
  }
}

export function runScoutSetup() {
  const bin = scoutBin();
  const bun = findBun();
  if (!bin) throw new Error("Scout CLI not found. Reinstall @openscout/sessions.");
  if (!bun) throw new Error("Bun 1.4.4+ is required to run Scout's background runtime (https://bun.sh).");
  const env = { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` };
  execFileSync(bin, ["setup"], { stdio: "pipe", env, timeout: 30_000 });
}

function walkJsonl(dir, maxDepth, out = [], depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, maxDepth, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs <= WINDOW_MS && st.size > 0) {
          out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {}
    }
  }
  return out;
}

function sniffTranscriptMeta(filePath, source) {
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = null;
  let project = null;
  if (source === "antigravity") {
    const match = /brain[\\/]([\da-f-]{36})[\\/]/i.exec(filePath);
    if (match?.[1]) sessionId = match[1];
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(16_384, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8").split("\n").slice(0, 15)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd && !cwd) cwd = obj.cwd;
        if (obj.sessionId && source !== "antigravity") sessionId = obj.sessionId;
        if (obj.type === "session_meta" && obj.payload?.cwd) cwd = obj.payload.cwd;
        const step = obj.step || obj;
        const ws = step.userInput?.activeUserState?.activeDocument?.workspaceUri;
        if (typeof ws === "string" && ws.startsWith("file://") && !cwd) {
          cwd = decodeURIComponent(ws.slice("file://".length));
        }
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }
  if (cwd) project = path.basename(cwd);
  else if (source === "claude") project = path.basename(path.dirname(filePath)).split("-").pop() || "claude";
  else project = source;
  return { sessionId, cwd, project };
}

export function discoverLocalTranscripts() {
  const home = homeDir();
  const sources = [
    { source: "claude", files: walkJsonl(path.join(home, ".claude", "projects"), 3) },
    { source: "codex", files: walkJsonl(path.join(home, ".codex", "sessions"), 4) },
    { source: "antigravity", files: [
      ...walkJsonl(path.join(home, ".gemini", "antigravity-cli", "brain"), 4),
      ...walkJsonl(path.join(home, ".gemini", "antigravity", "brain"), 4),
      ...walkJsonl(path.join(home, ".gemini", "antigravity-ide", "brain"), 4),
    ] },
    { source: "kimi", files: walkJsonl(path.join(home, ".kimi", "sessions"), 4) },
  ];

  const transcripts = [];
  for (const group of sources) {
    const recent = group.files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 40);
    for (const item of recent) {
      try {
        const meta = sniffTranscriptMeta(item.path, group.source);
        transcripts.push({
          source: group.source,
          sessionId: meta.sessionId,
          project: meta.project,
          cwd: meta.cwd,
          transcriptPath: item.path,
          mtimeMs: Math.floor(item.mtimeMs),
          size: item.size,
        });
      } catch {}
    }
  }
  return transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function parseSessionObserve(transcript) {
  const content = fs.readFileSync(transcript.transcriptPath, "utf8");
  const lines = content.split("\n").filter(Boolean).slice(-400);
  const events = [];
  let model = null;
  let seq = 0;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || obj.step?.metadata?.createdAt || "") || transcript.mtimeMs;

    if (transcript.source === "claude") {
      if (obj.message?.model) model = obj.message.model;
      if (obj.type === "user" && typeof obj.message?.content === "string") {
        events.push({ id: `ev-${++seq}`, kind: "prompt", text: obj.message.content, ts });
      } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === "text" && block.text) {
            events.push({ id: `ev-${++seq}`, kind: "message", text: block.text, ts });
          } else if (block.type === "tool_use") {
            const arg = block.input?.command || block.input?.file_path || block.input?.pattern || "";
            events.push({ id: `ev-${++seq}`, kind: "tool", tool: block.name, arg: String(arg), text: `${block.name} ${arg}`.trim(), ts });
          }
        }
      }
    } else if (transcript.source === "codex") {
      if (obj.type === "turn_context" && obj.payload?.model) model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const text = (obj.payload.content || []).map((c) => c.text || "").join("\n").trim();
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts });
      } else if (obj.type === "response_item" && obj.payload?.role === "assistant") {
        const text = (obj.payload.content || []).map((c) => c.text || "").join("\n").trim();
        if (text) events.push({ id: `ev-${++seq}`, kind: "message", text, ts });
      } else if (obj.type === "response_item" && obj.payload?.type === "function_call") {
        events.push({ id: `ev-${++seq}`, kind: "tool", tool: obj.payload.name || "tool", arg: String(obj.payload.arguments || "").slice(0, 180), text: obj.payload.name || "tool", ts });
      }
    } else if (transcript.source === "antigravity") {
      const step = obj.step || obj;
      const type = String(step.type || "");
      if (step.metadata?.generatorModel) model = step.metadata.generatorModel;
      if (type.endsWith("USER_INPUT") && step.userInput?.userResponse) {
        events.push({ id: `ev-${++seq}`, kind: "prompt", text: step.userInput.userResponse, ts });
      } else if (type.endsWith("PLANNER_RESPONSE") && step.plannerResponse) {
        const pr = step.plannerResponse;
        for (const call of pr.toolCalls || []) {
          let args = {};
          try { args = typeof call.argumentsJson === "string" ? JSON.parse(call.argumentsJson) : (call.arguments || {}); } catch {}
          const pathVal = args.Path || args.TargetFile || null;
          const arg = args.CommandLine || pathVal || args.query || call.name || "";
          events.push({
            id: `ev-${++seq}`,
            kind: "tool",
            tool: call.name || "tool",
            arg: String(arg),
            ...(pathVal ? { path: String(pathVal) } : {}),
            text: `${call.name || "tool"} ${arg}`.trim(),
            ts,
          });
        }
        const reply = pr.modifiedResponse || pr.response;
        if (reply) events.push({ id: `ev-${++seq}`, kind: "message", text: reply, ts });
      }
    }
  }

  return {
    live: Date.now() - transcript.mtimeMs < 60_000,
    events,
    files: [],
    metadata: {
      session: {
        adapterType: transcript.source,
        cwd: transcript.cwd,
        externalSessionId: transcript.sessionId,
        ...(model ? { model } : {}),
      },
    },
  };
}
