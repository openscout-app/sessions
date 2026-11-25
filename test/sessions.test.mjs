import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionsServer } from "../server/serve.mjs";

test("serves prebuilt Sessions HTML with embedded skeleton and parses Claude and Antigravity sessions", async (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "scout-sessions-test-"));
  const agyUuid = "11111111-2222-3333-4444-555555555555";
  const agyLogs = path.join(tempHome, ".gemini", "antigravity-cli", "brain", agyUuid, ".system_generated", "logs");
  fs.mkdirSync(agyLogs, { recursive: true });
  fs.writeFileSync(
    path.join(agyLogs, "transcript.jsonl"),
    [
      JSON.stringify({
        step: {
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          userInput: {
            userResponse: "Inspect the web shell exports",
            activeUserState: { activeDocument: { workspaceUri: "file:///tmp/scout-app" } },
          },
        },
      }),
      JSON.stringify({
        step: {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          metadata: { generatorModel: "gemini-3-pro" },
          plannerResponse: {
            toolCalls: [{ name: "read_file", argumentsJson: JSON.stringify({ Path: "/tmp/scout-app/package.json" }) }],
            modifiedResponse: "Verified the composable shell exports.",
          },
        },
      }),
    ].join("\n") + "\n",
  );

  process.env.SCOUT_SESSIONS_HOME = tempHome;
  process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1";

  const server = createSessionsServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // 1. HTML loads immediately with baked-in Scout Sessions skeleton (zero runtime running).
  const htmlRes = await fetch(`${base}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.match(html, /data-scout-boot="sessions"/);
  assert.match(html, /Scout Sessions/);

  // 2. Cross-origin API calls are rejected.
  const crossOrigin = await fetch(`${base}/api/tail/discover`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(crossOrigin.status, 403);

  // 3. Discovers Antigravity transcript on disk with runtime offline.
  const discRes = await fetch(`${base}/api/tail/discover`);
  assert.equal(discRes.status, 200);
  const disc = await discRes.json();
  assert.equal(disc.transcripts.length, 1);
  assert.equal(disc.transcripts[0].source, "antigravity");
  assert.equal(disc.transcripts[0].sessionId, agyUuid);

  // 4. Parses structured ObserveData (prompt + read_file tool call + assistant answer + model).
  const refRes = await fetch(`${base}/api/session-ref/${agyUuid}`);
  assert.equal(refRes.status, 200);
  const ref = await refRes.json();
  assert.equal(ref.observe.data.metadata.session.model, "gemini-3-pro");
  assert.equal(ref.observe.data.events.length, 3);
  assert.equal(ref.observe.data.events[1].tool, "read_file");
});
