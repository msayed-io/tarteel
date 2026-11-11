const BAR_COUNT = 5;
const clamp = value => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * Derive smoothed, normalized visual levels from samples read from the active
 * HTML media playback stream. These values are not generated or animated.
 */
export function measureAudioLevels(samples, previousLevels = []) {
  const data = samples || [];
  const length = Number(data.length) || 0;
  if (!length) return { rms: 0, peak: 0, levels: Array(BAR_COUNT).fill(0), silent: true };

  const sumSquares = Array(BAR_COUNT).fill(0);
  const peaks = Array(BAR_COUNT).fill(0);
  const counts = Array(BAR_COUNT).fill(0);
  let totalSquares = 0;
  let peak = 0;
  let totalCount = 0;
  const segmentSize = Math.ceil(length / BAR_COUNT);

  for (let index = 0; index < length; index += 1) {
    const sample = Number(data[index]);
    if (!Number.isFinite(sample)) continue;
    const magnitude = Math.abs(sample);
    const bar = Math.min(BAR_COUNT - 1, Math.floor(index / segmentSize));
    sumSquares[bar] += sample * sample;
    counts[bar] += 1;
    peaks[bar] = Math.max(peaks[bar], magnitude);
    totalSquares += sample * sample;
    totalCount += 1;
    peak = Math.max(peak, magnitude);
  }

  const rms = totalCount ? Math.sqrt(totalSquares / totalCount) : 0;
  const silent = peak < 0.004 && rms < 0.002;
  const rawLevels = silent ? Array(BAR_COUNT).fill(0) : sumSquares.map((sum, index) => {
    const segmentRms = counts[index] ? Math.sqrt(sum / counts[index]) : 0;
    return clamp(Math.max(segmentRms * 4.2, peaks[index] * 0.72));
  });
  const levels = rawLevels.map((target, index) => {
    const previous = clamp(Number(previousLevels[index]) || 0);
    const response = target > previous ? 0.62 : 0.25;
    return clamp(previous + (target - previous) * response);
  });

  return { rms: clamp(rms), peak: clamp(peak), levels, silent };
}
