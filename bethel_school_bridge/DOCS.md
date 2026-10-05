# Bethel School Bridge

Connects the **Building** pages of the Bethel School staff website
(homeworthschool.com → Staff → Building) to this Home Assistant.

- **Outgoing connections only.** The app waits for a "check now" signal on a
  secret ntfy.sh topic, then fetches commands from the website with its token.
  Nothing on the school network is opened to the internet.
- **Fixed list of actions.** It will only change bell times and bell slots, turn
  all bells on/off, ring the bell, switch lights (`light.*`), set thermostats
  (`climate.*`, 60–80°F, off/heat/cool), and edit the thermostat schedule helpers
  (`thermostats_<zone>_*`). It refuses anything else.
- **Commands expire after 60 seconds**, so a delayed "ring bell" is never rung late.
- Home Assistant itself still runs the bell and thermostat schedules. If this app
  or the internet is down, they keep working; only the website's buttons stop.

## Configuration

| Option | What to enter |
| --- | --- |
| Website address | `https://homeworthschool.com` |
| Home Assistant address | `http://homeassistant:8123` (leave as is) |
| Bridge token | Same value as `BRIDGE_TOKEN` in Netlify |
| Signal topic | Same value as `NTFY_TOPIC` in Netlify |
| Home Assistant token | Long-lived token from the non-admin **Website Bridge** user (Profile → Security) |

After saving, start the app and open the **Log** tab. You should see
`Home Assistant reachable` and `Connected; waiting for signals from the website.`

## Changing tokens

- **Website side:** change `BRIDGE_TOKEN` / `NTFY_TOPIC` in Netlify (Project
  configuration → Environment variables), redeploy, then enter the same values here.
- **Home Assistant side:** create a new token on the Website Bridge user, paste it
  here, restart the app, then delete the old token.
- To cut the website off from Home Assistant immediately, stop this app or delete
  the Website Bridge user.
