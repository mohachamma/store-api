// Local development server (`npm run dev`). On Vercel the entry point is src/index.ts.
import { serve } from "@hono/node-server";
import { app } from "../src/app.js";
import { getEnv } from "../src/env.js";

const { PORT } = getEnv();
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.info(`store-api listening on http://localhost:${info.port}`);
});
