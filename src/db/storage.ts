import fs from "node:fs/promises";
import path from "node:path";
import { Sequelize, DataTypes, Model, Op, type ModelCtor } from "sequelize";
import type { NodeConfig } from "../types.js";

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
}

export class SequelizeStorage {
  private sequelize: Sequelize;
  private User: ModelCtor<Model<any, any>>;
  private Node: ModelCtor<Model<any, any>>;
  private storagePath: string;

  constructor(dbPath: string) {
    this.storagePath = dbPath;
    this.sequelize = new Sequelize({
      dialect: "sqlite",
      storage: dbPath,
      logging: false
    });

    this.User = this.sequelize.define(
      "User",
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        username: { type: DataTypes.STRING, allowNull: false, unique: true },
        passwordHash: { type: DataTypes.STRING, allowNull: false }
      },
      { tableName: "users" }
    );

    this.Node = this.sequelize.define(
      "Node",
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        nodeId: { type: DataTypes.STRING, allowNull: false },
        userId: { type: DataTypes.INTEGER, allowNull: false },
        chain: { type: DataTypes.STRING, allowNull: false },
        datadir: { type: DataTypes.STRING, allowNull: false },
        p2pPort: { type: DataTypes.INTEGER, allowNull: false },
        rpcPort: { type: DataTypes.INTEGER, allowNull: false },
        rpcUser: { type: DataTypes.STRING, allowNull: false },
        rpcPassword: { type: DataTypes.STRING, allowNull: false },
        masternodeKey: { type: DataTypes.STRING, allowNull: false },
        externalIp: { type: DataTypes.STRING, allowNull: false },
        snapshotUrl: { type: DataTypes.STRING, allowNull: true },
        coreVersion: { type: DataTypes.STRING, allowNull: true },
        daemonPath: { type: DataTypes.STRING, allowNull: true }
      },
      {
        tableName: "nodes",
        indexes: [{ unique: true, fields: ["userId", "nodeId"] }]
      }
    );
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await this.sequelize.authenticate();
    await this.sequelize.sync();
  }

  async createUser(username: string, passwordHash: string): Promise<UserRecord> {
    const user = await (this.User as any).create({ username, passwordHash });
    return user.get({ plain: true }) as UserRecord;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const user = await (this.User as any).findOne({ where: { username } });
    return user ? (user.get({ plain: true }) as UserRecord) : null;
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    const user = await (this.User as any).findByPk(id);
    return user ? (user.get({ plain: true }) as UserRecord) : null;
  }

  async listNodes(userId: number): Promise<NodeConfig[]> {
    const rows = await (this.Node as any).findAll({ where: { userId } });
    return rows.map((row: any) => this.toNodeConfig(row));
  }

  async listAllNodes(): Promise<NodeConfig[]> {
    const rows = await (this.Node as any).findAll();
    return rows.map((row: any) => this.toNodeConfig(row));
  }

  async getNode(userId: number, nodeId: string): Promise<NodeConfig> {
    const row = await (this.Node as any).findOne({ where: { userId, nodeId } });
    if (!row) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    return this.toNodeConfig(row);
  }

  async addNode(userId: number, node: NodeConfig): Promise<void> {
    await (this.Node as any).create({
      nodeId: node.id,
      userId,
      chain: node.chain,
      datadir: node.datadir,
      p2pPort: node.p2pPort,
      rpcPort: node.rpcPort,
      rpcUser: node.rpcUser,
      rpcPassword: node.rpcPassword,
      masternodeKey: node.masternodeKey,
      externalIp: node.externalIp,
      snapshotUrl: node.snapshotUrl ?? null,
      coreVersion: node.coreVersion ?? null,
      daemonPath: node.daemonPath ?? null
    });
  }

  async updateNode(userId: number, nodeId: string, updates: Partial<NodeConfig>): Promise<void> {
    const payload: Record<string, any> = {};
    const assign = (key: string, value: any) => {
      if (value !== undefined) payload[key] = value;
    };

    assign("chain", updates.chain);
    assign("datadir", updates.datadir);
    assign("p2pPort", updates.p2pPort);
    assign("rpcPort", updates.rpcPort);
    assign("rpcUser", updates.rpcUser);
    assign("rpcPassword", updates.rpcPassword);
    assign("masternodeKey", updates.masternodeKey);
    assign("externalIp", updates.externalIp);
    if (updates.snapshotUrl !== undefined) payload.snapshotUrl = updates.snapshotUrl ?? null;
    if (updates.coreVersion !== undefined) payload.coreVersion = updates.coreVersion ?? null;
    if (updates.daemonPath !== undefined) payload.daemonPath = updates.daemonPath ?? null;

    await (this.Node as any).update(payload, { where: { userId, nodeId } });
  }

  async removeNode(userId: number, nodeId: string): Promise<void> {
    await (this.Node as any).destroy({ where: { userId, nodeId } });
  }

  async nodeExists(userId: number, nodeId: string): Promise<boolean> {
    const count = await (this.Node as any).count({ where: { userId, nodeId } });
    return count > 0;
  }

  async nodeIdInUse(nodeId: string): Promise<boolean> {
    const count = await (this.Node as any).count({ where: { nodeId } });
    return count > 0;
  }

  async portsInUse(ports: number[]): Promise<number[]> {
    const rows = await (this.Node as any).findAll({
      where: {
        [Op.or]: [{ p2pPort: { [Op.in]: ports } }, { rpcPort: { [Op.in]: ports } }]
      },
      attributes: ["p2pPort", "rpcPort"]
    });

    const used = new Set<number>();
    for (const row of rows) {
      used.add(row.get("p2pPort"));
      used.add(row.get("rpcPort"));
    }
    return Array.from(used);
  }

  private toNodeConfig(row: any): NodeConfig {
    return {
      id: row.get("nodeId"),
      chain: row.get("chain"),
      datadir: row.get("datadir"),
      p2pPort: row.get("p2pPort"),
      rpcPort: row.get("rpcPort"),
      rpcUser: row.get("rpcUser"),
      rpcPassword: row.get("rpcPassword"),
      masternodeKey: row.get("masternodeKey"),
      externalIp: row.get("externalIp"),
      snapshotUrl: row.get("snapshotUrl") ?? undefined,
      coreVersion: row.get("coreVersion") ?? undefined,
      daemonPath: row.get("daemonPath") ?? undefined,
      createdAt: row.get("createdAt").toISOString()
    };
  }
}
