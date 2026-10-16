import { DshClient } from "../adapters/dsh.mjs";
import { createLogger } from "../host/log.mjs";

const log = createLogger(process.env.LOG_LEVEL || "debug");
const dsh = new DshClient({ log });

const seen = new Map();
dsh.on("event", (frame) => {
  seen.set(frame.event, (seen.get(frame.event) || 0) + 1);
});
dsh.on("waterfall", (frame) => {
  console.log("WATERFALL", frame.event, "eventId=" + frame.eventId, "agentId=" + frame.agentId, JSON.stringify(frame.request).slice(0, 300));
});
dsh.on("ready", () => {
  console.log("READY clientId=" + dsh.eventsClientId);
});

await dsh.connect();
await new Promise((resolve) => setTimeout(resolve, 3000));

try {
  const value = await dsh.listSessions();
  const items = (value && value.items) || [];
  console.log("SESSIONS", items.length);
  for (const item of items.slice(0, 5)) {
    console.log(" -", item.sessionId, "running=" + item.running, "title=" + ((item.projections && item.projections.values && item.projections.values.title) || ""));
  }
} catch (error) {
  console.log("LIST ERROR", error.message);
}

await new Promise((resolve) => setTimeout(resolve, 5000));
console.log("EVENT TYPES", JSON.stringify([...seen.entries()]));
dsh.close();
process.exit(0);
