import fs from "node:fs/promises";
import path from "node:path";

import { downloadToFile } from "./downloader.ts";
import { extractArchive } from "./extract.ts";
import type { NodeConfig } from "../types.ts";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function moveDir(src: string, dst: string): Promise<void> {
  await fs.rm(dst, { recursive: true, force: true });
  try {
    await fs.rename(src, dst);
  } catch {
    await fs.cp(src, dst, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

function resolveSnapshotType(url: string): "zip" | "tar.gz" {
  const lower = url.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  return "zip";
}

export async function applySnapshot(node: NodeConfig, snapshotUrl: string): Promise<void> {
  const archiveType = resolveSnapshotType(snapshotUrl);
  const tmpDir = path.join(node.datadir, "_snapshot_tmp");
  const archivePath = path.join(node.datadir, `snapshot.${archiveType === "zip" ? "zip" : "tar.gz"}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  await downloadToFile(snapshotUrl, archivePath);
  await extractArchive(archivePath, tmpDir, archiveType);

  const blocksSrc = path.join(tmpDir, "blocks");
  const chainstateSrc = path.join(tmpDir, "chainstate");

  if (await pathExists(blocksSrc)) {
    await moveDir(blocksSrc, path.join(node.datadir, "blocks"));
  }

  if (await pathExists(chainstateSrc)) {
    await moveDir(chainstateSrc, path.join(node.datadir, "chainstate"));
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });
}
