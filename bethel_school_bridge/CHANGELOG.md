# Changelog

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
