// Writes openapi.json to the repo root (handy for front-ends without a running API).
import { writeFileSync } from "node:fs";
import { app, OPENAPI_INFO } from "../src/app.js";

writeFileSync("openapi.json", JSON.stringify(app.getOpenAPI31Document(OPENAPI_INFO), null, 2));
console.info("openapi.json written");
