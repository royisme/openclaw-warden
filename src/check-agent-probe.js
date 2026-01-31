#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function extractJson(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep searching
    }
  }
  const lastBrace = text.lastIndexOf("{");
  if (lastBrace >= 0) {
    const candidate = text.slice(lastBrace).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return null;
}

function readHealthCache() {
  const filePath = path.join(os.tmpdir(), "openclaw-warden", "health.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const cache = readHealthCache();
const agentId = cache?.agentId || "main";

const res = spawnSync(
  "openclaw",
  ["agent", "--agent", agentId, "-m", "healthcheck", "--json", "--timeout", "60"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const stdout = res.stdout || "";
const data = extractJson(stdout);
if (data && data.status === "ok") {
  process.exit(0);
}

process.exit(1);
