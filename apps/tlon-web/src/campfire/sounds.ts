/**
 * Synthesized call tones via Web Audio — no bundled assets needed.
 *
 * Browsers may refuse to start an AudioContext without prior user
 * interaction; play() is best-effort and fails silently in that case (the
 * browser notification still surfaces incoming calls).
 */

type Tone = 'ringback' | 'ringtone';

// [frequencies, onMs, periodMs]
const PATTERNS: Record<Tone, [number[], number, number]> = {
  // North-American-style ringback: 440+480Hz, 2s on / 4s off
  ringback: [[440, 480], 2000, 6000],
  // Incoming ring: brighter dual tone, 1s on / 2s off
  ringtone: [[523, 659], 1000, 3000],
};

export class CallSounds {
  private ctx: AudioContext | null = null;
  private oscillators: OscillatorNode[] = [];
  private gain: GainNode | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private current: Tone | null = null;

  play(tone: Tone) {
    if (this.current === tone) {
      return;
    }
    this.stop();
    this.current = tone;
    try {
      this.ctx = this.ctx ?? new AudioContext();
      const ctx = this.ctx;
      ctx.resume().catch(() => {});

      const [freqs, onMs, periodMs] = PATTERNS[tone];
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(ctx.destination);
      this.oscillators = freqs.map((freq) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(this.gain as GainNode);
        osc.start();
        return osc;
      });

      const burst = () => {
        const g = this.gain;
        if (!g) {
          return;
        }
        const now = ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(0.08, now + 0.02);
        g.gain.setValueAtTime(0.08, now + onMs / 1000);
        g.gain.linearRampToValueAtTime(0, now + onMs / 1000 + 0.05);
      };
      burst();
      this.interval = setInterval(burst, periodMs);
    } catch {
      this.stop();
    }
  }

  stop() {
    this.current = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.oscillators.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // already stopped
      }
    });
    this.oscillators = [];
    this.gain?.disconnect();
    this.gain = null;
  }
}
