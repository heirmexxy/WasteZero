// Run one pass of the autonomous operator and print what it did.
//   npm run operate
// Note: answer reuse lives in the server's memory, so run this while the server is stopped,
// or call POST /admin/operator/run on the running server instead.
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const app = await createApp(loadConfig());
console.log(JSON.stringify(await app.runOperator(), null, 2));
