# OpenClaw Warden

A lightweight watchdog/guard:
- Validates OpenClaw config using the official schema to avoid crashes
- Stores config in this repo and versions changes with git, then syncs to `~/.openclaw/openclaw.json`
- Heartbeat checks every 5 minutes with 30/40/50-second backoff; restarts the gateway if unhealthy

## Layout
- `warden.config.json`: warden configuration
- `config/openclaw.json`: managed OpenClaw config (git-tracked)
- `state/schema.json`: OpenClaw config schema (generated)
- `src/warden.js`: CLI entry

## Initialization
`openclaw-warden init` creates `warden.config.json` in the current directory (if missing),
and pulls `~/.openclaw/openclaw.json` into `./config/openclaw.json`.
**Note:** `config/openclaw.json` is always created relative to the directory
containing `warden.config.json`.

## Quick start

```bash
# Run without cloning the repo
npx openclaw-warden init
# or
bunx openclaw-warden init

# Generate/update schema (auto-clone OpenClaw source)
npx openclaw-warden schema:update

# Validate config
npx openclaw-warden config:validate

# Watch config -> validate -> sync to ~/.openclaw/openclaw.json -> git commit
npx openclaw-warden watch

# Heartbeat loop (every 5 minutes with 30/40/50s backoff)
npx openclaw-warden heartbeat

# Watch + heartbeat
npx openclaw-warden run
```

## Background (daemon)
You can run in the background (no foreground terminal needed):
```bash
npx openclaw-warden daemon:start
npx openclaw-warden daemon:status
npx openclaw-warden daemon:stop
```

Default pid/log paths:
- pid: `os.tmpdir()/openclaw-warden/warden.pid`
- log: `os.tmpdir()/openclaw-warden/warden.log`

## System service (recommended)
For auto-start after reboot, install a system service:

### Linux (systemd --user)
```bash
openclaw-warden service:template > ~/.config/systemd/user/openclaw-warden.service
systemctl --user daemon-reload
systemctl --user enable --now openclaw-warden
```

### macOS (launchd)
```bash
openclaw-warden service:template > ~/Library/LaunchAgents/ai.openclaw.warden.plist
launchctl load -w ~/Library/LaunchAgents/ai.openclaw.warden.plist
```

### Windows (Task Scheduler)
```powershell
openclaw-warden service:template | Out-File -Encoding unicode $env:TEMP\openclaw-warden.xml
schtasks /Create /TN OpenClawWarden /XML $env:TEMP\openclaw-warden.xml /F
```

> Tip: service templates assume `openclaw-warden` is on PATH (use `npm i -g openclaw-warden`).

## Config location strategy
- Prefer `./warden.config.json` in the current directory
- If missing, fall back to the global config directory:
  - macOS: `~/Library/Application Support/openclaw-warden/warden.config.json`
  - Linux: `~/.config/openclaw-warden/warden.config.json`
  - Windows: `%APPDATA%\openclaw-warden\warden.config.json`

`init` creates the config in the current directory by default. Use `--global` to write to the global path:
```bash
npx openclaw-warden init --global
```

## Configuration (warden.config.json)

```json
{
  "paths": {
    "repoConfig": "./config/openclaw.json",
    "liveConfig": "~/.openclaw/openclaw.json",
    "schemaFile": "./state/schema.json"
  },
  "schema": {
    "source": "git",
    "repoUrl": "https://github.com/openclaw/openclaw.git",
    "ref": "main",
    "checkoutDir": "./state/openclaw",
    "useLocalDeps": true,
    "exportCommand": "node --import tsx -e \"import { buildConfigSchema } from './src/config/schema.ts'; console.log(JSON.stringify(buildConfigSchema(), null, 2));\""
  },
  "git": {
    "enabled": true,
    "autoInit": true
  },
  "heartbeat": {
    "intervalMinutes": 5,
    "waitSeconds": [30, 40, 50],
    "checkCommand": "node ./src/check-health.js",
    "agentProbe": {
      "enabled": true,
      "fallbackAgentId": "main",
      "command": "node ./src/check-agent-probe.js"
    },
    "notifyOnRestart": true,
    "notifyCommand": "openclaw agent --agent {agentId} -m \"[warden] gateway restarted after failed health check\" --channel last --deliver",
    "restartCommand": "openclaw gateway restart"
  }
}
```

### checkCommand / notifyCommand / restartCommand / placeholders
- `checkCommand`: health check (**exit code 0 = healthy**)
- `agentProbe`: optional agent probe after gateway health
- `notifyOnRestart`: send notification after restart
- `notifyCommand`: notify command (recommended to use `openclaw agent ... --channel last --deliver`)
- `restartCommand`: restart command

Supported placeholders:
- `{id}`: heartbeat id
- `{repoConfig}`: managed config path
- `{liveConfig}`: live config path
- `{agentId}`: default agent id from last health check
- `{sessionId}`: latest session id from sessions.json
- `{sessionKey}`: latest session key

### Logging
- Default: `os.tmpdir()/openclaw-warden/warden.log` (stdout preserved)
- Optional: set `logging.file` to override

### Default health check script
- `src/check-health.js`: runs `openclaw gateway call health --json`, parses the last JSON object and checks `ok: true`
- Writes recent session info to `os.tmpdir()/openclaw-warden/health.json` for notify/agent probe use
- Only requires `openclaw` in PATH

### Default agent probe script
- `src/check-agent-probe.js`: reads `health.json` for `agentId` (fallback `main`), runs
  `openclaw agent --agent <id> -m "healthcheck" --json --timeout 60`
  and checks `status: "ok"`

## Notes
- `schema:update` auto-clones OpenClaw source (default: main) and generates schema locally.
- By default, OpenClaw repo dependencies are not installed; warden reuses its own `node_modules` (`useLocalDeps: true`).
- All git operations only affect this repo; `~/.openclaw/` is never git-managed.
