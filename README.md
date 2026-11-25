# Scout Sessions

Live and recent coding agent sessions on your machine, in one local table and structured turn viewer.

`npx openscout-app/sessions` stands up a prebuilt HTML page immediately on loopback (`http://127.0.0.1:4805`) with zero build step at launch and no redirect to another server. It paints the Sessions skeleton from HTML on load, discovers Claude Code, Codex, Antigravity, and Kimi transcripts directly from disk, and connects to [Scout](https://github.com/openscout-app/scout) (`@openscout/scout`) for live tool-call tailing.

## Run it

```sh
npx openscout-app/sessions
```

- `--port <n>` chooses a specific loopback port (default `4805`).
- `--no-open` prints the URL without opening a browser.
- `npx openscout-app/sessions setup` installs and starts Scout's background runtime via the `scout` CLI for live event tailing.
- `npx openscout-app/sessions status` checks runtime reachability and discovered transcript counts.

## Licenses

This launcher and server are licensed under the [Apache License, Version 2.0](LICENSE).
The compiled UI in `dist/` uses components from [`openscout-app/scout-app`](https://github.com/openscout-app/scout-app) under PolyForm Shield 1.0.0 (`notices/scout-app.txt`).
