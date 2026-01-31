#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const CWD = process.cwd();
const DEFAULT_CONFIG_NAME = "warden.config.json";
const DEFAULT_CONFIG_PATH = path.join(CWD, DEFAULT_CONFIG_NAME);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.join(os.tmpdir(), "openclaw-warden");
const DAEMON_PID = path.join(DAEMON_DIR, "warden.pid");
const DAEMON_LOG = path.join(DAEMON_DIR, "warden.log");

function resolveGlobalConfigDir() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "openclaw-warden",
    );
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "openclaw-warden");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "openclaw-warden");
}

function resolveConfigPath() {
  if (process.env.WARDEN_CONFIG) return process.env.WARDEN_CONFIG;
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) return DEFAULT_CONFIG_PATH;
  return path.join(resolveGlobalConfigDir(), DEFAULT_CONFIG_NAME);
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid() {
  try {
    const raw = await fsp.readFile(DAEMON_PID, "utf8");
    const pid = Number(raw.trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function writePid(pid) {
  await ensureDir(path.dirname(DAEMON_PID));
  await fsp.writeFile(DAEMON_PID, `${pid}\n`, "utf8");
}

async function clearPid() {
  try {
    await fsp.unlink(DAEMON_PID);
  } catch {
    // ignore
  }
}

function getDefaultConfig() {
  return {
    paths: {
      repoConfig: "./config/openclaw.json",
      liveConfig: "~/.openclaw/openclaw.json",
      schemaFile: "./state/schema.json",
    },
    schema: {
      source: "git",
      repoUrl: "https://github.com/openclaw/openclaw.git",
      ref: "main",
      checkoutDir: "./state/openclaw",
      useLocalDeps: true,
      exportCommand:
        "node --import tsx -e \"import { buildConfigSchema } from './src/config/schema.ts'; console.log(JSON.stringify(buildConfigSchema(), null, 2));\"",
    },
    git: {
      enabled: true,
      autoInit: true,
    },
    heartbeat: {
      intervalMinutes: 5,
      waitSeconds: [30, 40, 50],
      checkCommand: "node ./src/check-health.js",
      agentProbe: {
        enabled: true,
        fallbackAgentId: "main",
        command: "node ./src/check-agent-probe.js",
      },
      notifyOnRestart: true,
      notifyCommand:
        'openclaw agent --agent {agentId} -m "[warden] gateway restarted after failed health check" --channel last --deliver',
      restartCommand: "openclaw gateway restart",
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

let logFilePath = null;

async function appendLog(line) {
  if (!logFilePath) return;
  try {
    await ensureDir(path.dirname(logFilePath));
    await fsp.appendFile(logFilePath, `${line}\n`, "utf8");
  } catch {
    // Swallow log file errors to avoid breaking the monitor loop.
  }
}

function logInfo(msg) {
  const line = `[${nowIso()}] ${msg}`;
  console.log(line);
  void appendLog(line);
}

function logWarn(msg) {
  const line = `[${nowIso()}] WARN: ${msg}`;
  console.warn(line);
  void appendLog(line);
}

function logError(msg) {
  const line = `[${nowIso()}] ERROR: ${msg}`;
  console.error(line);
  void appendLog(line);
}

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolvePath(inputPath) {
  if (!inputPath) return inputPath;
  const expanded = expandHome(inputPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(CWD, expanded);
}

function resolvePathWithBase(inputPath, baseDir) {
  if (!inputPath) return inputPath;
  const expanded = expandHome(inputPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  const data = JSON.stringify(value, null, 2);
  await fsp.writeFile(filePath, data, "utf8");
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function fileSha256(filePath) {
  const data = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function formatCmd(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

function buildCommand(template, config, extraVars) {
  const configDir = path.dirname(config.__configPath || DEFAULT_CONFIG_PATH);
  const repoConfigPath = resolvePathWithBase(
    config.paths.repoConfig,
    configDir,
  );
  const liveConfigPath = resolvePathWithBase(
    config.paths.liveConfig,
    configDir,
  );
  const healthCachePath = path.join(
    os.tmpdir(),
    "openclaw-warden",
    "health.json",
  );
  let healthCache = null;
  if (fs.existsSync(healthCachePath)) {
    try {
      const raw = fs.readFileSync(healthCachePath, "utf8");
      healthCache = JSON.parse(raw);
    } catch {
      healthCache = null;
    }
  }
  const baseVars = {
    repoConfig: repoConfigPath,
    liveConfig: liveConfigPath,
    target: config.heartbeat?.target ?? "",
    agentId:
      healthCache?.agentId ??
      config.heartbeat?.agentProbe?.fallbackAgentId ??
      "",
    sessionId: healthCache?.sessionId ?? "",
    sessionKey: healthCache?.sessionKey ?? "",
  };
  return formatCmd(template, { ...baseVars, ...extraVars });
}

async function execShell(command, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd || CWD,
      env: options.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function loadConfig() {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const config = await readJson(configPath);
  config.__configPath = configPath;
  if (config?.logging?.file) {
    logFilePath = resolvePath(config.logging.file);
  } else {
    logFilePath = DAEMON_LOG;
  }
  return {
    config,
    configPath,
  };
}

async function daemonStart() {
  const existingPid = await readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    logInfo(`Daemon already running (pid ${existingPid}).`);
    return;
  }
  await ensureDir(DAEMON_DIR);
  const out = fs.openSync(DAEMON_LOG, "a");
  const err = fs.openSync(DAEMON_LOG, "a");
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "run"],
    {
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, WARDEN_DAEMON: "1" },
    },
  );
  await writePid(child.pid);
  child.unref();
  logInfo(`Daemon started (pid ${child.pid}).`);
}

async function daemonStop() {
  const pid = await readPid();
  if (!pid) {
    logWarn("Daemon pid not found.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    logWarn(`Failed to stop daemon: ${String(err)}`);
  }
  await clearPid();
  logInfo(`Daemon stopped (pid ${pid}).`);
}

async function daemonStatus() {
  const pid = await readPid();
  if (pid && isProcessAlive(pid)) {
    logInfo(`Daemon running (pid ${pid}).`);
  } else {
    logInfo("Daemon not running.");
  }
}

function resolveWardenCommand() {
  if (process.env.WARDEN_COMMAND) return process.env.WARDEN_COMMAND;
  return "openclaw-warden";
}

function renderSystemdService(configPath) {
  const execCmd = resolveWardenCommand();
  return `[Unit]
Description=OpenClaw Warden
After=network.target

[Service]
Type=simple
Environment=WARDEN_CONFIG=${configPath}
ExecStart=${execCmd} run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function renderLaunchdService(configPath) {
  const execCmd = resolveWardenCommand();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.openclaw.warden</string>
    <key>ProgramArguments</key>
    <array>
      <string>${execCmd}</string>
      <string>run</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>WARDEN_CONFIG</key>
      <string>${configPath}</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${DAEMON_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${DAEMON_LOG}</string>
  </dict>
</plist>
`;
}

function renderWindowsTask(configPath) {
  const execCmd = resolveWardenCommand();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Name>OpenClawWarden</Name>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${execCmd}</Command>
      <Arguments>run</Arguments>
      <WorkingDirectory>${path.dirname(configPath)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function ensureDefaultConfig({ scope } = {}) {
  const configPath =
    scope === "global"
      ? path.join(resolveGlobalConfigDir(), DEFAULT_CONFIG_NAME)
      : DEFAULT_CONFIG_PATH;
  if (fs.existsSync(configPath)) {
    return configPath;
  }
  await ensureDir(path.dirname(configPath));
  await writeJson(configPath, getDefaultConfig());
  logInfo(`Created default config: ${configPath}`);
  return configPath;
}

async function ensureGitRepo(repoDir, autoInit) {
  const gitDir = path.join(repoDir, ".git");
  if (fs.existsSync(gitDir)) return true;
  if (!autoInit) return false;
  const res = await execShell("git init", { cwd: repoDir });
  if (res.code !== 0) {
    logWarn(`git init failed: ${res.stderr.trim()}`);
    return false;
  }
  return true;
}

async function gitCommitIfChanged(repoDir, files, message) {
  const status = await execShell("git status --porcelain", { cwd: repoDir });
  if (status.code !== 0) {
    logWarn(`git status failed: ${status.stderr.trim()}`);
    return;
  }
  const changed = status.stdout
    .split("\n")
    .filter(Boolean)
    .some((line) => files.some((file) => line.includes(file)));
  if (!changed) return;

  const addCmd = `git add ${files.map((f) => `"${f}"`).join(" ")}`;
  const addRes = await execShell(addCmd, { cwd: repoDir });
  if (addRes.code !== 0) {
    logWarn(`git add failed: ${addRes.stderr.trim()}`);
    return;
  }
  const commitRes = await execShell(`git commit -m "${message}"`, {
    cwd: repoDir,
  });
  if (commitRes.code !== 0) {
    logWarn(`git commit failed: ${commitRes.stderr.trim()}`);
  }
}

async function loadSchema(schemaPath) {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}`);
  }
  const schema = await readJson(schemaPath);
  return schema;
}

function extractSchemaFromCommandOutput(raw) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (data && typeof data === "object") {
    if (data.schema) return data.schema;
    if (data.payload && data.payload.schema) return data.payload.schema;
    if (data.result && data.result.schema) return data.result.schema;
  }
  return data;
}

async function ensureGitCheckout(schemaConfig) {
  const repoUrl = schemaConfig.repoUrl;
  const ref = schemaConfig.ref || "main";
  const checkoutDir = resolvePath(
    schemaConfig.checkoutDir || "./state/openclaw",
  );
  await ensureDir(path.dirname(checkoutDir));

  if (!fs.existsSync(checkoutDir)) {
    const cloneCmd = `git clone --filter=blob:none ${repoUrl} \"${checkoutDir}\"`;
    logInfo(`Cloning OpenClaw: ${cloneCmd}`);
    const cloneRes = await execShell(cloneCmd);
    if (cloneRes.code !== 0) {
      throw new Error(`git clone failed: ${cloneRes.stderr.trim()}`);
    }
  }

  const fetchRes = await execShell("git fetch --all --prune", {
    cwd: checkoutDir,
  });
  if (fetchRes.code !== 0) {
    throw new Error(`git fetch failed: ${fetchRes.stderr.trim()}`);
  }

  const checkoutRes = await execShell(`git checkout ${ref}`, {
    cwd: checkoutDir,
  });
  if (checkoutRes.code !== 0) {
    throw new Error(`git checkout failed: ${checkoutRes.stderr.trim()}`);
  }

  return checkoutDir;
}

async function maybeInstallDeps(schemaConfig, cwd) {
  const installCommand = schemaConfig.installCommand;
  if (!installCommand) return;

  const nodeModulesDir = path.join(cwd, "node_modules");
  const lockfilePath = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
    ? path.join(cwd, "pnpm-lock.yaml")
    : fs.existsSync(path.join(cwd, "package-lock.json"))
      ? path.join(cwd, "package-lock.json")
      : fs.existsSync(path.join(cwd, "yarn.lock"))
        ? path.join(cwd, "yarn.lock")
        : null;
  const hashStampPath = path.join(cwd, ".warden-lockhash");

  let needsInstall = !fs.existsSync(nodeModulesDir);
  if (!needsInstall && lockfilePath) {
    try {
      const currentHash = await fileSha256(lockfilePath);
      const savedHash = fs.existsSync(hashStampPath)
        ? (await fsp.readFile(hashStampPath, "utf8")).trim()
        : "";
      if (!savedHash || savedHash !== currentHash) {
        needsInstall = true;
      }
    } catch (err) {
      logWarn(`Lockfile hash check failed: ${String(err)}`);
      needsInstall = true;
    }
  }

  if (!needsInstall) return;

  logInfo(`Installing OpenClaw deps: ${installCommand}`);
  const res = await execShell(installCommand, { cwd });
  if (res.code !== 0) {
    throw new Error(`Install failed: ${res.stderr.trim()}`);
  }

  if (lockfilePath) {
    try {
      const currentHash = await fileSha256(lockfilePath);
      await fsp.writeFile(hashStampPath, `${currentHash}\n`, "utf8");
    } catch (err) {
      logWarn(`Failed to write lockfile hash: ${String(err)}`);
    }
  }
}

function buildNodePathEnv(extraNodePath) {
  const delimiter = path.delimiter;
  const current = process.env.NODE_PATH || "";
  const parts = [extraNodePath, current].filter(Boolean);
  return parts.join(delimiter);
}

async function updateSchema(config) {
  const configDir = path.dirname(config.__configPath || DEFAULT_CONFIG_PATH);
  const schemaPath = resolvePathWithBase(config.paths.schemaFile, configDir);
  await ensureDir(path.dirname(schemaPath));
  const schemaCfg = config.schema || {};
  const source = schemaCfg.source || "command";

  let cwd = CWD;
  let command = schemaCfg.command;
  let execEnv = process.env;

  if (source === "git") {
    if (!schemaCfg.repoUrl) {
      throw new Error("schema.repoUrl is required when schema.source=git");
    }
    cwd = await ensureGitCheckout({
      ...schemaCfg,
      checkoutDir: resolvePathWithBase(schemaCfg.checkoutDir, configDir),
    });
    const useLocalDeps = Boolean(schemaCfg.useLocalDeps);
    if (!useLocalDeps) {
      await maybeInstallDeps(schemaCfg, cwd);
    } else {
      let localNodePath = null;
      if (schemaCfg.nodePath) {
        const cwdNodePath = resolvePath(schemaCfg.nodePath);
        if (fs.existsSync(cwdNodePath)) {
          localNodePath = cwdNodePath;
        } else {
          const scriptNodePath = path.resolve(
            SCRIPT_DIR,
            "..",
            schemaCfg.nodePath,
          );
          if (fs.existsSync(scriptNodePath)) {
            localNodePath = scriptNodePath;
          }
        }
      }
      if (!localNodePath) {
        localNodePath = path.resolve(SCRIPT_DIR, "..", "node_modules");
      }
      execEnv = {
        ...process.env,
        NODE_PATH: buildNodePathEnv(localNodePath),
      };
    }
    command = schemaCfg.exportCommand;
    if (!command) {
      throw new Error(
        "schema.exportCommand is required when schema.source=git",
      );
    }
  } else {
    cwd = schemaCfg.cwd ? resolvePath(schemaCfg.cwd) : CWD;
    if (!command) {
      throw new Error("schema.command is required in warden.config.json");
    }
  }

  logInfo(`Running schema command: ${command}`);
  const res = await execShell(command, { cwd, env: execEnv });
  if (res.code !== 0) {
    throw new Error(`Schema command failed: ${res.stderr.trim()}`);
  }
  const schema = extractSchemaFromCommandOutput(res.stdout.trim());
  if (!schema || typeof schema !== "object") {
    throw new Error("Failed to parse schema JSON from command output");
  }
  await writeJson(schemaPath, schema);
  logInfo(`Schema updated: ${schemaPath}`);
}

async function validateConfig(config) {
  const configDir = path.dirname(config.__configPath || DEFAULT_CONFIG_PATH);
  const repoConfigPath = resolvePathWithBase(
    config.paths.repoConfig,
    configDir,
  );
  const schemaPath = resolvePathWithBase(config.paths.schemaFile, configDir);
  const raw = await fsp.readFile(repoConfigPath, "utf8");
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err && err.message) || String(err)}`);
  }
  const schema = await loadSchema(schemaPath);
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(json);
  if (!ok) {
    const errors = (validate.errors || []).map((e) => {
      const at = e.instancePath || e.schemaPath || "";
      return `- ${at} ${e.message || "invalid"}`;
    });
    const detail = errors.join("\n");
    throw new Error(`Schema validation failed:\n${detail}`);
  }
  return true;
}

async function atomicCopy(srcPath, destPath) {
  const dir = path.dirname(destPath);
  await ensureDir(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(destPath)}.tmp-${Date.now()}`,
  );
  await fsp.copyFile(srcPath, tempPath);
  await fsp.rename(tempPath, destPath);
}

async function syncPull(config) {
  const configDir = path.dirname(config.__configPath || DEFAULT_CONFIG_PATH);
  const repoConfigPath = resolvePathWithBase(
    config.paths.repoConfig,
    configDir,
  );
  const repoRoot = path.dirname(repoConfigPath);
  const liveConfigPath = resolvePathWithBase(
    config.paths.liveConfig,
    configDir,
  );
  if (!fs.existsSync(liveConfigPath)) {
    throw new Error(`Live config not found: ${liveConfigPath}`);
  }
  await ensureDir(path.dirname(repoConfigPath));
  await fsp.copyFile(liveConfigPath, repoConfigPath);
  logInfo(`Pulled live config -> repo: ${repoConfigPath}`);

  if (config.git?.enabled) {
    const gitReady = await ensureGitRepo(
      repoRoot,
      Boolean(config.git?.autoInit),
    );
    if (gitReady) {
      await gitCommitIfChanged(
        repoRoot,
        [path.relative(repoRoot, repoConfigPath)],
        `sync pull ${nowIso()}`,
      );
    }
  }
}

async function syncPush(config) {
  const configDir = path.dirname(config.__configPath || DEFAULT_CONFIG_PATH);
  const repoConfigPath = resolvePathWithBase(
    config.paths.repoConfig,
    configDir,
  );
  const repoRoot = path.dirname(repoConfigPath);
  const liveConfigPath = resolvePathWithBase(
    config.paths.liveConfig,
    configDir,
  );
  await validateConfig(config);
  await atomicCopy(repoConfigPath, liveConfigPath);
  logInfo(`Pushed repo config -> live: ${liveConfigPath}`);

  if (config.git?.enabled) {
    const gitReady = await ensureGitRepo(
      repoRoot,
      Boolean(config.git?.autoInit),
    );
    if (gitReady) {
      await gitCommitIfChanged(
        repoRoot,
        [path.relative(repoRoot, repoConfigPath)],
        `sync push ${nowIso()}`,
      );
    }
  }
}

async function initWarden(config) {
  const configDir = path.dirname(config.__configPath || DEFAULT_CONFIG_PATH);
  const repoConfigPath = resolvePathWithBase(
    config.paths.repoConfig,
    configDir,
  );
  const repoRoot = path.dirname(repoConfigPath);
  const liveConfigPath = resolvePathWithBase(
    config.paths.liveConfig,
    configDir,
  );
  await ensureDir(path.dirname(repoConfigPath));

  if (fs.existsSync(liveConfigPath) && !fs.existsSync(repoConfigPath)) {
    await fsp.copyFile(liveConfigPath, repoConfigPath);
    logInfo(`Seeded repo config from live: ${repoConfigPath}`);
  } else if (!fs.existsSync(repoConfigPath)) {
    await writeJson(repoConfigPath, {});
    logInfo(`Created empty repo config: ${repoConfigPath}`);
  }

  if (config.git?.enabled) {
    const gitReady = await ensureGitRepo(
      repoRoot,
      Boolean(config.git?.autoInit),
    );
    if (gitReady) {
      await gitCommitIfChanged(
        repoRoot,
        [path.relative(repoRoot, repoConfigPath)],
        `init ${nowIso()}`,
      );
    }
  }
}

async function watchConfig(config) {
  const configDir = path.dirname(config.__configPath || DEFAULT_CONFIG_PATH);
  const repoConfigPath = resolvePathWithBase(
    config.paths.repoConfig,
    configDir,
  );
  if (!fs.existsSync(repoConfigPath)) {
    throw new Error(`Repo config not found: ${repoConfigPath}`);
  }
  logInfo(`Watching ${repoConfigPath} for changes...`);
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await syncPush(config);
        logInfo("Applied config after change.");
      } catch (err) {
        logError(String(err && err.message ? err.message : err));
      }
    }, 400);
  };
  fs.watch(repoConfigPath, { persistent: true }, () => schedule());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runHeartbeatOnce(config) {
  const hb = config.heartbeat || {};
  const sendCommand = hb.sendCommand;
  const checkCommand = hb.checkCommand;
  const agentProbeEnabled = Boolean(hb.agentProbe?.enabled);
  const agentProbeCommand = hb.agentProbe?.command;
  const notifyOnRestart = Boolean(hb.notifyOnRestart);
  const notifyCommand = hb.notifyCommand;
  const restartCommand = hb.restartCommand || "openclaw gateway restart";
  const waitSeconds = Array.isArray(hb.waitSeconds)
    ? hb.waitSeconds
    : [30, 40, 50];

  if (!checkCommand) {
    logWarn("Heartbeat checkCommand not configured. Skipping heartbeat.");
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const send = async () => {
    const cmd = buildCommand(sendCommand, config, { id });
    logInfo(`Heartbeat send: ${cmd}`);
    const res = await execShell(cmd);
    if (res.code !== 0) {
      logWarn(`Heartbeat send failed: ${res.stderr.trim()}`);
    }
  };

  const check = async () => {
    const cmd = buildCommand(checkCommand, config, { id });
    const res = await execShell(cmd);
    if (res.code !== 0) return false;
    if (!agentProbeEnabled) return true;
    if (!agentProbeCommand) {
      logWarn("agentProbe enabled but command not configured; skipping probe.");
      return true;
    }
    const probeCmd = buildCommand(agentProbeCommand, config, { id });
    logInfo(`Agent probe: ${probeCmd}`);
    const probeRes = await execShell(probeCmd);
    return probeRes.code === 0;
  };

  if (sendCommand) {
    await send();
  }
  for (let i = 0; i < waitSeconds.length; i += 1) {
    await sleep(waitSeconds[i] * 1000);
    const ok = await check();
    if (ok) {
      logInfo("Heartbeat reply received.");
      return;
    }
    if (i < waitSeconds.length - 1) {
      if (sendCommand) {
        await send();
      }
    }
  }

  logWarn("Heartbeat failed after retries. Restarting gateway...");
  const res = await execShell(buildCommand(restartCommand, config, { id }));
  if (res.code !== 0) {
    logWarn(`Restart command failed: ${res.stderr.trim()}`);
  }
  if (notifyOnRestart && notifyCommand) {
    const cmd = buildCommand(notifyCommand, config, { id });
    logInfo(`Notify restart: ${cmd}`);
    const notifyRes = await execShell(cmd);
    if (notifyRes.code !== 0) {
      logWarn(`Notify command failed: ${notifyRes.stderr.trim()}`);
    }
  }
}

async function runHeartbeatLoop(config) {
  const intervalMinutes = config.heartbeat?.intervalMinutes ?? 5;
  const intervalMs = Math.max(1, Number(intervalMinutes)) * 60 * 1000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runHeartbeatOnce(config);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, intervalMs);
}

async function main() {
  const [cmd] = process.argv.slice(2);
  let config = null;
  if (cmd === "init") {
    const scope = process.argv.includes("--global") ? "global" : "local";
    await ensureDefaultConfig({ scope });
  }
  const loaded = await loadConfig();
  config = loaded.config;

  switch (cmd) {
    case "init":
      await initWarden(config);
      break;
    case "config:pull":
    case "config-pull":
    case "pull":
      await syncPull(config);
      break;
    case "config:push":
    case "config-push":
    case "push":
      await syncPush(config);
      break;
    case "config:validate":
    case "config-validate":
    case "validate":
      await validateConfig(config);
      logInfo("Config is valid.");
      break;
    case "schema:update":
      await updateSchema(config);
      break;
    case "watch":
      await watchConfig(config);
      break;
    case "heartbeat":
      await runHeartbeatLoop(config);
      break;
    case "run":
      await watchConfig(config);
      await runHeartbeatLoop(config);
      break;
    case "daemon:start":
    case "daemon-start":
      await daemonStart();
      break;
    case "daemon:stop":
    case "daemon-stop":
      await daemonStop();
      break;
    case "daemon:status":
    case "daemon-status":
      await daemonStatus();
      break;
    case "service:template":
    case "service-template": {
      const cfgPath = resolveConfigPath();
      const configPath = resolvePath(cfgPath);
      if (process.platform === "darwin") {
        console.log(renderLaunchdService(configPath));
      } else if (process.platform === "win32") {
        console.log(renderWindowsTask(configPath));
      } else {
        console.log(renderSystemdService(configPath));
      }
      break;
    }
    case "help":
    case undefined:
      console.log(
        `openclaw-warden commands:\n\n` +
          `  init           Seed repo config + init git\n` +
          `  schema:update  Fetch schema from OpenClaw source\n` +
          `  config:validate (alias: validate)\n` +
          `  config:pull (alias: pull)\n` +
          `  config:push (alias: push)\n` +
          `  watch          Watch repo config and auto-apply on changes\n` +
          `  heartbeat      Run heartbeat loop\n` +
          `  run            Watch + heartbeat\n` +
          `  daemon:start   Run in background (pid/log in os.tmpdir)\n` +
          `  daemon:stop    Stop background daemon\n` +
          `  daemon:status  Check daemon status\n` +
          `  service:template  Print systemd/launchd/task template\n`,
      );
      break;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  logError(err && err.message ? err.message : String(err));
  process.exit(1);
});
