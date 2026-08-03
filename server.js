/**
 * Hitster Digital — game server.
 *
 * This process is the referee. It owns every song's release year and never
 * transmits one to a phone until the placement has been resolved. The TV tab
 * receives a Spotify track URI so it can play audio, but no metadata it could
 * render, so the room genuinely cannot see the answer early.
 */

require('dotenv').config();

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

/**
 * `Number(x) || fallback` silently discards an explicit 0 — 0 is falsy, so
 * STEAL_LOCK_MS=0 in .env would quietly become 15000 instead of "no lockout".
 * This only falls back when the variable is genuinely unset or unparseable.
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const PORT = envInt('PORT', 3000);
const TARGET_CARDS = envInt('TARGET_CARDS', 10);
/** How long the reveal stays up before the game moves itself on. */
const REVEAL_MS = envInt('REVEAL_MS', 5000);
/** "Alex is up" breathing room between the reveal and the next song. */
const INTRO_MS = envInt('INTRO_MS', 3000);
/** Dead time at the start of a song where nobody may steal. */
const STEAL_LOCK_MS = envInt('STEAL_LOCK_MS', 10000);
/** How long a stealer gets to pick both answers once they've claimed. */
const STEAL_ANSWER_MS = envInt('STEAL_ANSWER_MS', 6000);
/**
 * How long the steal verdict owns the room. This is a real phase rather than a
 * TV-only animation: if play resumed the instant the answer landed, the placer
 * could commit a card while the verdict was still on screen, and the reveal
 * that followed would be cut short by a timer that had already been running.
 */
const VERDICT_MS = envInt('VERDICT_MS', 2800);
/**
 * Extra songs required beyond the player count before a game may start. Kept
 * generous by default so a real game has variety; the discard pile recycling
 * wrong guesses means it's no longer load-bearing for "won't the game just
 * end abruptly", so it's fine to loosen for a small custom set — or a test.
 */
const MIN_DECK_BUFFER = envInt('MIN_DECK_BUFFER', 8);
/**
 * Overridable so a test run can point at a throwaway pool and never touch the
 * resolved one. Resolving takes a while and losing it is genuinely costly.
 */
const SONGS_PATH = process.env.SONGS_FILE
  ? path.resolve(__dirname, process.env.SONGS_FILE)
  : path.join(__dirname, 'songs.json');
const BACKUP_PATH = `${SONGS_PATH.replace(/\.json$/, '')}.backup.json`;
// Overridable for the same reason as SONGS_PATH — lets a test point at a tiny
// throwaway catalog instead of exercising the real one.
const CATALOG_PATH = process.env.CATALOG_FILE
  ? path.resolve(__dirname, process.env.CATALOG_FILE)
  : path.join(__dirname, 'song-catalog.json');
const SETS_PATH = path.join(__dirname, 'sets.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Song pool
// ---------------------------------------------------------------------------

let songPool = [];

/** Spotify track URIs are the literal prefix plus a 22-character base62 id. */
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

/**
 * Sets are independent playlists, not filters that narrow each other. A song is
 * dealt if it belongs to ANY set that is switched on, so turning on Pop and
 * 2000s gives you all the pop plus all the 2000s rather than the sliver where
 * they overlap. That is what makes "64 songs in this set" a number you can
 * actually rely on.
 */
const SETS = [
  { id: 'classic', label: 'Classic', kind: 'special', blurb: 'One song per year, 1960 to 2023' },
  { id: 'pop', label: 'Pop', kind: 'genre' },
  { id: 'rock', label: 'Rock', kind: 'genre' },
  { id: 'hiphop', label: 'Hip-hop', kind: 'genre' },
  { id: 'rnb', label: 'R&B / Soul', kind: 'genre' },
  { id: 'country', label: 'Country', kind: 'genre' },
  { id: 'electronic', label: 'Electronic', kind: 'genre' },
  { id: 'sixties-seventies', label: '60s & 70s', kind: 'era', from: 1960, to: 1979 },
  { id: 'eighties-nineties', label: '80s & 90s', kind: 'era', from: 1980, to: 1999 },
  { id: 'two-thousands', label: '2000s', kind: 'era', from: 2000, to: 2009 },
  { id: 'modern', label: '2010 to now', kind: 'era', from: 2010, to: 9999 },
];

const SET_IDS = SETS.map((set) => set.id);

function inSet(song, setId) {
  const set = SETS.find((s) => s.id === setId);
  if (!set) return false;
  if (set.kind === 'special') return song.classic === true;
  if (set.kind === 'genre') return song.genre === set.id;
  return song.year >= set.from && song.year <= set.to;
}

/**
 * song-catalog.json is the curated list of what songs exist; songs.json holds
 * the Spotify ids the resolver found. Merging on read means the catalog can
 * grow without throwing away work already done by /resolve.
 */
function loadSongs() {
  let resolved = [];
  try {
    resolved = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  } catch {
    resolved = [];
  }

  let catalog = [];
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch (err) {
    console.error('Could not read song-catalog.json:', err.message);
    // With no catalog, fall back to whatever songs.json already had.
    songPool = resolved;
    return;
  }

  const key = (song) => `${song.title}|${song.artist}`.toLowerCase();
  const known = new Map(resolved.map((song) => [key(song), song]));

  songPool = catalog.map((entry) => {
    const previous = known.get(key(entry));
    return {
      id: previous?.id ?? null,
      albumArt: previous?.albumArt ?? null,
      title: entry.title,
      artist: entry.artist,
      year: entry.year,
      genre: entry.genre,
      classic: entry.classic === true,
    };
  });
}

/** Songs the resolver has matched to a real Spotify track. */
function playableSongs() {
  return songPool.filter((song) => TRACK_URI.test(song.id || ''));
}

// --- Sets -------------------------------------------------------------------

/** Classic alone is a sane default: one song per year, the widest possible spread. */
let activeSets = ['classic'];

function loadSets() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETS_PATH, 'utf8'));
    const picked = (saved.sets || []).filter((id) => SET_IDS.includes(id));
    // Never let a saved file leave the game with nothing to play.
    activeSets = picked.length ? picked : ['classic'];
  } catch {
    activeSets = ['classic'];
  }
}

/** Resolved songs belonging to at least one switched-on set. */
function activeSongs() {
  return playableSongs().filter((song) => activeSets.some((id) => inSet(song, id)));
}

/**
 * The switched-on sets, named. Small enough to ride along with every state
 * broadcast, which is what keeps the TV's label honest the moment someone
 * changes the selection from anywhere.
 */
function activeSetSummary() {
  return {
    active: SETS.filter((set) => activeSets.includes(set.id)).map(({ id, label }) => ({ id, label })),
    total: activeSongs().length,
  };
}

/** What each set is worth on its own, so the toggles can show real numbers. */
function setCounts() {
  const resolved = playableSongs();
  return Object.fromEntries(
    SETS.map((set) => [set.id, resolved.filter((song) => inSet(song, set.id)).length]));
}

loadSongs();
loadSets();

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Four-letter codes drawn from record-shop vocabulary, so they're easy to say aloud. */
const CODE_WORDS = [
  'FUNK', 'SOUL', 'JAZZ', 'ROCK', 'BEAT', 'DISC', 'WAVE', 'TUNE', 'VIBE', 'RIFF',
  'BASS', 'DRUM', 'HORN', 'ECHO', 'DUET', 'LOOP', 'FADE', 'HOOK', 'JAMS', 'SKAS',
  'DUBS', 'MIXX', 'TAPE', 'VINL', 'SPIN', 'GROV', 'REVB', 'TONE', 'CHOR', 'SYNC',
];

/** code -> room */
const rooms = new Map();

const PHASES = {
  LOBBY: 'lobby',
  /** "Alex is up, starting in 3" — the card is drawn but nothing plays yet. */
  TURN_INTRO: 'turn_intro',
  PLAYING: 'playing',
  STEAL_CHOOSING: 'steal_choosing',
  /** The result is on screen and nobody acts until it has been seen. */
  STEAL_VERDICT: 'steal_verdict',
  STEAL_PLACING: 'steal_placing',
  REVEALING: 'revealing',
  GAME_OVER: 'game_over',
};

function newCode() {
  const free = CODE_WORDS.filter((word) => !rooms.has(word));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  let code;
  do {
    code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = newCode();
  const room = {
    code,
    players: [],
    hostId: null,
    tvSockets: new Set(),
    spotifyReady: false,
    phase: PHASES.LOBBY,
    round: 0,
    currentPlayerIndex: 0,
    /** The song in play. Never leaves this object until a reveal. */
    currentCard: null,
    /** Who is placing right now — normally the current player, or a successful stealer. */
    placerId: null,
    deck: [],
    deckIndex: 0,
    /** Wrong guesses land here and get reshuffled in once the deck runs dry. */
    discardPile: [],
    /**
     * Set while a steal is in progress. Server-side this also holds the full
     * multiple-choice options and which index is correct; publicState()
     * strips that down to just who's attempting before it goes over the wire.
     */
    stealClaim: null,
    /** Player ids that already burned their steal on this turn. */
    stealBlocked: new Set(),
    lastReveal: null,
    winner: null,
    /** Set when the TV reports a track that would not play; reveals the skip. */
    playbackFailed: false,
    /** Pending auto-advance out of the reveal. */
    revealTimer: null,
    /** Pending start of playback after the "who's up" intro. */
    introTimer: null,
    /** Fires when a stealer runs out of time to answer. */
    stealTimer: null,
    /** Fires when the verdict has been on screen long enough. */
    verdictTimer: null,
    /** { success, playerName } while the verdict is showing. */
    stealOutcome: null,
    /** When the steal window opens, and when the current answer is due. */
    stealOpensAt: 0,
    stealDeadline: 0,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId) || null;
}

function findPlayerBySocket(room, socketId) {
  return room.players.find((p) => p.socketId === socketId) || null;
}

function currentPlayer(room) {
  return room.players[room.currentPlayerIndex] || null;
}

function connectedPlayers(room) {
  return room.players.filter((p) => p.connected);
}

// ---------------------------------------------------------------------------
// State broadcasting
// ---------------------------------------------------------------------------

/**
 * The only game payload that goes over the wire. Everything here is safe for
 * every device to see; the hidden card is represented purely by whether one
 * exists, until `lastReveal` is populated.
 */
function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    targetCards: TARGET_CARDS,
    revealMs: REVEAL_MS,
    introMs: INTRO_MS,
    stealAnswerMs: STEAL_ANSWER_MS,
    verdictMs: VERDICT_MS,
    stealOutcome: room.stealOutcome,
    // Relative, not absolute: the phone's clock need not agree with the
    // server's, and each client just counts down locally from receipt.
    stealOpensInMs: Math.max(0, room.stealOpensAt - Date.now()),
    stealDeadlineInMs: Math.max(0, room.stealDeadline - Date.now()),
    spotifyReady: room.spotifyReady,
    hostId: room.hostId,
    currentPlayerId: currentPlayer(room)?.id || null,
    placerId: room.placerId,
    // Only the identity of the stealer is public. The options and the correct
    // index are never broadcast — they go to that one socket directly.
    stealClaim: room.stealClaim
      ? { playerId: room.stealClaim.playerId, playerName: room.stealClaim.playerName }
      : null,
    stealBlocked: Array.from(room.stealBlocked),
    // Which music is switched on. Global rather than per-room, but it rides
    // along with the state so every screen can name the set without polling —
    // "which songs am I actually going to hear" is the first thing anyone asks.
    sets: activeSetSummary(),
    playbackFailed: room.playbackFailed,
    winner: room.winner,
    // Includes the discard pile, since those cards are still coming back.
    cardsLeft: Math.max(0, room.deck.length - room.deckIndex) + room.discardPile.length,
    lastReveal: room.lastReveal,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
      score: p.timeline.length,
      timeline: p.timeline,
    })),
  };
}

function broadcast(room) {
  io.to(`room:${room.code}`).emit('game_state', publicState(room));
}

function toTv(room, event, payload) {
  for (const socketId of room.tvSockets) io.to(socketId).emit(event, payload);
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function shuffle(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Six options for a steal question: the real answer plus distinct decoys
 * drawn from the whole catalog. Decoys are just text — they don't need a
 * Spotify match — so the full songPool gives plenty of variety even for a
 * small active set. Returns the shuffled options and where the answer landed,
 * so the caller can keep that index secret and only ship the text to the client.
 */
function buildChoices(correctValue, pool, count = 6) {
  const decoys = shuffle([...new Set(pool)].filter((value) => value !== correctValue)).slice(0, count - 1);
  const options = shuffle([correctValue, ...decoys]);
  return { options, correctIndex: options.indexOf(correctValue) };
}

function startGame(room) {
  const playable = activeSongs();
  const needed = room.players.length + MIN_DECK_BUFFER;
  if (playable.length < needed) {
    const total = playableSongs().length;
    return {
      error: total < needed
        ? `Only ${total} songs are matched to Spotify. Open /resolve on the TV to build the pool.`
        : `Your sets only have ${playable.length} matched songs and this game needs ${needed}. Turn on more sets in /resolve, or match more songs.`,
    };
  }

  room.deck = shuffle(playable);
  room.deckIndex = 0;
  room.discardPile = [];
  room.round = 1;
  room.currentPlayerIndex = 0;
  room.winner = null;
  room.lastReveal = null;

  // Everyone opens with one free card, face up. Placing into an empty timeline
  // would be trivially correct, so the first card has to be a gift.
  for (const player of room.players) {
    player.timeline = [{ ...room.deck[room.deckIndex++] }];
  }

  startTurn(room);
  return { ok: true };
}

/** Every pending timer for a room, cleared together so none fires late. */
function clearTimers(room) {
  clearTimeout(room.revealTimer);
  clearTimeout(room.introTimer);
  clearTimeout(room.stealTimer);
  clearTimeout(room.verdictTimer);
  room.revealTimer = null;
  room.introTimer = null;
  room.stealTimer = null;
  room.verdictTimer = null;
}

function startTurn(room) {
  clearTimers(room);

  if (room.deckIndex >= room.deck.length) {
    if (room.discardPile.length) {
      // Wrong guesses don't leave the game — reshuffle them back in as a
      // fresh deck rather than ending things early.
      room.deck = shuffle(room.discardPile);
      room.discardPile = [];
      room.deckIndex = 0;
    } else {
      // Every song has either been recycled away or correctly placed
      // somewhere — nothing left anywhere. Whoever is furthest along takes it.
      const best = room.players.slice().sort((a, b) => b.timeline.length - a.timeline.length)[0];
      room.winner = best ? { id: best.id, name: best.name, score: best.timeline.length } : null;
      room.phase = PHASES.GAME_OVER;
      room.currentCard = null;
      broadcast(room);
      return;
    }
  }

  room.currentCard = room.deck[room.deckIndex++];
  room.placerId = currentPlayer(room)?.id || null;
  room.stealClaim = null;
  room.stealOutcome = null;
  room.stealBlocked = new Set();
  room.lastReveal = null;
  room.playbackFailed = false;
  room.stealOpensAt = 0;
  room.stealDeadline = 0;

  // Announce who's up before any audio, so the room can look up and register
  // whose turn it is instead of the next song just appearing.
  room.phase = PHASES.TURN_INTRO;
  broadcast(room);

  clearTimeout(room.introTimer);
  room.introTimer = setTimeout(() => beginPlayback(room), INTRO_MS);
}

function beginPlayback(room) {
  if (room.phase !== PHASES.TURN_INTRO || !room.currentCard) return;

  room.phase = PHASES.PLAYING;
  // The steal window opens partway in, so nobody can win on the first note.
  room.stealOpensAt = Date.now() + STEAL_LOCK_MS;

  broadcast(room);
  toTv(room, 'song_started', { spotifyUri: room.currentCard.id });
}

/**
 * Penalty for a failed steal: one card off the player's timeline, chosen at
 * random, back into circulation via the discard pile.
 *
 * Returns the card that was taken, or null if they had nothing to lose — a
 * player on zero cards is not put into debt, they simply get away with it.
 */
function takeRandomCard(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player || player.timeline.length === 0) return null;

  const index = Math.floor(Math.random() * player.timeline.length);
  const [card] = player.timeline.splice(index, 1);
  room.discardPile.push(card);
  return { title: card.title, artist: card.artist, year: card.year };
}

/**
 * Settle a steal, whether the answer came in or the clock ran out.
 *
 * The result gets its own phase for a couple of seconds. Handing the turn
 * straight back would let the placer commit a card while the verdict was still
 * up on the TV, and the reveal that followed would then be racing a timer that
 * had already been running — which is how a turn could appear to end seconds
 * after it resumed.
 */
function resolveSteal(room, correct) {
  const claim = room.stealClaim;
  if (!claim) return;

  clearTimeout(room.stealTimer);
  room.stealTimer = null;
  room.stealDeadline = 0;

  // A missed steal costs a card. Taken here rather than in finishSteal() so the
  // timeline visibly loses it while the verdict is still on screen, instead of
  // a card quietly vanishing once play has already resumed.
  const lostCard = correct ? null : takeRandomCard(room, claim.playerId);

  room.stealOutcome = { success: correct, playerName: claim.playerName, lostCard };
  room.phase = PHASES.STEAL_VERDICT;

  toTv(room, 'steal_result', { success: correct, playerName: claim.playerName, lostCard });
  broadcast(room);

  clearTimeout(room.verdictTimer);
  room.verdictTimer = setTimeout(() => finishSteal(room, correct), VERDICT_MS);
}

/** Hand the turn back once the verdict has been seen, and restart the song. */
function finishSteal(room, correct) {
  if (room.phase !== PHASES.STEAL_VERDICT) return;
  const claim = room.stealClaim;
  if (!claim) return;

  if (correct) {
    // The stealer takes over the turn and now has to place the card themselves.
    room.placerId = claim.playerId;
    room.phase = PHASES.STEAL_PLACING;
  } else {
    room.stealBlocked.add(claim.playerId);
    room.phase = PHASES.PLAYING;
  }

  room.stealClaim = null;
  room.stealOutcome = null;

  toTv(room, 'resume_music', {});
  broadcast(room);
}

function isCorrectPlacement(timeline, year, gapIndex) {
  const before = timeline[gapIndex - 1];
  const after = timeline[gapIndex];
  if (before && year < before.year) return false;
  if (after && year > after.year) return false;
  return true;
}

function resolvePlacement(room, player, gapIndex) {
  const card = room.currentCard;
  const correct = isCorrectPlacement(player.timeline, card.year, gapIndex);

  if (correct) {
    player.timeline.splice(gapIndex, 0, { ...card });
    player.timeline.sort((a, b) => a.year - b.year);
  } else {
    // Doesn't vanish — it's back in circulation once the deck runs dry.
    room.discardPile.push(card);
  }

  // Read the phase, not stealClaim: the claim is cleared when the verdict ends,
  // which is before a successful stealer ever gets to place.
  const wasSteal = room.phase === PHASES.STEAL_PLACING;

  room.phase = PHASES.REVEALING;
  room.lastReveal = {
    card: { title: card.title, artist: card.artist, year: card.year, albumArt: card.albumArt },
    correct,
    gapIndex,
    placerId: player.id,
    placerName: player.name,
    wasSteal,
  };
  room.currentCard = null;
  room.stealClaim = null;

  if (player.timeline.length >= TARGET_CARDS) {
    room.winner = { id: player.id, name: player.name, score: player.timeline.length };
  }

  broadcast(room);
  toTv(room, 'stop_music', {});

  // Nobody should have to tap to keep the game moving. The manual button is
  // still there to cut the wait short; whichever fires first wins, and
  // nextTurn() clears the other.
  clearTimeout(room.revealTimer);
  room.revealTimer = setTimeout(() => {
    if (room.phase === PHASES.REVEALING) nextTurn(room);
  }, REVEAL_MS);
}

function nextTurn(room) {
  clearTimers(room);

  if (room.winner) {
    room.phase = PHASES.GAME_OVER;
    broadcast(room);
    return;
  }

  const startIndex = room.currentPlayerIndex;
  for (let step = 1; step <= room.players.length; step++) {
    const index = (startIndex + step) % room.players.length;
    if (room.players[index].connected) {
      room.currentPlayerIndex = index;
      if (index <= startIndex) room.round += 1;
      startTurn(room);
      return;
    }
  }

  // Nobody is connected. Park the game until someone comes back.
  room.phase = PHASES.LOBBY;
  broadcast(room);
}

function reassignHost(room) {
  const host = findPlayer(room, room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0];
  room.hostId = next ? next.id : null;
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'controller.html')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/callback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'callback.html')));
app.get('/resolve', (req, res) => res.sendFile(path.join(__dirname, 'public', 'resolve.html')));

app.get('/api/config', (req, res) => {
  res.json({
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    targetCards: TARGET_CARDS,
    songsTotal: songPool.length,
    songsPlayable: playableSongs().length,
    songsActive: activeSongs().length,
  });
});

app.get('/api/sets', (req, res) => {
  res.json({
    sets: SETS.map(({ id, label, kind, blurb }) => ({ id, label, kind, blurb })),
    active: activeSets,
    counts: setCounts(),
    activeTotal: activeSongs().length,
  });
});

app.post('/api/sets', (req, res) => {
  const picked = (req.body?.sets || []).filter((id) => SET_IDS.includes(id));
  if (!picked.length) return res.status(400).json({ error: 'Leave at least one set switched on.' });

  activeSets = picked;
  try {
    fs.writeFileSync(SETS_PATH, `${JSON.stringify({ sets: activeSets }, null, 2)}\n`);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Every screen showing the set label needs to change with it, wherever the
  // toggle was pressed. A running game keeps the deck it was dealt — this only
  // decides what the next one is built from.
  for (const room of rooms.values()) broadcast(room);

  res.json({
    ok: true,
    active: activeSets,
    activeTotal: activeSongs().length,
    counts: setCounts(),
  });
});

app.get('/api/songs', (req, res) => res.json(songPool));

/**
 * The resolver posts the completed pool back so the running game can use it
 * immediately. Resolving is expensive to redo, so the previous pool is copied
 * aside first — a bad or partial run should never be the only thing left.
 */
app.post('/api/songs', (req, res) => {
  if (!Array.isArray(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Expected a non-empty array of songs.' });
  }
  try {
    /*
     * Only ever back up a pool that came from a real resolve. Album art is the
     * tell: /resolve always returns it alongside the id, so a pool with ids but
     * no art was written by something else. Without this guard a throwaway pool
     * could overwrite the backup and leave no good copy anywhere.
     */
    const current = playableSongs();
    const worthKeeping = current.length && current.some((song) => /i\.scdn\.co/.test(song.albumArt || ''));
    if (worthKeeping) fs.copyFileSync(SONGS_PATH, BACKUP_PATH);
    fs.writeFileSync(SONGS_PATH, `${JSON.stringify(req.body, null, 2)}\n`);

    // The catalogue is the source of truth for year, so a year corrected in the
    // resolver has to land there too — otherwise loadSongs() would put the old
    // one straight back on the next restart.
    const corrected = writeCatalogYears(req.body);

    loadSongs();
    res.json({ ok: true, playable: playableSongs().length, yearsCorrected: corrected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function writeCatalogYears(incoming) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch {
    return 0;
  }

  const key = (song) => `${song.title}|${song.artist}`.toLowerCase();
  const years = new Map(incoming
    .filter((song) => Number.isInteger(song.year))
    .map((song) => [key(song), song.year]));

  let changed = 0;
  for (const entry of catalog) {
    const year = years.get(key(entry));
    if (year && year !== entry.year) {
      entry.year = year;
      changed++;
    }
  }

  if (changed) fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  return changed;
}

/** Put back whatever the last save replaced. */
app.post('/api/songs/restore', (req, res) => {
  if (!fs.existsSync(BACKUP_PATH)) return res.status(404).json({ error: 'No backup to restore.' });
  try {
    fs.copyFileSync(BACKUP_PATH, SONGS_PATH);
    loadSongs();
    res.json({ ok: true, playable: playableSongs().length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** LAN address, so the QR code points somewhere a phone can actually reach. */
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function joinUrlFor(req, code) {
  const host = req.get('host') || `localhost:${PORT}`;
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  const lan = lanAddress();
  const target = isLoopback && lan ? `${lan}:${PORT}` : host;
  const protocol = isLoopback ? 'http' : req.protocol;
  return `${protocol}://${target}/?room=${code}`;
}

app.get('/api/join-info', async (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  const url = joinUrlFor(req, code);
  try {
    const qr = await QRCode.toDataURL(url, {
      margin: 1,
      width: 420,
      color: { dark: '#1B2A3F', light: '#FFFFFF' },
    });
    res.json({ url, qr });
  } catch (err) {
    res.json({ url, qr: null });
  }
});

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  /** Set once this socket belongs to a room, so handlers can find it again. */
  let roomCode = null;

  const room = () => (roomCode ? rooms.get(roomCode) || null : null);

  function attach(target) {
    roomCode = target.code;
    socket.join(`room:${target.code}`);
  }

  // --- TV -----------------------------------------------------------------

  socket.on('register_tv', (payload = {}, ack) => {
    const requested = String(payload.code || '').toUpperCase();
    const target = (requested && rooms.get(requested)) || createRoom();
    attach(target);
    target.tvSockets.add(socket.id);
    if (typeof ack === 'function') ack({ ok: true, code: target.code });
    broadcast(target);

    // song_started is a one-shot fired when the turn began. A TV that joins or
    // reloads after that point never saw it, and would sit silent for the rest
    // of the turn — so hand the current track to this socket directly.
    const midTurn = target.phase === PHASES.PLAYING || target.phase === PHASES.STEAL_PLACING;
    if (midTurn && target.currentCard) {
      io.to(socket.id).emit('song_started', { spotifyUri: target.currentCard.id });
    }
  });

  socket.on('spotify_ready', () => {
    const target = room();
    if (!target) return;
    target.spotifyReady = true;
    broadcast(target);
  });

  /**
   * Hitster has no skip. The control only exists to rescue a turn when a track
   * refuses to play, so it stays hidden until the TV reports exactly that.
   */
  socket.on('playback_failed', () => {
    const target = room();
    if (!target || !target.tvSockets.has(socket.id)) return;
    target.playbackFailed = true;
    broadcast(target);
    io.to(`room:${target.code}`).emit('playback_failed', {});
  });

  // --- Joining ------------------------------------------------------------

  socket.on('join_game', (payload = {}, ack) => {
    const name = String(payload.name || '').trim().slice(0, 16);
    if (!name) return ack?.({ error: 'Enter a name to join.' });

    const requested = String(payload.code || '').toUpperCase();
    let target = requested ? rooms.get(requested) : null;

    if (!target && !requested) {
      // No code given: drop into the only game running, if there is exactly one.
      const open = Array.from(rooms.values());
      if (open.length === 1) target = open[0];
    }
    if (!target) return ack?.({ error: requested ? `No game found with code ${requested}.` : 'No game running. Open the TV screen first.' });

    // Returning player, same name — hand them their timeline back.
    const returning = target.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (returning) {
      if (returning.connected) return ack?.({ error: `${name} is already in this game. Pick another name.` });
      returning.connected = true;
      returning.socketId = socket.id;
      attach(target);
      reassignHost(target);
      ack?.({ ok: true, code: target.code, playerId: returning.id });
      broadcast(target);
      return;
    }

    if (target.phase !== PHASES.LOBBY) {
      return ack?.({ error: 'That game is already underway.' });
    }
    if (target.players.length >= 8) {
      return ack?.({ error: 'This game is full (8 players).' });
    }

    const player = {
      id: crypto.randomUUID(),
      socketId: socket.id,
      name,
      timeline: [],
      connected: true,
    };
    target.players.push(player);
    if (!target.hostId) target.hostId = player.id;

    attach(target);
    ack?.({ ok: true, code: target.code, playerId: player.id });
    broadcast(target);
  });

  socket.on('rejoin', (payload = {}, ack) => {
    const target = rooms.get(String(payload.code || '').toUpperCase());
    if (!target) return ack?.({ error: 'That game has ended.' });
    const player = findPlayer(target, payload.playerId);
    if (!player) return ack?.({ error: 'You are not in that game.' });

    player.connected = true;
    player.socketId = socket.id;
    attach(target);
    reassignHost(target);
    ack?.({ ok: true, code: target.code, playerId: player.id });
    broadcast(target);
  });

  // --- Host controls ------------------------------------------------------

  socket.on('start_game', (payload, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });
    const player = findPlayerBySocket(target, socket.id);
    if (!player || player.id !== target.hostId) return ack?.({ error: 'Only the host can start the game.' });
    if (target.phase !== PHASES.LOBBY) return ack?.({ error: 'The game is already running.' });
    if (target.players.length < 2) return ack?.({ error: 'You need at least 2 players.' });

    const result = startGame(target);
    if (result.error) return ack?.({ error: result.error });
    ack?.({ ok: true });
  });

  /** Hand host duties to someone else, on purpose rather than by disconnecting. */
  socket.on('transfer_host', (payload = {}, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });
    const player = findPlayerBySocket(target, socket.id);
    if (!player || player.id !== target.hostId) return ack?.({ error: 'Only the host can hand off host.' });

    const next = findPlayer(target, payload.playerId);
    if (!next) return ack?.({ error: 'That player is not in this game.' });
    if (!next.connected) return ack?.({ error: `${next.name} is not connected right now.` });
    if (next.id === target.hostId) return ack?.({ error: `${next.name} is already the host.` });

    target.hostId = next.id;
    broadcast(target);
    ack?.({ ok: true });
  });

  socket.on('skip_song', (payload, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });
    const player = findPlayerBySocket(target, socket.id);
    if (!player || player.id !== target.hostId) return ack?.({ error: 'Only the host can skip.' });
    if (target.phase !== PHASES.PLAYING && target.phase !== PHASES.STEAL_CHOOSING) {
      return ack?.({ error: 'Nothing is playing to skip.' });
    }

    // Put the skipped song back at the bottom rather than burning it.
    if (target.currentCard) target.deck.push(target.currentCard);
    target.stealClaim = null;
    target.stealOutcome = null;
    target.stealBlocked = new Set();
    startTurn(target);
    ack?.({ ok: true });
  });

  /**
   * Abandon this room and open a fresh one. Available to the host and to the
   * TV, so a wedged game can be cleared from whichever surface is to hand.
   * Everyone lands back on the join screen with the new code.
   */
  socket.on('new_room', (payload, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });

    const isTv = target.tvSockets.has(socket.id);
    const player = findPlayerBySocket(target, socket.id);
    if (!isTv && (!player || player.id !== target.hostId)) {
      return ack?.({ error: 'Only the host or the TV can open a new room.' });
    }

    const fresh = createRoom();
    clearTimers(target);
    toTv(target, 'stop_music', {});
    io.to(`room:${target.code}`).emit('room_closed', { code: fresh.code });
    rooms.delete(target.code);

    ack?.({ ok: true, code: fresh.code });
  });

  // --- Turn actions -------------------------------------------------------

  socket.on('place_card', (payload = {}, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });
    const player = findPlayerBySocket(target, socket.id);
    if (!player) return ack?.({ error: 'You are not in this game.' });
    if (target.phase !== PHASES.PLAYING && target.phase !== PHASES.STEAL_PLACING) {
      return ack?.({ error: 'Too late — that turn is over.' });
    }
    if (player.id !== target.placerId) return ack?.({ error: 'It is not your turn.' });

    const gapIndex = Number(payload.gapIndex);
    if (!Number.isInteger(gapIndex) || gapIndex < 0 || gapIndex > player.timeline.length) {
      return ack?.({ error: 'That slot does not exist.' });
    }

    resolvePlacement(target, player, gapIndex);
    ack?.({ ok: true });
  });

  socket.on('attempt_steal', (payload, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });
    if (target.phase !== PHASES.PLAYING) return ack?.({ error: 'The steal window is closed.' });

    const player = findPlayerBySocket(target, socket.id);
    if (!player) return ack?.({ error: 'You are not in this game.' });
    if (player.id === target.placerId) return ack?.({ error: 'You cannot steal on your own turn.' });
    if (target.stealBlocked.has(player.id)) return ack?.({ error: 'You already used your steal this turn.' });
    if (target.stealClaim) return ack?.({ error: 'Someone beat you to it.' });

    const waitMs = target.stealOpensAt - Date.now();
    if (waitMs > 0) {
      return ack?.({ error: `Hold on — ${Math.ceil(waitMs / 1000)}s until stealing opens.` });
    }

    const card = target.currentCard;
    const titles = buildChoices(card.title, songPool.map((s) => s.title));
    const artists = buildChoices(card.artist, songPool.map((s) => s.artist));

    target.stealClaim = {
      playerId: player.id,
      playerName: player.name,
      titleOptions: titles.options,
      correctTitleIndex: titles.correctIndex,
      artistOptions: artists.options,
      correctArtistIndex: artists.correctIndex,
    };
    target.phase = PHASES.STEAL_CHOOSING;
    target.stealDeadline = Date.now() + STEAL_ANSWER_MS;

    // Running out of time is the same outcome as answering wrong, so the
    // room can never be left waiting on someone who froze.
    clearTimeout(target.stealTimer);
    target.stealTimer = setTimeout(() => {
      if (target.phase === PHASES.STEAL_CHOOSING) resolveSteal(target, false);
    }, STEAL_ANSWER_MS);

    broadcast(target);
    toTv(target, 'pause_music', {});
    toTv(target, 'steal_attempt', { playerName: player.name, answerMs: STEAL_ANSWER_MS });
    // The options — and which one is right — go only to the stealer's socket.
    io.to(socket.id).emit('steal_choices', { titleOptions: titles.options, artistOptions: artists.options });
    ack?.({ ok: true });
  });

  socket.on('submit_steal_answer', (payload = {}, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });
    if (target.phase !== PHASES.STEAL_CHOOSING || !target.stealClaim) {
      return ack?.({ error: 'That steal has already been settled.' });
    }

    const claim = target.stealClaim;
    const player = findPlayerBySocket(target, socket.id);
    if (!player || player.id !== claim.playerId) return ack?.({ error: 'This is not your steal to answer.' });

    const correct = payload.titleIndex === claim.correctTitleIndex && payload.artistIndex === claim.correctArtistIndex;
    resolveSteal(target, correct);
    ack?.({ ok: true, correct });
  });

  socket.on('ready_next_turn', (payload, ack) => {
    const target = room();
    if (!target) return ack?.({ error: 'That game has ended.' });
    // The reveal advances itself, so a tap that lands after the timer already
    // fired is expected and simply has nothing to do.
    if (target.phase !== PHASES.REVEALING) return ack?.({ ok: true, alreadyAdvanced: true });

    const player = findPlayerBySocket(target, socket.id);
    // Whoever just placed moves the game on; the host can also unstick it.
    if (!player || (player.id !== target.lastReveal?.placerId && player.id !== target.hostId)) {
      return ack?.({ error: 'Only the player who just went can move things along.' });
    }

    nextTurn(target);
    ack?.({ ok: true });
  });

  // --- Teardown -----------------------------------------------------------

  socket.on('disconnect', () => {
    const target = room();
    if (!target) return;

    target.tvSockets.delete(socket.id);

    const player = findPlayerBySocket(target, socket.id);
    if (player) {
      player.connected = false;
      reassignHost(target);

      // A stealer who vanishes mid-choice would otherwise leave the room
      // stuck waiting on an answer that's never coming.
      if (target.phase === PHASES.STEAL_CHOOSING && target.stealClaim?.playerId === player.id) {
        resolveSteal(target, false);
      }

      // If the room emptied out during the lobby, drop the room entirely.
      if (target.phase === PHASES.LOBBY && !connectedPlayers(target).length && !target.tvSockets.size) {
        clearTimers(target);
        rooms.delete(target.code);
        return;
      }
      broadcast(target);
      return;
    }

    if (!target.tvSockets.size) {
      // A quick reload or a hop over to /resolve disconnects this socket too;
      // give a real reconnect a few seconds before flipping the room back to
      // "waiting for Spotify".
      const code = target.code;
      setTimeout(() => {
        const still = rooms.get(code);
        if (still && !still.tvSockets.size) {
          still.spotifyReady = false;
          broadcast(still);
        }
      }, 4000);
    }
  });
});

// Sweep rooms that have been abandoned for an hour.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [code, target] of rooms) {
    const empty = !target.tvSockets.size && !connectedPlayers(target).length;
    if (empty && target.createdAt < cutoff) {
      clearTimers(target);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log('');
  console.log('  HITSTER DIGITAL');
  console.log(`  TV screen     http://127.0.0.1:${PORT}/tv`);
  console.log(`  Phones        ${lan ? `http://${lan}:${PORT}` : `http://127.0.0.1:${PORT}`}`);
  const playable = playableSongs();
  console.log(`  Song pool     ${playable.length} of ${songPool.length} matched to Spotify`);
  console.log(`  Active sets   ${activeSongs().length} songs · ${activeSets.join(', ')}`);
  if (!process.env.SPOTIFY_CLIENT_ID) console.log('  ! SPOTIFY_CLIENT_ID is not set — copy .env.example to .env');
  if (!playable.length) console.log(`  ! No songs matched yet — open http://127.0.0.1:${PORT}/resolve`);
  // A genuine resolve always brings album art back with the track id. Ids
  // without art mean the pool was written by something other than /resolve,
  // and those ids will not play.
  else if (!playable.some((song) => song.albumArt)) {
    console.log('  ! Track ids present but no album art — this pool did not come from /resolve');
    console.log(`  ! Re-run http://127.0.0.1:${PORT}/resolve, or POST /api/songs/restore for the previous pool`);
  }
  console.log('');
});
