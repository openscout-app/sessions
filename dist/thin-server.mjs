import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
const require$1 = createRequire(import.meta.url);
const DEFAULT_WINDOW_MS = 14 * 24 * 36e5;
function homeDir() {
  return process.env.SCOUT_SESSIONS_HOME || process.env.HOME || os.homedir();
}
function runtimeUrl() {
  const explicit = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(homeDir(), ".openscout", "config.json"), "utf8"));
    if (cfg?.port) return `http://127.0.0.1:${cfg.port}`;
  } catch {
  }
  return "http://127.0.0.1:43110";
}
function scoutBin() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  try {
    const pkg = require$1.resolve("@openscout/scout/package.json");
    const candidate = path.join(path.dirname(pkg), "bin", "scout");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
  }
  const which = spawnSync("which", ["scout"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
function findBun() {
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
async function checkRuntime(base = runtimeUrl()) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    return res.ok;
  } catch {
    return false;
  }
}
function runScoutSetup(packageName = "@openscout/scout") {
  const bin = scoutBin();
  const bun = findBun();
  if (!bin) throw new Error(`Scout CLI not found. Reinstall ${packageName}.`);
  if (!bun) throw new Error("Bun 1.4.4+ is required to run Scout's background runtime (https://bun.sh).");
  const env = { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` };
  execFileSync(bin, ["setup"], { stdio: "pipe", env, timeout: 3e4 });
}
function isSyntheticPromptRecord(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^# AGENTS\.md instructions\b/i.test(trimmed)) return true;
  if (/^<environment_context>/i.test(trimmed) && !trimmed.includes("</environment_context>\n")) return true;
  if (/^The following is a <SYSTEM_MESSAGE>/i.test(trimmed)) return true;
  if (/<command-name>\s*\/(?:clear|compact|login|logout|status|help)\s*<\/command-name>/i.test(trimmed)) return true;
  return false;
}
function stripPromptEnvelope(raw) {
  if (!raw) return "";
  if (isSyntheticPromptRecord(raw)) return "";
  const userReq = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const picked = userReq ? userReq[1] : raw;
  return picked.replace(/<(ADDITIONAL_METADATA|CONTEXT_SUMMARY|SYSTEM_MESSAGE|INSTRUCTIONS|environment_context|system-reminder|system_reminder|local-command-caveat|recommended_plugins|command-name|command-message|command-args)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ").replace(/<\/?pasted_content\b[^>]*>/gi, " ").replace(/^New (?:broker|runtime) ask from [^\n]+?\.\s*(?:Task:\s*)?/i, "").replace(/<\/?[A-Z_]{4,}>/g, " ").replace(/<truncated \d+ (?:bytes|lines)>/gi, "").replace(/\s+/g, " ").trim();
}
function summarizeHumanTitle(raw, maxLen = 110) {
  if (!raw) return null;
  const cleaned = stripPromptEnvelope(raw).replace(/^#+\s*/, "").replace(/^[>*-\s]+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
  if (!cleaned) return null;
  const firstSentence = cleaned.split(/\n/)[0]?.trim() || cleaned;
  return firstSentence.length <= maxLen ? firstSentence : `${firstSentence.slice(0, maxLen - 1).trimEnd()}…`;
}
function sniffWorkspaceFromPathHint(candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath.startsWith("/")) return null;
  const devMatch = /^(\/(?:Users|home)\/[^/]+\/dev\/[^/]+)/.exec(candidatePath);
  if (devMatch?.[1]) return devMatch[1];
  const parts = candidatePath.split("/").filter(Boolean);
  if (parts.length >= 4 && (parts[0] === "Users" || parts[0] === "home") && !parts[2]?.startsWith(".")) {
    return `/${parts.slice(0, 4).join("/")}`;
  }
  return null;
}
function sniffWorkspaceFromText(text) {
  const activeMatch = /Active Workspaces:\s*\n\s*-\s*([^\r\n<]+)/i.exec(text);
  if (activeMatch?.[1]?.trim()) return activeMatch[1].trim();
  const cwdMatch = /Command Working Directory:\s*([^\r\n<]+)/i.exec(text);
  if (cwdMatch?.[1]?.trim()) return cwdMatch[1].trim();
  return null;
}
function walkJsonl(dir, maxDepth, windowMs, filter, out = [], depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, maxDepth, windowMs, filter, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (filter && !filter(full, entry.name)) continue;
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs <= windowMs && st.size > 0) {
          out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
      }
    }
  }
  return out;
}
function readSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const clampedStart = Math.max(0, Math.min(start, size));
    const clampedLen = Math.max(0, Math.min(length, size - clampedStart));
    if (clampedLen === 0) return "";
    const buf = Buffer.alloc(clampedLen);
    fs.readSync(fd, buf, 0, clampedLen, clampedStart);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const rec = item;
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.input_text === "string") return rec.input_text;
        if (typeof rec.output_text === "string") return rec.output_text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
function looksLikeUuid(value) {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
}
function sniffTranscriptMeta(filePath, source, size) {
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = null;
  let branch = null;
  let model = null;
  let firstPrompt = null;
  let latestPrompt = null;
  if (source === "antigravity") {
    const brainMatch = /brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i.exec(filePath) || /brain[\\/]([\da-f-]{36})[\\/]/i.exec(filePath);
    if (brainMatch?.[1]) sessionId = brainMatch[1];
  } else if (source === "kimi") {
    const kimiMatch = /sessions[\\/][^\\/]+[\\/]([^\\/]+)[\\/]agents/i.exec(filePath);
    if (kimiMatch?.[1]) sessionId = kimiMatch[1];
  }
  const fileSize = size ?? (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  const head = readSlice(filePath, 0, 48e3);
  const tail = fileSize > 48e3 ? readSlice(filePath, Math.max(0, fileSize - 48e3), 48e3) : "";
  const lines = [...head.split("\n").slice(0, 30), ...tail ? tail.split("\n").slice(1) : []];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && !branch) branch = obj.gitBranch;
    if (source === "claude") {
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      if (typeof obj.message?.model === "string") model = obj.message.model;
      if (obj.type === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "codex") {
      if (obj.type === "session_meta" && obj.payload) {
        if (typeof obj.payload.id === "string") sessionId = obj.payload.id;
        if (typeof obj.payload.cwd === "string" && !cwd) cwd = obj.payload.cwd;
        if (typeof obj.payload.git?.branch === "string" && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && typeof obj.payload?.model === "string") model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      } else if (obj.type === "event_msg" && obj.payload?.type === "user_message") {
        const txt = stripPromptEnvelope(String(obj.payload.message ?? obj.payload.text ?? ""));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "antigravity") {
      const step = obj.step || obj;
      const type = String(step.type || "");
      if (typeof step.metadata?.generatorModel === "string") model = step.metadata.generatorModel;
      if (typeof step.model === "string" && !model) model = step.model;
      const ws = step.userInput?.activeUserState?.activeDocument?.workspaceUri;
      if (typeof ws === "string" && ws.startsWith("file://") && !cwd) {
        cwd = decodeURIComponent(ws.slice("file://".length));
      }
      if (!cwd && typeof step.content === "string") {
        cwd = sniffWorkspaceFromText(step.content);
      }
      const rawCalls = step.plannerResponse?.toolCalls || step.tool_calls || [];
      if (!cwd && Array.isArray(rawCalls)) {
        for (const call of rawCalls) {
          let args = call?.args || call?.arguments || {};
          if (typeof call?.argumentsJson === "string") {
            try {
              args = JSON.parse(call.argumentsJson);
            } catch {
            }
          }
          cwd = sniffWorkspaceFromPathHint(args?.Path || args?.TargetFile);
          if (cwd) break;
        }
      }
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const rawPrompt = String(step.userInput?.userResponse ?? step.content ?? "");
        if (!cwd) cwd = sniffWorkspaceFromText(rawPrompt);
        const txt = stripPromptEnvelope(rawPrompt);
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "kimi") {
      if (obj.type === "turn.prompt") {
        const txt = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    }
  }
  let project = "session";
  if (cwd) {
    project = path.basename(cwd);
  } else if (source === "claude") {
    const dirName = path.basename(path.dirname(filePath));
    project = dirName.replace(/^-/, "").split("-").pop() || "claude";
  } else if (source === "kimi") {
    const wdMatch = /sessions[\\/]wd_([^\\/]+)[\\/]/i.exec(filePath);
    project = wdMatch?.[1] || "kimi";
  } else if (!looksLikeUuid(sessionId)) {
    project = sessionId;
  } else {
    project = source === "antigravity" ? "Antigravity" : source;
  }
  const title = summarizeHumanTitle(latestPrompt || firstPrompt);
  return { sessionId, cwd, project, branch, model, title };
}
const transcriptDiscoveryCache = /* @__PURE__ */ new Map();
function discoverLocalTranscripts(options = {}) {
  const home = homeDir();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPerHarness = options.maxPerHarness ?? 40;
  const filterHarness = options.harness || "";
  const cacheKey = `${home}|${windowMs}|${maxPerHarness}|${filterHarness}|${process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT || ""}|${process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || ""}`;
  const cached = !options.bypassCache ? transcriptDiscoveryCache.get(cacheKey) : void 0;
  if (cached && Date.now() - cached.at < 2500) {
    return cached.items;
  }
  const claudeRoot = process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || path.join(home, ".claude", "projects");
  const codexRoot = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || path.join(home, ".codex", "sessions");
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code");
  const kimiRoot = process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || path.join(kimiHome, "sessions");
  const agyBrainOverride = process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT;
  const brainFilter = (full, name) => name === "transcript.jsonl" && full.includes(`${path.sep}.system_generated${path.sep}logs${path.sep}`);
  const sources = [
    { source: "claude", files: walkJsonl(claudeRoot, 3, windowMs) },
    {
      source: "codex",
      files: [
        ...walkJsonl(codexRoot, 4, windowMs),
        ...process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".openai-codex", "sessions"), 4, windowMs)
      ]
    },
    {
      source: "antigravity",
      files: [
        ...agyBrainOverride ? walkJsonl(agyBrainOverride, 4, windowMs, brainFilter) : [
          ...walkJsonl(path.join(home, ".gemini", "antigravity-cli", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity-ide", "brain"), 4, windowMs, brainFilter)
        ],
        ...walkJsonl(path.join(home, ".gemini", "antigravity", "conversations"), 2, windowMs)
      ]
    },
    {
      source: "kimi",
      files: [
        ...walkJsonl(kimiRoot, 5, windowMs, (_full, name) => name === "wire.jsonl"),
        ...process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".kimi", "sessions"), 5, windowMs)
      ]
    }
  ];
  const seenPaths = /* @__PURE__ */ new Set();
  const transcripts = [];
  for (const group of sources) {
    if (filterHarness && group.source !== filterHarness) continue;
    const recent = group.files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxPerHarness);
    for (const item of recent) {
      if (seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      try {
        const meta = sniffTranscriptMeta(item.path, group.source, item.size);
        transcripts.push({
          source: group.source,
          sessionId: meta.sessionId,
          project: meta.project,
          cwd: meta.cwd,
          branch: meta.branch,
          model: meta.model,
          title: meta.title,
          transcriptPath: item.path,
          mtimeMs: Math.floor(item.mtimeMs),
          size: item.size
        });
      } catch {
      }
    }
  }
  const sorted = transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  transcriptDiscoveryCache.set(cacheKey, { at: Date.now(), items: sorted });
  return sorted;
}
function parseSessionObserve(transcript) {
  const content = fs.readFileSync(transcript.transcriptPath, "utf8");
  const allLines = content.split("\n");
  const startIdx = Math.max(0, allLines.length - 1600);
  const events = [];
  let model = transcript.model ?? null;
  let branch = transcript.branch ?? null;
  let cwd = transcript.cwd ?? null;
  let seq = 0;
  for (let i = startIdx; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line?.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || obj.created_at || obj.step?.metadata?.createdAt || "") || transcript.mtimeMs;
    if (transcript.source === "claude") {
      if (obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.gitBranch && !branch) branch = obj.gitBranch;
      if (obj.message?.model) model = obj.message.model;
      if (obj.type === "user") {
        const text = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "text" && block.text) {
            events.push({ id: `ev-${++seq}`, kind: "message", text: block.text, ts, recordIndex: i });
          } else if (block?.type === "tool_use") {
            const pathVal = block.input?.file_path || block.input?.path || void 0;
            const arg = block.input?.command || pathVal || block.input?.pattern || "";
            events.push({
              id: `ev-${++seq}`,
              kind: "tool",
              tool: block.name || "tool",
              arg: String(arg),
              ...pathVal ? { path: String(pathVal) } : {},
              text: `${block.name || "tool"} ${arg}`.trim(),
              ts,
              recordIndex: i
            });
          }
        }
      }
    } else if (transcript.source === "codex") {
      if (obj.type === "session_meta") {
        if (obj.payload?.cwd && !cwd) cwd = obj.payload.cwd;
        if (obj.payload?.git?.branch && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && obj.payload?.model) model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const text = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "response_item" && obj.payload?.role === "assistant") {
        const text = flattenContent(obj.payload.content).trim();
        if (text) events.push({ id: `ev-${++seq}`, kind: "message", text, ts, recordIndex: i });
      } else if (obj.type === "response_item" && (obj.payload?.type === "function_call" || obj.payload?.type === "local_shell_call")) {
        let arg = String(obj.payload.arguments || obj.payload.command || "");
        try {
          const parsed = JSON.parse(arg);
          arg = parsed.cmd || parsed.command || (Array.isArray(parsed.command) ? parsed.command.join(" ") : arg);
        } catch {
        }
        events.push({
          id: `ev-${++seq}`,
          kind: "tool",
          tool: obj.payload.name || "shell",
          arg: String(arg).slice(0, 220),
          text: `${obj.payload.name || "shell"} ${String(arg).slice(0, 220)}`.trim(),
          ts,
          recordIndex: i
        });
      }
    } else if (transcript.source === "antigravity") {
      const step = obj.step || obj;
      const type = String(step.type || "");
      if (step.metadata?.generatorModel) model = step.metadata.generatorModel;
      if (typeof step.model === "string") model = step.model;
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const text = stripPromptEnvelope(String(step.userInput?.userResponse ?? step.content ?? ""));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (type === "PLANNER_RESPONSE" || type.endsWith("_PLANNER_RESPONSE")) {
        const pr = step.plannerResponse;
        const calls = pr?.toolCalls || step.tool_calls || [];
        for (const call of calls) {
          let args = {};
          try {
            args = typeof call.argumentsJson === "string" ? JSON.parse(call.argumentsJson) : call.arguments || call.args || {};
          } catch {
          }
          const toolName = call.name || call.tool_name || "tool";
          const pathVal = args.Path || args.TargetFile || null;
          if (!cwd && pathVal) cwd = sniffWorkspaceFromPathHint(pathVal);
          const arg = args.CommandLine || pathVal || args.query || args.toolSummary || toolName;
          events.push({
            id: `ev-${++seq}`,
            kind: "tool",
            tool: toolName,
            arg: String(arg),
            ...pathVal ? { path: String(pathVal) } : {},
            text: `${toolName} ${arg}`.trim(),
            ts,
            recordIndex: i
          });
        }
        const reply = pr?.modifiedResponse || pr?.response || (typeof step.content === "string" ? step.content : "");
        if (reply) events.push({ id: `ev-${++seq}`, kind: "message", text: reply, ts, recordIndex: i });
      }
    } else if (transcript.source === "kimi") {
      if (obj.type === "turn.prompt") {
        const text = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "context.append_loop_event") {
        const ev = obj.event;
        if (ev?.type === "tool.call") {
          const arg = typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args ?? ev.input ?? {}).slice(0, 180);
          events.push({ id: `ev-${++seq}`, kind: "tool", tool: ev.name || "tool", arg, text: `${ev.name || "tool"} ${arg}`.trim(), ts, recordIndex: i });
        } else if (ev?.part?.text) {
          events.push({ id: `ev-${++seq}`, kind: "message", text: String(ev.part.text), ts, recordIndex: i });
        }
      }
    }
  }
  return {
    live: Date.now() - transcript.mtimeMs < 6e4,
    events,
    files: [],
    metadata: {
      session: {
        adapterType: transcript.source,
        cwd,
        externalSessionId: transcript.sessionId || path.basename(transcript.transcriptPath, ".jsonl"),
        ...model ? { model } : {},
        ...branch ? { branch } : {},
        ...transcript.title ? { title: transcript.title } : {}
      }
    }
  };
}
async function resolveSessionObserve(requestedId) {
  const cleaned = requestedId.replace(/^session:[^:]+:/, "");
  let hit = discoverLocalTranscripts({ maxPerHarness: 80 }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  ) ?? discoverLocalTranscripts({ maxPerHarness: 80, bypassCache: true }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  );
  if (!hit) {
    const base = runtimeUrl();
    if (await checkRuntime(base)) {
      try {
        const res = await fetch(`${base}/v1/tail/discover`, {
          signal: AbortSignal.timeout(2500),
          redirect: "error"
        });
        if (res.ok) {
          const snap = await res.json();
          const rtHit = (snap?.transcripts || []).find(
            (t) => t.sessionId === cleaned || typeof t.transcriptPath === "string" && t.transcriptPath.includes(cleaned)
          );
          if (rtHit && typeof rtHit.transcriptPath === "string" && fs.existsSync(rtHit.transcriptPath)) {
            const st = fs.statSync(rtHit.transcriptPath);
            const meta = sniffTranscriptMeta(rtHit.transcriptPath, rtHit.source || "claude", st.size);
            hit = {
              source: rtHit.source || "claude",
              sessionId: rtHit.sessionId || meta.sessionId,
              project: rtHit.project || meta.project,
              cwd: rtHit.cwd || meta.cwd,
              branch: meta.branch,
              model: meta.model,
              title: meta.title,
              transcriptPath: rtHit.transcriptPath,
              mtimeMs: Math.floor(st.mtimeMs),
              size: st.size
            };
          }
        }
      } catch {
      }
    }
  }
  if (!hit || !fs.existsSync(hit.transcriptPath)) return null;
  const data = parseSessionObserve(hit);
  return {
    kind: "observe",
    refId: hit.sessionId,
    observe: {
      kind: "history",
      refId: hit.sessionId,
      sessionId: hit.sessionId,
      source: hit.source,
      project: hit.project,
      fidelity: "timestamped",
      updatedAt: hit.mtimeMs,
      data
    }
  };
}
function readTranscriptContextWindow(params) {
  const home = homeDir();
  let filePath = null;
  if (params.source) {
    const candidate = params.source.startsWith("~/") ? path.join(home, params.source.slice(2)) : params.source;
    if (fs.existsSync(candidate) && candidate.endsWith(".jsonl")) filePath = candidate;
  }
  const local = discoverLocalTranscripts({ maxPerHarness: 80 });
  const hit = local.find(
    (t) => filePath && t.transcriptPath === filePath || params.sessionId && (t.sessionId === params.sessionId || t.transcriptPath.includes(params.sessionId))
  );
  if (!hit && !filePath) return null;
  const targetPath = hit?.transcriptPath ?? filePath;
  const harness = hit?.source ?? (targetPath.includes(".claude") ? "claude" : targetPath.includes("antigravity") ? "antigravity" : targetPath.includes("kimi") ? "kimi" : "codex");
  const st = fs.statSync(targetPath);
  const meta = hit ?? { ...sniffTranscriptMeta(targetPath, harness, st.size), source: harness, transcriptPath: targetPath, mtimeMs: st.mtimeMs, size: st.size };
  const parsed = parseSessionObserve(meta);
  const center = params.centerRecord ?? -1;
  const radius = params.radius ?? 3;
  let matchPos = parsed.events.findIndex((e) => e.recordIndex === center);
  if (matchPos < 0 && center >= 0) {
    matchPos = parsed.events.reduce((best, ev, idx) => {
      if (ev.recordIndex == null) return best;
      if (best < 0) return idx;
      const prevDiff = Math.abs((parsed.events[best]?.recordIndex ?? 0) - center);
      return Math.abs(ev.recordIndex - center) < prevDiff ? idx : best;
    }, -1);
  }
  const sliceStart = matchPos >= 0 ? Math.max(0, matchPos - radius) : Math.max(0, parsed.events.length - (radius * 2 + 1));
  const sliceEnd = matchPos >= 0 ? Math.min(parsed.events.length, matchPos + radius + 1) : parsed.events.length;
  const turns = parsed.events.slice(sliceStart, sliceEnd).map((ev, idx) => ({
    index: ev.recordIndex ?? sliceStart + idx,
    role: ev.kind === "prompt" ? "prompt" : ev.kind === "tool" ? "tool" : "reply",
    label: ev.kind === "prompt" ? "You" : ev.kind === "tool" ? ev.tool || "Tool" : "Agent",
    text: ev.kind === "tool" ? ev.arg || ev.text : ev.text,
    matched: matchPos >= 0 ? sliceStart + idx === matchPos : false
  }));
  return {
    sessionId: meta.sessionId,
    project: meta.project,
    harness: meta.source,
    title: meta.title,
    turns
  };
}
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};
function isLoopbackHost(req) {
  return LOCAL_HOST.test(req.headers.host || "");
}
function isLocalRequest(req) {
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
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}
async function readJsonBody(req, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}
function createScoutThinHttpHandler(options) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  return async function handleThinApi(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) return false;
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { error: `Open ${title} on this host.` });
      return true;
    }
    const runtimeBase = runtimeUrl();
    if (req.method === "GET" && pathname === "/api/identity") {
      sendJson(res, 200, { app: options.packageName, product: options.product });
      return true;
    }
    if (options.apiHandler) {
      const handled = await options.apiHandler(req, res, { url, pathname, runtimeBase });
      if (handled) return true;
    }
    if (req.method === "GET" && pathname === "/api/status") {
      const runtimeUp = await checkRuntime(runtimeBase);
      const extra = options.getStatus ? await options.getStatus({ runtimeUp, runtimeUrl: runtimeBase }) : {};
      sendJson(res, 200, { runtimeUp, runtimeUrl: runtimeBase, ...extra });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/setup") {
      try {
        runScoutSetup(options.packageName);
        sendJson(res, 200, { ok: true, runtimeUp: await checkRuntime(runtimeBase) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (req.method === "GET" && (pathname === "/v1/events/stream" || pathname === "/v1/tail/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive"
      });
      res.write(": connected\n\n");
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 2e4);
      req.on("close", () => clearInterval(keepAlive));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/recent-sessions") {
      const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit") ?? 8)));
      const sessions = discoverLocalTranscripts({ maxPerHarness: 15 }).slice(0, limit).map((item) => ({
        sessionId: item.sessionId,
        harness: item.source,
        project: item.project,
        branch: item.branch,
        model: item.model,
        title: item.title,
        updatedAt: item.mtimeMs
      }));
      sendJson(res, 200, { sessions });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/session-context") {
      try {
        const body = await readJsonBody(req);
        const context = readTranscriptContextWindow(body);
        if (!context) {
          sendJson(res, 404, { error: "Session transcript not found." });
          return true;
        }
        sendJson(res, 200, context);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    const refMatch = /^\/api\/session-ref\/(.+)$/.exec(pathname);
    if (req.method === "GET" && refMatch?.[1]) {
      const resolved = await resolveSessionObserve(decodeURIComponent(refMatch[1]));
      if (!resolved) {
        sendJson(res, 404, { error: "Session transcript not found." });
        return true;
      }
      sendJson(res, 200, resolved);
      return true;
    }
    if (req.method === "GET" && pathname === "/api/messages") {
      const conversationId = url.searchParams.get("conversationId") || "";
      if (conversationId && await checkRuntime(runtimeBase)) {
        try {
          const upstream = await fetch(`${runtimeBase}/v1/messages?conversationId=${encodeURIComponent(conversationId)}&limit=50`, {
            signal: AbortSignal.timeout(3e3),
            redirect: "error"
          });
          if (upstream.ok) {
            const data = await upstream.json();
            sendJson(res, 200, Array.isArray(data) ? data : data.messages || []);
            return true;
          }
        } catch {
        }
      }
      sendJson(res, 200, []);
      return true;
    }
    sendJson(res, 404, { error: `Unknown ${title} API route.` });
    return true;
  };
}
function createScoutThinServer(options) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  const distDir = path.resolve(options.distDir);
  const handleApi = createScoutThinHttpHandler(options);
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!isLoopbackHost(req)) {
      sendJson(res, 421, { error: `Open ${title} via its local loopback address.` });
      return;
    }
    try {
      if (await handleApi(req, res)) return;
    } catch (err) {
      if (!res.destroyed) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const urlPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    let file = path.join(distDir, rel);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, "index.html");
    }
    if (!fs.existsSync(file)) {
      sendJson(res, 503, { error: `${title}: dist/index.html is missing. Run npm run build first.` });
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600"
    });
    fs.createReadStream(file).pipe(res);
  });
}
function serveScoutThinServer(createServer, port, host = "127.0.0.1") {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", url] : [url];
  execFile(cmd, cmdArgs, () => {
  });
}
async function runScoutThinCli(options, argv = process.argv.slice(2)) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  const opt = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : void 0;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(options.help);
    return;
  }
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  if (sub && options.commands && Object.hasOwn(options.commands, sub)) {
    await options.commands[sub](argv.slice(1));
    return;
  }
  if (sub === "setup") {
    try {
      runScoutSetup(options.packageName);
      console.log(`Scout runtime is ready at ${runtimeUrl()}.`);
      return;
    } catch (err) {
      console.error(`${options.binName}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  if (sub === "status") {
    if (options.getStatus) {
      const report = await options.getStatus();
      if (argv.includes("--json")) {
        console.log(JSON.stringify(report.json, null, 2));
      } else {
        for (const line of report.lines) console.log(line);
      }
      return;
    }
    const url = runtimeUrl();
    const up = await checkRuntime(url);
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ runtimeUp: up, runtimeUrl: url }, null, 2));
    } else {
      console.log(`Runtime: ${up ? `up at ${url}` : `not running (run ${options.binName} setup to start it)`}`);
    }
    return;
  }
  if (sub && sub !== "serve") {
    console.error(`${options.binName}: unknown command "${sub}". Run ${options.binName} --help.`);
    process.exit(1);
  }
  const indexHtml = path.join(path.resolve(options.distDir), "index.html");
  if (!fs.existsSync(indexHtml)) {
    console.error(`${options.binName}: dist/index.html is missing. Run \`npm run build\` first.`);
    process.exit(1);
  }
  const requested = Number(opt("--port") ?? process.env[options.portEnvVar] ?? 0);
  if (opt("--port") !== void 0 && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
    console.error(`${options.binName}: use a port between 1 and 65535.`);
    process.exit(1);
  }
  const startPort = requested || options.defaultPort;
  const open = !argv.includes("--no-open");
  for (let port = startPort; port < startPort + (requested ? 1 : 10); port++) {
    try {
      await serveScoutThinServer(options.createServer, port);
      const url = `http://127.0.0.1:${port}`;
      console.log(`${title}: ${url}`);
      if (open) openBrowser(url);
      return;
    } catch (err) {
      if (err?.code === "EADDRINUSE") {
        try {
          const check = await fetch(`http://127.0.0.1:${port}/api/identity`, {
            signal: AbortSignal.timeout(800),
            redirect: "error"
          });
          if (check.ok && (await check.json()).app === options.packageName) {
            const url = `http://127.0.0.1:${port}`;
            console.log(`${title} is already running at ${url}`);
            if (open) openBrowser(url);
            return;
          }
        } catch {
        }
        if (!requested) continue;
      }
      console.error(`${options.binName}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  console.error(`${options.binName}: ports ${startPort}-${startPort + 9} are in use. Pass --port to choose another.`);
  process.exit(1);
}
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
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
        signal: AbortSignal.timeout(3e3),
        redirect: "error"
      });
      if (res.ok) {
        const snapshot = await res.json();
        if (Array.isArray(snapshot?.transcripts)) {
          return { up: true, base, snapshot };
        }
      }
    } catch {
    }
  }
  const transcripts = discoverLocalTranscripts();
  return { up, base, snapshot: { transcripts, processes: [] } };
}
const SERVER_OPTIONS = {
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
            redirect: "error"
          });
          if (upstream.ok) {
            sendJson(res, 200, await upstream.json());
            return true;
          }
        } catch {
        }
      }
      sendJson(res, 200, { events: [] });
      return true;
    }
    if (req.method === "GET" && pathname === "/api/terminal-sessions") {
      sendJson(res, 200, { sessions: [] });
      return true;
    }
    return false;
  }
};
const handle = createScoutThinHttpHandler(SERVER_OPTIONS);
function createSessionsServer() {
  return createScoutThinServer(SERVER_OPTIONS);
}
function serve(port, host = "127.0.0.1") {
  return serveScoutThinServer(createSessionsServer, port, host);
}
function cli(argv = process.argv.slice(2)) {
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
            `Discovered: ${discovered} local transcripts`
          ]
        };
      }
    },
    argv
  );
}
export {
  DIST,
  cli,
  createSessionsServer,
  handle,
  serve
};
