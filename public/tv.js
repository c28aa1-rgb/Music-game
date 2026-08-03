/**
 * TV view.
 *
 * Owns audio playback and renders the shared screen. It receives a Spotify
 * track URI so it can play a song, but never any metadata for that song until
 * the server sends a reveal — so nothing on this screen can leak the answer.
 */

const socket = io();

const el = (id) => document.getElementById(id);
const ROOM_KEY = 'hitster.tv.room';

let state = null;
let player = null;
let deviceId = null;
let accessToken = null;
let pendingUri = null;
let progressTimer = null;
/** Identifies the reveal currently on screen, so it animates exactly once. */
let shownRevealKey = null;
let shownPhase = null;
/** Local countdown state, refreshed from each broadcast's relative timings. */
let stealOpensAt = 0;
let answerDeadline = 0;
let clockTimer = null;

// ---------------------------------------------------------------------------
// Boot
//
// The Spotify SDK <script> tag calls window.onSpotifyWebPlaybackSDKReady() the
// moment it finishes loading its own runtime — on its own schedule, not ours.
// That can easily land before our async auth check resolves, so this callback
// has to exist synchronously from the first tick, not get assigned later
// inside an async function. If it doesn't exist yet when the SDK looks for it,
// the SDK just drops the call; nothing ever retries it.
// ---------------------------------------------------------------------------

let sdkLoaded = false;
/**
 * Whether this tab has been allowed to make sound yet. Browsers block audio
 * until the page has been interacted with, and the game is started from a
 * phone — so without an explicit tap here, playback fails silently forever.
 */
let audioReady = false;

window.onSpotifyWebPlaybackSDKReady = () => {
  sdkLoaded = true;
  if (accessToken) initPlayer();
};

(async function boot() {
  accessToken = await SpotifyAuth.getToken();
  if (!accessToken) return showAuthGate();
  el('auth').hidden = true;
  if (sdkLoaded) initPlayer();
  // else initPlayer() runs once onSpotifyWebPlaybackSDKReady fires above.
})();

function showAuthGate() {
  el('auth').hidden = false;
  el('auth-btn').addEventListener('click', async () => {
    try {
      await SpotifyAuth.login('/tv');
    } catch (err) {
      el('auth-error').textContent = err.message;
    }
  });
}

/**
 * activateElement() has to run inside a real user gesture — it is the SDK's
 * hook for unblocking the underlying audio element. Once it resolves, any
 * track that arrived while we were still muted gets played.
 */
function showAudioGate() {
  el('audio').hidden = false;
  el('audio-btn').addEventListener('click', async () => {
    try {
      await player.activateElement();
      // Same gesture unlocks the effects; an AudioContext is blocked until one.
      SFX.unlock();
      audioReady = true;
      el('audio').hidden = true;
      if (pendingUri) {
        playTrack(pendingUri);
        pendingUri = null;
      }
    } catch (err) {
      el('audio-error').textContent = `${err.message} — try tapping again.`;
    }
  }, { once: false });
}

function initPlayer() {
  player = new Spotify.Player({
    name: 'Hitster TV',
    getOAuthToken: (cb) => SpotifyAuth.getToken().then((token) => {
      accessToken = token;
      cb(token);
    }),
    volume: savedVolume() / 100,
  });

  player.addListener('ready', async ({ device_id }) => {
    deviceId = device_id;
    await transferPlaybackHere();
    // joinRoom() sends register_tv, which is what attaches this socket to a
    // room server-side. spotify_ready must go out after that, or the server
    // finds no room for this socket yet and silently drops it.
    joinRoom();
    socket.emit('spotify_ready');
    if (!audioReady) showAudioGate();
    if (pendingUri && audioReady) {
      playTrack(pendingUri);
      pendingUri = null;
    }
  });

  player.addListener('not_ready', () => { deviceId = null; });

  player.addListener('initialization_error', ({ message }) => fatal(message));
  player.addListener('authentication_error', ({ message }) => {
    SpotifyAuth.logout();
    fatal(`${message} — sign in again.`);
  });
  player.addListener('account_error', () => {
    fatal('The Web Playback SDK needs a Spotify Premium account. Sign in with a Premium account on this screen.');
  });

  player.connect();
  wireVolume();
  wireNewRoom();
  startProgressLoop();
  startClockLoop();
}

function fatal(message) {
  el('auth').hidden = false;
  el('auth-error').textContent = message;
}

// ---------------------------------------------------------------------------
// Spotify playback
// ---------------------------------------------------------------------------

async function spotifyFetch(path, options = {}) {
  const token = await SpotifyAuth.getToken();
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

/** Make this browser tab the active Spotify device without starting anything. */
function transferPlaybackHere() {
  return spotifyFetch('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  }).catch(() => {});
}

/**
 * Every load of this page registers a fresh "Hitster TV" device, and Spotify
 * keeps the previous one listed for a while after the page is gone. Playback
 * can therefore land on a stale device rather than this player — and when it
 * does, getCurrentState() here returns null forever, so the progress bar sits
 * at 0:00 while Spotify reports the track as playing somewhere else.
 * Claiming the device before every play keeps this page authoritative.
 */
async function claimDevice() {
  await transferPlaybackHere();
  // Spotify needs a beat to move the session across.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * The SDK's own resume() takes no arguments, so starting a specific track goes
 * through the Web API against this device. That is what the
 * user-modify-playback-state scope is for.
 */
async function playTrack(uri) {
  // Hold the track until the device exists and the tab is allowed to make
  // sound; the audio gate replays whatever is waiting here.
  if (!deviceId || !audioReady) {
    pendingUri = uri;
    if (deviceId && !audioReady) showAudioGate();
    return;
  }
  await claimDevice();
  const res = await spotifyFetch(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri], position_ms: 0 }),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    toast(body.error?.message || 'Spotify would not start that track.');
    // Skipping is not part of Hitster, so the control stays hidden until a
    // track genuinely refuses to play and the turn would otherwise be stuck.
    socket.emit('playback_failed');
  }
}

function savedVolume() {
  return Number(localStorage.getItem('hitster.volume') ?? 60);
}

function wireVolume() {
  const slider = el('volume');
  slider.value = savedVolume();
  slider.addEventListener('input', () => {
    localStorage.setItem('hitster.volume', slider.value);
    player?.setVolume(Number(slider.value) / 100);
  });
}

let resetConfirmTimer = null;

/** Abandoning a game in progress deserves a second tap. */
function wireNewRoom() {
  const button = el('new-room-btn');
  button.addEventListener('click', () => {
    if (button.dataset.confirming !== 'true') {
      button.dataset.confirming = 'true';
      button.textContent = 'Confirm';
      toast('Press again to end this game and open a fresh room.');
      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = setTimeout(() => {
        button.dataset.confirming = 'false';
        button.textContent = 'New room';
      }, 4200);
      return;
    }

    clearTimeout(resetConfirmTimer);
    button.dataset.confirming = 'false';
    button.textContent = 'New room';
    socket.emit('new_room', {}, (res) => {
      if (res?.error) toast(res.error);
      // On success the server sends room_closed, which navigates us.
    });
  });
}

/**
 * Decorative bars. Spotify's stream is DRM-protected and cannot be routed
 * through the Web Audio API, so there is no real amplitude to read — each bar
 * just runs on its own randomised cycle and freezes when playback pauses.
 */
function buildWave(node, count) {
  node.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const bar = document.createElement('i');
    bar.style.animationDuration = `${420 + Math.random() * 640}ms`;
    bar.style.animationDelay = `${-Math.random() * 900}ms`;
    node.appendChild(bar);
  }
}

function startProgressLoop() {
  clearInterval(progressTimer);
  buildWave(el('wave'), 56);

  progressTimer = setInterval(async () => {
    if (!player) return;
    const playback = await player.getCurrentState();
    const disc = el('disc');
    const wave = el('wave');
    if (!playback) {
      disc.classList.remove('is-playing', 'record--paused');
      wave.classList.add('is-idle');
      // Null state means this player is not the active device. If a turn is
      // supposed to be running, playback has drifted to another device and the
      // screen would otherwise sit frozen — take it back.
      if (state && (state.phase === 'playing' || state.phase === 'steal_placing')) recoverPlayback();
      return;
    }
    disc.classList.toggle('is-playing', !playback.paused);
    disc.classList.toggle('record--paused', playback.paused);
    wave.classList.toggle('is-idle', playback.paused);
    const pct = playback.duration ? (playback.position / playback.duration) * 100 : 0;
    el('progress-fill').style.width = `${pct}%`;
    el('np-elapsed').textContent = formatTime(playback.position);
  }, 500);
}

/**
 * Pull playback back onto this device after it has drifted. Rate-limited
 * because the progress loop runs twice a second and Spotify's transfer is not
 * instant — without the guard this would stampede the API.
 */
let recoveringUntil = 0;

async function recoverPlayback() {
  if (!deviceId || !audioReady || Date.now() < recoveringUntil) return;
  recoveringUntil = Date.now() + 6000;

  const res = await spotifyFetch('/me/player').catch(() => null);
  // 204 means nothing is playing anywhere; there is nothing to recover.
  if (!res || res.status === 204) return;

  const playback = await res.json().catch(() => null);
  if (!playback?.is_playing || playback.device?.id === deviceId) return;

  await claimDevice();
  await spotifyFetch(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [playback.item.uri], position_ms: playback.progress_ms || 0 }),
  }).catch(() => {});
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Drives both countdowns. Runs at 100ms so the ring moves smoothly, but the
 * tick sound is gated on the displayed second changing, so it fires once per
 * second rather than ten times.
 */
let lastAnswerSecond = null;

function startClockLoop() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    updateStealClock();
    updateAnswerClock();
  }, 100);
}

function updateStealClock() {
  const clock = el('steal-clock');
  if (!state || state.phase !== 'playing') {
    clock.hidden = true;
    return;
  }

  clock.hidden = false;
  const remaining = stealOpensAt - Date.now();

  if (remaining > 0) {
    clock.classList.remove('stealclock--open');
    el('steal-clock-label').textContent = 'Steals open in';
    el('steal-clock-value').textContent = String(Math.ceil(remaining / 1000));
    return;
  }

  clock.classList.add('stealclock--open');
  el('steal-clock-label').textContent = 'Steals are';
  el('steal-clock-value').textContent = 'OPEN';
}

function updateAnswerClock() {
  if (!answerDeadline) {
    lastAnswerSecond = null;
    return;
  }

  const ring = document.getElementById('answer-ring');
  const value = document.getElementById('answer-value');
  const wrap = document.getElementById('answer-clock');
  if (!ring || !value || !wrap) return;

  const total = state?.stealAnswerMs || 6000;
  const remaining = Math.max(0, answerDeadline - Date.now());
  const seconds = Math.ceil(remaining / 1000);

  // r=54 → circumference 2πr ≈ 339.29, matching the dasharray in CSS.
  ring.style.strokeDashoffset = String(339.29 * (1 - remaining / total));
  value.textContent = String(seconds);
  wrap.classList.toggle('answerclock--urgent', remaining <= 3000);

  if (seconds !== lastAnswerSecond) {
    lastAnswerSecond = seconds;
    if (seconds > 0) (remaining <= 3000 ? SFX.tickUrgent() : SFX.tick());
  }
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

function joinRoom() {
  const requested = new URLSearchParams(location.search).get('room') || localStorage.getItem(ROOM_KEY) || '';
  socket.emit('register_tv', { code: requested }, ({ code }) => {
    localStorage.setItem(ROOM_KEY, code);
    loadJoinInfo(code);
  });
}

socket.on('connect', () => {
  if (!deviceId) return;
  joinRoom();
  socket.emit('spotify_ready');
});

socket.on('song_started', ({ spotifyUri }) => playTrack(spotifyUri));
socket.on('pause_music', () => player?.pause());
socket.on('resume_music', () => player?.resume());
socket.on('stop_music', () => player?.pause());

socket.on('steal_attempt', ({ playerName, answerMs }) => {
  SFX.stealClaimed();
  answerDeadline = Date.now() + (answerMs || 6000);
  showStealOverlay(playerName);
});

// The overlay itself comes from the steal_verdict phase; this is just the
// sound, which has to fire once rather than on every re-render.
socket.on('steal_result', ({ success }) => {
  answerDeadline = 0;
  if (success) SFX.correct(); else SFX.wrong();
});

socket.on('playback_failed', () => {
  toast('That track will not play. The host can skip it.');
});

/** The room was abandoned; follow it to the fresh one. */
socket.on('room_closed', ({ code }) => {
  localStorage.setItem(ROOM_KEY, code);
  location.href = `/tv?room=${code}`;
});

socket.on('game_state', (next) => {
  state = next;

  // Countdowns arrive relative to the broadcast, so anchor them locally.
  stealOpensAt = next.stealOpensInMs > 0 ? Date.now() + next.stealOpensInMs : 0;
  if (next.phase !== 'steal_choosing') answerDeadline = 0;

  render();
});

async function loadJoinInfo(code) {
  el('lobby-code').textContent = code;
  try {
    const res = await fetch(`/api/join-info?code=${code}`);
    const { url, qr } = await res.json();
    el('lobby-url').textContent = url.replace(/^https?:\/\//, '');
    if (qr) el('lobby-qr').src = qr;
  } catch {
    el('lobby-url').textContent = 'Open this server’s address on your phone.';
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;

  const inLobby = state.phase === 'lobby';
  el('lobby').hidden = !inLobby;
  el('game').hidden = inLobby;

  if (inLobby) return renderLobby();

  renderHeader();
  renderNowPlaying();
  renderGroove();
  renderPlayerBar();
  renderOverlay();

  shownPhase = state.phase;
}

function renderLobby() {
  el('lobby-target').textContent = state.targetCards;

  const list = el('lobby-players');
  list.innerHTML = '';
  for (const p of state.players) {
    const item = document.createElement('li');
    item.className = `lobby__player${p.isHost ? ' lobby__player--host' : ''}`;
    item.textContent = p.name;
    list.appendChild(item);
  }

  const host = state.players.find((p) => p.isHost);
  if (!state.spotifyReady) {
    el('lobby-hint').textContent = 'Waiting for Spotify to connect on this screen.';
  } else if (state.players.length < 2) {
    el('lobby-hint').textContent = 'Two players minimum. Scan the code to join.';
  } else {
    el('lobby-hint').textContent = `${host ? host.name : 'The host'} starts the game from their phone.`;
  }
}

function renderHeader() {
  el('round-label').textContent = `Round ${state.round}`;
  const placer = state.players.find((p) => p.id === state.placerId);
  el('turn-label').textContent = placer ? `${placer.name}'s turn` : '—';
}

function renderNowPlaying() {
  const reveal = state.lastReveal;
  const revealed = state.phase === 'revealing' && reveal;

  el('np-eyebrow').textContent = revealed ? 'That was' : 'Now playing';
  el('np-title').textContent = revealed ? reveal.card.title : '??? — ?????';
  el('np-title').classList.toggle('is-hidden-track', !revealed);

  if (revealed) {
    el('np-sub').textContent = `${reveal.card.artist} · ${reveal.card.year}`;
  } else if (state.phase === 'turn_intro') {
    el('np-sub').textContent = 'Next song coming up.';
  } else if (state.phase === 'steal_choosing') {
    el('np-sub').textContent = `${state.stealClaim?.playerName} is naming it. Music paused.`;
  } else if (state.phase === 'steal_verdict') {
    el('np-sub').textContent = state.stealOutcome?.success
      ? `${state.stealOutcome.playerName} stole it.`
      : `${state.stealOutcome?.playerName} missed.`;
  } else {
    el('np-sub').textContent = 'Nobody knows the year yet.';
  }

  const art = el('disc-art');
  if (revealed && reveal.card.albumArt) {
    art.src = reveal.card.albumArt;
    art.hidden = false;
  } else {
    art.hidden = true;
    art.removeAttribute('src');
  }
}

function renderGroove() {
  const owner = state.players.find((p) => p.id === state.placerId) || state.players[0];
  el('groove-owner-name').textContent = owner ? owner.name : '—';

  const container = el('groove-cards');
  container.innerHTML = '';

  if (!owner || !owner.timeline.length) {
    const empty = document.createElement('p');
    empty.className = 'groove__empty';
    empty.textContent = 'No cards yet.';
    container.appendChild(empty);
    return;
  }

  const justPlaced = state.phase === 'revealing' && state.lastReveal?.correct ? state.lastReveal.card.year : null;

  owner.timeline.forEach((card, index) => {
    const item = document.createElement('article');
    item.className = `tcard${card.year === justPlaced ? ' tcard--new' : ''}`;
    item.style.animationDelay = `${Math.min(index * 45, 320)}ms`;
    item.innerHTML = `
      <span class="tcard__year">${card.year}</span>
      <span class="tcard__node"></span>
      <span class="tcard__drop"></span>
      <div class="tcard__body card">
        <p class="card__title">${escapeHtml(card.title)}</p>
        <p class="card__artist">${escapeHtml(card.artist)}</p>
      </div>`;
    container.appendChild(item);
  });

  // Keep a freshly placed card in view on long timelines.
  if (justPlaced !== null) {
    requestAnimationFrame(() => {
      container.querySelector('.tcard--new')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  }
}

function renderPlayerBar() {
  const bar = el('playerbar');
  bar.innerHTML = '';
  for (const p of state.players) {
    const pill = document.createElement('div');
    const classes = ['pplayer'];
    if (p.id === state.placerId) classes.push('pplayer--active');
    if (!p.connected) classes.push('pplayer--offline');
    if (state.stealBlocked.includes(p.id)) classes.push('pplayer--blocked');
    pill.className = classes.join(' ');
    pill.innerHTML = `
      <span class="pplayer__name">${escapeHtml(p.name)}</span>
      <span class="pplayer__count">${p.score}</span>`;
    bar.appendChild(pill);
  }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function renderOverlay() {
  if (state.phase === 'game_over') return showWinnerOverlay();
  if (state.phase === 'turn_intro') return showTurnIntro();
  if (state.phase === 'steal_choosing') return showStealOverlay(state.stealClaim?.playerName);
  if (state.phase === 'steal_verdict') return showStealVerdict(state.stealOutcome);

  if (state.phase === 'revealing' && state.lastReveal) {
    const key = `${state.round}:${state.lastReveal.placerId}:${state.lastReveal.card.title}`;
    if (key !== shownRevealKey) {
      shownRevealKey = key;
      showRevealOverlay(state.lastReveal);
    }
    return;
  }

  hideOverlay();
}

function hideOverlay() {
  el('overlay').hidden = true;
  el('overlay-inner').innerHTML = '';
}

/**
 * Rendered from the steal_verdict phase, which the server holds for a couple of
 * seconds. Nobody can act during it, so the result is never talked over by the
 * next thing happening — and the music comes back on the server's cue, not a
 * timer here that could drift out of step with it.
 */
let shownVerdictFor = null;

function showStealVerdict(outcome) {
  if (!outcome) return;
  const overlay = el('overlay');
  overlay.hidden = false;

  // Re-renders during the hold must not restart the animations.
  const key = `${state.round}:${state.cardsLeft}:${outcome.playerName}:${outcome.success}`;
  if (key === shownVerdictFor) return;
  shownVerdictFor = key;

  const tone = outcome.success ? 'good' : 'bad';
  el('overlay-inner').innerHTML = `
    <div class="verdict verdict--${tone}">
      ${outcome.success ? '<div class="verdict__burst"></div>' : ''}
      <span class="verdict__word">${outcome.success ? 'Stolen' : 'Denied'}</span>
      <span class="verdict__who">${escapeHtml(outcome.playerName)}</span>
      <p class="verdict__note">${outcome.success
        ? 'The card is theirs to place.'
        : 'No steal, and they are out for this song.'}</p>
    </div>`;
}

/**
 * "Alex is up", counting into the song. Rendered once per turn — the ticking
 * numbers are driven locally so the overlay doesn't depend on further traffic.
 */
let introKey = null;

function showTurnIntro() {
  const overlay = el('overlay');
  overlay.hidden = false;

  const who = nameOf(state.placerId) || 'Someone';
  const key = `${state.round}:${state.cardsLeft}:${state.placerId}`;
  if (key === introKey) return;
  introKey = key;

  const seconds = Math.max(1, Math.round((state.introMs || 3000) / 1000));
  el('overlay-inner').innerHTML = `
    <div class="intro">
      <span class="intro__who">${escapeHtml(who)}</span>
      <p class="intro__sub">is up next</p>
      <p class="intro__count" id="intro-count"><span>${seconds}</span></p>
    </div>`;

  let left = seconds;
  const countdown = setInterval(() => {
    left -= 1;
    const node = document.getElementById('intro-count');
    // The phase moved on, or the overlay was replaced — stop counting.
    if (!node || left < 1) return clearInterval(countdown);
    node.innerHTML = `<span>${left}</span>`;
  }, 1000);
}

function showStealOverlay(playerName) {
  if (!playerName) return;
  const overlay = el('overlay');
  overlay.hidden = false;
  el('overlay-inner').innerHTML = `
    <p class="steal-mark">Steal</p>
    <h2 class="overlay__headline">${escapeHtml(playerName)}</h2>
    <div class="answerclock" id="answer-clock">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="answerclock__track" cx="60" cy="60" r="54" fill="none" stroke-width="7" />
        <circle class="answerclock__ring" id="answer-ring" cx="60" cy="60" r="54" fill="none" stroke-width="7" />
      </svg>
      <span class="answerclock__value" id="answer-value">—</span>
    </div>
    <p class="overlay__sub">Picking the title and artist on their phone.</p>`;
}

function showRevealOverlay(reveal) {
  const overlay = el('overlay');
  overlay.hidden = false;

  const tone = reveal.correct ? 'good' : 'bad';
  const headline = reveal.correct ? 'Correct' : 'Not quite';
  const sub = reveal.correct
    ? `${escapeHtml(reveal.placerName)} keeps the card.${reveal.wasSteal ? ' Stolen clean.' : ''}`
    : `${escapeHtml(reveal.placerName)} loses it. The card goes back in the crate.`;

  el('overlay-inner').innerHTML = `
    <div class="flip flip--${tone}" id="flip">
      <div class="flip__inner">
        <div class="flip__face flip__face--front"><span>?</span></div>
        <div class="flip__face flip__face--back">
          ${reveal.card.albumArt ? `<img class="flip__art" src="${reveal.card.albumArt}" alt="" />` : ''}
          <span class="flip__year">${reveal.card.year}</span>
          <p class="flip__title">${escapeHtml(reveal.card.title)}</p>
          <p class="flip__artist">${escapeHtml(reveal.card.artist)}</p>
        </div>
      </div>
    </div>
    <h2 class="overlay__headline overlay__headline--${tone}">${headline}</h2>
    <p class="overlay__sub">${sub}</p>`;

  requestAnimationFrame(() => {
    setTimeout(() => {
      el('flip')?.classList.add('is-flipped');
      if (reveal.correct) SFX.correct(); else SFX.wrong();
    }, 320);
    // A kept card flies down toward the rail, so the landing on the timeline
    // reads as the same object arriving rather than a new one appearing.
    if (reveal.correct) {
      setTimeout(() => {
        el('flip')?.classList.add('is-departing');
        // Lands just as the card reaches the rail.
        setTimeout(() => SFX.cardLand(), 420);
      }, 3000);
    }
  });
}

let fanfarePlayed = false;

function showWinnerOverlay() {
  const overlay = el('overlay');
  overlay.hidden = false;
  if (!fanfarePlayed) {
    fanfarePlayed = true;
    SFX.fanfare();
  }
  const winner = state.winner;
  el('overlay-inner').innerHTML = `
    <p class="eyebrow">Game over</p>
    <p class="winner-name">${escapeHtml(winner ? winner.name : 'Nobody')}</p>
    <h2 class="overlay__headline">${winner ? `${winner.score} cards` : 'Out of songs'}</h2>
    <p class="overlay__sub">The host can start another game from their phone.</p>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(message) {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}

function nameOf(playerId) {
  return state?.players.find((p) => p.id === playerId)?.name || null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
