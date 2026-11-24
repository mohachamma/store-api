// Local development server (`npm run dev`).
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { getEnv } from "./env.js";

const { PORT } = getEnv();
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.info(`store-api listening on http://localhost:${info.port}`);
});
