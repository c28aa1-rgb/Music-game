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
/** Which gap the slider is currently sitting on. */
let selectedGap = 0;
/** Cheap signature of the rendered reel, so we only rebuild when it changes. */
let reelSignature = null;
let lastRevealKey = null;
/**
 * Options for the steal question in progress, plus which one is currently
 * picked. The server never tells anyone which index is correct — that's
 * checked server-side when the answer is submitted.
 */
let stealChoices = null;

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
el('restart-btn').addEventListener('click', () => send('restart_game'));
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

/*
 * The thumb moves continuously with the finger, but the card only changes slot
 * once the thumb is past the halfway point between two of them — so dragging
 * feels smooth while the card still reads as landing in a definite place.
 * Releasing snaps the thumb onto the slot the card actually chose.
 */
el('gap-slider').addEventListener('input', (e) => {
  setGap(Math.round(Number(e.target.value)));
});

el('gap-slider').addEventListener('change', (e) => {
  const gap = Math.round(Number(e.target.value));
  e.target.value = String(gap);
  setGap(gap);
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
  if (!stillMyChoice) stealChoices = null;

  render();
});

socket.on('steal_choices', ({ titleOptions, artistOptions }) => {
  stealChoices = { titleOptions, artistOptions, titleIndex: null, artistIndex: null };
  render();
});

const SCREENS = ['screen-join', 'screen-lobby', 'screen-waiting', 'screen-place', 'screen-steal-choice', 'screen-reveal', 'screen-over'];

function show(id) {
  for (const screen of SCREENS) el(screen).hidden = screen !== id;
}

function render() {
  if (!me) return show('screen-join');

  switch (state.phase) {
    case 'lobby': return renderLobby();
    case 'game_over': return renderOver();
    case 'revealing': return renderReveal();
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
    item.innerHTML = `<span>${escapeHtml(p.name)}</span>${p.isHost ? '<span class="roster__tag">host</span>' : ''}`;
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
  const stealerName = state.stealClaim?.playerName;

  el('waiting-eyebrow').textContent = playing ? 'Listening' : 'Hold on';
  el('waiting-title').textContent = playing
    ? (placer ? `${placer.name} is up` : 'Waiting')
    : (stealerName ? `${stealerName} is naming it` : 'Waiting');
  el('waiting-note').textContent = playing
    ? 'A song is playing on the TV. No year, no title, no clues.'
    : (stealerName ? `${stealerName} is picking their answer. Music is paused.` : 'The table is sorting something out.');

  const wave = el('waiting-wave');
  if (!wave.childElementCount) buildWave(wave, 28);
  wave.classList.toggle('is-idle', !playing);

  renderVerticalTimeline(el('waiting-timeline'));

  const blocked = state.stealBlocked.includes(me.id);
  const canSteal = playing && !blocked && !state.stealClaim;
  el('steal-btn').disabled = !canSteal;
  el('steal-note').textContent = blocked
    ? 'You already used your steal on this song.'
    : canSteal
      ? 'Know it? Hit steal and pick the title and artist from a list.'
      : 'The steal window is closed.';

  // Not a Hitster rule — only offered when a track has actually failed to play.
  el('skip-btn').hidden = !me.isHost || !playing || !state.playbackFailed;
}

// ---------------------------------------------------------------------------
// Placement reel
// ---------------------------------------------------------------------------

function renderPlace() {
  show('screen-place');
  el('place-eyebrow').textContent = state.phase === 'steal_placing' ? 'You stole it' : 'Your turn';
  el('place-btn').disabled = false;
  el('skip-btn-2').hidden = !me.isHost || state.phase !== 'playing' || !state.playbackFailed;

  const timeline = me.timeline;
  // cardsLeft ticks down once per turn, so a wrong guess — which leaves the
  // timeline untouched — still counts as a new turn and recentres the slider.
  const signature = `${timeline.map((c) => c.year).join(',')}|${state.cardsLeft}`;

  if (signature !== reelSignature) {
    reelSignature = signature;
    // Open in the middle so the first drag is short in either direction.
    selectedGap = Math.floor(timeline.length / 2);
    buildReel(timeline);
  }

  const slider = el('gap-slider');
  slider.max = String(timeline.length);
  slider.value = String(selectedGap);
  setGap(selectedGap, true);
}

function buildReel(timeline) {
  const track = el('reel-track');
  track.innerHTML = '';

  for (let i = 0; i <= timeline.length; i++) {
    const slot = document.createElement('div');
    slot.className = 'rgap';
    slot.dataset.gap = String(i);
    track.appendChild(slot);

    const card = timeline[i];
    if (!card) continue;
    const node = document.createElement('article');
    node.className = 'rcard';
    node.innerHTML = `
      <span class="rcard__year">${card.year}</span>
      <p class="rcard__title">${escapeHtml(card.title)}</p>
      <p class="rcard__artist">${escapeHtml(card.artist)}</p>`;
    track.appendChild(node);
  }
}

function setGap(index, force = false) {
  // input fires on every pixel of the drag; most of those land on the slot we
  // are already showing, and re-running the scroll would fight the finger.
  if (!force && index === selectedGap) return;
  selectedGap = index;

  const slots = el('reel-track').querySelectorAll('.rgap');
  slots.forEach((slot) => slot.classList.toggle('rgap--open', Number(slot.dataset.gap) === index));

  el('gap-label').textContent = gapLabel(me.timeline, index);

  // Slot widths are fixed, so this offset is stable and the card can simply
  // glide to it rather than chasing a reflowing row.
  const target = slots[index];
  if (!target) return;
  el('reel-card').style.transform = `translateX(${target.offsetLeft}px)`;
  target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

function gapLabel(timeline, index) {
  const before = timeline[index - 1];
  const after = timeline[index];
  if (!before && !after) return 'Anywhere';
  if (!before) return `Before ${after.year}`;
  if (!after) return `After ${before.year}`;
  return `${before.year} – ${after.year}`;
}

// ---------------------------------------------------------------------------

function renderStealChoice() {
  show('screen-steal-choice');

  if (!stealChoices) {
    // steal_choices lands a beat after game_state; nothing to show yet.
    el('steal-title-choices').innerHTML = '';
    el('steal-artist-choices').innerHTML = '';
    el('steal-submit-btn').disabled = true;
    return;
  }

  renderChoiceGroup(el('steal-title-choices'), stealChoices.titleOptions, stealChoices.titleIndex, (i) => {
    stealChoices.titleIndex = i;
    renderStealChoice();
  });
  renderChoiceGroup(el('steal-artist-choices'), stealChoices.artistOptions, stealChoices.artistIndex, (i) => {
    stealChoices.artistIndex = i;
    renderStealChoice();
  });

  el('steal-submit-btn').disabled = stealChoices.titleIndex === null || stealChoices.artistIndex === null;
}

function renderChoiceGroup(container, options, selectedIndex, onPick) {
  container.innerHTML = '';
  options.forEach((text, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `choice${i === selectedIndex ? ' choice--selected' : ''}`;
    button.textContent = text;
    button.addEventListener('click', () => onPick(i));
    container.appendChild(button);
  });
}

el('steal-submit-btn').addEventListener('click', () => {
  if (!stealChoices || stealChoices.titleIndex === null || stealChoices.artistIndex === null) return;
  el('steal-submit-btn').disabled = true;
  send('submit_steal_answer', { titleIndex: stealChoices.titleIndex, artistIndex: stealChoices.artistIndex });
});

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

  el('restart-btn').hidden = !me.isHost;
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
