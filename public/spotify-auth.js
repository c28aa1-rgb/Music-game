/**
 * Spotify OAuth 2.0 with PKCE.
 *
 * PKCE means no client secret ever reaches the browser, so this file is safe to
 * ship to the client. Tokens live in localStorage on the TV device only —
 * phones never authenticate with Spotify at all.
 */
(function () {
  const STORE = 'hitster.spotify';
  const VERIFIER = 'hitster.spotify.verifier';
  const RETURN_TO = 'hitster.spotify.returnTo';

  const SCOPES = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-modify-playback-state',
    'user-read-playback-state',
  ].join(' ');

  const redirectUri = `${location.origin}/callback`;

  function readStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || 'null');
    } catch {
      return null;
    }
  }

  function writeStore(token) {
    localStorage.setItem(STORE, JSON.stringify(token));
  }

  function randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  async function challengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  async function clientId() {
    const res = await fetch('/api/config');
    const config = await res.json();
    if (!config.clientId) throw new Error('SPOTIFY_CLIENT_ID is not set on the server. Copy .env.example to .env and add it.');
    return config.clientId;
  }

  /** Send the browser to Spotify's consent screen. */
  async function login(returnTo) {
    const id = await clientId();
    const verifier = randomString(96);
    sessionStorage.setItem(VERIFIER, verifier);
    sessionStorage.setItem(RETURN_TO, returnTo || location.pathname);

    const params = new URLSearchParams({
      client_id: id,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      scope: SCOPES,
    });
    location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  /** Called on /callback: swap the authorization code for tokens. */
  async function completeLogin() {
    const code = new URLSearchParams(location.search).get('code');
    const denied = new URLSearchParams(location.search).get('error');
    if (denied) throw new Error(`Spotify returned "${denied}".`);
    if (!code) throw new Error('Spotify did not return an authorization code.');

    const verifier = sessionStorage.getItem(VERIFIER);
    if (!verifier) throw new Error('This login attempt expired. Start again from the TV screen.');

    const id = await clientId();
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: id,
        code_verifier: verifier,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || 'Token exchange failed.');

    writeStore({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    sessionStorage.removeItem(VERIFIER);
    return sessionStorage.getItem(RETURN_TO) || '/tv';
  }

  async function refresh(token) {
    const id = await clientId();
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: id,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'Could not refresh the Spotify session.');

    const next = {
      accessToken: data.access_token,
      // Spotify rotates refresh tokens; keep the old one if none comes back.
      refreshToken: data.refresh_token || token.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    writeStore(next);
    return next;
  }

  /** A valid access token, refreshed if it is close to expiry. Null if signed out. */
  async function getToken() {
    const token = readStore();
    if (!token) return null;
    if (Date.now() < token.expiresAt - 60_000) return token.accessToken;
    if (!token.refreshToken) return null;
    try {
      return (await refresh(token)).accessToken;
    } catch {
      logout();
      return null;
    }
  }

  function logout() {
    localStorage.removeItem(STORE);
  }

  window.SpotifyAuth = { login, completeLogin, getToken, logout, isSignedIn: () => Boolean(readStore()) };
})();
