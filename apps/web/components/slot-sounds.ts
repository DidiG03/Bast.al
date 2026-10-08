/**
 * The casino's sounds (the slot's and the roulette wheel's), made in the browser with Web Audio: no sound
 * files, so there's nothing to license or download. They play at the
 * phone's own volume (a page can't read or change it), and on an iPhone with
 * the silent switch on, the browser keeps them silent. Players can also turn
 * them off in the game; that's remembered on this device.
 *
 * Browsers only allow sound after the Player has tapped something, so
 * `unlock()` is called from the Start button before anything plays.
 */

const STORAGE_KEY = "bastal-slot-sound";

let audio: AudioContext | null = null;
let master: GainNode | null = null;
/** A silent loop started on the tap, so the browser doesn't put the audio to sleep before the server answers. */
let keepAlive: AudioBufferSourceNode | null = null;
let ticking: ReturnType<typeof setInterval> | null = null;
/** Stops the ticking if a landing is missed; cleared with it, so an earlier spin's never cuts a later one short. */
let tickingLimit: ReturnType<typeof setTimeout> | null = null;
let on = readSetting();

function readSetting(): boolean {
  try {
    return typeof window === "undefined" || window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * The audio graph, once the Player has tapped. A suspended or interrupted context (the phone
 * ducked the audio, or the tab was in the background) still counts: the note is scheduled and
 * resume() is kicked, so it plays when the graph wakes up. Dropping those notes is what made
 * the speaker stay on while the table went quiet.
 */
function ready(): { ctx: AudioContext; out: GainNode } | null {
  if (!on || !audio || !master || audio.state === "closed") return null;
  if (audio.state !== "running") void audio.resume().catch(() => undefined);
  return { ctx: audio, out: master };
}

/** One note: a pitch (optionally sliding), with a quick attack and a decay. */
function tone(freq: number, at: number, length: number, options: { type?: OscillatorType; gain?: number; slideTo?: number } = {}) {
  const sound = ready();
  if (!sound) return;
  try {
    const { ctx, out } = sound;
    const start = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = options.type ?? "square";
    osc.frequency.setValueAtTime(freq, start);
    if (options.slideTo && options.slideTo > 0) osc.frequency.exponentialRampToValueAtTime(options.slideTo, start + length);
    const peak = options.gain ?? 0.2;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + Math.min(0.008, length * 0.4));
    env.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(length, 0.02));
    osc.connect(env).connect(out);
    osc.start(start);
    osc.stop(start + length + 0.02);
  } catch {
    // A note the browser won't schedule is skipped. It must not fail the round.
  }
}

/** A burst of filtered noise: clicks, thunks and swishes. */
function noise(at: number, length: number, options: { gain?: number; filter?: BiquadFilterType; freq?: number; sweepTo?: number } = {}) {
  const sound = ready();
  if (!sound) return;
  try {
    const { ctx, out } = sound;
    const start = ctx.currentTime + at;
    const samples = Math.max(1, Math.floor(ctx.sampleRate * length));
    const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i += 1) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = options.filter ?? "bandpass";
    const freq = Math.max(1, options.freq ?? 1200);
    filter.frequency.setValueAtTime(freq, start);
    if (options.sweepTo && options.sweepTo > 0) filter.frequency.exponentialRampToValueAtTime(options.sweepTo, start + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(Math.max(options.gain ?? 0.2, 0.0002), start);
    env.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(length, 0.02));
    source.connect(filter).connect(env).connect(out);
    source.start(start);
  } catch {
    // Same as a note: skip it, leave the round alone.
  }
}

function release() {
  try {
    keepAlive?.stop();
  } catch {
    // Already stopped.
  }
  keepAlive = null;
}

export const slotSound = {
  get on() {
    return on;
  },

  /** Turns sound on or off, and remembers it on this device. */
  setOn(next: boolean) {
    on = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      // Private browsing: it just isn't remembered.
    }
    if (!next) {
      this.stopTicking();
      release();
    } else this.unlock();
  },

  /** Call from a tap: browsers only start sound after the Player has touched the page. */
  unlock() {
    if (!on || typeof window === "undefined") return;
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      if (!audio || audio.state === "closed") {
        release();
        audio = new Context();
        master = audio.createGain();
        master.gain.value = 0.5;
        master.connect(audio.destination);
      }
    } catch {
      audio = null;
      master = null;
      return;
    }
    if (!audio || !master) return;
    // "interrupted" is the phone taking the audio away. It is not "suspended", and it stays
    // silent until resume() runs inside a tap.
    if (audio.state !== "running") void audio.resume().catch(() => undefined);
    try {
      if (!keepAlive) {
        const buffer = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(master);
        source.start();
        keepAlive = source;
      }
    } catch {
      // The context is still there. The coin or the blast plays when the round answers.
    }
  },

  /** A small button press. */
  click() {
    tone(1400, 0, 0.04, { type: "triangle", gain: 0.12 });
  },

  /** The lever: a click and a short rising whoosh as the reels set off. */
  spinStart() {
    noise(0, 0.05, { freq: 2500, gain: 0.25 });
    noise(0.02, 0.28, { filter: "bandpass", freq: 300, sweepTo: 1800, gain: 0.12 });
  },

  /** The reels running: a fast mechanical tick until they've all landed. */
  startTicking() {
    this.stopTicking();
    if (!ready()) return;
    ticking = setInterval(() => noise(0, 0.018, { filter: "highpass", freq: 3200, gain: 0.07 }), 62);
    // Never tick forever if a landing is missed.
    tickingLimit = setTimeout(() => this.stopTicking(), 9000);
  },

  stopTicking() {
    if (ticking) clearInterval(ticking);
    if (tickingLimit) clearTimeout(tickingLimit);
    ticking = null;
    tickingLimit = null;
  },

  /** A reel landing: a low thunk, a little higher for each reel to the right. */
  reelStop(reel: number) {
    tone(150 + reel * 12, 0, 0.12, { type: "sine", gain: 0.35, slideTo: 70 });
    noise(0, 0.04, { freq: 900, gain: 0.15 });
  },

  /** A star landing. */
  star(reel: number) {
    const base = 880 * 2 ** (reel / 12);
    tone(base, 0, 0.35, { type: "triangle", gain: 0.16 });
    tone(base * 1.5, 0.05, 0.4, { type: "triangle", gain: 0.1 });
  },

  /** A win: a rising jingle; a big win gets a longer fanfare. */
  win(big: boolean) {
    const notes = big ? [523, 659, 784, 1047, 784, 1047, 1319, 1568] : [659, 784, 1047, 1319];
    notes.forEach((freq, index) => tone(freq, index * (big ? 0.11 : 0.08), big ? 0.22 : 0.16, { type: "square", gain: 0.11 }));
    if (big) tone(2093, notes.length * 0.11, 0.6, { type: "triangle", gain: 0.12 });
  },

  /** Coins counting up while a win ticks into the meter. */
  coins(milliseconds: number) {
    const count = Math.min(40, Math.max(4, Math.round(milliseconds / 55)));
    for (let i = 0; i < count; i += 1) tone(1900 + (i % 3) * 180, (i * milliseconds) / count / 1000, 0.05, { type: "square", gain: 0.05 });
  },

  /** Mines: a coin landing on a safe tile. Each later gem sits a little higher. */
  coinPop(step = 1) {
    const lift = Math.min(12, Math.max(0, step - 1)) * 28;
    noise(0, 0.028, { filter: "highpass", freq: 4800, gain: 0.18 });
    tone(1520 + lift, 0, 0.07, { type: "triangle", gain: 0.16 });
    tone(2140 + lift, 0.04, 0.1, { type: "square", gain: 0.05 });
  },

  /** Mines: the tile you opened was a mine. */
  explosion() {
    noise(0, 0.07, { filter: "highpass", freq: 1600, gain: 0.26 });
    noise(0.02, 0.48, { filter: "lowpass", freq: 480, sweepTo: 90, gain: 0.38 });
    tone(96, 0.02, 0.46, { type: "sine", gain: 0.4, slideTo: 38 });
    tone(420, 0, 0.12, { type: "sawtooth", gain: 0.07, slideTo: 80 });
  },

  /** Double or nothing: the card turning over. */
  cardFlip() {
    noise(0, 0.14, { filter: "bandpass", freq: 2400, sweepTo: 700, gain: 0.2 });
  },

  /** A right guess: two bright notes up. */
  gambleWin() {
    tone(988, 0.1, 0.14, { type: "square", gain: 0.12 });
    tone(1319, 0.22, 0.3, { type: "square", gain: 0.12 });
  },

  /** A wrong guess: a low falling tone. */
  gambleLose() {
    tone(220, 0.1, 0.45, { type: "sawtooth", gain: 0.12, slideTo: 90 });
  },

  /** Blackjack: a card sliding out of the shoe onto the felt. */
  cardDeal() {
    noise(0, 0.09, { filter: "bandpass", freq: 3200, sweepTo: 1200, gain: 0.16 });
    noise(0.07, 0.03, { filter: "highpass", freq: 2000, gain: 0.08 });
  },

  /** Roulette: a chip put down on the table. */
  chip() {
    noise(0, 0.035, { filter: "bandpass", freq: 3800, gain: 0.22 });
    tone(2600, 0, 0.05, { type: "triangle", gain: 0.06 });
  },

  /** Roulette: the ball rolling round the track, a low rumble fading as it slows. */
  ballRoll(milliseconds: number) {
    const seconds = milliseconds / 1000;
    const pieces = Math.max(1, Math.round(seconds / 0.25));
    for (let i = 0; i < pieces; i += 1) {
      const fade = 1 - i / pieces;
      noise(i * 0.25, 0.32, { filter: "bandpass", freq: 500 + 900 * fade, gain: 0.05 + 0.11 * fade });
    }
  },

  /** Roulette: the ball hitting a fret between pockets; softer as it settles. */
  pocketTick(strength: number) {
    const level = Math.max(0.15, Math.min(1, strength));
    noise(0, 0.025, { filter: "highpass", freq: 2600, gain: 0.2 * level });
    tone(1800 + Math.random() * 500, 0, 0.03, { type: "triangle", gain: 0.07 * level });
  },

  /** Roulette: the ball dropping into its pocket for good. */
  ballStop() {
    noise(0, 0.06, { filter: "bandpass", freq: 1400, gain: 0.25 });
    tone(320, 0, 0.12, { type: "sine", gain: 0.2, slideTo: 160 });
  },

  /** Book of Ra: free spins won, a fanfare in an Eastern scale. */
  freeSpinsWon() {
    [440, 466, 554, 587, 659, 698, 831, 880].forEach((freq, index) => tone(freq, index * 0.12, 0.22, { type: "triangle", gain: 0.13 }));
    tone(880, 1.0, 0.9, { type: "square", gain: 0.08 });
    tone(1319, 1.0, 0.9, { type: "triangle", gain: 0.08 });
  },

  /** Book of Ra: the book's pages flipping before the special symbol shows. */
  pageFlip(pages = 6) {
    for (let i = 0; i < pages; i += 1) noise(i * 0.11, 0.09, { filter: "bandpass", freq: 3000 - i * 200, sweepTo: 900, gain: 0.14 });
  },

  /** Book of Ra: the special symbol chosen, a low gong. */
  gong() {
    tone(110, 0, 1.6, { type: "sine", gain: 0.35, slideTo: 98 });
    tone(220, 0, 1.2, { type: "triangle", gain: 0.12, slideTo: 200 });
    noise(0, 0.25, { filter: "lowpass", freq: 600, gain: 0.2 });
  },

  /** Penalty: the referee's whistle as a shootout starts. */
  whistle() {
    tone(2800, 0, 0.18, { type: "square", gain: 0.06 });
    tone(3200, 0.16, 0.22, { type: "square", gain: 0.05 });
  },

  /** Penalty: the boot on the ball. */
  kick() {
    noise(0, 0.05, { filter: "lowpass", freq: 700, gain: 0.32 });
    tone(180, 0, 0.08, { type: "sine", gain: 0.22, slideTo: 70 });
  },

  /** Penalty: the ball in the net. */
  net() {
    noise(0, 0.22, { filter: "bandpass", freq: 2400, sweepTo: 600, gain: 0.2 });
    tone(880, 0.02, 0.16, { type: "triangle", gain: 0.1 });
  },

  /** Penalty: a short cheer after a goal. */
  cheer() {
    [523, 659, 784].forEach((freq, index) => tone(freq, index * 0.07, 0.16, { type: "triangle", gain: 0.08 }));
  },

  /** Penalty: the keeper getting a hand to it. */
  save() {
    noise(0, 0.08, { filter: "bandpass", freq: 900, gain: 0.28 });
    tone(160, 0.02, 0.28, { type: "sine", gain: 0.22, slideTo: 70 });
  },

  /** Plinko: the ball tapping a peg, a little higher for each row it falls. */
  peg(row: number, rows: number) {
    tone(1100 + (row / Math.max(1, rows)) * 900 + Math.random() * 60, 0, 0.035, { type: "triangle", gain: 0.05 });
  },

  /** Plinko: the ball dropping into a bucket. Under the stake a dull thud, over it a chime, a big one a fanfare. */
  bucket(multiplier: number) {
    if (multiplier >= 10) {
      this.win(multiplier >= 100);
      return;
    }
    if (multiplier > 1) {
      tone(1320, 0, 0.09, { type: "triangle", gain: 0.13 });
      tone(1760, 0.06, 0.14, { type: "triangle", gain: 0.1 });
      return;
    }
    noise(0, 0.05, { filter: "lowpass", freq: 700, gain: 0.16 });
    tone(220, 0, 0.09, { type: "sine", gain: 0.14, slideTo: 140 });
  },

  /** Dice: the dice shaken and thrown, a quick rattle of clicks. */
  diceRoll() {
    for (let i = 0; i < 6; i += 1) noise(i * 0.035 + Math.random() * 0.012, 0.03, { filter: "bandpass", freq: 2200 + Math.random() * 1600, gain: 0.12 - i * 0.012 });
    tone(300, 0.2, 0.05, { type: "sine", gain: 0.08, slideTo: 180 });
  },

  /** Dice: one die landing on the tray, a short wooden knock, a little higher for each die to the right. */
  dieLand(index: number) {
    noise(0, 0.035, { filter: "bandpass", freq: 1700 + index * 180, gain: 0.2 });
    tone(360 + index * 40, 0, 0.07, { type: "sine", gain: 0.16, slideTo: 210 });
  },

  /** Dice: the result. A win chimes, higher and longer the more it pays; a loss is a short low knock. */
  diceResult(won: boolean, multiplier: number) {
    if (!won) {
      tone(190, 0, 0.12, { type: "sine", gain: 0.16, slideTo: 120 });
      noise(0, 0.04, { filter: "lowpass", freq: 600, gain: 0.1 });
      return;
    }
    if (multiplier >= 10) {
      this.win(multiplier >= 50);
      return;
    }
    tone(988, 0, 0.1, { type: "triangle", gain: 0.13 });
    tone(1319, 0.07, 0.16, { type: "triangle", gain: 0.11 });
  },

  /** Book of Ra: the special symbol growing to fill a reel, a rising shimmer. */
  expand(reel: number) {
    const base = 330 * 2 ** (reel / 6);
    tone(base, 0, 0.45, { type: "triangle", gain: 0.12, slideTo: base * 2 });
    noise(0, 0.4, { filter: "highpass", freq: 4000, sweepTo: 8000, gain: 0.05 });
  },
};
