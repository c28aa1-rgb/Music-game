/**
 * Song sets + Spotify matching.
 *
 * Runs on the TV device because it borrows that device's Spotify session —
 * searching the Web API needs a token, and the PKCE flow already put one here.
 */

const el = (id) => document.getElementById(id);

let songs = [];
let sets = null;

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Loose comparison so "Beyonce" still matches "Beyoncé" and features don't trip it. */
const normalize = (v) => String(v).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '')
  .replace(/\b(feat|ft|featuring|with)\b.*$/, '')
  .replace(/[^a-z0-9]/g, '');

const GENRE_LABELS = {
  pop: 'Pop', rock: 'Rock', hiphop: 'Hip-hop',
  rnb: 'R&B / Soul', country: 'Country', electronic: 'Electronic',
};

// ---------------------------------------------------------------------------
// Sets — independent playlists that stack, rather than filters that narrow.
// ---------------------------------------------------------------------------

async function loadSets() {
  sets = await (await fetch('/api/sets')).json();
  drawSets();
}

function drawSets() {
  const render = (kind, target) => {
    el(target).innerHTML = sets.sets
      .filter((set) => set.kind === kind)
      .map((set) => chip(set, sets.counts[set.id], sets.active.includes(set.id)))
      .join('');
  };
  render('special', 'special-chips');
  render('genre', 'genre-chips');
  render('era', 'era-chips');

  for (const node of document.querySelectorAll('.chip')) {
    node.addEventListener('click', () => toggle(node.dataset.id));
  }
  drawTally();
}

function chip(set, count, on) {
  const title = set.blurb ? ` title="${escapeHtml(set.blurb)}"` : '';
  return `<button class="chip" type="button" data-id="${set.id}"${title}
    aria-pressed="${on}">${escapeHtml(set.label)} <span class="chip__n">${count}</span></button>`;
}

async function toggle(id) {
  const next = sets.active.includes(id)
    ? sets.active.filter((s) => s !== id)
    : [...sets.active, id];

  // The server rejects an empty selection; keep the UI from getting there.
  if (!next.length) {
    el('message').textContent = 'Leave at least one set switched on.';
    return;
  }

  const res = await fetch('/api/sets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sets: next }),
  });
  const data = await res.json();
  if (!res.ok) {
    el('message').textContent = data.error;
    return;
  }
  el('message').textContent = '';
  sets.active = data.active;
  sets.activeTotal = data.activeTotal;
  drawSets();
}

function drawTally() {
  const total = sets.activeTotal;
  // A game needs one starting card each plus a working deck; under about a
  // dozen songs it will refuse to start, so say so before they try.
  const thin = total < 12;
  const node = el('tally');
  node.className = `tally${thin ? ' tally--thin' : ''}`;
  node.innerHTML = thin
    ? `<b>${total}</b> songs in play — not enough to start a game. Switch on more sets, or match more songs below.`
    : `<b>${total}</b> songs in play`;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

async function load() {
  songs = await (await fetch('/api/songs')).json();
  draw();
  if (!(await SpotifyAuth.getToken())) {
    el('message').innerHTML =
      'Not signed in to Spotify on this device. <a href="/tv">Open the TV screen</a> and connect first, then come back.';
    el('run').disabled = true;
  }
}

const keyOf = (song) => `${song.title}|${song.artist}`;
const yearsOff = () => songs.filter((s) => s._spotifyYear && s._spotifyYear !== s.year);

function draw() {
  el('rows').innerHTML = songs.map((song) => {
    const state = song.id ? (song._suspect ? 'is-suspect' : 'is-matched') : (song._tried ? 'is-failed' : '');
    const status = song.id
      ? (song._suspect ? '<span class="status status--warn">check</span>' : '<span class="status status--ok">matched</span>')
      : (song._tried ? '<span class="status status--bad">no match</span>' : '<span class="status muted">—</span>');

    const off = song._spotifyYear && song._spotifyYear !== song.year;
    const spotifyYear = song._spotifyYear
      ? (off
        ? `<span class="status status--warn">${song._spotifyYear}</span>
           <button class="useyear" type="button" data-key="${escapeHtml(keyOf(song))}">use</button>`
        : `<span class="muted">${song._spotifyYear}</span>`)
      : '<span class="muted">—</span>';

    const tags = [
      song.classic ? 'Classic' : null,
      GENRE_LABELS[song.genre] || song.genre,
    ].filter(Boolean).join(' · ');

    return `<tr class="${state}">
      <td class="yr">${song.year}</td>
      <td>${spotifyYear}</td>
      <td>${song.albumArt ? `<img class="art" src="${song.albumArt}" alt="" />` : ''}</td>
      <td>${escapeHtml(song.title)}<br /><span class="muted">${escapeHtml(song.artist)}</span></td>
      <td><span class="tag">${escapeHtml(tags)}</span></td>
      <td>${song._matched ? escapeHtml(song._matched) : '<span class="muted">—</span>'}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');

  el('count-ok').textContent = songs.filter((s) => s.id && !s._suspect).length;
  el('count-warn').textContent = songs.filter((s) => s.id && s._suspect).length;
  el('count-bad').textContent = songs.filter((s) => !s.id && s._tried).length;
  el('count-year').textContent = yearsOff().length;

  const any = songs.some((s) => s.id);
  el('save').disabled = !any;
  el('download').disabled = !any;
}

/** Versions that are never the original recording, whatever their date says. */
const NOT_ORIGINAL = /karaoke|tribute|made famous|made popular|instrumental|cover version|\blive\b|re-?recorded|rerecord|taylor's version/i;

async function search(song) {
  const token = await SpotifyAuth.getToken();
  const query = `track:${song.title.replace(/\.\.\./g, '')} artist:${song.artist}`;
  // Wide enough to see past the reissues to the original. 10 is the ceiling —
  // this app's quota rejects anything larger with "Invalid limit".
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 429) {
    // Spotify asked us to back off. Wait it out and try this song again.
    await new Promise((r) => setTimeout(r, (Number(res.headers.get('Retry-After')) || 2) * 1000));
    return search(song);
  }
  if (!res.ok) return null;

  const data = await res.json();
  const items = data.tracks?.items || [];
  if (!items.length) return null;

  const wantTitle = normalize(song.title);
  const wantArtist = normalize(song.artist);

  const candidates = items.filter((track) => {
    if (NOT_ORIGINAL.test(track.name)) return false;
    if (track.artists.some((a) => NOT_ORIGINAL.test(a.name))) return false;
    return normalize(track.name).startsWith(wantTitle.slice(0, 10))
      && track.artists.some((a) => normalize(a.name).includes(wantArtist.slice(0, 6)));
  });

  if (!candidates.length) return items[0];

  /*
   * Spotify serves remasters and greatest-hits reissues alongside originals, and
   * release_date reports the reissue — "Let It Be - Remastered 2009" comes back
   * dated 2009. Among equally good matches the earliest release is nearly always
   * the original recording, which gives both the right take and the right year.
   */
  return candidates.slice().sort((a, b) =>
    String(a.album?.release_date || '9999').localeCompare(String(b.album?.release_date || '9999')))[0];
}

el('run').addEventListener('click', async () => {
  el('run').disabled = true;
  const onlyNew = el('only-new').checked;
  const queue = songs.filter((song) => !onlyNew || !song.id);

  if (!queue.length) {
    el('message').textContent = 'Everything is already matched. Untick the box to re-match from scratch.';
    el('run').disabled = false;
    return;
  }
  el('message').textContent = `Searching Spotify for ${queue.length} song${queue.length === 1 ? '' : 's'}…`;

  for (let i = 0; i < queue.length; i++) {
    const song = queue[i];
    song._tried = true;
    try {
      const track = await search(song);
      if (track) {
        song.id = track.uri;
        song.albumArt = track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || null;
        song._matched = `${track.name} — ${track.artists.map((a) => a.name).join(', ')}`;
        song._suspect = !normalize(track.name).startsWith(normalize(song.title).slice(0, 10));
        // Spotify's own release year, so a wrong catalogue year is visible
        // rather than silently marking correct placements as wrong.
        const released = Number(String(track.album?.release_date || '').slice(0, 4));
        song._spotifyYear = Number.isInteger(released) && released > 1900 ? released : null;
      } else {
        song.id = null;
        song._matched = null;
        song._spotifyYear = null;
      }
    } catch {
      song.id = null;
      song._matched = null;
      song._spotifyYear = null;
    }
    el('bar').style.width = `${((i + 1) / queue.length) * 100}%`;
    draw();
  }

  el('run').disabled = false;
  el('message').textContent = 'Done. Save to the server so the game can use the pool right away, and download a copy to keep in the repo.';
});

// One row at a time — bulk-accepting would trade correct original years for
// remaster dates across the whole catalogue.
el('rows').addEventListener('click', (event) => {
  const button = event.target.closest('.useyear');
  if (!button) return;
  const song = songs.find((s) => keyOf(s) === button.dataset.key);
  if (!song?._spotifyYear) return;
  song.year = song._spotifyYear;
  el('message').textContent = `${song.title} is now ${song.year}. Save to write it into the catalogue.`;
  draw();
});

/** Strip the page's own bookkeeping fields before anything leaves this page. */
const clean = () => songs.map(({ _tried, _matched, _suspect, _spotifyYear, ...song }) => song);

el('save').addEventListener('click', async () => {
  const res = await fetch('/api/songs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(clean()),
  });
  const data = await res.json();
  if (!res.ok) {
    el('message').textContent = `Could not save: ${data.error}`;
    return;
  }
  el('message').textContent = `Saved. ${data.playable} songs matched.`
    + (data.yearsCorrected ? ` ${data.yearsCorrected} year${data.yearsCorrected === 1 ? '' : 's'} written into the catalogue.` : '');
  await loadSets();
});

el('download').addEventListener('click', () => {
  const blob = new Blob([`${JSON.stringify(clean(), null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'songs.json';
  link.click();
  URL.revokeObjectURL(link.href);
});

load();
loadSets();
