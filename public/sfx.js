/**
 * Sound effects, synthesised in the browser.
 *
 * Nothing is loaded from disk: every sound is built from oscillators and gain
 * envelopes at play time. That keeps the page weightless, sidesteps licensing
 * entirely, and means the ticking clock lines up with the server's deadline
 * instead of drifting against a sample.
 *
 * Everything sits deliberately low in the mix — these play over music, and the
 * song is the thing people are listening to.
 */
(function () {
  let ctx = null;
  let master = null;

  /**
   * Browsers start an AudioContext suspended until a gesture. The TV's
   * "turn the sound on" tap is that gesture, and it calls this.
   */
  function unlock() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** One shaped tone. Everything below is a handful of these stacked up. */
  function tone({ freq, endFreq, type = 'sine', start = 0, duration = 0.2, peak = 1, glideCurve = 'exponential' }) {
    if (!ctx) return;
    const at = ctx.currentTime + start;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (endFreq && endFreq !== freq) {
      // Exponential ramps can't reach or cross zero, hence the guard.
      if (glideCurve === 'exponential' && endFreq > 0) osc.frequency.exponentialRampToValueAtTime(endFreq, at + duration);
      else osc.frequency.linearRampToValueAtTime(endFreq, at + duration);
    }

    const gain = ctx.createGain();
    // A tiny attack instead of an instant one; square starts click otherwise.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** Filtered noise, for anything percussive. */
  function noise({ start = 0, duration = 0.12, peak = 0.5, frequency = 1800, q = 1 }) {
    if (!ctx) return;
    const at = ctx.currentTime + start;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    source.connect(filter).connect(gain).connect(master);
    source.start(at);
    source.stop(at + duration);
  }

  const SFX = {
    unlock,

    /** Someone hit steal. A stab and a rising swell — the room should look up. */
    stealClaimed() {
      noise({ duration: 0.18, peak: 0.55, frequency: 2600, q: 0.7 });
      tone({ freq: 180, endFreq: 620, type: 'sawtooth', duration: 0.42, peak: 0.4 });
      tone({ freq: 1400, type: 'square', start: 0.02, duration: 0.1, peak: 0.22 });
    },

    /** One second gone. Dry and small so six of them don't become annoying. */
    tick() {
      tone({ freq: 1250, type: 'square', duration: 0.035, peak: 0.3 });
    },

    /** Last three seconds: same tick, higher and harder. */
    tickUrgent() {
      tone({ freq: 1650, type: 'square', duration: 0.045, peak: 0.5 });
    },

    /** Got it. A major arpeggio, up. */
    correct() {
      tone({ freq: 523.25, type: 'triangle', duration: 0.13, peak: 0.6 });
      tone({ freq: 659.25, type: 'triangle', start: 0.1, duration: 0.13, peak: 0.6 });
      tone({ freq: 783.99, type: 'triangle', start: 0.2, duration: 0.3, peak: 0.65 });
    },

    /** Missed it. Two notes down, detuned enough to sit wrong. */
    wrong() {
      tone({ freq: 340, type: 'sawtooth', duration: 0.16, peak: 0.45 });
      tone({ freq: 210, type: 'sawtooth', start: 0.13, duration: 0.34, peak: 0.45 });
      tone({ freq: 203, type: 'sawtooth', start: 0.13, duration: 0.34, peak: 0.3 });
    },

    /** A card landed on the timeline. */
    cardLand() {
      noise({ duration: 0.09, peak: 0.35, frequency: 1100, q: 1.4 });
      tone({ freq: 520, endFreq: 300, type: 'sine', duration: 0.16, peak: 0.4 });
    },

    /**
     * Somebody is one card from winning. Deliberately not a happy sound — it
     * is a warning to everyone else — so it climbs and then hangs unresolved
     * on a bare fifth instead of landing on a major chord.
     */
    matchPoint() {
      noise({ duration: 0.5, peak: 0.22, frequency: 5200, q: 0.5 });
      [440, 587.33, 659.25].forEach((freq, i) => {
        tone({ freq, type: 'triangle', start: i * 0.13, duration: 0.16, peak: 0.5 });
      });
      // The held pair, left hanging.
      tone({ freq: 659.25, type: 'triangle', start: 0.39, duration: 1.1, peak: 0.5 });
      tone({ freq: 988, type: 'triangle', start: 0.39, duration: 1.1, peak: 0.34 });
      tone({ freq: 164.81, type: 'sine', start: 0.39, duration: 1.2, peak: 0.42 });
    },

    /** Somebody won. */
    fanfare() {
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        tone({ freq, type: 'triangle', start: i * 0.11, duration: i === 3 ? 0.6 : 0.16, peak: 0.6 });
      });
    },

    /**
     * The end of the whole game, not just a good guess — so it runs long and
     * layers up: a rising run into a held major chord, three confetti pops
     * timed to the bursts on screen, and a bass note under all of it.
     */
    victory() {
      // Run up to the top.
      [392, 523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        tone({ freq, type: 'triangle', start: i * 0.09, duration: 0.14, peak: 0.55 });
      });

      // Held C major on top of it, brass-ish.
      const chordAt = 0.45;
      [523.25, 659.25, 783.99, 1046.5].forEach((freq) => {
        tone({ freq, type: 'sawtooth', start: chordAt, duration: 1.5, peak: 0.3 });
        // A hair sharp, so the chord shimmers instead of sitting dead still.
        tone({ freq: freq * 1.003, type: 'sawtooth', start: chordAt, duration: 1.5, peak: 0.22 });
      });
      tone({ freq: 130.81, type: 'sine', start: chordAt, duration: 1.8, peak: 0.5 });

      // Poppers, lined up with the confetti bursts.
      [0.42, 0.78, 1.2].forEach((start) => {
        noise({ start, duration: 0.16, peak: 0.5, frequency: 3200, q: 0.5 });
        tone({ freq: 900, endFreq: 2400, type: 'square', start, duration: 0.09, peak: 0.25 });
      });

      // Cymbal-ish wash to close it out.
      noise({ start: chordAt, duration: 1.1, peak: 0.3, frequency: 7000, q: 0.4 });

      // The final tag, an octave up.
      [1046.5, 1318.5, 1568].forEach((freq, i) => {
        tone({ freq, type: 'triangle', start: 1.7 + i * 0.1, duration: i === 2 ? 0.9 : 0.16, peak: 0.5 });
      });
    },
  };

  window.SFX = SFX;
})();
