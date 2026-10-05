// Bethel School building bridge.
//
// Runs on the school's Windows mini PC. Relays a fixed list of allowed
// commands from the staff website to Home Assistant (bells, lights and
// thermostats only) and reports their state back. It only makes outgoing connections, so
// nothing at the school is exposed to the internet.
//
// Requires Node.js 20 or newer. No other packages. Settings come from the
// .env file next to this script (see .env.example). Setup: README.md.

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(here, "bridge.log");

// ---------------------------------------------------------------- settings

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const key = line.slice(0, line.indexOf("=")).trim();
    const value = line.slice(line.indexOf("=") + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(join(here, ".env"));

// When running as a Home Assistant app (add-on), settings come from the
// app's Configuration tab, which Home Assistant saves to /data/options.json.
const OPTIONS_FILE = process.env.BRIDGE_OPTIONS_FILE ?? "/data/options.json";
if (existsSync(OPTIONS_FILE)) {
  const options = JSON.parse(readFileSync(OPTIONS_FILE, "utf8"));
  for (const [key, value] of Object.entries(options)) {
    if (value !== "" && value !== null && !(key.toUpperCase() in process.env)) {
      process.env[key.toUpperCase()] = String(value);
    }
  }
}

const config = {
  siteUrl: (process.env.SITE_URL ?? "").replace(/\/+$/, ""),
  bridgeToken: process.env.BRIDGE_TOKEN ?? "",
  ntfyTopic: process.env.NTFY_TOPIC ?? "",
  haUrl: (process.env.HA_URL ?? "").replace(/\/+$/, ""),
  haToken: process.env.HA_TOKEN ?? "",
  automation: process.env.AUTOMATION_ENTITY || "automation.bethel_school_daily_bell_schedule",
};

const missing = Object.entries(config)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length) {
  console.error(`Missing settings in .env: ${missing.join(", ")}`);
  process.exit(1);
}

// Home Assistant entities (see the "Bethel School - Daily Bell Schedule" automation).
const BELL_SLOTS = 24;
const BELLS_ENABLED = "input_boolean.bethel_school_bells_enabled";
const RING_SCRIPT = "script.ring_bethel_school_bell";
const pad = (n) => String(n).padStart(2, "0");
const bellTime = (slot) => `input_datetime.bell_time_${pad(slot)}`;
const bellSlot = (slot) => `input_boolean.bell_slot_${pad(slot)}`;

// ----------------------------------------------------------------- logging

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) {
      renameSync(LOG_FILE, `${LOG_FILE}.old`);
    }
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Logging must never stop the bridge.
  }
}

// ------------------------------------------------------------ HTTP helpers

async function request(base, token, path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${path}`);
  return response.json();
}

const ha = (path, init) => request(config.haUrl, config.haToken, `/api/${path}`, init);
const site = (path, init) => request(config.siteUrl, config.bridgeToken, `/api/bridge/${path}`, init);
const callService = (domain, service, data) =>
  ha(`services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) });

// --------------------------------------------- allowlisted commands only

const isSlot = (value) => Number.isInteger(value) && value >= 1 && value <= BELL_SLOTS;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Only lights and thermostats may be controlled, never other switches.
const LIGHT = /^light\.[a-z0-9_]+$/;
const CLIMATE = /^climate\.[a-z0-9_]+$/;
const THERMOSTAT_MIN_F = 60;
const THERMOSTAT_MAX_F = 80;
const THERMOSTAT_MODES = ["off", "heat", "cool"];

// Thermostat day/night schedules: Home Assistant helpers per zone, read by
// the "Thermostats - <zone> schedule (website)" automations.
const SCHEDULE_ZONES = ["classrooms", "rest"];
const scheduleEntities = (zone) => ({
  enabled: `input_boolean.thermostats_${zone}_schedule`,
  dayStart: `input_datetime.thermostats_${zone}_day_start`,
  nightStart: `input_datetime.thermostats_${zone}_night_start`,
  dayTemp: `input_number.thermostats_${zone}_day_temp`,
  nightTemp: `input_number.thermostats_${zone}_night_temp`,
});

const isEntityList = (value, pattern) =>
  Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every((e) => pattern.test(e));

// Thermostats are set one at a time so one failure doesn't stop the rest.
async function forEachThermostat(entities, call) {
  const failed = [];
  for (const entity of entities) {
    try {
      await call(entity);
    } catch (error) {
      failed.push(`${entity} (${error.message})`);
    }
  }
  if (failed.length) throw new Error(`Failed for ${failed.join(", ")}`);
}

async function execute({ action, payload }) {
  switch (action) {
    case "set_bell_time":
      if (!isSlot(payload.slot) || !TIME.test(payload.time)) throw new Error("Invalid bell time");
      return callService("input_datetime", "set_datetime", {
        entity_id: bellTime(payload.slot),
        time: `${payload.time}:00`,
      });
    case "set_bell_slot":
      if (!isSlot(payload.slot) || typeof payload.on !== "boolean") throw new Error("Invalid bell slot");
      return callService("input_boolean", payload.on ? "turn_on" : "turn_off", {
        entity_id: bellSlot(payload.slot),
      });
    case "set_bells_enabled":
      if (typeof payload.on !== "boolean") throw new Error("Invalid value");
      // The website's master switch. Turning bells on also makes sure the
      // bell schedule automation itself is enabled; turning them off only
      // flips the master toggle, which the automation checks.
      if (payload.on) {
        await callService("automation", "turn_on", { entity_id: config.automation });
      }
      return callService("input_boolean", payload.on ? "turn_on" : "turn_off", {
        entity_id: BELLS_ENABLED,
      });
    case "ring_bell":
      return callService("script", "turn_on", { entity_id: RING_SCRIPT });
    case "set_lights":
      if (!isEntityList(payload.entities, LIGHT) || typeof payload.on !== "boolean") {
        throw new Error("Invalid lights");
      }
      return callService("light", payload.on ? "turn_on" : "turn_off", { entity_id: payload.entities });
    case "set_thermostat_temp":
      if (
        !isEntityList(payload.entities, CLIMATE) ||
        !Number.isInteger(payload.temperature) ||
        payload.temperature < THERMOSTAT_MIN_F ||
        payload.temperature > THERMOSTAT_MAX_F
      ) {
        throw new Error("Invalid thermostat temperature");
      }
      return forEachThermostat(payload.entities, (entity) =>
        callService("climate", "set_temperature", { entity_id: entity, temperature: payload.temperature }),
      );
    case "set_thermostat_mode":
      if (!isEntityList(payload.entities, CLIMATE) || !THERMOSTAT_MODES.includes(payload.mode)) {
        throw new Error("Invalid thermostat mode");
      }
      return forEachThermostat(payload.entities, (entity) =>
        callService("climate", "set_hvac_mode", { entity_id: entity, hvac_mode: payload.mode }),
      );
    case "set_thermostat_schedule": {
      const temps = [payload.dayTemp, payload.nightTemp];
      if (
        !SCHEDULE_ZONES.includes(payload.zone) ||
        typeof payload.enabled !== "boolean" ||
        !TIME.test(payload.dayStart) ||
        !TIME.test(payload.nightStart) ||
        payload.dayStart >= payload.nightStart ||
        !temps.every((t) => Number.isInteger(t) && t >= THERMOSTAT_MIN_F && t <= THERMOSTAT_MAX_F)
      ) {
        throw new Error("Invalid thermostat schedule");
      }
      const ids = scheduleEntities(payload.zone);
      await callService("input_datetime", "set_datetime", { entity_id: ids.dayStart, time: `${payload.dayStart}:00` });
      await callService("input_datetime", "set_datetime", { entity_id: ids.nightStart, time: `${payload.nightStart}:00` });
      await callService("input_number", "set_value", { entity_id: ids.dayTemp, value: payload.dayTemp });
      await callService("input_number", "set_value", { entity_id: ids.nightTemp, value: payload.nightTemp });
      // Last, so the automation re-applies with all the new values in place.
      return callService("input_boolean", payload.enabled ? "turn_on" : "turn_off", { entity_id: ids.enabled });
    }
    default:
      throw new Error(`Action not allowed: ${action}`);
  }
}

// ------------------------------------------------------------------- sync

async function readSnapshot() {
  const states = await ha("states");
  const byId = new Map(states.map((state) => [state.entity_id, state]));
  const errors = [];
  const isOn = (id) => {
    const state = byId.get(id);
    if (!state) {
      errors.push(`Home Assistant has no ${id}`);
      return null;
    }
    return state.state === "on";
  };

  const bells = [];
  for (let slot = 1; slot <= BELL_SLOTS; slot++) {
    const time = byId.get(bellTime(slot));
    bells.push({
      slot,
      name: time?.attributes?.friendly_name ?? `Bell ${slot}`,
      time: /^\d{2}:\d{2}:\d{2}$/.test(time?.state ?? "") ? time.state : null,
      enabled: isOn(bellSlot(slot)),
    });
  }

  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const lights = states
    .filter((state) => LIGHT.test(state.entity_id))
    .map((state) => ({
      entity: state.entity_id,
      name: state.attributes?.friendly_name ?? state.entity_id,
      on: state.state === "on" ? true : state.state === "off" ? false : null,
      brightness:
        state.state === "on" && num(state.attributes?.brightness) !== null
          ? Math.round((state.attributes.brightness / 255) * 100)
          : null,
    }));
  const thermostats = states
    .filter((state) => CLIMATE.test(state.entity_id))
    .map((state) => ({
      entity: state.entity_id,
      name: state.attributes?.friendly_name ?? state.entity_id,
      mode: state.state,
      modes: state.attributes?.hvac_modes ?? [],
      action: state.attributes?.hvac_action ?? null,
      current: num(state.attributes?.current_temperature),
      target: num(state.attributes?.temperature),
    }));

  // Only zones whose helpers exist in Home Assistant are reported.
  const thermostatSchedules = SCHEDULE_ZONES.filter((zone) => byId.has(scheduleEntities(zone).enabled)).map(
    (zone) => {
      const ids = scheduleEntities(zone);
      const time = (id) => (/^\d{2}:\d{2}:\d{2}$/.test(byId.get(id)?.state ?? "") ? byId.get(id).state : null);
      const number = (id) => {
        const value = Number.parseFloat(byId.get(id)?.state);
        return Number.isFinite(value) ? value : null;
      };
      return {
        zone,
        enabled: byId.get(ids.enabled).state === "on",
        dayStart: time(ids.dayStart),
        nightStart: time(ids.nightStart),
        dayTemp: number(ids.dayTemp),
        nightTemp: number(ids.nightTemp),
      };
    },
  );

  const automation = byId.get(config.automation);
  return {
    bellsEnabled: isOn(BELLS_ENABLED),
    automationEnabled: automation ? automation.state === "on" : null,
    bells,
    lights,
    thermostats,
    thermostatSchedules,
    errors,
  };
}

async function processCommands() {
  const { commands } = await site("commands");
  for (const command of commands) {
    let result;
    try {
      await execute(command);
      result = { ok: true };
      log(`Done #${command.id}: ${command.action} ${JSON.stringify(command.payload)}`);
    } catch (error) {
      result = { ok: false, error: error.message };
      log(`Failed #${command.id}: ${command.action}: ${error.message}`);
    }
    await site(`commands/${command.id}`, { method: "POST", body: JSON.stringify(result) });
  }
  return commands.length;
}

async function reportState() {
  await site("state", { method: "POST", body: JSON.stringify(await readSnapshot()) });
}

let busy = false;
let runAgain = false;

// Fetch and run any commands, then report fresh state. Overlapping signals
// are merged into one extra pass.
async function sync(reason) {
  if (busy) {
    runAgain = true;
    return;
  }
  busy = true;
  try {
    do {
      runAgain = false;
      const ran = await processCommands();
      if (ran) await new Promise((resolve) => setTimeout(resolve, 500)); // let HA settle
      await reportState();
    } while (runAgain);
  } catch (error) {
    log(`Sync failed (${reason}): ${error.message}`);
  } finally {
    busy = false;
  }
}

// ------------------------------------------------------- website signals

// Listens to the secret ntfy.sh topic. Messages only mean "check now";
// the real commands are always fetched from the website with the token.
async function listen() {
  for (;;) {
    const controller = new AbortController();
    let watchdog;
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      // ntfy sends a keepalive about every 45 seconds.
      watchdog = setTimeout(() => controller.abort(), 120_000);
    };
    try {
      resetWatchdog();
      const response = await fetch(`https://ntfy.sh/${config.ntfyTopic}/json`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`ntfy responded ${response.status}`);
      log("Connected; waiting for signals from the website.");
      sync("connected");

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        resetWatchdog();
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.event === "message") sync(event.message);
        }
      }
      throw new Error("stream ended");
    } catch (error) {
      log(`Connection lost (${error.message}); retrying in 10 seconds.`);
    } finally {
      clearTimeout(watchdog);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

process.on("unhandledRejection", (error) => log(`Unexpected error: ${error?.message ?? error}`));

log(`Bethel School bridge starting. Website: ${config.siteUrl}  Home Assistant: ${config.haUrl}`);
try {
  const info = await ha("");
  log(`Home Assistant reachable: ${info.message ?? "ok"}`);
} catch (error) {
  log(`WARNING: can't reach Home Assistant yet (${error.message}). Will keep trying.`);
}
listen();
