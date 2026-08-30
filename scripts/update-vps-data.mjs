import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const dataRoot = path.resolve(process.env.DATA_ROOT || "/data");
const versionsDir = path.join(dataRoot, "versions");
const currentLink = path.join(dataRoot, "current");
const keepVersions = Math.max(1, Number(process.env.KEEP_DATA_VERSIONS || 2));
const buildBinaries = !["0", "false", "no"].includes(String(process.env.BUILD_BINARY_RULESETS || "true").toLowerCase());
const args = new Set(process.argv.slice(2));

const sources = {
  geosite: "https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat",
  geoip: "https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat",
};

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const parseUpdateTime = () => {
  const value = String(process.env.UPDATE_TIME || "06:30").trim();
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  if (!match) throw new Error(`Invalid UPDATE_TIME: ${value}. Expected HH:MM (00:00-23:59).`);
  const [hour, minute] = value.split(":").map(Number);
  return { value, hour, minute };
};

const validateTimeZone = () => {
  const value = process.env.TZ || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid TZ time zone: ${value}.`);
  }
  return value;
};

const nextScheduledRun = (hour, minute, now = new Date()) => {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
};

const formatLocalTime = (date, timeZone) => {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${formatted} (${timeZone})`;
};

const run = (command, commandArgs, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, commandArgs, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
});

const readCurrentMetadata = async () => {
  try {
    return JSON.parse(await fsp.readFile(path.join(currentLink, "metadata.json"), "utf8"));
  } catch {
    return null;
  }
};

const download = async (url) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};

const cleanCompilerSources = async (directory) => {
  try {
    for (const name of await fsp.readdir(directory)) {
      if (name.startsWith(".")) await fsp.rm(path.join(directory, name), { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const activate = async (versionPath) => {
  const nextLink = path.join(dataRoot, `.current-${process.pid}`);
  await fsp.rm(nextLink, { force: true });
  await fsp.symlink(path.relative(dataRoot, versionPath), nextLink);
  await fsp.rename(nextLink, currentLink);
};

const cleanupVersions = async () => {
  const names = (await fsp.readdir(versionsDir)).filter((name) => !name.startsWith(".")).sort().reverse();
  for (const name of names.slice(keepVersions)) {
    await fsp.rm(path.join(versionsDir, name), { recursive: true, force: true });
  }
};

const updateOnce = async ({ onlyIfMissing = false } = {}) => {
  await fsp.mkdir(versionsDir, { recursive: true });
  const current = await readCurrentMetadata();
  if (onlyIfMissing && current) {
    console.log(`Data version ${current.version} is already initialized.`);
    return false;
  }

  console.log("Downloading current GeoSite and GeoIP sources...");
  const [geosite, geoip] = await Promise.all([download(sources.geosite), download(sources.geoip)]);
  const hashes = { geosite: sha256(geosite), geoip: sha256(geoip) };
  if (current?.sourceHashes?.geosite === hashes.geosite && current?.sourceHashes?.geoip === hashes.geoip) {
    console.log("Sources are unchanged; keeping the current data version.");
    return false;
  }

  const version = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const staging = path.join(versionsDir, `.building-${version}-${process.pid}`);
  const finalPath = path.join(versionsDir, version);
  const sourceDir = path.join(staging, "sources");
  await fsp.mkdir(sourceDir, { recursive: true });
  const geositePath = path.join(sourceDir, "geosite.dat");
  const geoipPath = path.join(sourceDir, "geoip.dat");
  await Promise.all([fsp.writeFile(geositePath, geosite), fsp.writeFile(geoipPath, geoip)]);

  const buildEnv = {
    BUILD_ROOT: staging,
    GEO_DAT_PATH: geositePath,
    GEOIP_DAT_PATH: geoipPath,
    SRS_CONCURRENCY: process.env.SRS_CONCURRENCY || "2",
    MRS_CONCURRENCY: process.env.MRS_CONCURRENCY || "2",
  };

  try {
    await run("node", ["scripts/build-geosite-json.mjs"], buildEnv);
    await run("node", ["scripts/build-geoip-json.mjs"], buildEnv);
    await run("node", ["scripts/build-sqlite.mjs"], buildEnv);
    if (buildBinaries) {
      await run("node", ["scripts/build-srs.mjs"], buildEnv);
      await run("node", ["scripts/build-geoip-srs.mjs"], buildEnv);
      await run("node", ["scripts/build-mrs.mjs"], buildEnv);
      await run("node", ["scripts/build-mrs-geoip.mjs"], buildEnv);
      await Promise.all([
        cleanCompilerSources(path.join(staging, "dist", "srs")),
        cleanCompilerSources(path.join(staging, "dist", "srs-geoip")),
        cleanCompilerSources(path.join(staging, "dist", "mrs")),
        cleanCompilerSources(path.join(staging, "dist", "mrs-geoip")),
      ]);
    }

    const metadata = {
      version,
      generatedAt: new Date().toISOString(),
      sourceHashes: hashes,
      binaryRulesets: buildBinaries,
    };
    await fsp.writeFile(path.join(staging, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await fsp.rename(staging, finalPath);
    await activate(finalPath);
    await cleanupVersions();
    console.log(`Activated data version ${version}.`);
    return true;
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
};

if (args.has("--loop")) {
  const schedule = parseUpdateTime();
  const timeZone = validateTimeZone();
  await updateOnce({ onlyIfMissing: true });
  while (true) {
    const nextRun = nextScheduledRun(schedule.hour, schedule.minute);
    const waitMilliseconds = nextRun.getTime() - Date.now();
    console.log(`Updater schedule enabled for ${schedule.value}; next check at ${formatLocalTime(nextRun, timeZone)}.`);
    await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
    try {
      await updateOnce();
    } catch (error) {
      console.error("Scheduled update failed:", error);
    }
  }
} else {
  await updateOnce({ onlyIfMissing: args.has("--if-missing") });
}
