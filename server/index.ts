import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import app from "../worker/index";

const dataRoot = path.resolve(process.env.DATA_ROOT || "/data");
const currentRoot = path.join(dataRoot, "current");
const cacheRoot = path.join(dataRoot, "cache");
const databasePath = path.join(currentRoot, "data.sqlite");
const port = Number(process.env.PORT || 8787);

class LocalObjectBody {
  body: Uint8Array;
  etag: string;

  constructor(private readonly filePath: string, body: Buffer, stat: fs.Stats) {
    this.body = body;
    this.etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  }

  async arrayBuffer() {
    return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.byteLength);
  }

  async json() {
    return JSON.parse(this.body.toString("utf8"));
  }
}

class LocalBucket {
  private resolve(key: string) {
    const normalized = path.posix.normalize(`/${key}`).slice(1);
    if (normalized.startsWith("../") || normalized.includes("/../")) throw new Error("Invalid object key");
    if (normalized === "geosite/index.json") return path.join(currentRoot, "index.json");
    if (normalized === "geoip/index.json") return path.join(currentRoot, "geoip-index.json");
    if (normalized.startsWith("geosite-json/")) return path.join(currentRoot, "dist", normalized);
    if (normalized.startsWith("geoip-json/")) return path.join(currentRoot, "dist", normalized);
    if (normalized.startsWith("geosite/")) {
      const name = path.basename(normalized);
      return path.join(currentRoot, "dist", name.endsWith(".mrs") ? "mrs" : "srs", name);
    }
    if (normalized.startsWith("geoip/")) {
      const name = path.basename(normalized);
      return path.join(currentRoot, "dist", name.endsWith(".mrs") ? "mrs-geoip" : "srs-geoip", name);
    }
    return path.join(currentRoot, "dist", normalized);
  }

  async get(key: string) {
    const filePath = this.resolve(key);
    try {
      const [body, stat] = await Promise.all([fsp.readFile(filePath), fsp.stat(filePath)]);
      return new LocalObjectBody(filePath, body, stat);
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
}

class LocalKv {
  private fileFor(key: string) {
    return path.join(cacheRoot, `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
  }

  async get(key: string, options?: { type?: string }) {
    try {
      const envelope = JSON.parse(await fsp.readFile(this.fileFor(key), "utf8"));
      if (envelope.expiresAt && envelope.expiresAt <= Date.now()) {
        await fsp.rm(this.fileFor(key), { force: true });
        return null;
      }
      return options?.type === "json" ? JSON.parse(envelope.value) : envelope.value;
    } catch (error: any) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    await fsp.mkdir(cacheRoot, { recursive: true });
    const filePath = this.fileFor(key);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    const envelope = {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    };
    await fsp.writeFile(tempPath, JSON.stringify(envelope));
    await fsp.rename(tempPath, filePath);
  }
}

class LocalD1 {
  private db: Database.Database | null = null;
  private inode: number | null = null;

  private open() {
    const stat = fs.statSync(databasePath);
    if (!this.db || this.inode !== stat.ino) {
      this.db?.close();
      this.db = new Database(databasePath, { readonly: true, fileMustExist: true });
      this.db.pragma("query_only = ON");
      this.db.pragma("cache_size = -131072");
      this.inode = stat.ino;
      console.log(`Opened SQLite data version at ${fs.realpathSync(databasePath)}`);
    }
    return this.db;
  }

  prepare(sql: string) {
    let params: unknown[] = [];
    return {
      bind: (...values: unknown[]) => {
        params = values;
        return this.prepareBound(sql, params);
      },
      all: () => this.prepareBound(sql, params).all(),
    };
  }

  private prepareBound(sql: string, params: unknown[]) {
    return {
      all: async () => ({ results: this.open().prepare(sql).all(...params as any[]) }),
    };
  }
}

await fsp.mkdir(cacheRoot, { recursive: true });
if (!fs.existsSync(databasePath)) {
  throw new Error(`Data is not initialized: ${databasePath} does not exist`);
}

const env = {
  SRS_BUCKET: new LocalBucket(),
  GEO_KV: new LocalKv(),
  DB: new LocalD1(),
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PUBLIC_PORT || 8080}`,
};

const executionCtx = {
  waitUntil(promise: Promise<unknown>) {
    void promise.catch((error) => console.error("Background task failed:", error));
  },
  passThroughOnException() {},
};

const server = serve({
  port,
  fetch: (request) => app.fetch(request, env as any, executionCtx as any),
});

console.log(`Surge Geosite API listening on 0.0.0.0:${port}`);

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
