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
