import { loadConfig } from "./config.js";
import { createApp, VERSION } from "./app.js";

let config;
try { config = loadConfig(); }
catch (error) { console.error(`Configuration error: ${error.message}`); process.exit(1); }

if (!config.adminKey) {
  console.error("Set WASTEZERO_ADMIN_KEY (24+ characters) before starting WasteZero. Did you copy .env.example to .env?");
  process.exit(1);
}
if (!config.upstreamKey) {
  console.warn("OPENAI_API_KEY is not set: customers must send their own key in X-Upstream-Authorization, and quality testing is disabled.");
}

const app = await createApp(config);
app.server.listen(config.port, config.host, () => {
  console.log(`WasteZero ${VERSION} listening on http://${config.host}:${config.port}`);
});

if (config.operatorIntervalMs > 0) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await app.runOperator();
      if (!r.halted && (r.proposals.length || r.actions.length || r.invoices.length)) {
        console.log(`operator: ${r.proposals.length} proposals, ${r.actions.length} actions, ${r.invoices.length} invoices, ${r.escalations.length} escalations`);
      }
    } catch (error) { console.error("operator run failed:", error.message); }
    finally { running = false; }
  }, config.operatorIntervalMs).unref();
  console.log(`Operator runs every ${Math.round(config.operatorIntervalMs / 1000)}s`);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.server.close(() => process.exit(0)));
