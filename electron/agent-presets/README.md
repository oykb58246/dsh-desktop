# Bundled agent presets

Community DeepSeek Harness agent presets shipped with DSH Desktop.

At boot, `companion-presets.mjs` copies each directory into
`$DSH_HOME/.agent-presets/<id>` so they show up in the new-session picker.

| Directory | Upstream | What it does |
|---|---|---|
| `anchored-standard/` | [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) @ `0398c5a` | First request uses the official Minimal tool pair, then unlocks Standard tools on demand. |
| `router-standard/` | [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) (`preset` @ `eff787e`) | Classifies the first user message and picks a planning vs doing reasoning mode. |

A folder we previously installed carries `.dsh-desktop-bundled.json`. App
updates refresh those copies. A same-id folder without the stamp is treated
as user-authored and is not overwritten.

Both upstream projects are MIT. Original `LICENSE` / `NOTICE` files stay
beside each preset.
