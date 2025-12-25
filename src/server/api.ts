import express from "express";
import session from "express-session";
import ConnectSqlite3 from "connect-sqlite3";
import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import path from "node:path";
import { rpcCall } from "../core/rpc.ts";

import type { NodeManager } from "../manager.ts";
import type { SequelizeStorage } from "../db/storage.ts";

export interface AppOptions {
  sessionDbPath: string;
  storage: SequelizeStorage;
}

export function createApp(manager: NodeManager, options: AppOptions): express.Express {
  const app = express();
  const SQLiteStore = ConnectSqlite3(session);

  app.use(express.json());
  app.use(
    session({
      store: new SQLiteStore({ db: "sessions.sqlite", dir: options.sessionDbPath }),
      secret: process.env.SESSION_SECRET ?? "neko-mn-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 5 * 60 * 60 * 1000
      }
    })
  );

  app.post("/api/auth/register", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const existing = await options.storage.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await options.storage.createUser(username, passwordHash);
    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username });
  });

  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const user = await options.storage.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const user = await options.storage.getUserById(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    res.json({ id: user.id, username: user.username });
  });

  app.post("/public/:chain/payments/new-address", async (req, res) => {
    try {
      const data = await manager.createPaymentAddress(req.params.chain);
      res.json({ ok: true, ...data });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/public/:chain/blockcount", async (req, res) => {
    try {
      const blockCount = await manager.getExplorerBlockCount(req.params.chain);
      res.json({ ok: true, blockCount });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/public/:chain/bestblockhash", async (req, res) => {
    try {
      const bestBlockHash = await manager.getExplorerBestBlockHash(req.params.chain);
      res.json({ ok: true, bestBlockHash });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/public/:chain/mempool", async (req, res) => {
    try {
      const txids = await manager.getExplorerMempool(req.params.chain);
      res.json({ ok: true, txids, count: txids.length });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/public/:chain/block/:id", async (req, res) => {
    try {
      const block = await manager.getExplorerBlock(req.params.chain, req.params.id);
      res.json({ ok: true, block });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/public/:chain/tx/:txid", async (req, res) => {
    try {
      const tx = await manager.getExplorerTx(req.params.chain, req.params.txid);
      res.json({ ok: true, tx });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/public/:chain/address/:address", async (req, res) => {
    try {
      const address = await manager.getExplorerAddress(req.params.chain, req.params.address);
      res.json({ ok: true, address });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/public/chains", (_req, res) => {
    res.json({ ok: true, chains: manager.listChains() });
  });

  app.use("/api", async (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  app.get("/api/chains", (_req, res) => {
    res.json(manager.listChains());
  });

  app.get("/api/nodes", async (req, res) => {
    const nodes = await manager.listNodes(req.session.userId);
    res.json(nodes);
  });

  app.get("/api/transactions", async (req, res) => {
    const search = String(req.query.search ?? "");
    const items = await manager.listAllTransactions(req.session.userId, search);
    res.json({ items });
  });

  app.get("/api/nodes/:id", async (req, res) => {
    const node = await manager.getNode(req.session.userId, req.params.id);
    res.json(node);
  });

  app.post("/api/nodes", async (req, res) => {
    try {
      const node = await manager.createNode(req.session.userId, req.body);
      let status = null;
      try {
        status = await manager.getBlockchainInfo(req.session.userId, node.id);
      } catch {
        status = null;
      }
      res.json({ ok: true, node, status });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to create node"
      });
    }
  });

  app.post("/api/nodes/:id/start", async (req, res) => {
    await manager.start(req.session.userId, req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/nodes/:id/startmasternode", async (req, res) => {
    try {
      const result = await manager.startMasternode(req.session.userId, req.params.id);
      res.json({ ok: true, result });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/masternode-status", async (req, res) => {
    try {
      const result = await manager.getMasternodeStatus(req.session.userId, req.params.id);
      res.json({ ok: true, result });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/peers", async (req, res) => {
    try {
      const peers = await manager.getPeerInfo(req.session.userId, req.params.id);
      res.json({ ok: true, peers, count: peers.length });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.post("/api/nodes/:id/stop", async (req, res) => {
    try {
      await manager.stop(req.session.userId, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.json({
        ok: false,
        error: "Node is offline. Start it first."
      });
    }
  });

  app.post("/api/nodes/:id/restart", async (req, res) => {
    try {
      await manager.restart(req.session.userId, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.json({
        ok: false,
        error: "Node is offline. Start it first."
      });
    }
  });

  app.post("/api/nodes/:id/resync", async (req, res) => {
    try {
      await manager.resync(req.session.userId, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.json({
        ok: false,
        error: "Node is offline. Start it first."
      });
    }
  });

  app.delete("/api/nodes/:id", async (req, res) => {
    await manager.deleteNode(req.session.userId, req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/nodes/:id/status", async (req, res) => {
    try {
      const blockCount = await manager.getBlockCount(req.session.userId, req.params.id);
      const info = await manager.getBlockchainInfo(req.session.userId, req.params.id);
      let masternodeStatus = null;
      try {
        masternodeStatus = await manager.getMasternodeStatus(req.session.userId, req.params.id);
      } catch {
        masternodeStatus = null;
      }
      res.json({
        online: true,
        blockCount,
        verificationProgress: info?.verificationprogress ?? null,
        headers: info?.headers ?? null,
        blocks: info?.blocks ?? null,
        chain: info?.chain ?? null,
        masternodeStatus
      });
    } catch (error) {
      res.json({
        online: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/balance", async (req, res) => {
    try {
      const balance = await manager.getBalance(req.session.userId, req.params.id);
      res.json({ online: true, balance });
    } catch (error) {
      res.json({
        online: false,
        balance: 0,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/transactions", async (req, res) => {
    const count = Number(req.query.count ?? 25);
    const skip = Number(req.query.skip ?? 0);
    try {
      const transactions = await manager.listTransactions(req.session.userId, req.params.id, count, skip);
      res.json({ online: true, transactions, count, skip });
    } catch (error) {
      res.json({
        online: false,
        transactions: [],
        count,
        skip,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.post("/api/nodes/:id/send", async (req, res) => {
    const { address, amount } = req.body ?? {};
    if (!address || typeof amount !== "number") {
      return res.status(400).json({ error: "Address and amount required" });
    }
    try {
      const txid = await manager.sendToAddress(req.session.userId, req.params.id, address, amount);
      res.json({ ok: true, txid });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/deposit", async (req, res) => {
    try {
      const address = await manager.getNewAddress(req.session.userId, req.params.id);
      res.json({ ok: true, address });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.post("/api/nodes/:id/import-key", async (req, res) => {
    const { privKey, label, rescan } = req.body ?? {};
    if (!privKey) {
      return res.status(400).json({ ok: false, error: "Private key required" });
    }
    try {
      await manager.importPrivKey(req.session.userId, req.params.id, privKey, label ?? "", !!rescan);
      res.json({ ok: true });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.post("/api/nodes/:id/export-key", async (req, res) => {
    const { address } = req.body ?? {};
    if (!address) {
      return res.status(400).json({ ok: false, error: "Address required" });
    }
    try {
      const privKey = await manager.dumpPrivKey(req.session.userId, req.params.id, address);
      res.json({ ok: true, privKey });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.post("/api/nodes/:id/export-all-keys", async (req, res) => {
    const { includeZero } = req.body ?? {};
    try {
      const keys = await manager.exportAllKeys(req.session.userId, req.params.id, includeZero !== false);
      res.json({ ok: true, keys });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/update-check", async (req, res) => {
    try {
      const { latest, current } = await manager.checkForUpdate(req.session.userId, req.params.id);
      res.json({ latest, current, updateAvailable: current && latest !== current });
    } catch (error) {
      res.json({
        latest: null,
        current: null,
        updateAvailable: false,
        error: error instanceof Error ? error.message : "Update check failed"
      });
    }
  });

  app.get("/api/nodes/:id/coldstaking/balance", async (req, res) => {
    try {
      const result = await manager.getColdStakingBalance(req.session.userId, req.params.id);
      res.json({ ok: true, result });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/coldstaking/address", async (req, res) => {
    try {
      const address = await manager.getNewStakingAddress(req.session.userId, req.params.id);
      res.json({ ok: true, address });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/staking/status", async (req, res) => {
    try {
      const result = await manager.getStakingStatus(req.session.userId, req.params.id);
      res.json({ ok: true, result });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.get("/api/nodes/:id/coldstaking/utxos", async (req, res) => {
    try {
      const utxos = await manager.listColdUtxos(req.session.userId, req.params.id);
      res.json({ ok: true, utxos });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.post("/api/nodes/:id/coldstaking/whitelist", async (req, res) => {
    try {
      const added = await manager.whitelistColdStakingDelegators(
        req.session.userId,
        req.params.id
      );
      res.json({ ok: true, added });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  app.post("/api/nodes/:id/update", async (req, res) => {
    try {
      await manager.updateNodeCore(req.session.userId, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.json({
        ok: false,
        error: "Node is offline. Start it first."
      });
    }
  });

  app.get("/api/nodes/:id/logs", async (req, res) => {
    const lines = Number(req.query.lines ?? 200);
    try {
      const node = await manager.getNode(req.session.userId, req.params.id);
      const logPath = path.join(node.datadir, "debug.log");
      const content = await fs.readFile(logPath, "utf8");
      const allLines = content.split(/\r?\n/);
      const tail = allLines.slice(-Math.max(1, lines)).join("\n");
      res.json({ ok: true, lines, content: tail });
    } catch (error) {
      res.json({
        ok: false,
        error: "Log not available. Ensure the node has been started."
      });
    }
  });

  app.post("/api/nodes/:id/rpc", async (req, res) => {
    const { method, params } = req.body ?? {};
    if (!method) {
      return res.status(400).json({ ok: false, error: "RPC method required" });
    }
    try {
      const node = await manager.getNode(req.session.userId, req.params.id);
      const result = await rpcCall(node, method, params ?? []);
      res.json({ ok: true, result });
    } catch (error) {
      res.json({
        ok: false,
        error: error instanceof Error ? error.message : "RPC unavailable"
      });
    }
  });

  return app;
}
