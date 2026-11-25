import { defineScoutThinViteConfig } from "scout-app/vite";

export default defineScoutThinViteConfig({
  product: "Sessions",
  variant: "sessions",
  rail: "wide",
  port: 4805,
  serverEntry: "src/server.ts",
});
