// Thin CLI for scripts/smoke-cft.sh ONLY (manual, never CI): launch one tenant's CfT via the real
// supervisor, print its pid, and wait. There is no daemon socket here, so no hello arrives and the
// tenant stays `starting` — this proves spawn args/profile dir, not the binding. Ctrl-C stops Chrome.
//   tsx daemon/launchTenant.ts <tenant> <cftBinary> <extensionDist>
import { createTenantSupervisor } from "./tenantSupervisor.js";

const [tenant, cftBinary, extensionDistPath] = process.argv.slice(2);
if (!tenant || !cftBinary || !extensionDistPath) {
  console.error("usage: launchTenant <tenant> <cftBinary> <extensionDist>");
  process.exit(2);
}
const sup = createTenantSupervisor({ cftBinary, extensionDistPath, readyTimeoutMs: 24 * 3600_000, log: (l) => console.log(l) });
sup.ensureTenant(tenant).catch(() => {});
setTimeout(() => {
  const h = sup.health(tenant);
  console.log(`tenant=${tenant} state=${h.state} pid=${h.pid} profile=${sup.profileDir(tenant)}`);
  console.log(`stop: Ctrl-C here, or: kill ${h.pid}`);
}, 1000);
const stop = () => {
  sup.stopTenant(tenant);
  setTimeout(() => process.exit(0), 300);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
