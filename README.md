# middle

Find places to meet in the middle on macOS, then let the group vote on
[ChattyMaps](https://chattymaps.com).

```bash
$ middle "Clapham" "Walthamstow" pubs

Middle: Hoxton, London (51.5229, -0.0792)
2 starting places, up to 15 km apart · searched within 1 km
Straight-line middle, not travel time. Places from Apple Maps.

1. The Wenlock Arms (pub)
   26 Wharf Road
   580 m from the middle · 7.9 km from Clapham · 7.6 km from Walthamstow

2. …

Vote here: https://chattymaps.com/poll/abc123

Manage it: https://chattymaps.com/poll/abc123#manage=…
  Keep this link to yourself. The first browser to open it becomes the organiser
  (edit, close, decide), and then the link stops working. Unused, it expires in 30 days.

Saved to: ~/Library/Application Support/chattymaps-middle/polls.jsonl (private, owner-only)
  Stores the poll title, area, place names, vote link and manage link — never your starting places.
  View later with `middle history` or `middle last`. Pass --no-save to skip saving.
```

Share the link and everyone votes on the places, or adds a better one. No
account and no API key.

## Install

Requires **macOS**, Node 20 or later, and Apple's Command Line Tools
(`xcode-select --install`). There are no npm dependencies.

```bash
git clone https://github.com/etewiah/meet-in-the-middle-chattymaps.git
cd meet-in-the-middle-chattymaps
npm link          # puts `middle` and `middle-with-me` on your PATH
middle "Brixton" "Camden" --preview
```

Or run without linking:

```bash
node bin/middle.js "Brixton" "Camden" --preview
node bin/middle-with-me.js "Camden" pubs --preview
```

## Examples

```bash
# Try it without creating a poll (stays completely offline from ChattyMaps)
middle "Clapham" "Walthamstow" pubs --preview

# Meet halfway between where you are right now and someone else
middle-with-me "Walthamstow" pubs --preview
middle-with-me "Camden" "Brixton" --what=bars

# Three or more people — use --what so the last place isn't read as the venue type
middle "Brixton" "Camden" "Hackney" --what="pubs with a garden"

# Postcodes and stations work too
middle "E1 6AN" "SW4 7AA" "King's Cross" --what=coffee

# Disambiguate common place names with --country
middle "Richmond" "Kingston" cafés --country=gb

# Create a titled poll with a deadline and open it straight in the browser
middle "Brooklyn" "Queens" "Hoboken" --what=ramen \
  --title="Friday dinner" --name="Sam" --days=3 --open

# Create a poll without saving anything to local history
middle "Clapham" "Walthamstow" pubs --no-save

# View or reopen previously created polls
middle history
middle last
middle last --open
middle history --clear

# Widen the net and ask for more options (e.g. from coordinates + a neighbourhood)
middle "51.5074,-0.1278" "Greenwich" parks --radius=2000 --count=8

# Pipe JSON to jq
middle "Clapham" "Walthamstow" pubs --preview --json | jq '.candidates[].name'
```

## Usage

```
middle <place> <place> [more places…] [what] [options]
middle-with-me <place> [more places…] [what] [options]
```

- With **three or more** words, the last is what to look for:
  `middle Clapham Walthamstow "pubs with a garden"`
- With **two**, both are starting places and it looks for cafés:
  `middle Brixton Camden`
- Use `--what` when every word is a starting place — without it,
  `middle Brixton Camden Hackney` will search for `"Hackney"` between Brixton
  and Camden:
  `middle Brixton Camden Hackney --what=bars`
- `middle-with-me` uses your Mac's current location via CoreLocation as the
  first starting place, so you only pass the other places:
  `middle-with-me Camden` (cafés), `middle-with-me Camden pubs`, or
  `middle-with-me Camden Brixton --what=bars`. On first run, macOS will prompt
  you to allow Location Services for your terminal (Wi-Fi must be on). Your
  location never leaves your Mac.

Starting places can be towns, stations, postcodes, or `"lat,lng"`. Up to 8
(7 other places with `middle-with-me`).

| Option | |
|---|---|
| `--what=TEXT` | What to look for (default: cafés), e.g. pubs, tapas, ramen, "pubs with a garden" |
| `--count=N` | Places to suggest, 2–10 (default: 5) |
| `--radius=M` | Search circle in metres, 100–5000 (default: 1000). Widens automatically if too few places are found |
| `--country=CC` | Look up starting places in one country (e.g. `gb`) |
| `--title=TEXT` | Poll title |
| `--name=TEXT` | Your name on the poll (default: Organiser) |
| `--days=N` | Close voting after N days, 1–90 |
| `--preview` | Show the places without creating a poll (never contacts ChattyMaps or saves anything) |
| `--no-save` | Do not save the created poll to local history |
| `--open` | Open the poll in your browser as its organiser (uses the one-time manage link) |
| `--json` | Print the raw JSON response |
| `--url=URL` | ChattyMaps server (default: `$CHATTYMAPS_URL`, then the public site) |

Point it at a local ChattyMaps with
`--url=http://localhost:4480` or `export CHATTYMAPS_URL=http://localhost:4480`.

## All lookups run locally through Apple Maps

`middle` takes the same approach as George Mandis's
[`nearme`](https://less.software/nearme/) and
[`whereami`](https://less.software/whereami/): it calls Apple's MapKit and
CoreLocation directly, through a small Swift helper (`src/mapkit-helper.swift`).
Geocoding, place search and naming the middle all happen on your Mac. That
means:

- No API keys, no accounts, and no server-side geocoding on ChattyMaps.
- **Your starting places never leave your Mac.** ChattyMaps receives only the
  midpoint, its area/country, and the chosen places.
- `--preview` doesn't contact ChattyMaps at all.

The helper is compiled on first use with Apple's Command Line Tools
(`xcode-select --install` if you don't have them). That takes about 15
seconds, and the result is cached in `~/Library/Caches/chattymaps-middle/`.

## Managing the poll

Creating a poll prints two links:

- **Vote here** is the link to share with the group.
- **Manage it** is for you. The first browser to open it becomes the
  organiser: it can edit places, close voting and pick the winner. Then the
  link stops working. Keep it private. If you don't use it, it expires after 30
  days. `--open` opens this link for you.

Organiser rights live in that browser, the same as for polls made on the
website. The design and the alternatives considered are in the ChattyMaps
repo, in `docs/MIDDLE_DECISIONS.md` (D8).

## Saved poll history

Because ChattyMaps has no user accounts, closing your terminal after creating a
poll without `--open` would otherwise lose both the unlisted **Vote here** link
and the one-time **Manage it** link.

To prevent that, every created poll is appended by default to a private,
owner-only (`0600`) file outside your current working directory:

```
~/Library/Application Support/chattymaps-middle/polls.jsonl
```

Every time a poll is saved, the CLI prints a `Saved to:` notice telling you
this exact path, what was stored, and how to skip it next time.

- **What is saved:** timestamp, poll ID, title, venue type (`what`), midpoint
  area label, suggested venue names, `Vote here` link, and `Manage it` link
  (+ expiry date).
- **What is never saved:** your starting places, postcodes, or your current
  location from `middle-with-me`. `--preview` runs never write to disk.
- **Why not the current folder:** storing links in macOS Application Support
  (instead of the folder you ran `middle` from) avoids cluttering directories
  and prevents accidentally committing private poll URLs or one-time manage
  secrets into a git repo.
- **Opt out:** pass `--no-save` on any run to write nothing to disk. The CLI
  confirms `Not saved (--no-save)` in its output.
- **Custom location:** set `CHATTYMAPS_MIDDLE_HISTORY=/path/to/file.jsonl`.

Manage your saved history with:

```bash
middle history           # list all saved polls
middle history --path    # print the exact file path
middle history --json    # print saved polls as JSON
middle history --clear   # delete the history file
middle last              # show the most recent saved poll
middle last --open       # open the most recent poll in your browser
```

See `docs/MIDDLE_DECISIONS.md` (D9) in the ChattyMaps repo for the full design
record.

## Why a vote?

The middle is an average of coordinates, and it knows nothing about what's
there. It can land in a river, beside a railway, or on the far side of a slow
bridge. The per-start distances show when the middle is lopsided, and the poll
lets the group fix it.

## How it works

The CLI geocodes the starting places locally with Apple Maps, averages them,
names the middle, and searches near it, widening from 1 km to 2 km and then
4 km if too few places turn up. It then sends `POST /api/middle` with only the
midpoint, area and chosen places, and ChattyMaps creates an unlisted poll
without performing any location lookups of its own.

The API contract is in the ChattyMaps repo, in `docs/MIDDLE_API.md`.

## Limits

- macOS only (uses MapKit and CoreLocation).
- Apple's search reads what you type as free text ("tapas", "ramen" and so on)
  but treats extra words like "with a garden" as a hint, not a filter.
- The middle is a straight line, not travel time.

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
npm test          # unit, CLI & Swift compile tests (offline)
npm run test:live # live Apple Maps & README example integration tests (macOS, network)
```
