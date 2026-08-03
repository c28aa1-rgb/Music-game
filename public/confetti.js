/**
 * Confetti, drawn on a canvas that sits above everything.
 *
 * Written by hand rather than pulled in, for the same reason the sound effects
 * are synthesised: the TV should stay a page with no dependencies to go stale,
 * and this is a couple of hundred lines of physics.
 *
 * Pieces are flat rectangles spun about their own axis, so each one flashes
 * edge-on as it falls instead of looking like a sliding sprite.
 */
(function () {
  const COLORS = ['#4a6fa5', '#e08a3c', '#c4453d', '#f2c14e', '#5aa87a', '#ffffff'];

  let canvas = null;
  let ctx = null;
  let pieces = [];
  let frame = null;
  let lastTime = 0;
  /** Set while a run is live; pieces stop being topped up once it passes. */
  let emitUntil = 0;
  let burstTimers = [];

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    // Backing store in device pixels so the edges stay crisp on a big screen,
    // while everything below works in CSS pixels.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(x, y, count, spread, power) {
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
      const speed = power * (0.55 + Math.random() * 0.75);
      pieces.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 7 + Math.random() * 7,
        h: 10 + Math.random() * 10,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        spin: (Math.random() - 0.5) * 14,
        tilt: Math.random() * Math.PI * 2,
        // Governs how fast it flattens out into a flutter.
        drag: 0.985 + Math.random() * 0.01,
        wobble: Math.random() * Math.PI * 2,
      });
    }
  }

  /** A cannon shot from a point, in screen coordinates. */
  function burst(x, y, count = 90) {
    ensureCanvas();
    spawn(x, y, count, Math.PI * 0.8, 900);
    run();
  }

  /** A steady fall from above the top edge, for the length of the run. */
  function rain(count = 26) {
    for (let i = 0; i < count; i++) {
      spawn(Math.random() * window.innerWidth, -20, 1, Math.PI, 120);
    }
  }

  function step(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
    lastTime = now;

    if (now < emitUntil && Math.random() < 0.7) rain(3);

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    const floor = window.innerHeight + 40;
    pieces = pieces.filter((p) => {
      p.vy += 1400 * dt;          // gravity
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.wobble += dt * 6;
      // Air resistance on a flat piece reads as a side-to-side flutter.
      p.x += (p.vx + Math.sin(p.wobble) * 40) * dt;
      p.y += p.vy * dt;
      p.tilt += p.spin * dt;

      if (p.y > floor) return false;

      // Foreshorten with the spin so the piece turns edge-on and vanishes.
      const squash = Math.abs(Math.cos(p.tilt));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.sin(p.tilt) * 0.6);
      ctx.globalAlpha = 0.25 + squash * 0.75;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * squash + 1);
      ctx.restore();
      return true;
    });

    if (pieces.length === 0 && now >= emitUntil) return stop();
    frame = requestAnimationFrame(step);
  }

  function run() {
    if (frame) return;
    lastTime = performance.now();
    frame = requestAnimationFrame(step);
  }

  /**
   * The full celebration: cannons from the bottom corners, a couple of follow-up
   * shots, and a steady fall over the top of it. Timings line up with the pops
   * in SFX.victory().
   */
  function celebrate(durationMs = 6000) {
    ensureCanvas();
    stop();
    emitUntil = performance.now() + durationMs;

    const w = window.innerWidth;
    const h = window.innerHeight;

    burst(w * 0.08, h, 110);
    burst(w * 0.92, h, 110);
    burstTimers.push(setTimeout(() => { burst(w * 0.3, h * 0.95, 80); burst(w * 0.7, h * 0.95, 80); }, 360));
    burstTimers.push(setTimeout(() => burst(w * 0.5, h * 0.9, 120), 780));
    run();
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = null;
    burstTimers.forEach(clearTimeout);
    burstTimers = [];
    emitUntil = 0;
    pieces = [];
    if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  window.Confetti = { celebrate, burst, stop };
})();
