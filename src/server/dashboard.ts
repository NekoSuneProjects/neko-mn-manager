import path from "node:path";
import express from "express";

export function createDashboardRouter(): express.Router {
  const router = express.Router();
  const assetsDir = path.join(process.cwd(), "src", "assets", "dashboard");
  router.get("/", (_req, res) => {
    res.sendFile(path.join(assetsDir, "home.html"));
  });
  router.get("/login", (_req, res) => {
    res.sendFile(path.join(assetsDir, "login.html"));
  });
  router.get("/register", (_req, res) => {
    res.sendFile(path.join(assetsDir, "register.html"));
  });
  router.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(assetsDir, "dashboard.html"));
  });
  router.use("/", express.static(assetsDir));
  return router;
}
