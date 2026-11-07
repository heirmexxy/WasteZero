// Manage customers from the command line (run with the server stopped, or use the admin API instead).
//   npm run tenant -- list
//   npm run tenant -- create "Acme Ltd" '{"allowedOptimizations":["cache","route"],"autoShadow":true}'
//   npm run tenant -- policy t_abc123 '{"autoPromote":true}'
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Tenants } from "../src/tenants.js";

const config = loadConfig();
const tenants = new Tenants(path.join(config.dataDir, "tenants.json"), { bootstrapKey: config.bootstrapTenantKey });
await tenants.init();
const [command, a, b] = process.argv.slice(2);
const parse = (s) => (s ? JSON.parse(s) : {});

try {
  if (command === "list") console.log(JSON.stringify(tenants.listPublic(), null, 2));
  else if (command === "create") {
    const { tenant, apiKey } = await tenants.create({ name: a, policy: parse(b) });
    console.log(JSON.stringify(tenant, null, 2));
    console.log(`\nAPI key (shown once, give it to the customer): ${apiKey}`);
  } else if (command === "policy") console.log(JSON.stringify(await tenants.update(a, { policy: parse(b) }), null, 2));
  else { console.log("Usage: tenant list | create <name> [policyJson] | policy <id> <policyJson>"); process.exitCode = 1; }
} catch (error) { console.error(error.message); process.exitCode = 1; }
