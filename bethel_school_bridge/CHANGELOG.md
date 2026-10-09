# Changelog

## 1.14.0

- Reports the Commons projector and can turn it on or off (Songs page, school network only).

## 1.13.0

- Reports the flood sensors (leak, battery) for admins, and checks them every minute so a leak
  reaches the website right away.

## 1.12.0

- Reports when the light sensor passed each dusk/dawn and gloomy-day level, for the 10-minute hold countdowns.

## 1.11.0

- Reports and edits the gloomy-day rule (front eve + carport cans): on/off lux levels, brightness, on/off.

## 1.10.0

- Reports the gym ceiling motion sensor and the gym school-year dates, for the gym light countdowns.

## 1.9.0

- Network details: IP, MAC, uplink and temperature for each UniFi device, and which access
  point each Wi-Fi device is connected to.

## 1.8.0

- Reports and can switch every building light on a relay (library, office, halls, restrooms,
  locker rooms, mechanical rooms and more), not just the kitchen.

## 1.7.0

- Reports the UniFi network (view-only; never the Wi-Fi on/off switches), the motion-light
  timers and kitchen motion sensors, and the outside light sensor with its dark/light levels.
- Can change the outside dark/light levels (needs the outside-lux setup in Home Assistant).

## 1.6.0

- Reports which lights are dimmable and can set a light's brightness (gym and stage dimmer sliders).

## 1.5.0

- The kitchen lights (Shelly relay E Kitchen #1) are reported and can be switched from the website.

## 1.4.0

- Separate heat and cool thermostat schedules: reports both and saves the one the website
  chooses (thermostats_<zone>_heat_* for heat). Needs the thermostat-schedules setup in Home
  Assistant for the heat schedule; until then it behaves as before.

## 1.3.0

- Reports the classroom lights on Kasa motion switches (on/off, display only; never switched).

## 1.2.0

- Outside light schedules: reports and edits the per-light outside schedule helpers
  (outside_<key>_*) used by the website. Needs the outside-lights setup in Home Assistant.

## 1.1.0

- "Turn all bells on" on the website now also turns on the bell schedule automation
  (Bethel School - Daily Bell Schedule), so the website switch is the one master control.

## 1.0.0

- First release: bells, lights, thermostats and thermostat schedules.
