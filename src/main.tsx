import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionsGlyph } from "scout-app/primitives";
import { SessionsStandaloneSurface } from "scout-app/sessions";
import { ScoutAppFrame, type ScoutRuntimeBadge } from "scout-app/shell";
import "scout-app/shell.css";

interface SessionsHostStatus {
  runtimeUp: boolean;
  runtimeUrl: string;
  discovered: number;
}

const PAGES = [{ id: "sessions", label: "Sessions", route: "/", icon: SessionsGlyph, match: () => true }] as const;

function App() {
  const [status, setStatus] = useState<SessionsHostStatus | null>(null);
  const [installing, setInstalling] = useState(false);

  const refreshStatus = useCallback(() => {
    fetch("/api/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setStatus(data as SessionsHostStatus);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    const timer = setInterval(refreshStatus, 15_000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const runSetup = async () => {
    setInstalling(true);
    try {
      await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      refreshStatus();
    } finally {
      setInstalling(false);
    }
  };

  const badge: ScoutRuntimeBadge = !status
    ? { label: "Scanning sessions", tone: "loading" }
    : status.runtimeUp
      ? { label: `Live tail · ${status.discovered} sessions`, tone: "ready", detail: status.runtimeUrl }
      : { label: `Local transcripts · ${status.discovered}`, tone: "local", detail: "Scout runtime not running" };

  const callout = status && !status.runtimeUp
    ? {
        title: "Live runtime tail is off.",
        description: "Transcripts on disk already appear below. Start Scout's runtime for real-time tool streaming and permission hooks.",
        command: "npx openscout-app/sessions setup",
        actionLabel: installing ? "Starting…" : "Enable live tail",
        onAction: installing ? undefined : () => void runSetup(),
      }
    : null;

  return (
    <ScoutAppFrame product="Sessions" variant="sessions" pages={PAGES} status={badge} setupCallout={callout}>
      <SessionsStandaloneSurface />
    </ScoutAppFrame>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
