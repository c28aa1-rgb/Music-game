/**
 * Controller — the phone view.
 *
 * A thin client: it renders whatever the server says the game looks like and
 * sends back intents. It is never told the hidden song's year, title or artist
 * until the server publishes a reveal — which is the whole game, so the
 * placement screen deliberately shows a blank card rather than a title.
 */

const socket = io();
const el = (id) => document.getElementById(id);
const STORE = 'hitster.player';

let state = null;
let me = null;
/** Which slot in the wheel is currently centred. */
let selectedGap = 0;
/** Cheap signature of the rendered wheel, so we only rebuild when it changes. */
let reelSignature = null;
let lastRevealKey = null;
/**
 * Options for the steal question in progress, which step we're on, and the
 * title already picked. The server never says which index is correct — that's
 * checked server-side when the answer is submitted.
 */
let stealChoices = null;
/** Local mirror of the server's answer deadline, for the on-screen clock. */
let quizDeadline = 0;
let quizTimer = null;

// ---------------------------------------------------------------------------
// Identity and joining
// ---------------------------------------------------------------------------

function readIdentity() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}

function saveIdentity(next) {
  localStorage.setItem(STORE, JSON.stringify(next));
}

(function prefill() {
  const saved = readIdentity();
  const roomParam = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (roomParam) {
    el('code-input').value = roomParam;
    el('code-field').hidden = true;
  } else if (saved?.code) {
    el('code-input').value = saved.code;
  }
  if (saved?.name) el('name-input').value = saved.name;
})();

// Read storage fresh on every connect: a player who joined during this page
// session also needs to be restored after a dropped connection.
socket.on('connect', () => {
  const saved = readIdentity();
  if (!saved?.playerId) return;
  socket.emit('rejoin', saved, (res) => {
    if (res?.error) {
      localStorage.removeItem(STORE);
      show('screen-join');
    }
  });
});

el('join-btn').addEventListener('click', join);
el('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
el('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join() {
  const name = el('name-input').value.trim();
  const code = el('code-input').value.trim().toUpperCase();
  if (!name) {
    el('join-error').textContent = 'Enter a name to join.';
    return;
  }

  el('join-btn').disabled = true;
  socket.emit('join_game', { name, code }, (res) => {
    el('join-btn').disabled = false;
    if (res?.error) {
      el('join-error').textContent = res.error;
      return;
    }
    el('join-error').textContent = '';
    saveIdentity({ playerId: res.playerId, code: res.code, name });
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function send(event, payload) {
  socket.emit(event, payload || {}, (res) => {
    if (res?.error) toast(res.error);
  });
}

el('start-btn').addEventListener('click', () => send('start_game'));
el('new-room-btn').addEventListener('click', () => send('new_room'));
el('next-btn').addEventListener('click', () => send('ready_next_turn'));
el('steal-btn').addEventListener('click', () => {
  el('steal-btn').disabled = true;
  send('attempt_steal');
});
el('skip-btn').addEventListener('click', () => send('skip_song'));
el('skip-btn-2').addEventListener('click', () => send('skip_song'));

el('place-btn').addEventListener('click', () => {
  el('place-btn').disabled = true;
  send('place_card', { gapIndex: selectedGap });
});

// Scrolling the wheel is the whole interaction; scroll-snap does the settling
// and this just reports which slot ended up under the beam.
el('wheel-scroll').addEventListener('scroll', () => {
  requestAnimationFrame(updateWheel);
}, { passive: true });

// Arrow keys for anyone not using a touchscreen.
el('wheel-scroll').addEventListener('keydown', (e) => {
  const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  scrollToGap(Math.min(Math.max(selectedGap + step, 0), me.timeline.length));
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

socket.on('game_state', (next) => {
  state = next;
  me = state.players.find((p) => p.id === readIdentity()?.playerId) || null;

  // Clear stale choices once this steal is no longer live, so the next one
  // never flashes an old question before its own steal_choices arrives.
  const stillMyChoice = state.phase === 'steal_choosing' && state.stealClaim?.playerId === me?.id;
  if (!stillMyChoice) {
    stealChoices = null;
    quizDeadline = 0;
    clearInterval(quizTimer);
  } else if (state.stealDeadlineInMs > 0) {
    // Re-anchor from the server in case this phone reconnected mid-question.
    quizDeadline = Date.now() + state.stealDeadlineInMs;
  }

  stealOpensAt = state.stealOpensInMs > 0 ? Date.now() + state.stealOpensInMs : 0;

  render();
});

socket.on('steal_choices', ({ titleOptions, artistOptions }) => {
  stealChoices = { titleOptions, artistOptions, titleIndex: null, artistIndex: null };
  quizDeadline = Date.now() + (state?.stealAnswerMs || 6000);
  startQuizClock();
  render();
});

/** This room was abandoned; start fresh on the join screen with the new code. */
socket.on('room_closed', ({ code }) => {
  localStorage.removeItem(STORE);
  location.href = `/?room=${code}`;
});

const SCREENS = ['screen-join', 'screen-lobby', 'screen-waiting', 'screen-place', 'screen-steal-choice', 'screen-reveal', 'screen-over'];

function show(id) {
  for (const screen of SCREENS) el(screen).hidden = screen !== id;
  // The steal countdown only makes sense on the waiting screen; left running it
  // would keep ticking against a button nobody can see.
  if (id !== 'screen-waiting') clearInterval(stealCountdown);
}

function render() {
  if (!me) return show('screen-join');

  switch (state.phase) {
    case 'lobby': return renderLobby();
    case 'game_over': return renderOver();
    case 'revealing': return renderReveal();
    // The intro and the verdict belong to the TV; phones wait them out. Not
    // handing the placer their wheel back until the verdict is over is the
    // point — otherwise they can commit a card while the room is still
    // reading the result.
    case 'turn_intro':
    case 'steal_verdict': return renderWaiting();
    case 'steal_choosing':
      return state.stealClaim?.playerId === me.id ? renderStealChoice() : renderWaiting();
    default:
      return state.placerId === me.id ? renderPlace() : renderWaiting();
  }
}

function renderLobby() {
  show('screen-lobby');
  reelSignature = null;
  lastRevealKey = null;
  el('lobby-code-label').textContent = state.code;

  const list = el('lobby-list');
  list.innerHTML = '';
  for (const p of state.players) {
    const item = document.createElement('li');
    item.className = `roster__item${p.id === me.id ? ' roster__item--you' : ''}${p.connected ? '' : ' roster__item--offline'}`;
    item.innerHTML = `<span>${escapeHtml(p.name)}</span>`;

    if (p.isHost) {
      item.insertAdjacentHTML('beforeend', '<span class="roster__tag">host</span>');
    } else if (me.isHost && p.connected) {
      // Only the current host can hand it off, and only to someone actually here.
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'roster__action';
      button.textContent = 'Make host';
      button.addEventListener('click', () => send('transfer_host', { playerId: p.id }));
      item.appendChild(button);
    }

    list.appendChild(item);
  }

  const enough = state.players.length >= 2;
  el('start-btn').hidden = !me.isHost;
  el('start-btn').disabled = !enough || !state.spotifyReady;

  if (!state.spotifyReady) {
    el('lobby-note').textContent = 'The TV screen still needs to connect to Spotify.';
  } else if (!enough) {
    el('lobby-note').textContent = 'Waiting for one more player.';
  } else if (me.isHost) {
    el('lobby-note').textContent = 'Everyone in? Start when you are ready.';
  } else {
    const host = state.players.find((p) => p.isHost);
    el('lobby-note').textContent = `${host ? host.name : 'The host'} starts the game.`;
  }
}

function renderWaiting() {
  show('screen-waiting');
  reelSignature = null;

  const placer = state.players.find((p) => p.id === state.placerId);
  const playing = state.phase === 'playing';
  const intro = state.phase === 'turn_intro';
  const verdict = state.phase === 'steal_verdict' ? state.stealOutcome : null;
  const stealerName = state.stealClaim?.playerName;

  if (verdict) {
    const mine = verdict.playerName === me.name;
    el('waiting-eyebrow').textContent = verdict.success ? 'Stolen' : 'Denied';
    el('waiting-title').textContent = verdict.success
      ? (mine ? 'You got it' : `${verdict.playerName} got it`)
      : (mine ? 'Not this time' : `${verdict.playerName} missed`);
    el('waiting-note').textContent = verdict.success
      ? 'The card goes to them to place.'
      : 'The song picks up where it left off.';
  } else {
    el('waiting-eyebrow').textContent = intro ? 'Next up' : playing ? 'Listening' : 'Hold on';
    el('waiting-title').textContent = playing || intro
      ? (placer ? `${placer.name} is up` : 'Waiting')
      : (stealerName ? `${stealerName} is naming it` : 'Waiting');
    el('waiting-note').textContent = intro
      ? 'The next song is about to start.'
      : playing
        ? 'A song is playing on the TV. No year, no title, no clues.'
        : (stealerName ? `${stealerName} is picking their answer. Music is paused.` : 'The table is sorting something out.');
  }

  const wave = el('waiting-wave');
  if (!wave.childElementCount) buildWave(wave, 28);
  wave.classList.toggle('is-idle', !playing);

  renderVerticalTimeline(el('waiting-timeline'));
  renderStealButton(playing);

  // Not a Hitster rule — only offered when a track has actually failed to play.
  el('skip-btn').hidden = !me.isHost || !playing || !state.playbackFailed;
}

/**
 * The steal button spends most of a song locked. It counts itself down rather
 * than just sitting greyed out, so the wait reads as part of the game.
 */
let stealOpensAt = 0;
let stealCountdown = null;

function renderStealButton(playing) {
  const button = el('steal-btn');
  const note = el('steal-note');
  const blocked = state.stealBlocked.includes(me.id);

  clearInterval(stealCountdown);

  if (!playing || blocked || state.stealClaim) {
    button.disabled = true;
    button.textContent = 'Steal';
    note.textContent = blocked
      ? 'You already used your steal on this song.'
      : 'The steal window is closed.';
    return;
  }

  const tick = () => {
    const remaining = stealOpensAt - Date.now();
    if (remaining > 0) {
      button.disabled = true;
      button.textContent = `Steal in ${Math.ceil(remaining / 1000)}`;
      note.textContent = 'Listen first — stealing opens partway through the song.';
      return;
    }
    clearInterval(stealCountdown);
    button.disabled = false;
    button.textContent = 'Steal';
    note.textContent = 'Six seconds to name the song and the artist.';
  };

  tick();
  stealCountdown = setInterval(tick, 200);
}

// ---------------------------------------------------------------------------
// Placement wheel
// ---------------------------------------------------------------------------

/** Year row height in px. Must match .wrow in the stylesheet. */
const ROW_H = 62;

function renderPlace() {
  show('screen-place');
  el('place-eyebrow').textContent = state.phase === 'steal_placing' ? 'You stole it' : 'Your turn';
  el('place-btn').disabled = false;
  el('skip-btn-2').hidden = !me.isHost || state.phase !== 'playing' || !state.playbackFailed;

  const timeline = me.timeline;
  // cardsLeft ticks down once per turn, so a wrong guess — which leaves the
  // timeline untouched — still counts as a new turn and recentres the wheel.
  const signature = `${timeline.map((c) => c.year).join(',')}|${state.cardsLeft}`;

  const fresh = signature !== reelSignature;
  if (fresh) {
    reelSignature = signature;
    buildWheel(timeline);
    // Open in the middle so the first scroll is short in either direction.
    scrollToGap(Math.floor(timeline.length / 2), false);
  }
  updateWheel();

  // The screen was hidden a moment ago, so the scroller only reaches its real
  // height after this frame. Re-measure once it has, or the end slots can't
  // reach the beam.
  requestAnimationFrame(() => {
    if (el('screen-place').hidden) return;
    if (sizeWheelPadding() || fresh) scrollToGap(selectedGap, false);
  });
}

function buildWheel(timeline) {
  const rail = el('wheel-rail');
  rail.innerHTML = '';

  const pad = document.createElement('div');
  pad.className = 'wheel__pad';
  rail.appendChild(pad);

  // marker, year, marker, year … marker. The markers are the snap targets;
  // the years are just labels that part around the fixed centre card.
  for (let i = 0; i <= timeline.length; i++) {
    const mark = document.createElement('div');
    mark.className = 'wmark';
    mark.dataset.gap = String(i);
    mark.setAttribute('role', 'option');
    rail.appendChild(mark);

    const card = timeline[i];
    if (!card) continue;
    const row = document.createElement('div');
    row.className = 'wrow';
    row.textContent = card.year;
    rail.appendChild(row);
  }

  const padEnd = document.createElement('div');
  padEnd.className = 'wheel__pad';
  rail.appendChild(padEnd);

  sizeWheelPadding();
}

/**
 * Half a viewport of padding at each end, so the boundaries before the first
 * year and after the last can still reach the centre. The markers are
 * zero-height, so this is exactly half the scroller rather than half a row.
 */
function sizeWheelPadding() {
  const scroller = el('wheel-scroll');
  const pads = el('wheel-rail').querySelectorAll('.wheel__pad');
  const height = Math.max(0, scroller.clientHeight / 2);
  let changed = false;
  pads.forEach((pad) => {
    const next = `${height}px`;
    if (pad.style.height !== next) { pad.style.height = next; changed = true; }
  });
  return changed;
}

/*
 * The scroller only reaches its real height once the flex layout settles, and
 * the first sizing pass runs before that — leaving the padding too short and
 * the end slots unreachable. Watching the element catches that settle, plus
 * every later resize, without guessing at timings.
 */
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    if (el('screen-place').hidden) return;
    if (sizeWheelPadding()) scrollToGap(selectedGap, false);
  }).observe(el('wheel-scroll'));
}

function scrollToGap(index, smooth = true) {
  const scroller = el('wheel-scroll');
  const mark = el('wheel-rail').querySelector(`.wmark[data-gap="${index}"]`);
  if (!mark) return;
  scroller.scrollTo({ top: mark.offsetTop - scroller.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  // Snap picks this up on settle, but update immediately so the label is right.
  selectedGap = index;
  updateWheel();
}

/** How far the years part to make room for the card sitting between them. */
const GAP_H = 74;

/**
 * Parts the years around the centre card, fades them off with distance, and
 * works out which boundary is currently under it. Runs on every scroll frame,
 * so it only writes inline custom properties — no layout thrash.
 */
function updateWheel() {
  const scroller = el('wheel-scroll');
  const rail = el('wheel-rail');
  if (!rail.childElementCount) return;

  const centre = scroller.scrollTop + scroller.clientHeight / 2;
  let bestGap = selectedGap;
  let bestDistance = Infinity;

  for (const node of rail.children) {
    if (node.classList.contains('wheel__pad')) continue;

    const nodeCentre = node.offsetTop + node.offsetHeight / 2;
    const offset = nodeCentre - centre;

    if (node.classList.contains('wmark')) {
      const distance = Math.abs(offset);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestGap = Number(node.dataset.gap);
      }
      continue;
    }

    // Years above the centre slide up, years below slide down — that split is
    // the gap the card occupies, and it's always in the middle.
    node.style.setProperty('--shift', `${offset < 0 ? -GAP_H / 2 : GAP_H / 2}px`);

    // Fall off over roughly three rows, then hold, so distant years stay
    // legible rather than collapsing to nothing.
    const falloff = Math.min(Math.abs(offset) / (ROW_H * 3), 1);
    node.style.setProperty('--s', String(1 - falloff * 0.3));
    node.style.setProperty('--o', String(1 - falloff * 0.6));
  }

  selectedGap = bestGap;
  el('gap-label').textContent = gapLabel(me.timeline, bestGap);
}

window.addEventListener('resize', () => {
  if (el('screen-place').hidden) return;
  sizeWheelPadding();
  scrollToGap(selectedGap, false);
});

function gapLabel(timeline, index) {
  const before = timeline[index - 1];
  const after = timeline[index];
  if (!before && !after) return 'Anywhere';
  if (!before) return `Before ${after.year}`;
  if (!after) return `After ${before.year}`;
  return `Between ${before.year} and ${after.year}`;
}

// ---------------------------------------------------------------------------
// Steal quiz — one question per screen, tap to answer, no confirm.
// ---------------------------------------------------------------------------

function renderStealChoice() {
  show('screen-steal-choice');

  if (!stealChoices) {
    // steal_choices lands a beat after game_state; nothing to show yet.
    el('quiz-choices').innerHTML = '';
    return;
  }

  const onTitle = stealChoices.titleIndex === null;
  el('quiz-step').textContent = onTitle ? 'Question 1 of 2' : 'Question 2 of 2';
  el('quiz-title').textContent = onTitle ? 'Which song is this?' : 'Who is it by?';

  const options = onTitle ? stealChoices.titleOptions : stealChoices.artistOptions;
  const container = el('quiz-choices');
  container.innerHTML = '';

  options.forEach((text, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.textContent = text;
    button.addEventListener('click', () => pickAnswer(i), { once: true });
    container.appendChild(button);
  });
}

function pickAnswer(index) {
  if (!stealChoices) return;

  if (stealChoices.titleIndex === null) {
    stealChoices.titleIndex = index;
    renderStealChoice();
    return;
  }

  // Second tap is the whole answer — nothing to confirm.
  stealChoices.artistIndex = index;
  el('quiz-choices').innerHTML = '';
  send('submit_steal_answer', {
    titleIndex: stealChoices.titleIndex,
    artistIndex: stealChoices.artistIndex,
  });
}

/** Mirrors the server's deadline so the stealer can see it running out. */
function startQuizClock() {
  clearInterval(quizTimer);
  quizTimer = setInterval(() => {
    if (!quizDeadline) return;
    const total = state?.stealAnswerMs || 6000;
    const remaining = Math.max(0, quizDeadline - Date.now());
    const seconds = Math.ceil(remaining / 1000);

    el('quiz-clock').textContent = String(seconds);
    el('quiz-clock').classList.toggle('quiz__clock--urgent', remaining <= 3000);
    el('quiz-bar-fill').style.transform = `scaleX(${remaining / total})`;
    el('quiz-bar-fill').parentElement.classList.toggle('quiz__bar--urgent', remaining <= 3000);
  }, 100);
}

function renderReveal() {
  show('screen-reveal');
  reelSignature = null;

  const reveal = state.lastReveal;
  if (!reveal) return;

  const mine = reveal.placerId === me.id;
  const tone = reveal.correct ? 'good' : 'bad';
  const headline = reveal.correct
    ? (mine ? 'You got it' : `${reveal.placerName} got it`)
    : (mine ? 'Not quite' : `${reveal.placerName} missed`);

  el('reveal-body').className = `reveal reveal--${tone}`;
  el('reveal-body').innerHTML = `
    <div class="reveal__emoji">${reveal.correct ? '🎉' : '😬'}</div>
    <p class="reveal__headline reveal__headline--${tone}">${escapeHtml(headline)}</p>
    ${reveal.card.albumArt ? `<img class="reveal__art" src="${reveal.card.albumArt}" alt="" />` : ''}
    <span class="reveal__year">${reveal.card.year}</span>
    <p class="reveal__track">${escapeHtml(reveal.card.title)}</p>
    <p class="reveal__artist">${escapeHtml(reveal.card.artist)}</p>
    <p class="note">${reveal.correct ? '+1 card' : 'The card goes back in the crate.'}</p>`;

  // The game advances itself; this button only cuts the wait short.
  el('next-btn').hidden = !(mine || me.isHost);
  el('next-btn').disabled = false;
  el('next-btn').textContent = 'Skip ahead';

  const key = `${state.round}:${reveal.placerId}:${reveal.card.title}`;
  if (key !== lastRevealKey) {
    lastRevealKey = key;
    el('reveal-note').innerHTML = `<span class="nextbar"><i style="animation-duration:${state.revealMs}ms"></i></span>`;
    if (reveal.correct && mine) confetti();
  }
}

function renderOver() {
  show('screen-over');
  const winner = state.winner;
  el('over-title').textContent = winner
    ? (winner.id === me.id ? 'You win' : `${winner.name} wins`)
    : 'Out of songs';
  el('over-note').textContent = winner ? `${winner.score} cards on the timeline.` : 'The crate is empty.';

  const list = el('over-list');
  list.innerHTML = '';
  for (const p of [...state.players].sort((a, b) => b.score - a.score)) {
    const item = document.createElement('li');
    item.className = `roster__item${p.id === me.id ? ' roster__item--you' : ''}`;
    item.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="roster__score">${p.score}</span>`;
    list.appendChild(item);
  }

  el('new-room-btn').hidden = !me.isHost;
  el('over-hint').textContent = me.isHost
    ? 'Opens a fresh room. Everyone rejoins with the new code.'
    : 'The host can open a new room from here.';
}

function renderVerticalTimeline(container) {
  container.innerHTML = '';

  if (!me.timeline.length) {
    const empty = document.createElement('li');
    empty.className = 'note';
    empty.textContent = 'No cards yet.';
    container.appendChild(empty);
    return;
  }

  for (const card of me.timeline) {
    const item = document.createElement('li');
    item.className = 'trow';
    item.innerHTML = `
      <span class="trow__year">${card.year}</span>
      <span class="trow__meta">
        <p class="trow__title">${escapeHtml(card.title)}</p>
        <p class="trow__artist">${escapeHtml(card.artist)}</p>
      </span>`;
    container.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Flourishes
// ---------------------------------------------------------------------------

function buildWave(node, count) {
  node.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const bar = document.createElement('i');
    bar.style.animationDuration = `${420 + Math.random() * 640}ms`;
    bar.style.animationDelay = `${-Math.random() * 900}ms`;
    node.appendChild(bar);
  }
}

function confetti() {
  const stage = el('confetti');
  const colors = ['#4A6FA5', '#E08A3C', '#C4453D', '#A9BDD6'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    piece.style.animationDelay = `${Math.random() * 0.35}s`;
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    stage.appendChild(piece);
    setTimeout(() => piece.remove(), 3600);
  }
  if (navigator.vibrate) navigator.vibrate([12, 40, 12]);
}

let toastTimer = null;

function toast(message) {
  const node = el('phone-toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
