export type PlatformKey =
  | "win32-x64"
  | "linux-x64"
  | "linux-arm"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64";

export type ArchiveType = "zip" | "tar.gz";

export interface ChainReleaseAsset {
  url: string;
  sha256: string;
  archive: ArchiveType;
}

export interface ChainPlugin {
  id: string;
  name: string;
  symbol: string;
  daemon: {
    win32: string;
    linux: string;
    darwin?: string;
  };
  defaultPorts: {
    p2p: number;
    rpc: number;
  };
  releases: Record<string, Partial<Record<PlatformKey, ChainReleaseAsset>>>;
  config: (node: NodeConfig) => string;
  rpc: {
    stop: string;
    blockCount: string;
    masternodeStatus?: string;
  };
}

export interface NodeConfig {
  id: string;
  chain: string;
  datadir: string;
  p2pPort: number;
  rpcPort: number;
  rpcUser: string;
  rpcPassword: string;
  masternodeKey: string;
  externalIp: string;
  snapshotUrl?: string;
  coreVersion?: string;
  daemonPath?: string;
  createdAt: string;
}

export interface NodeCreateInput {
  id: string;
  chain: string;
  externalIp: string;
  masternodeKey: string;
  p2pPort?: number;
  rpcPort?: number;
  snapshotUrl?: string;
  coreVersion?: string;
}
