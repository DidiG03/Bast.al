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

/** The audio graph, once the Player has tapped; null before then, or when sound is off or unsupported. */
function ready(): { ctx: AudioContext; out: GainNode } | null {
  if (!on || !audio || !master || audio.state !== "running") return null;
  return { ctx: audio, out: master };
}

/** One note: a pitch (optionally sliding), with a quick attack and a decay. */
function tone(freq: number, at: number, length: number, options: { type?: OscillatorType; gain?: number; slideTo?: number } = {}) {
  const sound = ready();
  if (!sound) return;
  const { ctx, out } = sound;
  const start = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = options.type ?? "square";
  osc.frequency.setValueAtTime(freq, start);
  if (options.slideTo) osc.frequency.exponentialRampToValueAtTime(options.slideTo, start + length);
  const peak = options.gain ?? 0.2;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(env).connect(out);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/** A burst of filtered noise: clicks, thunks and swishes. */
function noise(at: number, length: number, options: { gain?: number; filter?: BiquadFilterType; freq?: number; sweepTo?: number } = {}) {
  const sound = ready();
  if (!sound) return;
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
  filter.frequency.setValueAtTime(options.freq ?? 1200, start);
  if (options.sweepTo) filter.frequency.exponentialRampToValueAtTime(options.sweepTo, start + length);
  const env = ctx.createGain();
  env.gain.setValueAtTime(options.gain ?? 0.2, start);
  env.gain.exponentialRampToValueAtTime(0.0001, start + length);
  source.connect(filter).connect(env).connect(out);
  source.start(start);
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
    if (!next) this.stopTicking();
    else this.unlock();
  },

  /** Call from a tap: browsers only start sound after the Player has touched the page. */
  unlock() {
    if (!on || typeof window === "undefined") return;
    try {
      if (!audio) {
        const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Context) return;
        audio = new Context();
        master = audio.createGain();
        master.gain.value = 0.5;
        master.connect(audio.destination);
      }
      if (audio.state === "suspended") void audio.resume();
    } catch {
      audio = null;
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
};
