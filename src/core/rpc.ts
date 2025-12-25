import type { NodeConfig } from "../types.js";

export async function rpcCall<T = any>(
  node: Pick<NodeConfig, "rpcPort" | "rpcUser" | "rpcPassword">,
  method: string,
  params: unknown[] = []
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${node.rpcPort}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization:
        "Basic " + Buffer.from(`${node.rpcUser}:${node.rpcPassword}`).toString("base64")
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "mn-manager", method, params })
  });

  if (!res.ok) {
    throw new Error(`RPC error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { result: T; error?: { message?: string } };
  if (json.error) {
    throw new Error(json.error.message ?? "RPC error");
  }

  return json.result;
}
