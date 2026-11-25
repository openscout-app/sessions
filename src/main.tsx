import { createRoot } from "react-dom/client";
import { SessionsStandaloneSurface } from "scout-app/sessions";
import { ScoutThinApp, type ScoutThinStatusBase } from "scout-app/shell";
import "scout-app/shell.css";

interface SessionsHostStatus extends ScoutThinStatusBase {
  discovered: number;
}

createRoot(document.getElementById("root")!).render(
  <ScoutThinApp<SessionsHostStatus>
    product="Sessions"
    variant="sessions"
    rail="wide"
    badge={(status) =>
      !status
        ? { label: "Scanning sessions", tone: "loading" }
        : status.runtimeUp
          ? { label: `Live tail · ${status.discovered} sessions`, tone: "ready", detail: status.runtimeUrl }
          : { label: `Local transcripts · ${status.discovered}`, tone: "local", detail: "Scout runtime not running" }
    }
    setupCallout={({ status, installing, runSetup }) =>
      status.runtimeUp
        ? null
        : {
            title: "Live runtime tail is off.",
            description: "Transcripts on disk already appear below. Start Scout's runtime for real-time tool streaming and permission hooks.",
            command: "npx openscout-app/sessions setup",
            actionLabel: installing ? "Starting…" : "Enable live tail",
            onAction: installing ? undefined : runSetup,
          }
    }
  >
    <SessionsStandaloneSurface />
  </ScoutThinApp>,
);
