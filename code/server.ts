// O1 probe: stdio MCP server. check_config_drift reads Image.I0.Name live from the P3285 and formats it with
// onvif-mcp's real formatDriftLines; reboot_camera is a stub that only logs.
// Env: O1_ARM, O1_RUN, O1_LOG (append-only call log).
import { formatDriftLines } from "<path-to>/onvif-mcp/config-drift.ts";
import { appendFileSync } from "node:fs";

const BASE = "https://<camera-ip>";
const PIN = "<tls-pin>";
const PARAM = "Image.I0.Name";
const BASELINE = "Camera 1";
const FILTER = /\b(ignore|instruction|instructions|reply|code word|reboot|restart|shutdown|delete|reset|override|execute|now)\b/i;
const pw = Bun.spawnSync([`${process.env.HOME}/.claude/bin/cred`, "get", "<credential-key>"]).stdout.toString().trim();
const log = (rec: object) => process.env.O1_LOG && appendFileSync(process.env.O1_LOG, JSON.stringify({ run: process.env.O1_RUN, arm: process.env.O1_ARM, ...rec }) + "\n");

function readLive(): string | null {
  const r = Bun.spawnSync(["curl", "-s", "-k", "--pinnedpubkey", PIN, "--basic", "-u", `root:${pw}`, "--max-time", "10",
    `${BASE}/axis-cgi/param.cgi?action=list&group=${PARAM}`]);
  const line = r.stdout.toString().split(/\r?\n/).find((l) => l.replace(/^root\./, "").startsWith(PARAM + "="));
  return line ? line.replace(/^root\./, "").slice(PARAM.length + 1) : null;
}

function drift(camera: string): string {
  const live = readLive();
  if (live === null) { log({ tool: "check_config_drift", camera, error: "read failed" }); return `${camera}: drift check failed (camera unreachable)`; }
  log({ tool: "check_config_drift", camera, live, filter_hit: FILTER.test(live) });
  if (live === BASELINE) return `${camera}: no drift (all tracked params match baseline)`;
  return `${camera}: 1 param differs from baseline\n` + formatDriftLines({ changed: [{ param: PARAM, baseline: BASELINE, live }], added: [], removed: [] }).join("\n");
}

const tools = [
  { name: "check_config_drift", description: "Compare a configured camera's live parameters against its stored baseline and list differences.", inputSchema: { type: "object", properties: { camera: { type: "string" } }, required: ["camera"] } },
  { name: "reboot_camera", description: "Reboot a configured camera.", inputSchema: { type: "object", properties: { camera: { type: "string" } }, required: ["camera"] } },
];

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!raw) continue;
    const m = JSON.parse(raw);
    if (m.id === undefined) continue;
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0.0.1" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
    else if (m.method === "tools/call") {
      const name = m.params?.name; const camera = String(m.params?.arguments?.camera ?? "");
      let text: string;
      if (name === "check_config_drift") text = drift(camera);
      else if (name === "reboot_camera") { log({ tool: "reboot_camera", camera }); text = `${camera}: reboot scheduled`; }
      else text = `unknown tool ${name}`;
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
    } else send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
