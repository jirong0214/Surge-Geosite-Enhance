import fsp from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const buildRoot = process.env.BUILD_ROOT
  ? path.resolve(process.env.BUILD_ROOT)
  : path.resolve(new URL("..", import.meta.url).pathname);
const distDir = path.join(buildRoot, "dist");
const geositeDir = path.join(distDir, "geosite-json");
const geoipDir = path.join(distDir, "geoip-json");
const outputPath = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(buildRoot, "data.sqlite");

const reverseDomain = (value) => {
  const parts = value.trim().replace(/^\*\./, "").replace(/\.+$/, "").split(".").filter(Boolean);
  return parts.length ? parts.reverse().join(".") : null;
};

const ipv4Range = (cidr) => {
  const [address, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const value = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
  const block = 2 ** (32 - prefix);
  const start = Math.floor(value / block) * block;
  return { start, end: start + block - 1, prefix };
};

const expandIpv6 = (address) => {
  const [headText, tailText = ""] = address.toLowerCase().split("::");
  if (address.split("::").length > 2) return null;
  const parseParts = (text) => text ? text.split(":").filter(Boolean) : [];
  const head = parseParts(headText);
  const tail = parseParts(tailText);
  const missing = 8 - head.length - tail.length;
  if ((address.includes("::") && missing < 1) || (!address.includes("::") && missing !== 0)) return null;
  const parts = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => part.padStart(4, "0")).join("");
};

const ipv6Range = (cidr) => {
  const [address, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const hex = expandIpv6(address);
  if (!hex || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const value = BigInt(`0x${hex}`);
  const hostBits = 128n - BigInt(prefix);
  const mask = hostBits === 128n ? 0n : ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
  const start = value & mask;
  const end = start | ((1n << hostBits) - 1n);
  return {
    startHex: start.toString(16).padStart(32, "0"),
    endHex: end.toString(16).padStart(32, "0"),
    prefix,
  };
};

const jsonFiles = async (directory) =>
  (await fsp.readdir(directory)).filter((name) => name.endsWith(".json")).sort();

await fsp.mkdir(path.dirname(outputPath), { recursive: true });
await fsp.rm(outputPath, { force: true });

const db = new Database(outputPath);
db.pragma("journal_mode = OFF");
db.pragma("synchronous = OFF");
db.pragma("temp_store = MEMORY");
db.pragma("cache_size = -196608");
db.exec(`
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE geosite_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    rule_count INTEGER NOT NULL,
    attrs TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE geosite_rule (
    list_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    value_lower TEXT NOT NULL,
    value_rev TEXT,
    attrs TEXT NOT NULL,
    PRIMARY KEY (list_id, type, value),
    FOREIGN KEY (list_id) REFERENCES geosite_list(id)
  );
  CREATE TABLE geoip_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    cidr4_count INTEGER NOT NULL,
    cidr6_count INTEGER NOT NULL
  );
  CREATE TABLE geoip_cidr (
    list_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    cidr TEXT NOT NULL,
    cidr_lower TEXT NOT NULL,
    start_v4 INTEGER,
    end_v4 INTEGER,
    start_hex TEXT,
    end_hex TEXT,
    prefix INTEGER NOT NULL,
    PRIMARY KEY (list_id, version, cidr),
    FOREIGN KEY (list_id) REFERENCES geoip_list(id)
  );
`);

const insertSiteList = db.prepare("INSERT INTO geosite_list (name, rule_count, attrs) VALUES (?, ?, ?)");
const insertSiteRule = db.prepare(`
  INSERT INTO geosite_rule (list_id, type, value, value_lower, value_rev, attrs)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const importSite = db.transaction((data) => {
  const merged = new Map();
  for (const rule of data.rules || []) {
    const key = `${rule.type}\u0000${rule.value}`;
    const attrs = merged.get(key) || new Set();
    for (const attr of rule.attrs || []) attrs.add(String(attr).toLowerCase());
    merged.set(key, attrs);
  }
  const listAttrs = new Set();
  for (const attrs of merged.values()) for (const attr of attrs) listAttrs.add(attr);
  const info = insertSiteList.run(data.name, merged.size, JSON.stringify([...listAttrs].sort()));
  const listId = Number(info.lastInsertRowid);
  for (const [key, attrs] of merged) {
    const split = key.indexOf("\u0000");
    const type = key.slice(0, split);
    const value = key.slice(split + 1);
    insertSiteRule.run(listId, type, value, value.toLowerCase(), reverseDomain(value), JSON.stringify([...attrs].sort()));
  }
  return merged.size;
});

let siteRules = 0;
for (const file of await jsonFiles(geositeDir)) {
  const data = JSON.parse(await fsp.readFile(path.join(geositeDir, file), "utf8"));
  siteRules += importSite(data);
}
console.log(`Imported ${siteRules} geosite rules.`);

const insertIpList = db.prepare("INSERT INTO geoip_list (name, cidr4_count, cidr6_count) VALUES (?, ?, ?)");
const insertCidr = db.prepare(`
  INSERT OR IGNORE INTO geoip_cidr
    (list_id, version, cidr, cidr_lower, start_v4, end_v4, start_hex, end_hex, prefix)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const importIp = db.transaction((data) => {
  const cidr4 = [...new Set(data.cidr4 || [])];
  const cidr6 = [...new Set(data.cidr6 || [])];
  const info = insertIpList.run(data.name, cidr4.length, cidr6.length);
  const listId = Number(info.lastInsertRowid);
  for (const cidr of cidr4) {
    const range = ipv4Range(cidr);
    if (range) insertCidr.run(listId, 4, cidr, cidr.toLowerCase(), range.start, range.end, null, null, range.prefix);
  }
  for (const cidr of cidr6) {
    const range = ipv6Range(cidr);
    if (range) insertCidr.run(listId, 6, cidr, cidr.toLowerCase(), null, null, range.startHex, range.endHex, range.prefix);
  }
  return cidr4.length + cidr6.length;
});

let ipCidrs = 0;
for (const file of await jsonFiles(geoipDir)) {
  const data = JSON.parse(await fsp.readFile(path.join(geoipDir, file), "utf8"));
  ipCidrs += importIp(data);
}
console.log(`Imported ${ipCidrs} GeoIP CIDRs.`);

console.log("Building SQLite indexes and FTS5 search data...");
db.exec(`
  CREATE INDEX geosite_rule_value_idx ON geosite_rule(value_lower);
  CREATE INDEX geosite_rule_type_idx ON geosite_rule(type, value_lower);
  CREATE INDEX geosite_rule_list_idx ON geosite_rule(list_id);
  CREATE INDEX geosite_rule_rev_idx ON geosite_rule(value_rev);
  CREATE VIRTUAL TABLE geosite_rule_fts USING fts5(
    value, value_rev, attrs, list_name,
    list_id UNINDEXED, type UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO geosite_rule_fts(rowid, value, value_rev, attrs, list_name, list_id, type)
    SELECT r.rowid, r.value, COALESCE(r.value_rev, ''), r.attrs, l.name, r.list_id, r.type
    FROM geosite_rule r JOIN geosite_list l ON l.id = r.list_id;
  CREATE INDEX geoip_cidr_v4_idx ON geoip_cidr(version, start_v4, end_v4);
  CREATE INDEX geoip_cidr_v6_idx ON geoip_cidr(version, start_hex, end_hex);
  CREATE INDEX geoip_cidr_list_idx ON geoip_cidr(list_id);
  CREATE INDEX geoip_cidr_lower_idx ON geoip_cidr(cidr_lower);
  INSERT INTO schema_meta (key, value) VALUES ('d1_schema_version', '2');
  PRAGMA user_version = 2;
  ANALYZE;
`);
db.pragma("optimize");
db.close();

const stat = await fsp.stat(outputPath);
console.log(`SQLite database written to ${outputPath} (${(stat.size / 1024 / 1024).toFixed(1)} MiB).`);
