# Bethel School Home Assistant apps

Home Assistant apps (add-ons) for Bethel School.

| App | Purpose |
| --- | --- |
| [Bethel School Bridge](bethel_school_bridge/) | Connects the staff website's Building page to Home Assistant |

## Install

In Home Assistant: **Settings → Apps (Add-ons) → App store (Add-on store) → ⋮ → Repositories**,
add `https://github.com/bethelschool26-cmd/bethel-ha-addons`, then install **Bethel School Bridge**.
See the app's **Documentation** tab for configuration.

This repository is public and contains **no secrets**. Tokens are entered only in the
app's Configuration tab inside Home Assistant.

## Maintainers

`bethel_school_bridge/bethel-bridge.mjs` is a copy of `bridge/bethel-bridge.mjs` from the
private website repository (`homeworth-school`). Change it there, copy it here, bump
`version` in `config.yaml`, add a CHANGELOG entry, and push. Home Assistant then offers
the update.
