# Optional overrides

Drop a file here **before the first launch** (or delete `data/state.json` and restart)
to replace the generated defaults.

- `codes.json` — pick your own 5-digit codes instead of random ones.
- `jokers.json` — rewrite the two jokers of each team: name, requirement, effect, duration.

Both files are plain JSON. Copy the `.example` files next to them and remove the
`.example` suffix. If a file is missing or invalid, the app falls back to its defaults
and says so in the server log.

## Joker effects

| `effect`           | What it does                                                      | uses `durationMin` |
|--------------------|-------------------------------------------------------------------|--------------------|
| `snapshot_pin`     | Drops a frozen pin on each opponent's current position             | no                 |
| `reveal_opponents` | The team that played it sees the other team live                   | yes                |
| `reveal_live`      | Same as `reveal_opponents`                                         | yes                |
| `block_reveal`     | The other team cannot get any location access                      | yes                |
| `freeze`           | The other team is told to stay put (timer on their screen)         | yes                |

Set `"requiresApproval": false` on a joker to make it fire instantly, without the admin.
