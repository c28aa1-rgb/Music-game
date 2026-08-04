# Hitster Digital

A party game for a room with one screen and a pile of phones. A song plays with
its year hidden; you say where it belongs on your timeline. Get it right and you
keep the card. First to ten wins.

The TV screen holds the music. Phones hold the game.

---

## What you need

- **Node 18 or newer**
- **A Spotify Premium account** for the TV screen only. The Web Playback SDK
  refuses to play audio on a free account. Nobody else signs in to anything.
- Everyone on the same wifi (or a deployed copy — see below).

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Create a Spotify app

Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
and create an app. In its settings:

- **Redirect URIs** — add `http://127.0.0.1:3000/callback`

  It has to be `127.0.0.1`. Spotify stopped accepting `http://localhost` in April
  2025, and the URI must match character for character.

- **APIs used** — tick *Web API* and *Web Playback SDK*.

Copy the **Client ID**. There is no client secret here: the app uses OAuth with
PKCE, so nothing secret ever reaches the browser.

### 3. Configure

```bash
cp .env.example .env
```

Put your Client ID in `SPOTIFY_CLIENT_ID`.

### 4. Start

```bash
npm start
```

The console prints the two addresses you need — the TV URL and the LAN address
for phones.

### 5. Connect Spotify, pick your sets, and build the song pool

Open **`http://127.0.0.1:3000/tv`** on the screen you'll play on and click
**Connect Spotify**.

Then open **`http://127.0.0.1:3000/resolve`** once and click **Match all songs**.

This step exists for a reason. `song-catalog.json` ships with titles, artists and
years but no Spotify track IDs, because writing plausible-looking IDs by hand
produces a pool that silently fails to play. The resolver searches Spotify for
each entry using the session you just signed in with, then fills in the real
track URIs and album art. **Save to server** makes the pool live immediately;
**Download songs.json** gives you a copy to keep in the repo so you never run
this again.

Rows flagged `check` matched something with a noticeably different name — worth a
glance before you save. Rows flagged `no match` usually mean the catalogue's
title isn't spelled the way Spotify spells it: censored titles are the common
case (Spotify lists `Ni**as In Paris`, so the uncensored spelling finds nothing).
Fix the title in `song-catalog.json` and re-run.

**Song sets.** The same page has eleven toggles: **Classic** (one song per year,
1960–2023), six genres, and four eras. Sets **stack** rather than narrow — a song
is dealt if it belongs to *any* switched-on set, so Pop + 2000s gives you all the
pop plus all the 2000s. Each toggle shows how many of its songs are matched and
ready, the running total sits underneath, and a selection too small to play is
called out before you try to start. The choice is saved to `sets.json`.

The TV carries the same toggles, minus the matching table: the lobby names the
sets in play under the player list, the topbar keeps a compact tag while a game
runs, and either one opens a **Song sets** panel with the full grid of counts.
Changing sets there takes effect immediately for the next game — a game already
running keeps the deck it was dealt, and the panel says so. Matching songs to
Spotify stays on `/resolve`, since that is a long table and a job for a laptop.

Every genre holds at least 64 songs and every era at least 73, so any single set
is enough for a full game on its own once matched.

**Year checking.** A wrong release year breaks placement silently — you'd be
marked incorrect while being right. So matching records Spotify's own release
year next to the catalogue's and flags any disagreement.

The catalogue year wins by default, because Spotify's `release_date` describes
the version it is serving, and for older songs that is usually a remaster or a
greatest-hits reissue. Searching "Let It Be" returns *Let It Be — Remastered
2009*. To stop that skewing everything, the matcher pulls ten results, discards
karaoke, tribute, live and re-recorded versions, and among the remaining good
matches takes the **earliest** release — which is nearly always the original.
That alone removes most disagreements.

Where Spotify is genuinely right, the **use** button on that row takes its year;
saving then writes the correction into `song-catalog.json` so it survives a
restart. There is deliberately no bulk-accept — applying Spotify's dates
wholesale would trade correct original years for remaster dates.

Matching only fetches songs you haven't matched yet, so growing the catalog later
costs one short run rather than re-resolving everything. Untick the box to force
a full re-match.

### 6. Play

Reload `/tv`. It shows a room code and a QR code. Everyone scans it, types a
name, and the first person to join starts the game.

---

## How a turn works

A song plays. Its year, title and artist stay on the server — the phones are
never sent them, so there is nothing to find in devtools.

**The player whose turn it is** sees their timeline with a dashed gap between
every card. Tap the gap, confirm, and the card flips on the TV. Right, and it
lands on their timeline. Wrong, and it's gone.

**Everyone else** gets a **Steal** button, pinned to the top of the screen. It
stays locked for the first 10 seconds of the song and counts itself down, so a
song has to actually be heard before anyone can pounce. When it opens, the TV
says so and a blip sounds.

Hit it and the music stops. You get **six seconds** for both questions — the
title on one screen, the artist on the next. Tapping *is* the answer; there's no
confirm step, because six seconds is not long enough to review a form. A clock
ticks on the TV so the room can watch it run out.

- **Both right** → the turn is yours, and you place the card on your own
  timeline. You can still blow the placement.
- **Either wrong, or the clock runs out** → you're locked out of stealing for
  the rest of that song, *and* a random card comes off your timeline and goes
  back in the crate. One shot each per turn, and it isn't free.

Either way the verdict holds the whole room for a couple of seconds before play
resumes. That pause is a real phase on the server, not a TV animation: nobody
can place a card while it is up. Handing the turn straight back instead let the
placer commit during the verdict, which started the reveal countdown before the
TV had finished showing the steal — so the reveal was cut short and the turn
appeared to end seconds after it resumed.

**A wrong placement doesn't remove the song from the game.** It goes onto a
discard pile, which gets reshuffled back into the deck once the deck itself
runs dry — so the game keeps going on whatever cards it has rather than ending
early because a run of guesses happened to be wrong. Only if every song is
either correctly placed on someone's timeline or discarded-and-reused with
nothing left anywhere does the game fall back to declaring whoever has the
most cards the winner.

**One card from the target and the TV says so.** The player's name is announced
across the screen, a cue sounds, and their pill in the player bar turns amber
with an expanding ring and a *1 to win* tag that stays there until they either
win or lose a card to a failed steal. The timeline is also at its longest around
then, so it scales itself down to keep all ten cards on screen at once.

First to **10 cards** wins. Change it with `TARGET_CARDS` in `.env`.
`MIN_DECK_BUFFER` (default 8 — extra songs required beyond the player count
before a game may start) is about giving a game variety now that recycling
exists, not "won't the game just end abruptly" — safe to lower for a small
custom set.

The host — whoever joined first — can start a new game once someone wins, and if
they drop out the role passes to the next connected player. The host can also
hand the role to someone else on purpose, from the lobby roster, without
needing to disconnect.

There is deliberately **no skip button** in normal play, because Hitster has no
such move. It appears for the host only when the TV reports that a track actually
refused to play, which would otherwise leave the turn stuck.

---

## Deploying to Render

The free tier runs a real Node process and speaks WebSockets, which is what
Socket.io needs. Netlify and Firebase Hosting can't do this — they have no
long-lived server to hold a socket open.

1. Push this repo to GitHub.
2. On Render, create a **Web Service** from the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add the environment variable `SPOTIFY_CLIENT_ID`. Leave `PORT` alone — Render
   sets it.
4. Add `https://<your-app>.onrender.com/callback` to your Spotify app's redirect
   URIs, alongside the `127.0.0.1` one. Both can coexist.

**Free tier caveat:** the service sleeps after 15 minutes idle and takes about
50 seconds to wake. Open the TV screen before people arrive and it'll be warm.

Commit a resolved `songs.json` before deploying. Render's filesystem resets on
every deploy, so a pool saved through `/resolve` in production won't survive one.

---

## Project layout

```
server.js              Express + Socket.io. Owns all game state and every hidden year.
song-catalog.json      404 songs, 1960-2023, tagged by genre. The curated source of truth.
                       Years are original release years, not reissue dates.
songs.json             Spotify ids and album art, filled in by /resolve. Merged with
                       the catalog on boot, so growing the catalog keeps existing matches.
sets.json              Which genres and eras are switched on (created on first save).
public/
  theme.css            Shared design tokens — colours, type, motion.
  tv.html/.css/.js     The shared screen. Spotify SDK lives here.
  controller.html/…    The phone. Seven screens, one state machine.
  spotify-auth.js      OAuth 2.0 PKCE. Used by the TV and the resolver.
  callback.html        OAuth landing page.
  resolve.html         One-time song pool builder.
```

### Socket events

| Phone → server | |
|---|---|
| `join_game` `{ name, code }` | Join, or reclaim a seat under the same name |
| `rejoin` `{ playerId, code }` | Silent reconnect after a dropped connection |
| `start_game` | Host only |
| `new_room` | Host or TV. Abandons this game and opens a fresh code |
| `transfer_host` `{ playerId }` | Host only. Hands the role to a connected player |
| `place_card` `{ gapIndex }` | Commit a placement |
| `attempt_steal` | Claim the steal. First press wins |
| `submit_steal_answer` `{ titleIndex, artistIndex }` | The stealer's multiple-choice pick |
| `ready_next_turn` | Advance past the reveal |
| `skip_song` | Host only |

| Server → clients | |
|---|---|
| `game_state` | The whole public game. Broadcast to everyone on every change |
| `song_started` `{ spotifyUri }` | **TV only.** A URI to play — no metadata |
| `pause_music` / `resume_music` / `stop_music` | TV only |
| `steal_attempt`, `steal_result` | TV only, for the overlay |
| `steal_choices` `{ titleOptions, artistOptions }` | Sent only to the stealer's own socket, never broadcast |
| `room_closed` `{ code }` | This room ended; here's the new one to join |

`game_state` is the single source of truth; both clients render straight from
it. The one-shot events exist only to drive audio and animation.

---

## Design

**Arctic Frost**, adapted from the theme-factory preset. The preset defines four
colours and no state colours, so the amber and the brick red below are additions;
everything else is its palette. Its DejaVu Sans pairing is a PDF-safe stack
rather than a web font, so it's substituted with Space Grotesk / Outfit / DM Mono.

| | | |
|---|---|---|
| Base | `#F4F8FD` | Cool near-white |
| Surface | `#FFFFFF` | Cards, pills, inputs |
| Accent | `#4A6FA5` | Steel blue — primary, correct, active |
| Accent 2 | `#E08A3C` | Amber — steals, waveform |
| Danger | `#C4453D` | Wrong answers |
| Text | `#1B2A3F` | Body |
| Muted | `#64789A` | Metadata |

Space Grotesk for years and counts. Outfit for prose. DM Mono for the things a
piece of equipment would display — room codes, timers, track position.

Tokens in `theme.css` are semantic (`--bg`, `--accent`, `--danger`…) rather than
named after colours, so retheming means editing one `:root` block and nothing
else.

The signature is the rail: a lit track running edge to edge across the TV with a
light sweeping along it, years set above, and song cards hanging underneath on
drop-lines. A kept card flies down off the reveal and slams into place.

---

## Notes

- **Placing is a picker wheel, held in portrait.** The card being placed is
  fixed dead centre and the years scroll past it, parting around it as they
  cross — years above slide up, years below slide down, so the gap is always in
  the middle. There is only ever one gap: a year is never itself a target, so
  nothing needs selecting but the space between two of them. Rows shrink and
  fade with distance. Scroll-snap settles on zero-height markers sitting on each
  boundary, including before the first year and after the last.
  Rendering a slot row between every year instead would half-fill the list with
  empty space — for ten cards that was 1826px of rail versus 1206px now.
- **The wheel's scroller is positioned, not `height: 100%`.** As a percentage it
  resolved against an indefinite flex height and grew with its own content,
  which broke the padding maths that lets the first and last slots reach the
  centre. It is pinned with `inset: 0` instead, and re-measured on the frame
  after the screen appears, since the layout is still settling before that.
- **`Number(x) || fallback` silently eats an explicit `0`.** `0` is falsy, so
  `STEAL_LOCK_MS=0` in `.env` would quietly become `10000` instead of "no
  lockout." Every timing constant now goes through a small `envInt()` helper
  that only falls back when the variable is genuinely unset.
- **Sound effects are synthesised, not sampled.** `sfx.js` builds every cue from
  oscillators and gain envelopes at play time: the steal stinger, the per-second
  tick, the correct and wrong chimes, the card landing, the win fanfare. Nothing
  to host, nothing to license, and the ticking lines up with the server's
  deadline instead of drifting against a fixed-length sample. The same tap that
  unblocks Spotify playback unblocks the AudioContext.
- **`songs.json` is backed up before every save.** Resolving is slow to redo, so
  `POST /api/songs` copies the previous pool to `songs.backup.json` first, and
  `POST /api/songs/restore` puts it back. The backup is only taken when the
  current pool carries Spotify album art — otherwise a throwaway pool could
  overwrite the good backup and leave no copy anywhere. On boot, a pool with
  track ids but no album art is flagged, since that means the file was written
  by something other than `/resolve` and those ids will not play.
- **Tests never touch the live pool.** `SONGS_FILE` points the server at a
  different pool file; the suites run against `songs.test.json` on a second port
  with compressed timings, so a killed test can't take the resolved pool with it.
- **The placer never sees the title.** Recognising a song by name is far easier
  than by ear, and that recognition is the entire game, so the card being placed
  stays blank until the reveal.
- **The reveal advances itself** after `REVEAL_MS` (5s by default, set it in
  `.env`). The button is only there to cut the wait short; whichever fires first
  wins and the other is cancelled.
- **The TV always has something on screen.** A signed-in screen dismisses the
  Spotify gate immediately, but the room is still several round trips away —
  the SDK has to load, the player has to reach ready, and only then is there a
  state to draw. That stretch used to be blank, and stayed blank if the SDK
  never loaded at all, which looks exactly like a broken page. A connecting
  screen now covers it, naming the step it is on, and after ten seconds it says
  what is probably wrong (blocked `sdk.scdn.co`, expired sign-in, or an account
  without Premium) and offers a reload and a re-sign-in.
- **Unblocking audio happens quietly, not as a screen to clear.** Browsers block
  a page from starting audio until it has been interacted with, and this game is
  started from a phone — so the TV could otherwise sit in silence with no error.
  `activateElement()` is attempted the moment the player is ready, and again off
  any click or key press anywhere on the page, so in practice it is unlocked
  before anyone notices. A full-screen prompt appears only when a song is
  genuinely waiting and every quiet attempt has been refused; the held track
  plays the instant it is dismissed.
- **A TV that reloads mid-turn gets the current track re-sent.** `song_started`
  is a one-shot fired when the turn begins, so a screen that joins after that
  point would stay silent until the next turn. Registering mid-turn now replays
  it to that socket.
- **The device is claimed before every play.** Each load of `/tv` registers a
  new "Hitster TV" device with Spotify, and the previous one stays listed for a
  while after the page is gone. Playback could land on a stale device, and when
  it did, `getCurrentState()` on the live page returned `null` — freezing the
  progress bar at 0:00 while Spotify reported the track as playing. A transfer
  immediately before each play keeps this page authoritative, and the progress
  loop treats a `null` state during a turn as drift and pulls playback back
  (rate-limited, since that loop runs twice a second).
- **The waveform is decorative.** Spotify's stream is DRM-protected and cannot be
  routed through the Web Audio API, so there is no real amplitude to read. The
  bars run on randomised cycles and freeze when playback pauses.
- **Album art stays hidden until the reveal**, for the same reason as the title.
  The disc spins blank while the song plays and the art drops onto it on the flip.
- **The Web Playback SDK's `resume()` takes no arguments.** Starting a specific
  track goes through the Web API's `PUT /me/player/play` against this device,
  which is what the `user-modify-playback-state` scope is for.
- **`[hidden]` needs `!important` here.** The browser's own `[hidden]` rule lives
  in the UA stylesheet and loses to any author rule that sets `display` —
  including `.btn` and `.dock`. Without the override in `theme.css`,
  `el.hidden = true` silently does nothing to a flex element.
- **The timeline shrinks to fit, and `min-width: 0` is what makes that possible.**
  A grid item's automatic minimum size is its content, so a long timeline did not
  scroll — it widened `.groove-wrap` past its track and dragged the topbar, the
  now-playing block and the player bar off the side of the screen with it. That
  starts at the eighth card on a 1280px screen. With the overflow correctly
  belonging to `.groove-scroll`, `fitGroove()` then measures the natural width
  against the available width and sets `--tscale`, which every dimension in the
  row is expressed as a fraction of. Ten cards lands around 0.93 on a 1080p
  screen and 0.74 at 1280px; below 0.55 it stops shrinking and scrolls instead.
  The width is measured rather than computed, because the card size is a
  `clamp()` of viewport units and only the browser knows what that came out as.
- **Match point is announced once per arrival, not once per render.** Reaching
  one card from the target is tracked as a set of player ids and diffed, so a
  re-render does not re-announce, a TV that reloads mid-game does not announce a
  position it never saw being reached, and a player knocked back by a failed
  steal gets announced again when they climb back up.
- **Two songs from the same year can go either side of each other.** The
  placement check uses `>=` / `<=`, so when a drawn card ties with one already on
  the timeline, both positions count as correct — same as the physical game.
  This matters most in a single-era set, where 64 songs are squeezed into ten
  years and most placements are between neighbours a year or two apart. That set
  being hard is the point; Classic is the gentle one.
- **Years are release years**, and a few are arguable where a single and its
  album straddle a new year. The resolver's year check will surface these — edit
  `song-catalog.json` if a call bothers you.
