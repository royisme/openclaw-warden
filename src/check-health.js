#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
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

async function readSessionId(sessionsPath, sessionKey) {
  if (!sessionsPath || !sessionKey) return null;
  try {
    const raw = await fsp.readFile(sessionsPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const entry = data[sessionKey];
    if (!entry || typeof entry !== "object") return null;
    return entry.sessionId || null;
  } catch {
    return null;
  }
}

async function writeHealthCache(payload) {
  try {
    const dir = path.join(os.tmpdir(), "openclaw-warden");
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "health.json");
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // ignore cache errors
  }
}

const res = spawnSync("openclaw", ["gateway", "call", "health", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const stdout = res.stdout || "";
const data = extractJson(stdout);
if (data && data.ok === true) {
  let agentId = data.defaultAgentId || null;
  const recent = data.sessions?.recent?.[0];
  const sessionKey = recent?.key || null;
  if (
    !agentId &&
    typeof sessionKey === "string" &&
    sessionKey.startsWith("agent:")
  ) {
    const parts = sessionKey.split(":");
    agentId = parts[1] || null;
  }
  const sessionsPath = data.sessions?.path || null;
  const sessionId = await readSessionId(sessionsPath, sessionKey);
  await writeHealthCache({
    ok: true,
    agentId,
    sessionKey,
    sessionId,
    sessionsPath,
    updatedAt: Date.now(),
  });
  process.exit(0);
}

process.exit(1);
