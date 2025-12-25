import { NodeManager } from "../manager.ts";
import { startServer } from "./server.ts";

const port = Number(
  process.env.PORT ??
    process.env.SERVER_PORT ??
    process.env.PTERODACTYL_SERVER_PORT ??
    8080
);

const manager = new NodeManager();
await manager.init();

startServer(manager, {
  port,
  baseDir: manager.getBaseDir(),
  storage: manager.getStorage()
});

const whitelistEnabled = process.env.COLDSTAKE_WHITELIST === "1";
const whitelistIntervalSec = Number(process.env.COLDSTAKE_WHITELIST_INTERVAL_SECONDS ?? 30);

if (whitelistEnabled) {
  const runWhitelist = async () => {
    try {
      const nodes = await manager.getStorage().listAllNodes();
      for (const node of nodes) {
        try {
          await manager.whitelistColdStakingDelegatorsForNode(node);
        } catch {
          // ignore per-node errors
        }
      }
    } catch {
      // ignore global errors
    }
  };

  void runWhitelist();
  setInterval(runWhitelist, Math.max(5, whitelistIntervalSec) * 1000);
}
