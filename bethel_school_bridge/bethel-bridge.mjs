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
// Only lights and thermostats may be controlled, plus the switchable light
// relays listed below; never other switches.
const LIGHT = /^light\.[a-z0-9_]+$/;
const CLIMATE = /^climate\.[a-z0-9_]+$/;
const THERMOSTAT_MIN_F = 60;
const THERMOSTAT_MAX_F = 80;
const THERMOSTAT_MODES = ["off", "heat", "cool"];

// Thermostat day/night schedules: Home Assistant helpers per zone, read by
// the "Thermostats - <zone> schedule (website)" automations. Each zone has a
// cool schedule (the original helpers) and a heat schedule (thermostats_<zone>_heat_*);
// each thermostat follows the schedule for its own mode.
const SCHEDULE_ZONES = ["classrooms", "rest"];
const SCHEDULE_MODES = ["heat", "cool"];
const scheduleEntities = (zone, mode = "cool") => {
  const prefix = `thermostats_${zone}_${mode === "heat" ? "heat_" : ""}`;
  return {
    enabled: `input_boolean.thermostats_${zone}_schedule`,
    dayStart: `input_datetime.${prefix}day_start`,
    nightStart: `input_datetime.${prefix}night_start`,
    dayTemp: `input_number.${prefix}day_temp`,
    nightTemp: `input_number.${prefix}night_temp`,
  };
};

// Outside light schedules: Home Assistant helpers per fixture, read by the
// "Outside Lights - Schedule (website)" automation. Keys must match
// src/lib/outside-lights.ts.
const OUTSIDE_KEYS = [
  "south_wallpacks",
  "w_front_wallpacks",
  "back_center_wallpacks",
  "up_down",
  "back_wallpacks",
  "north_gym_wp",
  "parking_lot",
  "carport_cans",
  "front_eve_cans",
  "gym_west_led",
];
const OUTSIDE_DIMMERS = ["parking_lot", "carport_cans", "front_eve_cans"];
const OUTSIDE_IS_DARK = "input_boolean.outside_is_dark";
// Light-sensor levels for "dark" and "light", read by "Outside - Darkness"
// (created by home-assistant/outside-lux-setup.mjs).
const LUX_SENSOR = "sensor.gym_bethel_school_weather_station_solar_lux";
const DARK_LUX = "input_number.outside_dark_lux";
const LIGHT_LUX = "input_number.outside_light_lux";
const LUX_MAX = 2000;
// Gloomy-day rule for the front eve + carport cans (home-assistant/outside-gloomy-setup.mjs).
const GLOOMY = {
  enabled: "input_boolean.outside_gloomy_enabled",
  onBelow: "input_number.outside_gloomy_on_lux",
  offAbove: "input_number.outside_gloomy_off_lux",
  brightness: "input_number.outside_gloomy_brightness",
};
const GLOOMY_LUX_MAX = 50000;
// Home Assistant waits for the sensor to stay past each level for 10 minutes;
// the website counts that down, so look back a little further than that.
const LUX_LOOKBACK_MS = 20 * 60_000;

// When the light sensor's current run below/above each level started (ISO),
// or null when it isn't past that level now. A missing reading ends a run,
// as it does for Home Assistant's numeric_state triggers.
async function luxSince(levels) {
  const start = new Date(Date.now() - LUX_LOOKBACK_MS).toISOString();
  const [rows = []] = await ha(
    `history/period/${start}?filter_entity_id=${LUX_SENSOR}&minimal_response&no_attributes`,
  );
  const readings = rows.map((row) => ({ at: row.last_changed, lux: Number.parseFloat(row.state) }));
  const since = (test, level) => {
    if (typeof level !== "number") return null;
    let at = null;
    for (let i = readings.length - 1; i >= 0; i--) {
      if (!Number.isFinite(readings[i].lux) || !test(readings[i].lux, level)) break;
      at = readings[i].at;
    }
    return at;
  };
  const below = (lux, level) => lux < level;
  const above = (lux, level) => lux > level;
  return {
    belowDark: since(below, levels.darkBelow),
    aboveLight: since(above, levels.lightAbove),
    belowGloomyOn: since(below, levels.onBelow),
    aboveGloomyOff: since(above, levels.offAbove),
  };
}

// Classroom lights on Kasa motion switches: reported (on/off) for display
// only; the bridge never switches them.
const CLASSROOM_SWITCH_LIGHTS = [
  "switch.classroom_3_motion_sensor",
  "switch.classroom_4_motion_sensor",
  "switch.classroom_5_motion_sensor",
  "switch.classroom_7_motion_sensor",
  "switch.classroom_8_motion_sensor",
  "switch.kindergaten_room_motion_sensor",
  "switch.special_ed_motion_2",
  "switch.aid_room_motion_1",
];
// Motion-light countdowns (display only; keep in step with MOTION_AREAS in
// src/lib/building.ts). The kitchen has no timer: its automation turns the
// lights off once all three sensors have been clear for 20 minutes.
const MOTION_TIMERS = [
  "timer.cafeteria_lights",
  "timer.cafeteria_off_delay",
  "timer.restroom_hall_lights",
  "timer.restroom_hall_off_delay",
  "timer.classroom_hall_lights",
  "timer.se_gym_mechanic_rm_lights",
];
// "Gym - idle controller" checks this sensor's clear time every 5 minutes.
const GYM_MOTION = "binary_sensor.gym_gym_ceiling_motion_sensor_input_0";
// Projectors the website may turn on or off (Songs page, on the school network only).
const PROJECTORS = ["media_player.cafeteria_projector"];
const KITCHEN_MOTION = [
  "binary_sensor.kitchen_e_kitchen_1_motion_sensor_input_0",
  "binary_sensor.shelly1g4_d885acf35844_input_0",
  "binary_sensor.shelly1g4_d885acf25854_input_0",
];

// UniFi devices report as "A A" (name twice); keep one copy.
function trackerName(state) {
  const attrs = state.attributes ?? {};
  let name = typeof attrs.friendly_name === "string" ? attrs.friendly_name.replace(/\s+/g, " ").trim() : "";
  if (name === "undefined") name = "";
  const half = name.slice(0, (name.length - 1) / 2);
  if (name.length % 2 === 1 && half && name === `${half} ${half}`) name = half;
  return (name || attrs.host_name || attrs.mac || state.entity_id).slice(0, 100);
}

// Lights on relays the website may switch (kept in step with src/lib/building.ts):
// Kasa motion switches and the Shelly relays that switch lights (not the Shellys
// used only as motion-sensor inputs). Their motion automations still run.
const SWITCHABLE_SWITCH_LIGHTS = [
  "switch.kitchen_e_kitchen_1_motion_sensor",
  "switch.classroom_hall_s_classroom_hall_1",
  "switch.classroom_hall_w_motion_2",
  "switch.gym_se_gym_mechanic_rm_motion_sensor",
  "switch.middle_mechanical_rm_motion",
  "switch.n_classroom_hall_motion_3",
  "switch.office_motion_sensor",
  "switch.teacher_lounge",
  "switch.w_entry_lights",
  "switch.women_s_restroom_motion",
  "switch.staff_bathroom_lights",
  "switch.boy_s_locker_motion_1",
  "switch.boy_s_locker_motion_2",
  "switch.girl_s_locker_motion_1",
  "switch.girl_s_locker_motion_2",
  "switch.sports_equip_room",
];
const outsideEntities = (key) => ({
  scheduled: `input_boolean.outside_${key}_scheduled`,
  onMode: `input_select.outside_${key}_on_mode`,
  onTime: `input_datetime.outside_${key}_on_time`,
  offMode: `input_select.outside_${key}_off_mode`,
  offTime: `input_datetime.outside_${key}_off_time`,
  brightness: `input_number.outside_${key}_brightness`,
  desired: `input_boolean.outside_${key}_desired`,
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
    case "set_lights": {
      const entities = Array.isArray(payload.entities) ? payload.entities : [];
      const lights = entities.filter((e) => LIGHT.test(e));
      const relays = entities.filter((e) => SWITCHABLE_SWITCH_LIGHTS.includes(e));
      if (
        !entities.length ||
        entities.length > 100 ||
        lights.length + relays.length !== entities.length ||
        typeof payload.on !== "boolean"
      ) {
        throw new Error("Invalid lights");
      }
      const service = payload.on ? "turn_on" : "turn_off";
      if (lights.length) await callService("light", service, { entity_id: lights });
      if (relays.length) await callService("switch", service, { entity_id: relays });
      return;
    }
    case "set_projector":
      if (!PROJECTORS.includes(payload.entity) || typeof payload.on !== "boolean") throw new Error("Invalid projector");
      return callService("media_player", payload.on ? "turn_on" : "turn_off", { entity_id: payload.entity });
    case "set_light_brightness":
      if (
        !isEntityList(payload.entities, LIGHT) ||
        payload.entities.length > 20 ||
        !Number.isInteger(payload.brightness) ||
        payload.brightness < 1 ||
        payload.brightness > 100
      ) {
        throw new Error("Invalid brightness");
      }
      return callService("light", "turn_on", { entity_id: payload.entities, brightness_pct: payload.brightness });
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
        (payload.mode !== undefined && !SCHEDULE_MODES.includes(payload.mode)) ||
        !temps.every((t) => Number.isInteger(t) && t >= THERMOSTAT_MIN_F && t <= THERMOSTAT_MAX_F)
      ) {
        throw new Error("Invalid thermostat schedule");
      }
      const ids = scheduleEntities(payload.zone, payload.mode);
      // Service calls on a missing helper silently do nothing, so check first.
      await ha(`states/${ids.dayTemp}`).catch(() => {
        throw new Error(`The ${payload.mode ?? "cool"} schedule is not set up in Home Assistant`);
      });
      await callService("input_datetime", "set_datetime", { entity_id: ids.dayStart, time: `${payload.dayStart}:00` });
      await callService("input_datetime", "set_datetime", { entity_id: ids.nightStart, time: `${payload.nightStart}:00` });
      await callService("input_number", "set_value", { entity_id: ids.dayTemp, value: payload.dayTemp });
      await callService("input_number", "set_value", { entity_id: ids.nightTemp, value: payload.nightTemp });
      // Last, so the automation re-applies with all the new values in place.
      return callService("input_boolean", payload.enabled ? "turn_on" : "turn_off", { entity_id: ids.enabled });
    }
    case "set_outside_lux":
      if (
        !Number.isInteger(payload.darkBelow) ||
        !Number.isInteger(payload.lightAbove) ||
        payload.darkBelow < 1 ||
        payload.lightAbove > LUX_MAX ||
        payload.darkBelow >= payload.lightAbove
      ) {
        throw new Error("Invalid light sensor levels");
      }
      await ha(`states/${DARK_LUX}`).catch(() => {
        throw new Error("The light sensor levels are not set up in Home Assistant");
      });
      await callService("input_number", "set_value", { entity_id: DARK_LUX, value: payload.darkBelow });
      return callService("input_number", "set_value", { entity_id: LIGHT_LUX, value: payload.lightAbove });
    case "set_gloomy_rule":
      if (
        typeof payload.enabled !== "boolean" ||
        !Number.isInteger(payload.onBelow) ||
        !Number.isInteger(payload.offAbove) ||
        !Number.isInteger(payload.brightness) ||
        payload.onBelow < 100 ||
        payload.offAbove > GLOOMY_LUX_MAX ||
        payload.onBelow >= payload.offAbove ||
        payload.brightness < 10 ||
        payload.brightness > 100
      ) {
        throw new Error("Invalid gloomy-day settings");
      }
      await ha(`states/${GLOOMY.enabled}`).catch(() => {
        throw new Error("The gloomy-day rule is not set up in Home Assistant");
      });
      await callService("input_number", "set_value", { entity_id: GLOOMY.onBelow, value: payload.onBelow });
      await callService("input_number", "set_value", { entity_id: GLOOMY.offAbove, value: payload.offAbove });
      await callService("input_number", "set_value", { entity_id: GLOOMY.brightness, value: payload.brightness });
      return callService("input_boolean", payload.enabled ? "turn_on" : "turn_off", { entity_id: GLOOMY.enabled });
    case "set_outside_schedule": {
      const dimmer = OUTSIDE_DIMMERS.includes(payload.key);
      if (
        !OUTSIDE_KEYS.includes(payload.key) ||
        typeof payload.scheduled !== "boolean" ||
        !["dusk", "time"].includes(payload.onMode) ||
        !["dawn", "time"].includes(payload.offMode) ||
        !TIME.test(payload.onTime) ||
        !TIME.test(payload.offTime) ||
        (dimmer && !(Number.isInteger(payload.brightness) && payload.brightness >= 10 && payload.brightness <= 100))
      ) {
        throw new Error("Invalid outside light schedule");
      }
      const ids = outsideEntities(payload.key);
      await callService("input_select", "select_option", { entity_id: ids.onMode, option: payload.onMode });
      await callService("input_datetime", "set_datetime", { entity_id: ids.onTime, time: `${payload.onTime}:00` });
      await callService("input_select", "select_option", { entity_id: ids.offMode, option: payload.offMode });
      await callService("input_datetime", "set_datetime", { entity_id: ids.offTime, time: `${payload.offTime}:00` });
      if (dimmer) {
        await callService("input_number", "set_value", { entity_id: ids.brightness, value: payload.brightness });
      }
      // Last, so the schedule automation re-applies with all new values in place.
      return callService("input_boolean", payload.scheduled ? "turn_on" : "turn_off", { entity_id: ids.scheduled });
    }
    default:
      throw new Error(`Action not allowed: ${action}`);
  }
}

// ------------------------------------------------------------------- sync

const waterSensorStates = (states) =>
  states.filter(
    (s) =>
      /^binary_sensor\.[a-z0-9_]+$/.test(s.entity_id) &&
      s.attributes?.device_class === "moisture" &&
      !/weather_station|rain/.test(s.entity_id),
  );

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
      dimmable: (state.attributes?.supported_color_modes ?? []).some((mode) => mode !== "onoff"),
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
      const time =(id) => (/^\d{2}:\d{2}:\d{2}$/.test(byId.get(id)?.state ?? "") ? byId.get(id).state : null);
      const number = (id) => {
        const value = Number.parseFloat(byId.get(id)?.state);
        return Number.isFinite(value) ? value : null;
      };
      const times = (mode) => {
        const ids = scheduleEntities(zone, mode);
        if (!byId.has(ids.dayTemp)) return null;
        return {
          dayStart: time(ids.dayStart),
          nightStart: time(ids.nightStart),
          dayTemp: number(ids.dayTemp),
          nightTemp: number(ids.nightTemp),
        };
      };
      const cool = times("cool");
      return {
        zone,
        enabled: byId.get(scheduleEntities(zone).enabled).state === "on",
        // The top-level fields are the cool schedule, for websites from before the heat/cool split.
        ...cool,
        cool,
        heat: times("heat"),
      };
    },
  );

  // Only fixtures whose helpers exist in Home Assistant are reported.
  const stateOf = (id) => byId.get(id)?.state;
  const onOff = (id) => (stateOf(id) === "on" ? true : stateOf(id) === "off" ? false : null);
  const hhmmss = (id) => (/^\d{2}:\d{2}:\d{2}$/.test(stateOf(id) ?? "") ? stateOf(id) : null);
  const outsideSchedules = OUTSIDE_KEYS.filter((key) => byId.has(outsideEntities(key).scheduled)).map((key) => {
    const ids = outsideEntities(key);
    const brightness = Number.parseFloat(stateOf(ids.brightness));
    return {
      key,
      scheduled: onOff(ids.scheduled),
      onMode: ["dusk", "time"].includes(stateOf(ids.onMode)) ? stateOf(ids.onMode) : null,
      onTime: hhmmss(ids.onTime),
      offMode: ["dawn", "time"].includes(stateOf(ids.offMode)) ? stateOf(ids.offMode) : null,
      offTime: hhmmss(ids.offTime),
      brightness: OUTSIDE_DIMMERS.includes(key) && Number.isFinite(brightness) ? brightness : null,
      shouldBeOn: onOff(ids.desired),
    };
  });

  const motionTimers = MOTION_TIMERS.filter((id) => byId.has(id)).map((id) => {
    const timer = byId.get(id);
    return {
      entity: id,
      state: timer.state,
      finishesAt: timer.state === "active" ? (timer.attributes?.finishes_at ?? null) : null,
    };
  });
  // Gym idle controller inputs: the ceiling PIR and the school-year dates.
  const gymSensor = byId.get(GYM_MOTION);
  const gymMotion = gymSensor
    ? {
        motion: gymSensor.state === "on",
        clearSince: gymSensor.state === "off" ? gymSensor.last_changed : null,
        schoolYearStart: byId.get("input_datetime.gym_school_year_start")?.state ?? null,
        schoolYearEnd: byId.get("input_datetime.gym_school_year_end")?.state ?? null,
      }
    : null;
  const kitchenSensors = KITCHEN_MOTION.map((id) => byId.get(id)).filter(Boolean);
  const kitchenMotion = kitchenSensors.length
    ? {
        motion: kitchenSensors.some((s) => s.state === "on"),
        // When the last sensor went clear; the lights go off 20 minutes later.
        clearSince: kitchenSensors.every((s) => s.state === "off")
          ? kitchenSensors.map((s) => s.last_changed).sort().at(-1)
          : null,
      }
    : null;

  // UniFi network, view-only (Network tab, admins only). Equipment = UniFi
  // devices with <name>_state and <name>_uptime sensors. The Wi-Fi on/off
  // switches are never reported.
  const pct = (id) => num(Number.parseFloat(byId.get(id)?.state));
  const network = {
    equipment: states
      .filter((s) => /^sensor\.[a-z0-9_]+_state$/.test(s.entity_id) && byId.has(s.entity_id.replace(/_state$/, "_uptime")))
      .map((s) => {
        const base = s.entity_id.slice("sensor.".length, -"_state".length);
        const update = byId.get(`update.${base}_firmware`);
        const tracker = byId.get(`device_tracker.${base}`);
        return {
          name: (s.attributes?.friendly_name ?? base).replace(/\s+State$/, "").replace(/\s+/g, " ").trim(),
          ip: tracker?.attributes?.ip ?? null,
          mac: tracker?.attributes?.mac ?? null,
          uplinkMac: byId.get(`sensor.${base}_uplink_mac`)?.state ?? null,
          temperature: pct(`sensor.${base}_temperature`),
          state: s.state,
          upSince: byId.get(`sensor.${base}_uptime`)?.state ?? null,
          cpu: pct(`sensor.${base}_cpu_utilization`),
          memory: pct(`sensor.${base}_memory_utilization`),
          updateAvailable: update ? update.state === "on" : null,
        };
      }),
    wifi: states
      .filter((s) => /^sensor\.bethel_school_[a-z0-9_]+_clients$/.test(s.entity_id))
      .map((s) => ({
        name: (s.attributes?.friendly_name ?? s.entity_id).replace(/\s+Clients$/, "").replace(/^Bethel_School_/, ""),
        clients: pct(s.entity_id),
      })),
    devices: states
      .filter((s) => s.entity_id.startsWith("device_tracker.") && s.attributes?.source_type === "router")
      .map((s) => ({
        name: trackerName(s),
        online: s.state === "home",
        ip: s.attributes?.ip ?? null,
        wifi: s.attributes?.essid ?? null,
        apMac: s.attributes?.ap_mac ?? null, // the access point it's connected to
        since: s.last_changed ?? null,
      })),
  };

  // Flood sensors (moisture binary sensors, not the weather station's rain sensor).
  const waterSensors = waterSensorStates(states).map((s) => {
    const base = s.entity_id.slice("binary_sensor.".length);
    const cable = byId.get(`binary_sensor.${base}_cable_unplugged`);
    return {
      entity: s.entity_id,
      name: s.attributes?.friendly_name ?? base,
      leak: s.state === "on" ? true : s.state === "off" ? false : null,
      since: s.last_changed ?? null,
      battery: pct(`sensor.${base}_battery`),
      cableUnplugged: cable ? cable.state === "on" : null,
    };
  });

  const automation = byId.get(config.automation);
  return {
    waterSensors,
    projectors: PROJECTORS.filter((id) => byId.has(id)).map((id) => ({
      entity: id,
      name: byId.get(id).attributes?.friendly_name ?? id,
      state: byId.get(id).state,
    })),
    motionTimers,
    kitchenMotion,
    gymMotion,
    network,
    bellsEnabled: isOn(BELLS_ENABLED),
    automationEnabled: automation ? automation.state === "on" : null,
    bells,
    lights,
    thermostats,
    thermostatSchedules,
    outsideSchedules,
    switchLights: [...CLASSROOM_SWITCH_LIGHTS, ...SWITCHABLE_SWITCH_LIGHTS].filter((id) => byId.has(id)).map((id) => ({
      entity: id,
      name: byId.get(id).attributes?.friendly_name ?? id,
      on: onOff(id),
      brightness: null,
    })),
    isDark: byId.has(OUTSIDE_IS_DARK) ? byId.get(OUTSIDE_IS_DARK).state === "on" : null,
    outsideLux: byId.has(DARK_LUX)
      ? {
          now: pct(LUX_SENSOR),
          darkBelow: pct(DARK_LUX),
          lightAbove: pct(LIGHT_LUX),
          since: await luxSince({
            darkBelow: pct(DARK_LUX),
            lightAbove: pct(LIGHT_LUX),
            onBelow: pct(GLOOMY.onBelow),
            offAbove: pct(GLOOMY.offAbove),
          }).catch((error) => {
            errors.push(`Light sensor history: ${error.message}`);
            return null;
          }),
        }
      : null,
    gloomy: byId.has(GLOOMY.enabled)
      ? {
          enabled: byId.get(GLOOMY.enabled).state === "on",
          onBelow: pct(GLOOMY.onBelow),
          offAbove: pct(GLOOMY.offAbove),
          brightness: pct(GLOOMY.brightness),
        }
      : null,
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

// The website only asks for fresh state while someone has it open, so check
// the flood sensors every minute and report straight away when one changes.
let lastLeaks = null;
setInterval(async () => {
  try {
    const leaks = waterSensorStates(await ha("states"))
      .map((s) => `${s.entity_id}=${s.state}`)
      .sort()
      .join(",");
    if (lastLeaks !== null && leaks !== lastLeaks) {
      log(`Flood sensor changed: ${leaks}`);
      sync("water sensor changed");
    }
    lastLeaks = leaks;
  } catch {
    // Home Assistant unreachable; the next check retries.
  }
}, 60_000);

log(`Bethel School bridge starting. Website: ${config.siteUrl}  Home Assistant: ${config.haUrl}`);
try {
  const info = await ha("");
  log(`Home Assistant reachable: ${info.message ?? "ok"}`);
} catch (error) {
  log(`WARNING: can't reach Home Assistant yet (${error.message}). Will keep trying.`);
}
listen();
