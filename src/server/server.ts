import path from "node:path";
import fs from "node:fs/promises";
import express from "express";

import { createApp } from "./api.js";
import { createDashboardRouter } from "./dashboard.js";
import type { NodeManager } from "../manager.js";
import type { SequelizeStorage } from "../db/storage.js";

export interface ServerOptions {
  port: number;
  baseDir: string;
  storage: SequelizeStorage;
}

export function startServer(manager: NodeManager, options: ServerOptions): express.Express {
  const sessionDir = path.join(options.baseDir, "sessions");
  void fs.mkdir(sessionDir, { recursive: true });
  const app = createApp(manager, {
    sessionDbPath: sessionDir,
    storage: options.storage
  });

  app.use("/", createDashboardRouter());
  app.listen(options.port, () => {
    console.log(`Dashboard running on http://localhost:${options.port}`);
  });

  return app;
}
