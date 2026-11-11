import { describe, expect, it } from 'vitest';
import { measureAudioLevels } from '../src/engine/audio-levels.js';

describe('real playback audio levels', () => {
  it('settles all five bars to zero for digital silence', () => {
    const signal = measureAudioLevels(new Float32Array(1024));
    expect(signal).toEqual({ rms: 0, peak: 0, levels: [0, 0, 0, 0, 0], silent: true });
  });

  it('derives RMS, peak, and bar heights from sampled PCM values', () => {
    const samples = Float32Array.from({ length: 1024 }, (_, i) => 0.25 * Math.sin(2 * Math.PI * 440 * i / 48_000));
    const signal = measureAudioLevels(samples);
    expect(signal.silent).toBe(false);
    expect(signal.rms).toBeGreaterThan(0.16);
    expect(signal.rms).toBeLessThan(0.19);
    expect(signal.peak).toBeCloseTo(0.25, 2);
    expect(signal.levels).toHaveLength(5);
    expect(signal.levels.every(level => level > 0 && level <= 1)).toBe(true);
  });

  it('smooths the fall to silence rather than inventing continued movement', () => {
    const signal = measureAudioLevels(new Float32Array(1024), [0.8, 0.7, 0.6, 0.5, 0.4]);
    expect(signal.silent).toBe(true);
    expect(signal.levels.every((level, index) => level > 0 && level < [0.8, 0.7, 0.6, 0.5, 0.4][index])).toBe(true);
  });

  it('clamps normalized values while preserving the raw measured amplitude range', () => {
    const samples = new Float32Array(1024).fill(2);
    const signal = measureAudioLevels(samples);
    expect(signal.rms).toBe(1);
    expect(signal.peak).toBe(1);
    expect(signal.levels.every(level => level <= 1)).toBe(true);
  });
});
