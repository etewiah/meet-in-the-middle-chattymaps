# middle

Find places to meet in the middle, then let the group vote on
[ChattyMaps](https://chattymaps.etewiah.workers.dev).

```bash
$ middle "Clapham" "Walthamstow" pubs

Middle: Hoxton, London (51.5229, -0.0792)
2 starting places, up to 15 km apart · searched within 1 km
Straight-line middle, not travel time. Places from Apple Maps.

1. The Wenlock Arms (pub)
   26 Wharf Road
   580 m from the middle · 7.9 km from Clapham · 7.6 km from Walthamstow

2. …

Vote here: https://chattymaps.etewiah.workers.dev/poll/abc123
```

Share the link and everyone votes on the places, or adds a better one. No
account and no API key.

## Install

You need Node 20 or later. There are no dependencies.

```bash
git clone https://github.com/etewiah/meet-in-the-middle-chattymaps.git
cd meet-in-the-middle-chattymaps
npm link          # puts `middle` on your PATH
# or, without linking (add --preview to test without creating a poll):
node bin/middle.js "Brixton" "Camden" --preview
```

## Examples

```bash
# Try it without creating a poll (on a Mac, stays completely offline from ChattyMaps)
middle "Clapham" "Walthamstow" pubs --preview

# Three or more people — use --what so the last place isn't read as the venue type
middle "Brixton" "Camden" "Hackney" --what="pubs with a garden"

# Postcodes and stations work too
middle "E1 6AN" "SW4 7AA" "King's Cross" --what=coffee

# Disambiguate common place names with --country
middle "Richmond" "Kingston" cafés --country=gb

# Create a titled poll with a deadline and open it straight in the browser
middle "Brooklyn" "Queens" "Hoboken" --what=ramen \
  --title="Friday dinner" --name="Sam" --days=3 --open

# Widen the net and ask for more options (e.g. from coordinates + a neighbourhood)
middle "51.5074,-0.1278" "Greenwich" parks --radius=2000 --count=8

# Use OpenStreetMap via ChattyMaps instead of Apple Maps, or pipe JSON to jq
middle "Shoreditch" "Soho" tapas --source=chattymaps --preview
middle "Clapham" "Walthamstow" pubs --preview --json | jq '.candidates[].name'
```

## Usage

```
middle <place> <place> [more places…] [what] [options]
```

- With **three or more** words, the last is what to look for:
  `middle Clapham Walthamstow "pubs with a garden"`
- With **two**, both are starting places and it looks for cafés:
  `middle Brixton Camden`
- Use `--what` when every word is a starting place — without it,
  `middle Brixton Camden Hackney` will search for `"Hackney"` between Brixton
  and Camden:
  `middle Brixton Camden Hackney --what=bars`

Starting places can be towns, stations, postcodes, or `"lat,lng"`. Up to 8.

| Option | |
|---|---|
| `--what=TEXT` | What to look for (default: cafés). Pubs, bars, cafés, restaurants and parks, plus words like "with a garden" or "vegan" |
| `--count=N` | Places to suggest, 2–10 (default: 5) |
| `--radius=M` | Search circle in metres, 100–5000 (default: 1000). Widens automatically if too few places are found |
| `--country=CC` | Look up starting places in one country (e.g. `gb`) |
| `--title=TEXT` | Poll title |
| `--name=TEXT` | Your name on the poll (default: Organiser) |
| `--days=N` | Close voting after N days, 1–90 |
| `--preview` | Show the places without creating a poll |
| `--open` | Open the poll in your browser |
| `--json` | Print the raw JSON response |
| `--source=WHERE` | `apple`, `chattymaps` or `auto` (default: `apple` on a Mac, otherwise `chattymaps`) |
| `--url=URL` | ChattyMaps server (default: `$CHATTYMAPS_URL`, then the public site) |

Point it at a local ChattyMaps with
`--url=http://localhost:4480` or `export CHATTYMAPS_URL=http://localhost:4480`.

## On a Mac, Apple Maps does the lookups

On macOS, `middle` takes the same approach as George Mandis's
[`nearme`](https://less.software/nearme/) and
[`whereami`](https://less.software/whereami/): it calls Apple's MapKit and
CoreLocation directly, through a small Swift helper (`src/mapkit-helper.swift`).
Geocoding, place search and naming the middle all happen on your machine. That
means:

- No API keys, no accounts, and no OpenStreetMap servers.
- **Your starting places never leave your Mac.** ChattyMaps receives only the
  midpoint and the chosen places.
- `--preview` doesn't contact ChattyMaps at all.

The helper is compiled on first use with Apple's Command Line Tools
(`xcode-select --install` if you don't have them). That takes about 15
seconds, and the result is cached in `~/Library/Caches/chattymaps-middle/`.

Elsewhere, or with `--source=chattymaps`, ChattyMaps does the lookups with
OpenStreetMap data.

## Why a vote?

The middle is an average of coordinates, and it knows nothing about what's
there. It can land in a river, beside a railway, or on the far side of a slow
bridge. The per-start distances show when the middle is lopsided, and the poll
lets the group fix it.

## How it works

With Apple Maps, the CLI geocodes the starting places, averages them, names
the middle, and searches near it, widening from 1 km to 2 km and then 4 km if
too few places turn up. It then sends `POST /api/middle` with the midpoint and
the places, and ChattyMaps creates an unlisted poll.

With `--source=chattymaps`, the CLI sends the starting places instead, and
ChattyMaps does the same steps with OpenStreetMap data. It uses them only for
that request and doesn't store them.

The API contract is in the ChattyMaps repo, in `docs/MIDDLE_API.md`.

## Limits

- Apple's search reads what you type as free text ("tapas", "ramen" and so on)
  but treats extra words like "with a garden" as a hint, not a filter.
- The middle is a straight line, not travel time.
- A poll created here has no organiser controls in the browser yet. People
  can vote, add places and comment, but nobody can close it.
- The CLI can't read your device location for "between me and X". Pass your
  coordinates as `"lat,lng"` instead.

## Credit

Inspired by George Mandis's
[Let's Meet in the Middle](https://george.mand.is/2026/11/lets-meet-in-the-middle/),
which chains his [`whereami`](https://github.com/georgemandis/whereami) and
[`nearme`](https://github.com/georgemandis/nearme) tools on macOS. The Apple
Maps path borrows their key idea: macOS's own MapKit search is free, needs no
keys, and runs locally. The code is new (Swift and Node, where theirs is Zig),
and it adds a group vote, so the group can fix a middle that lands somewhere
awkward.

## Development

```bash
npm test    # node --test, no network
```
