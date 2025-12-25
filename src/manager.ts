import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";

import { SequelizeStorage } from "./db/storage.ts";
import { getBasePlatform, getPlatformKey } from "./core/platform.ts";
import { downloadToFile } from "./core/downloader.ts";
import { verifySha256 } from "./core/verify.ts";
import { extractArchive } from "./core/extract.ts";
import { writeConfig } from "./core/configWriter.ts";
import { startNodeProcess } from "./core/processManager.ts";
import { rpcCall } from "./core/rpc.ts";
import { applySnapshot } from "./core/snapshot.ts";
import { builtinChains } from "./chains/registry.ts";
import type { ChainPlugin, NodeConfig, NodeCreateInput } from "./types.ts";

export interface NodeManagerOptions {
  baseDir?: string;
  storagePath?: string;
  chains?: ChainPlugin[];
}

export class NodeManager {
  private baseDir: string;
  private storage: SequelizeStorage;
  private chains: Map<string, ChainPlugin>;

  constructor(options: NodeManagerOptions = {}) {
    const baseDir = options.baseDir ?? this.resolveBaseDir();
    const storagePath = options.storagePath ?? path.join(baseDir, "db.sqlite");

    this.baseDir = baseDir;
    this.storage = new SequelizeStorage(storagePath);
    this.chains = new Map();

    for (const chain of builtinChains) {
      this.chains.set(chain.id, chain);
    }

    for (const chain of options.chains ?? []) {
      this.chains.set(chain.id, chain);
    }
  }

  private resolveBaseDir(): string {
    if (process.env.NEKO_MN_BASEDIR) {
      return process.env.NEKO_MN_BASEDIR;
    }

    const pterodactyl =
      process.env.PTERODACTYL_SERVER_UUID ||
      process.env.PTERODACTYL_SERVER_ID ||
      process.env.PTERODACTYL;
    if (pterodactyl || this.pathExists("/home/container")) {
      return path.join("/home/container", ".neko-mn-manager");
    }

    if (this.isDocker()) {
      throw new Error(
        "Running in Docker without Pterodactyl. Set NEKO_MN_BASEDIR to a mounted volume path."
      );
    }

    return path.join(os.homedir(), ".neko-mn-manager");
  }

  private isDocker(): boolean {
    if (this.pathExists("/.dockerenv")) return true;
    try {
      const cgroup = fsSync.readFileSync("/proc/1/cgroup", "utf8");
      return cgroup.includes("docker") || cgroup.includes("containerd");
    } catch {
      return false;
    }
  }

  private pathExists(target: string): boolean {
    try {
      fsSync.accessSync(target);
      return true;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await this.storage.init();
  }

  listChains(): ChainPlugin[] {
    return Array.from(this.chains.values());
  }

  getStorage(): SequelizeStorage {
    return this.storage;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getChain(chainId: string): ChainPlugin {
    const chain = this.chains.get(chainId);
    if (!chain) {
      throw new Error(`Unknown chain: ${chainId}`);
    }
    return chain;
  }

  async installCore(chainId: string, version: string): Promise<string> {
    const chain = this.getChain(chainId);
    const platformKey = getPlatformKey();
    const release = chain.releases[version]?.[platformKey];
    if (!release) {
      throw new Error(`No release for ${chainId} ${version} (${platformKey})`);
    }

    const coreDir = path.join(this.baseDir, "cores", chainId, version);
    const archivePath = path.join(coreDir, `core-${platformKey}.${release.archive}`);
    const extractDir = path.join(coreDir, "bin");

    await fs.mkdir(coreDir, { recursive: true });
    await downloadToFile(release.url, archivePath);
    if (!this.shouldSkipVerify()) {
      await verifySha256(archivePath, release.sha256);
    }
    await extractArchive(archivePath, extractDir, release.archive);

    return extractDir;
  }

  async createNode(userId: number, input: NodeCreateInput): Promise<NodeConfig> {
    const chain = this.getChain(input.chain);
    const existingNodes = await this.storage.listAllNodes();
    const conflict = existingNodes.find((node) => node.chain === input.chain);
    if (conflict) {
      throw new Error(`Only one node per chain is allowed. ${input.chain} already exists.`);
    }
    const coreVersion = input.coreVersion ?? this.getLatestVersion(chain);
    const { p2pPort, rpcPort } = await this.allocatePorts(
      input.p2pPort,
      input.rpcPort,
      chain
    );

    const node: NodeConfig = {
      id: input.id,
      chain: input.chain,
      datadir: path.join(this.baseDir, "nodes", String(userId), input.id),
      p2pPort,
      rpcPort,
      rpcUser: this.randomToken(12),
      rpcPassword: this.randomToken(24),
      masternodeKey: input.masternodeKey,
      externalIp: input.externalIp,
      snapshotUrl: input.snapshotUrl,
      coreVersion,
      createdAt: new Date().toISOString()
    };

    await this.installCore(chain.id, coreVersion);
    await writeConfig(chain, node);

    if (node.snapshotUrl) {
      await applySnapshot(node, node.snapshotUrl);
    }

    await this.storage.addNode(userId, node);
    await this.start(userId, node.id);
    await this.waitForRpc(userId, node.id);
    return node;
  }

  async start(userId: number, id: string): Promise<void> {
    const node = await this.storage.getNode(userId, id);
    const chain = this.getChain(node.chain);
    const daemonPath = await this.resolveDaemonPath(userId, chain, node);
    const confPath = path.join(node.datadir, `${chain.id}.conf`);
    startNodeProcess({ daemonPath, datadir: node.datadir, confPath });
  }

  async stop(userId: number, id: string): Promise<void> {
    const node = await this.storage.getNode(userId, id);
    const chain = this.getChain(node.chain);
    await rpcCall(node, chain.rpc.stop);
  }

  async restart(userId: number, id: string): Promise<void> {
    await this.stop(userId, id);
    await this.start(userId, id);
  }

  async resync(userId: number, id: string): Promise<void> {
    const node = await this.storage.getNode(userId, id);
    await this.stop(userId, id);
    await fs.rm(path.join(node.datadir, "blocks"), { recursive: true, force: true });
    await fs.rm(path.join(node.datadir, "chainstate"), { recursive: true, force: true });
    await this.start(userId, id);
  }

  async deleteNode(userId: number, id: string): Promise<void> {
    const node = await this.storage.getNode(userId, id);
    try {
      await this.stop(userId, id);
    } catch {
      // ignore stop errors
    }
    await fs.rm(node.datadir, { recursive: true, force: true });
    await this.storage.removeNode(userId, id);
  }

  async getBlockCount(userId: number, id: string): Promise<number> {
    const node = await this.storage.getNode(userId, id);
    const chain = this.getChain(node.chain);
    return rpcCall(node, chain.rpc.blockCount);
  }

  async getBlockchainInfo(userId: number, id: string): Promise<any> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getblockchaininfo");
  }

  async getBalance(userId: number, id: string): Promise<number> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getbalance");
  }

  async listTransactions(userId: number, id: string, count = 25, skip = 0): Promise<any[]> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "listtransactions", ["*", count, skip]);
  }

  async sendToAddress(
    userId: number,
    id: string,
    address: string,
    amount: number
  ): Promise<string> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "sendtoaddress", [address, amount]);
  }

  async getNewAddress(userId: number, id: string): Promise<string> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getnewaddress");
  }

  async createPaymentAddress(
    chain: string
  ): Promise<{ address: string; privKey: string }> {
    const node = await this.getBestNodeByChain(chain);
    const address = await rpcCall<string>(node, "getnewaddress");
    const privKey = await rpcCall<string>(node, "dumpprivkey", [address]);
    return { address, privKey };
  }

  async importPrivKey(
    userId: number,
    id: string,
    privKey: string,
    label = "",
    rescan = false
  ): Promise<void> {
    const node = await this.storage.getNode(userId, id);
    await rpcCall(node, "importprivkey", [privKey, label, rescan]);
  }

  async dumpPrivKey(userId: number, id: string, address: string): Promise<string> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "dumpprivkey", [address]);
  }

  async exportAllKeys(
    userId: number,
    id: string,
    includeZero = true
  ): Promise<Array<{ address: string; balance: number; privKey: string; hasBalance: boolean }>> {
    const node = await this.storage.getNode(userId, id);
    const rows = await rpcCall<any[]>(node, "listreceivedbyaddress", [0, true]);
    const filtered = includeZero ? rows : rows.filter((row) => Number(row.amount) > 0);
    const results = [];
    for (const row of filtered) {
      const address = row.address as string;
      const balance = Number(row.amount) || 0;
      const privKey = await rpcCall(node, "dumpprivkey", [address]);
      results.push({ address, balance, privKey, hasBalance: balance > 0 });
    }
    return results;
  }

  async listAllTransactions(
    userId: number,
    search = "",
    perNodeLimit = 200
  ): Promise<
    Array<{
      nodeId: string;
      chain: string;
      label: string;
      txid: string;
      category: string;
      amount: number;
      confirmations?: number;
      blockhash?: string;
      blockheight?: number | null;
      time?: number;
      address?: string;
    }>
  > {
    const nodes = await this.storage.listNodes(userId);
    const results = [];
    const blockHeightCache = new Map<string, number>();
    const term = search.trim().toLowerCase();

    for (const node of nodes) {
      let transactions: any[] = [];
      try {
        transactions = await rpcCall(node, "listtransactions", ["*", perNodeLimit, 0]);
      } catch {
        continue;
      }

      for (const tx of transactions) {
        const label = `${node.chain}-${node.id}`;
        let blockheight: number | null = null;
        if (tx.blockhash) {
          if (blockHeightCache.has(tx.blockhash)) {
            blockheight = blockHeightCache.get(tx.blockhash) ?? null;
          } else {
            try {
              const header = await rpcCall<any>(node, "getblockheader", [tx.blockhash]);
              blockheight = header?.height ?? null;
              if (blockheight !== null) {
                blockHeightCache.set(tx.blockhash, blockheight);
              }
            } catch {
              blockheight = null;
            }
          }
        }

        const entry = {
          nodeId: node.id,
          chain: node.chain,
          label,
          txid: tx.txid as string,
          category: tx.category as string,
          amount: Number(tx.amount) || 0,
          confirmations: tx.confirmations as number | undefined,
          blockhash: tx.blockhash as string | undefined,
          blockheight,
          time: tx.time as number | undefined,
          address: tx.address as string | undefined
        };

        if (term) {
          const haystack = [
            entry.txid,
            entry.address,
            entry.category,
            String(entry.amount),
            String(entry.blockheight ?? ""),
            entry.label,
            entry.nodeId,
            entry.chain
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(term)) {
            continue;
          }
        }

        results.push(entry);
      }
    }

    results.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    return results;
  }

  async getExplorerBlockCount(chain: string): Promise<number> {
    const node = await this.getBestNodeByChain(chain);
    return rpcCall(node, "getblockcount");
  }

  async getExplorerBestBlockHash(chain: string): Promise<string> {
    const node = await this.getBestNodeByChain(chain);
    return rpcCall(node, "getbestblockhash");
  }

  async getExplorerMempool(chain: string): Promise<string[]> {
    const node = await this.getBestNodeByChain(chain);
    return rpcCall(node, "getrawmempool");
  }

  async getExplorerBlock(chain: string, id: string): Promise<any> {
    const node = await this.getBestNodeByChain(chain);
    const height = Number(id);
    const blockHash =
      Number.isNaN(height) ? id : await rpcCall<string>(node, "getblockhash", [height]);
    return rpcCall(node, "getblock", [blockHash, 2]);
  }

  async getExplorerTx(chain: string, txid: string): Promise<any> {
    const node = await this.getBestNodeByChain(chain);
    return rpcCall(node, "getrawtransaction", [txid, true]);
  }

  async getExplorerAddress(chain: string, address: string): Promise<any> {
    const node = await this.getBestNodeByChain(chain);
    const received = await rpcCall<any[]>(node, "listreceivedbyaddress", [0, true, true]);
    const entry = received.find((row) => row.address === address);
    return {
      address,
      amount: entry?.amount ?? 0,
      confirmations: entry?.confirmations ?? 0,
      txids: entry?.txids ?? []
    };
  }

  async getMasternodeStatus(userId: number, id: string): Promise<any> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getmasternodestatus");
  }

  async startMasternode(userId: number, id: string): Promise<any> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "startmasternode", ["local", false]);
  }

  async getPeerInfo(userId: number, id: string): Promise<any[]> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getpeerinfo");
  }

  async getColdStakingBalance(userId: number, id: string): Promise<any> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getcoldstakingbalance");
  }

  async getNewStakingAddress(userId: number, id: string): Promise<string> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getnewstakingaddress");
  }

  async getStakingStatus(userId: number, id: string): Promise<any> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "getstakingstatus");
  }

  async listColdUtxos(userId: number, id: string): Promise<any[]> {
    const node = await this.storage.getNode(userId, id);
    return rpcCall(node, "listcoldutxos");
  }

  async whitelistColdStakingDelegators(userId: number, id: string): Promise<number> {
    const node = await this.storage.getNode(userId, id);
    return this.whitelistColdStakingDelegatorsForNode(node);
  }

  async whitelistColdStakingDelegatorsForNode(node: NodeConfig): Promise<number> {
    const utxos = await rpcCall<any[]>(node, "listcoldutxos");
    let added = 0;
    for (const stake of utxos) {
      const whitelisted = stake["whitelisted"];
      const isWhitelisted = whitelisted === true || whitelisted === "true";
      if (!isWhitelisted) {
        const owner = stake["coin-owner"];
        if (owner) {
          await rpcCall(node, "delegatoradd", [owner]);
          added += 1;
        }
      }
    }
    return added;
  }

  async listNodes(userId: number): Promise<NodeConfig[]> {
    return this.storage.listNodes(userId);
  }

  async checkForUpdate(userId: number, id: string): Promise<{ latest: string; current?: string }> {
    const node = await this.storage.getNode(userId, id);
    const chain = this.getChain(node.chain);
    const latest = this.getLatestVersion(chain);
    return { latest, current: node.coreVersion };
  }

  async updateNodeCore(userId: number, id: string): Promise<void> {
    const node = await this.storage.getNode(userId, id);
    const chain = this.getChain(node.chain);
    const latest = this.getLatestVersion(chain);
    await this.stop(userId, id);
    await this.installCore(chain.id, latest);
    await this.storage.updateNode(userId, id, { coreVersion: latest, daemonPath: undefined });
    await this.start(userId, id);
  }

  async getNode(userId: number, id: string): Promise<NodeConfig> {
    return this.storage.getNode(userId, id);
  }

  private randomToken(bytes: number): string {
    return crypto.randomBytes(bytes).toString("hex");
  }

  private async resolveDaemonPath(
    userId: number,
    chain: ChainPlugin,
    node: NodeConfig
  ): Promise<string> {
    if (node.daemonPath) {
      return node.daemonPath;
    }

    if (!node.coreVersion) {
      throw new Error(`Node ${node.id} missing coreVersion`);
    }

    const platformKey = getPlatformKey();
    const coreDir = path.join(this.baseDir, "cores", chain.id, node.coreVersion, "bin");
    const daemonName = chain.daemon[getBasePlatform(platformKey)];
    if (!daemonName) {
      throw new Error(`No daemon name for ${chain.id} on ${platformKey}`);
    }

    let found = await this.findBinary(coreDir, daemonName);
    if (!found) {
      await this.installCore(chain.id, node.coreVersion);
      found = await this.findBinary(coreDir, daemonName);
    }
    if (!found) {
      throw new Error(`Daemon not found: ${daemonName}`);
    }

    node.daemonPath = found;
    await this.storage.updateNode(userId, node.id, { daemonPath: found });
    return found;
  }

  private async findBinary(rootDir: string, fileName: string): Promise<string | null> {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        const found = await this.findBinary(fullPath, fileName);
        if (found) {
          return found;
        }
      } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return fullPath;
      }
    }
    return null;
  }

  private async waitForRpc(userId: number, id: string): Promise<void> {
    const timeoutMs = 15000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        await this.getBlockCount(userId, id);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async getBestNodeByChain(chain: string): Promise<NodeConfig> {
    const nodes = (await this.storage.listAllNodes()).filter((node) => node.chain === chain);
    if (!nodes.length) {
      throw new Error(`No nodes available for chain: ${chain}`);
    }

    let best = nodes[0];
    let bestHeight = -1;
    for (const node of nodes) {
      try {
        const height = await rpcCall<number>(node, "getblockcount");
        if (height > bestHeight) {
          bestHeight = height;
          best = node;
        }
      } catch {
        continue;
      }
    }

    return best;
  }

  private async allocatePorts(
    p2pPort: number | undefined,
    rpcPort: number | undefined,
    chain: ChainPlugin
  ): Promise<{ p2pPort: number; rpcPort: number }> {
    const usedPorts = new Set<number>();
    const allNodes = await this.storage.listAllNodes();
    for (const node of allNodes) {
      usedPorts.add(node.p2pPort);
      usedPorts.add(node.rpcPort);
    }

    const pickPort = (start: number): number => {
      let port = start;
      while (usedPorts.has(port)) {
        port += 1;
      }
      usedPorts.add(port);
      return port;
    };

    const resolvedP2p = p2pPort ?? pickPort(chain.defaultPorts.p2p);
    const resolvedRpc = rpcPort ?? pickPort(chain.defaultPorts.rpc);

    if (resolvedP2p === resolvedRpc) {
      return { p2pPort: resolvedP2p, rpcPort: pickPort(resolvedRpc + 1) };
    }

    return { p2pPort: resolvedP2p, rpcPort: resolvedRpc };
  }

  private getLatestVersion(chain: ChainPlugin): string {
    const versions = Object.keys(chain.releases);
    if (versions.length === 0) {
      throw new Error(`No releases configured for ${chain.id}`);
    }
    return versions.sort(this.compareSemver).pop() as string;
  }

  private compareSemver(a: string, b: string): number {
    const parse = (value: string) => value.split(".").map((part) => Number(part) || 0);
    const aParts = parse(a);
    const bParts = parse(b);
    const length = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < length; i += 1) {
      const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  private shouldSkipVerify(): boolean {
    return process.env.SKIP_VERIFY === "1";
  }
}
