import { defineScoutThinViteConfig } from "scout-app/vite";
// @ts-expect-error plain ESM server handler
import { handle } from "./server/api.mjs";

export default defineScoutThinViteConfig({
  product: "Sessions",
  variant: "sessions",
  port: 4805,
  apiHandler: handle,
});
