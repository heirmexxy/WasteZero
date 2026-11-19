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
  console.warn(`No server key for the default provider (${config.defaultProvider}): customers must send their own key in X-Upstream-Authorization, and quality testing is disabled.`);
}
const withKeys = Object.values(config.providers).filter((p) => p.serverKey).map((p) => p.name);
console.log(`Providers with a WasteZero key: ${withKeys.join(", ") || "none"} (others need the customer's own key)`);

const app = await createApp(config);
app.server.listen(config.port, config.host, () => {
  console.log(`WasteZero ${VERSION} listening on http://${config.host}:${config.port}`);
  // Dogfooding: WasteZero's own AI calls go through this server.
  app.ctx.selfUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
});
if (config.agents.enabled && config.agents.reliabilityIntervalMs > 0) {
  setInterval(() => app.runReliability().catch((e) => console.error("reliability check failed:", e.message)), config.agents.reliabilityIntervalMs).unref();
  // Deferred (batch) requests: submit and collect every 2 minutes.
  setInterval(() => app.runDeferred().catch((e) => console.error("deferred jobs failed:", e.message)), 120_000).unref();
}
if (config.telegram.botToken) {
  app.setupTelegram().then((ok) => console.log(ok ? "Telegram webhook registered" : "Telegram webhook not registered (needs an https PUBLIC_BASE_URL)"));
}

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
