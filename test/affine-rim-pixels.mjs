import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

const W = 350;
const H = 60;
const R = 30;
const STRAIGHT = W - 2 * R;
const P = 2 * STRAIGHT + 2 * Math.PI * R;
const INV = 1 / Math.SQRT2;
const rounded = value => Number(value.toFixed(5));

// Independent analytic capsule + dense chord integration. This deliberately does
// not import the production perimeter metric or the production lighting function.
function boundary(s) {
  let p = ((s % P) + P) % P;
  if (p <= STRAIGHT) return { x: R + p, y: 0, nx: 0, ny: -1 };
  p -= STRAIGHT;
  if (p <= Math.PI * R) {
    const angle = -Math.PI / 2 + p / R;
    return { x: W - R + R * Math.cos(angle), y: R + R * Math.sin(angle), nx: Math.cos(angle), ny: Math.sin(angle) };
  }
  p -= Math.PI * R;
  if (p <= STRAIGHT) return { x: W - R - p, y: H, nx: 0, ny: 1 };
  p -= STRAIGHT;
  const angle = Math.PI / 2 + p / R;
  return { x: R + R * Math.cos(angle), y: R + R * Math.sin(angle), nx: Math.cos(angle), ny: Math.sin(angle) };
}

function localPosition(nx, ny) {
  let angle = Math.atan2(ny, nx);
  if (nx >= 0) return STRAIGHT + R * (angle + Math.PI / 2);
  if (angle < 0) angle += 2 * Math.PI;
  return 2 * STRAIGHT + Math.PI * R + R * (angle - Math.PI / 2);
}

function mapPoint(point, m) {
  return { x: m.a * point.x + m.c * point.y, y: m.b * point.x + m.d * point.y };
}

function normal(point, m) {
  const det = m.a * m.d - m.b * m.c;
  const x = (m.d * point.nx - m.b * point.ny) / det;
  const y = (-m.c * point.nx + m.a * point.ny) / det;
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}

function denseMetric(m) {
  const count = 32768;
  const distances = new Float64Array(count + 1);
  let previous = mapPoint(boundary(0), m);
  for (let index = 1; index <= count; index += 1) {
    const point = mapPoint(boundary(P * index / count), m);
    distances[index] = distances[index - 1] + Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  const perimeter = distances[count];
  return {
    perimeter,
    screenPosition(s) {
      const position = ((s % P) + P) % P / P * count;
      const index = Math.floor(position);
      return distances[index] + (distances[index + 1] - distances[index]) * (position - index);
    },
    pointAtScreen(s) {
      const distance = ((s % perimeter) + perimeter) % perimeter;
      let left = 0;
      let right = count;
      while (right - left > 1) {
        const middle = (left + right) >> 1;
        if (distances[middle] <= distance) left = middle;
        else right = middle;
      }
      const fraction = (distance - distances[left]) / (distances[right] - distances[left]);
      return boundary((left + fraction) / count * P);
    },
  };
}

function red(image, x, y) {
  const channels = image.data.length / (image.width * image.height);
  const px = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  return image.data[(py * image.width + px) * channels];
}

function sampleActualAlpha(actual, mask, x, y, dpr) {
  let best = null;
  for (let py = Math.floor(y - dpr); py <= Math.ceil(y + dpr); py += 1) {
    for (let px = Math.floor(x - dpr); px <= Math.ceil(x + dpr); px += 1) {
      const coverage = red(mask, px, py);
      if (coverage < 80) continue;
      const distance = (px + 0.5 - x) ** 2 + (py + 0.5 - y) ** 2;
      if (!best || distance < best.distance) best = { distance, alpha: red(actual, px, py) / coverage };
    }
  }
  assert.ok(best, 'affine station has a real, adequately covered screenshot pixel');
  return best.alpha;
}

function bilinear(image, x, y) {
  const px = x - 0.5;
  const py = y - 0.5;
  const left = Math.floor(px);
  const top = Math.floor(py);
  const fx = px - left;
  const fy = py - top;
  return ((1 - fx) * (1 - fy) * red(image, left, top) + fx * (1 - fy) * red(image, left + 1, top)
    + (1 - fx) * fy * red(image, left, top + 1) + fx * fy * red(image, left + 1, top + 1)) / 255;
}

function measuredWidth(mask, point, m, dpr) {
  const mapped = mapPoint(point, m);
  const n = normal(point, m);
  const step = 1 / (16 * dpr);
  let area = 0;
  for (let inward = -2; inward <= 3; inward += step) {
    area += bilinear(mask, (100 + mapped.x - n.x * inward) * dpr,
      (80 + mapped.y - n.y * inward) * dpr) * step;
  }
  return area;
}

export async function checkAffineRimPixels(page, dpr) {
  for (const [name, matrix] of [
    ['scale(2,1)', { a: 2, b: 0, c: 0, d: 1 }],
    ['affine shear', { a: 1, b: 0.25, c: 0.65, d: 1 }],
  ]) {
    await page.evaluate(async m => window.setAffineMatrix(m), matrix);
    const actual = PNG.sync.read(await page.locator('#affineHost').screenshot());
    const mask = PNG.sync.read(await page.locator('#calAffineHost').screenshot());
    const metric = denseMetric(matrix);
    const L = Math.abs(W * (-matrix.a + matrix.b) * INV) + Math.abs(H * (-matrix.c + matrix.d) * INV);
    const extents = [Math.min(48, 0.32 * L), Math.min(36, 0.30 * L)];
    const values = { upper: [], lower: [] };
    for (const lower of [false, true]) {
      const sign = lower ? 1 : -1;
      const anchor = metric.screenPosition(localPosition(sign * (matrix.a + matrix.b) * INV,
        sign * (matrix.c + matrix.d) * INV));
      const amplitude = lower ? 0.28 : 0.54;
      const extent = extents[lower ? 1 : 0];
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const point = metric.pointAtScreen(anchor + extent * fraction);
        const n = normal(point, matrix);
        const mapped = mapPoint(point, matrix);
        const angular = Math.max(0, sign * (n.x + n.y) * INV) ** 6;
        const expected = 0.06 + Math.min(amplitude * angular, amplitude * (1 - fraction) ** 3);
        const alpha = sampleActualAlpha(actual, mask,
          (100 + mapped.x - n.x * 0.5) * dpr, (80 + mapped.y - n.y * 0.5) * dpr, dpr);
        assert.ok(Math.abs(alpha - expected) <= 0.055,
          `${name} ${lower ? 'lower' : 'upper'} screen-distance station ${fraction} at DPR ${dpr}: expected ${expected}, actual ${alpha}`);
        values[lower ? 'lower' : 'upper'].push(rounded(alpha));
      }
    }
    const topWidth = measuredWidth(mask, { x: 175, y: 0, nx: 0, ny: -1 }, matrix, dpr);
    const leftWidth = measuredWidth(mask, { x: 0, y: 30, nx: -1, ny: 0 }, matrix, dpr);
    for (const [edge, width] of [['top', topWidth], ['left', leftWidth]]) {
      assert.ok(Math.abs(width - 1) <= 0.22, `${name} ${edge} screen stroke is 1 CSS px at DPR ${dpr}, got ${width}`);
    }
    const center = mapPoint({ x: W / 2, y: H / 2 }, matrix);
    assert.equal(red(actual, (100 + center.x) * dpr, (80 + center.y) * dpr), 0, `${name} interior remains clean`);
    console.log(`MEASURED affine ${name} DPR ${dpr}× ${JSON.stringify({ stations: values, strokePx: [rounded(topWidth), rounded(leftWidth)] })}`);
  }
  console.log(`PASS browser affine DPR ${dpr}×: independently integrated screen-distance stations, screen-fixed normals, 1px top/side stroke, and clean interior under non-uniform scale and shear.`);
}
