import { NodeManager } from "../manager.ts";
import { startServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);

const manager = new NodeManager();
await manager.init();

startServer(manager, {
  port,
  baseDir: manager.getBaseDir(),
  storage: manager.getStorage()
});
