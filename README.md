# middle

Find places to meet in the middle, then let the group vote on
[ChattyMaps](https://chattymaps.etewiah.workers.dev).

```bash
$ middle "Clapham" "Walthamstow" pubs

Middle: Hoxton, London (51.5229, -0.0792)
2 starting places, up to 15 km apart · searched within 1 km
Straight-line middle, not travel time.

1. The Wenlock Arms (pub)
   26 Wharf Road
   580 m from the middle · 7.9 km from Clapham · 7.6 km from Walthamstow

2. …

Vote here: https://chattymaps.etewiah.workers.dev/poll/abc123
```

Share the link and everyone votes on the places, or adds a better one. No
account and no API key.

## Why a vote?

The middle is an average of coordinates, and it knows nothing about what's
there. It can land in a river, beside a railway, or on the far side of a slow
bridge. The per-start distances show when the middle is lopsided, and the poll
lets the group fix it.

## Install

You need Node 20 or later. There are no dependencies.

```bash
git clone <this repo> chattymaps-middle
cd chattymaps-middle
npm link          # puts `middle` on your PATH
# or, without linking:
node bin/middle.js "Brixton" "Camden"
```

## Usage

```
middle <place> <place> [more places…] [what] [options]
```

- With **three or more** words, the last is what to look for:
  `middle Clapham Walthamstow "pubs with a garden"`
- With **two**, both are starting places and it looks for cafés:
  `middle Brixton Camden`
- Use `--what` when every word is a starting place:
  `middle Clapham Walthamstow Brixton --what=bars`

Starting places can be towns, stations, postcodes, or `"lat,lng"`. Up to 8.

| Option | |
|---|---|
| `--what=TEXT` | What to look for (default: cafés). Pubs, bars, cafés, restaurants and parks, plus words like "with a garden" or "vegan" |
| `--count=N` | Places to suggest, 2–10 (default: 5) |
| `--radius=M` | Search circle in metres, 100–5000 (default: 1000). Widens automatically if too few places are found |
| `--country=CC` | Look up starting places in one country (e.g. `gb`) |
| `--title=TEXT` | Poll title |
| `--name=TEXT` | Your name on the poll (default: Organiser) |
| `--days=N` | Close voting after N days |
| `--preview` | Show the places without creating a poll |
| `--open` | Open the poll in your browser |
| `--json` | Print the raw JSON response |
| `--url=URL` | ChattyMaps server (default: `$CHATTYMAPS_URL`, then the public site) |

Point it at a local ChattyMaps with
`--url=http://localhost:4480` or `export CHATTYMAPS_URL=http://localhost:4480`.

## How it works

The CLI makes one `POST /api/middle` request. ChattyMaps looks up the
starting places, averages them, searches OpenStreetMap places near the
midpoint, and creates an unlisted poll. Starting places are used only for that
request and aren't stored. The API contract is in the ChattyMaps repo, in
`docs/MIDDLE_API.md`.

## Limits

- The middle is a straight line, not travel time.
- A poll created here has no organiser controls in the browser yet. People
  can vote, add places and comment, but nobody can close it.
- The CLI can't read your device location for "between me and X". Pass your
  coordinates as `"lat,lng"` instead.

## Credit

Inspired by George Mandis's
[Let's Meet in the Middle](https://george.mand.is/2026/11/lets-meet-in-the-middle/),
which chains his [`whereami`](https://github.com/georgemandis/whereami) and
[`nearme`](https://github.com/georgemandis/nearme) tools on macOS. This is a new
implementation with no code from those projects. It adds a group vote, so the
group can fix a middle that lands somewhere awkward.

## Development

```bash
npm test    # node --test, no network
```
