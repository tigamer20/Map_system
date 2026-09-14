# Spy Map — live location game

A web app for a hide-and-seek / spy game played in a real city.
Two teams, an admin who approves everything, and a big viewer screen that sees it all.

- **Spies** hunt the other team. They cannot see anyone but themselves until the admin
  grants them access to the spied team's live position.
- **Spied** try to stay hidden. Their phones broadcast GPS all game; the question is
  only *who is allowed to look*.
- **Admin** (game master) approves location requests and jokers, can open or cut
  tracking manually, and can push a message to any team's phones.
- **Viewer** is the commentary screen: both teams live, every event, distances between
  players, and no way to influence the game.

Admin and viewer never appear on the map — only players carry markers.

## Run it

```bash
npm install
npm start
```

The server prints every access code on boot:

```
  Spy map running on http://localhost:3000

  Access codes:
  10458  player  spy     Spy 1
  ...
```

Open the URL, type a 5-digit code, and the device is bound to that role until it signs out.

### Phones need HTTPS

Browsers only give GPS to secure origins. `localhost` works on your laptop, but a phone
on your Wi-Fi does **not** — it needs `https://`. Two easy options:

```bash
# a free public https URL pointing at your local server
cloudflared tunnel --url http://localhost:3000
#   or
ngrok http 3000
```

Or deploy it: any Node host works (Render, Railway, Fly.io, a small VPS). Set the `PORT`
env var if the host requires one; everything else runs out of the box.

## Roles and codes

| | |
|---|---|
| Code format | exactly 5 digits |
| One code | one player slot, one marker, one name on the map |
| Re-login | allowed — the code keeps its identity and position |
| Deleting a code | signs that device out immediately |

The admin panel (**Codes** tab) creates, re-rolls and deletes codes live during a game.

To pick your own memorable codes instead of the random ones, copy
`config/codes.json.example` to `config/codes.json` **before the first launch**
(or delete `data/state.json` and restart):

```json
{
  "11111": { "role": "player", "team": "spy",   "label": "Spy 1" },
  "55555": { "role": "admin",  "label": "Game master" },
  "66666": { "role": "viewer", "label": "Viewer screen" }
}
```

## How a round plays out

1. Everyone signs in with their code. Players' phones start broadcasting GPS.
2. The spies open **Requests** and ask for the spied team's position, either
   **live tracking** (a countdown window) or a **snapshot** (one frozen pin).
3. The admin sees the request in **Approvals** and grants 3 min, 10 min, or denies it.
4. The spied team's phones get a *"You are exposed"* alert the moment access opens.
5. Either team can burn one of its **two jokers**. The admin checks the requirement
   before approving; the other team is notified as soon as it fires.
6. The viewer screen follows everything, with live distances between the two teams.

The admin can also open or cut tracking by hand at any time from the **Control** tab,
send a message to one or both teams, and reset the round (codes and sign-ins survive).

## Jokers

Two per team, each gated behind a requirement the admin validates:

| Team | Joker | Requirement | Effect |
|---|---|---|---|
| Spies | Satellite Ping | The whole spy team must be together at a bus stop or metro station | Drops a pin with each spied player's exact position, right now |
| Spies | Roadblock | Name out loud the district you think they are hiding in | The spied team must stay put for 10 minutes |
| Spied | Smoke Screen | Send the admin a photo of the street sign next to you | The spies get no location access for 15 minutes |
| Spied | Counter-Intel | Answer the admin's trivia question | The spied team sees every spy for 3 minutes |

Rewrite them freely: copy `config/jokers.json.example` to `config/jokers.json` and edit
names, requirements, durations and effects. See `config/README.md` for the list of
effects and for `"requiresApproval": false`, which makes a joker fire instantly without
the admin.

## Phone notifications

Every alert shows up in-app with a sound and a vibration. For alerts that land while the
phone is locked, tap **Enable phone alerts** in the app (Control / Device card):

- **Android:** works in Chrome straight away.
- **iPhone:** Safari → Share → *Add to Home Screen*, open the app from the home screen
  icon, then enable alerts. iOS only allows web push for installed apps.

Push keys (VAPID) are generated automatically on first boot and stored in
`data/state.json`.

## A more detailed map

The default basemap is CARTO Voyager (OpenStreetMap data) and shows shop and restaurant
names as you zoom in. The satellite button switches to Esri imagery with labels.

For the closest thing to Apple Maps — sharper POIs, house numbers, transit — get a free
[MapTiler](https://www.maptiler.com/) key and start the server with it:

```bash
MAPTILER_KEY=your_key npm start
```

The app then loads MapTiler's vector *Streets v2* style instead, with no other change.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `APP_NAME` | `OPERATION NIGHTFALL` | Title on the login screen |
| `MAPTILER_KEY` | — | Enables the MapTiler vector basemap |
| `DATA_DIR` | `./data` | Where `state.json` is written |
| `PUSH_SUBJECT` | `mailto:admin@example.com` | Contact address sent with web push |

## Project layout

```
server/index.js    HTTP + WebSocket, REST API, auth by code
server/store.js    State, persistence to data/state.json, config overrides
server/game.js     Visibility rules, requests, jokers, effects, events
server/push.js     Web push (VAPID)
public/index.html  Login (5-digit code)
public/app.html    Map app — adapts to player / admin / viewer
public/js/map.js   MapLibre basemaps, markers, snapshot pins, accuracy halo
public/js/app.js   Live state, panels, actions, alerts
config/            Optional codes.json / jokers.json overrides
```

Positions travel over a WebSocket and are filtered **server-side**: a spy's browser never
receives the spied team's coordinates unless a reveal is actually open. Positions live in
memory only — restarting the server clears the map but keeps codes and jokers.

## Good to know

- GPS accuracy is whatever the phone reports; each marker shows its own ± radius, and a
  player whose phone has been silent for 5 minutes fades out and is marked *signal lost*.
- Keep the app in the foreground while playing. Phones stop the GPS of background tabs;
  the app requests a screen wake lock where the browser supports it.
- There is no password beyond the code, and no encryption of positions at rest. It is a
  game for friends, not a security product — don't run it with strangers.
