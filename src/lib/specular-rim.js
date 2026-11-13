const BASE = 0.06;
const KEY_LIGHT = 0.54;
const FILL_LIGHT = 0.28;
const EXPONENT = 6;
const INV_SQRT2 = 1 / Math.sqrt(2);
const EDGE_WIDTH = 1;
const SPATIAL_HANDOFF = 12;
const renderCache = new WeakMap();
const GEOMETRY_PROPERTIES = new Set([
  'transform', 'rotate', 'scale', 'translate', 'left', 'right', 'top', 'bottom', 'width', 'height',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
]);
const GEOMETRY_ANIMATION_KEYS = new Set([
  'transform', 'rotate', 'scale', 'translate', 'left', 'right', 'top', 'bottom', 'width', 'height',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
]);

const clamp01 = value => Math.max(0, Math.min(1, value));
const signNonZero = value => value < 0 ? -1 : 1;

function perimeterMetrics(width, height, radius) {
  const r = Math.max(0, Math.min(Number(radius) || 0, width / 2, height / 2));
  const top = Math.max(0, width - 2 * r);
  const side = Math.max(0, height - 2 * r);
  const arc = r * Math.PI / 2;
  const perimeter = 2 * (top + side) + 4 * arc;
  return { r, top, side, arc, perimeter };
}

function maximumSingularValue(matrix) {
  const { a = 1, b = 0, c = 0, d = 1 } = matrix;
  const trace = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant));
  return Math.sqrt(Math.max(1e-12, (trace + discriminant) / 2));
}

/** Build the screen-space perimeter once; straight sections are exact and arcs use an integrated LUT. */
function buildScreenPerimeterMetric(width, height, radius, matrix) {
  const { a = 1, b = 0, c = 0, d = 1 } = matrix;
  const { r, top, side, arc, perimeter } = perimeterMetrics(width, height, radius);
  const columnX = Math.hypot(a, b);
  const columnY = Math.hypot(c, d);
  const dot = a * c + b * d;
  const uniformRotationScale = Math.abs(columnX - columnY) < 1e-10 && Math.abs(dot) < 1e-10;
  const uniformScale = (columnX + columnY) / 2 || 1;
  if (uniformRotationScale) {
    return {
      total: perimeter * uniformScale,
      at: position => ((position % perimeter) + perimeter) % perimeter * uniformScale,
    };
  }

  const segments = [];
  let localStart = 0;
  let screenStart = 0;
  const addStraight = (length, tangentX, tangentY) => {
    if (length <= 0) return;
    const factor = Math.hypot(a * tangentX + c * tangentY, b * tangentX + d * tangentY);
    segments.push({ localStart, localLength: length, screenStart, screenLength: length * factor, kind: 'straight', factor });
    localStart += length;
    screenStart += length * factor;
  };
  const addArc = (length, thetaStart) => {
    if (length <= 0 || r <= 0) return;
    const count = 64;
    const values = new Float64Array(count + 1);
    const speed = theta => {
      const tx = -Math.sin(theta);
      const ty = Math.cos(theta);
      return r * Math.hypot(a * tx + c * ty, b * tx + d * ty);
    };
    for (let i = 1; i <= count; i += 1) {
      const lo = thetaStart + (i - 1) * Math.PI / 2 / count;
      const hi = thetaStart + i * Math.PI / 2 / count;
      const mid = (lo + hi) / 2;
      values[i] = values[i - 1] + (hi - lo) * (speed(lo) + 4 * speed(mid) + speed(hi)) / 6;
    }
    segments.push({ localStart, localLength: length, screenStart, screenLength: values[count], kind: 'arc', values, thetaStart, count });
    localStart += length;
    screenStart += values[count];
  };

  addStraight(top, 1, 0);
  addArc(arc, -Math.PI / 2);
  addStraight(side, 0, 1);
  addArc(arc, 0);
  addStraight(top, -1, 0);
  addArc(arc, Math.PI / 2);
  addStraight(side, 0, -1);
  addArc(arc, Math.PI);

  return {
    total: screenStart,
    at(position) {
      if (perimeter <= 0) return 0;
      const value = ((position % perimeter) + perimeter) % perimeter;
      const segment = segments.find((item, index) => value < item.localStart + item.localLength || index === segments.length - 1);
      if (!segment) return 0;
      const local = Math.max(0, Math.min(segment.localLength, value - segment.localStart));
      if (segment.kind === 'straight') return segment.screenStart + local * segment.factor;
      const fraction = local / segment.localLength;
      const scaled = fraction * segment.count;
      const index = Math.min(segment.count - 1, Math.floor(scaled));
      const part = scaled - index;
      const arcLength = segment.values[index] + (segment.values[index + 1] - segment.values[index]) * part;
      return segment.screenStart + arcLength;
    },
  };
}

/** Return a clockwise perimeter coordinate measured from the top-left tangent. */
function perimeterPosition(nx, ny, x, y, width, height, radius) {
  const { r, top, side, arc } = perimeterMetrics(width, height, radius);
  const rightStart = top + arc;
  const bottomStart = rightStart + side + arc;
  const leftStart = bottomStart + top + arc;
  const topLeftStart = leftStart + side;
  const epsilon = 1e-7;

  if (nx < -epsilon && ny < -epsilon) {
    let angle = Math.atan2(ny, nx);
    if (angle < 0) angle += 2 * Math.PI;
    return topLeftStart + r * (angle - Math.PI);
  }
  if (nx > epsilon && ny < -epsilon) {
    const angle = Math.atan2(ny, nx);
    return top + r * (angle + Math.PI / 2);
  }
  if (nx > epsilon && ny > epsilon) {
    const angle = Math.atan2(ny, nx);
    return rightStart + side + r * angle;
  }
  if (nx < -epsilon && ny > epsilon) {
    const angle = Math.atan2(ny, nx);
    return bottomStart + r * (angle - Math.PI / 2);
  }
  if (ny < 0) return Math.max(0, Math.min(top, x - r));
  if (nx > 0) return rightStart + Math.max(0, Math.min(side, y - r));
  if (ny > 0) return bottomStart + Math.max(0, Math.min(top, width - r - x));
  if (nx < 0) return leftStart + Math.max(0, Math.min(side, height - r - y));
  return 0;
}

function pointOnPerimeter(width, height, radius, position) {
  const { r, top, side, arc, perimeter } = perimeterMetrics(width, height, radius);
  let s = ((position % perimeter) + perimeter) % perimeter;
  if (s <= top || arc === 0) return { x: r + Math.min(s, top), y: 0 };
  s -= top;
  if (s <= arc) {
    const angle = -Math.PI / 2 + s / r;
    return { x: width - r + r * Math.cos(angle), y: r + r * Math.sin(angle) };
  }
  s -= arc;
  if (s <= side || arc === 0) return { x: width, y: r + Math.min(s, side) };
  s -= side;
  if (s <= arc) {
    const angle = s / r;
    return { x: width - r + r * Math.cos(angle), y: height - r + r * Math.sin(angle) };
  }
  s -= arc;
  if (s <= top || arc === 0) return { x: width - r - Math.min(s, top), y: height };
  s -= top;
  if (s <= arc) {
    const angle = Math.PI / 2 + s / r;
    return { x: r + r * Math.cos(angle), y: height - r + r * Math.sin(angle) };
  }
  s -= arc;
  if (s <= side || arc === 0) return { x: 0, y: height - r - Math.min(s, side) };
  s -= side;
  const angle = Math.PI + s / r;
  return { x: r + r * Math.cos(angle), y: r + r * Math.sin(angle) };
}

/** Expose boundary points so pixel tests can sample exact positions on the rim. */
export function roundedRectBoundaryPoint(width, height, radius, position) {
  return pointOnPerimeter(width, height, radius, position);
}

/** Exact alpha from the directive's screen-fixed two-lobe lighting model. */
export function specularRimIntensity(nx, ny) {
  const length = Math.hypot(nx, ny);
  if (!Number.isFinite(length) || length === 0) return BASE;
  const x = nx / length;
  const y = ny / length;
  const towardKey = Math.max(0, -(x + y) * INV_SQRT2);
  const towardFill = Math.max(0, (x + y) * INV_SQRT2);
  return BASE + KEY_LIGHT * towardKey ** EXPONENT + FILL_LIGHT * towardFill ** EXPONENT;
}

/** Combine the screen-space normal model with cubic, fixed-pixel spatial envelopes. */
export function combinedSpecularRimIntensity({ nx, ny, localNx = nx, localNy = ny, x, y, width, height, radius, transform = { a: 1, b: 0, c: 0, d: 1 }, perimeterMetric } = {}) {
  const length = Math.hypot(nx, ny);
  if (!Number.isFinite(length) || length === 0) return BASE;
  const screenX = nx / length;
  const screenY = ny / length;
  const towardKey = Math.max(0, -(screenX + screenY) * INV_SQRT2) ** EXPONENT;
  const towardFill = Math.max(0, (screenX + screenY) * INV_SQRT2) ** EXPONENT;
  if (towardKey === 0 && towardFill === 0) return BASE;

  const { a = 1, b = 0, c = 0, d = 1 } = transform;
  const keyLocalX = a * -INV_SQRT2 + b * -INV_SQRT2;
  const keyLocalY = c * -INV_SQRT2 + d * -INV_SQRT2;
  const fillLocalX = -keyLocalX;
  const fillLocalY = -keyLocalY;
  const keyPosition = perimeterPosition(keyLocalX, keyLocalY, width / 2, 0, width, height, radius);
  const fillPosition = perimeterPosition(fillLocalX, fillLocalY, width / 2, height, width, height, radius);
  const currentPosition = perimeterPosition(localNx, localNy, x, y, width, height, radius);
  const metric = perimeterMetric || buildScreenPerimeterMetric(width, height, radius, transform);
  const { total: screenPerimeter } = metric;
  const circularDistance = origin => {
    const current = metric.at(currentPosition);
    const target = metric.at(origin);
    const delta = Math.abs(current - target);
    return Math.min(delta, Math.max(0, screenPerimeter - delta));
  };

  const gradientLength = Math.abs(width * (a * -INV_SQRT2 + b * INV_SQRT2))
    + Math.abs(height * (c * -INV_SQRT2 + d * INV_SQRT2));
  const topLength = Math.min(48, 0.32 * gradientLength);
  const bottomLength = Math.min(36, 0.30 * gradientLength);
  const keyDistance = circularDistance(keyPosition);
  const fillDistance = circularDistance(fillPosition);
  const availableHandoff = Math.max(0, (screenPerimeter / 2 - topLength - bottomLength) / 2);
  const handoffLength = Math.min(SPATIAL_HANDOFF, availableHandoff);
  const boundedLobe = (angular, amplitude, distance, extent) => {
    if (distance <= extent) {
      const cubicEnvelope = amplitude * Math.max(0, 1 - distance / extent) ** 3;
      return Math.min(angular, cubicEnvelope);
    }
    if (handoffLength === 0 || distance >= extent + handoffLength) return angular;
    const progress = (distance - extent) / handoffLength;
    const smooth = progress * progress * (3 - 2 * progress);
    return angular * smooth;
  };

  // The cubic stations cap each corner lobe; outside that local zone, smoothly
  // restore I(n), preserving .095 on the lower straight edge midpoint.
  return BASE + boundedLobe(KEY_LIGHT * towardKey, KEY_LIGHT, keyDistance, topLength)
    + boundedLobe(FILL_LIGHT * towardFill, FILL_LIGHT, fillDistance, bottomLength);
}

/** Signed distance and outward unit normal for a rounded rectangle with one radius. */
export function roundedRectDistance(x, y, width, height, radius) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  if (w === 0 || h === 0) return { distance: Infinity, nx: 0, ny: 0 };

  const r = Math.max(0, Math.min(Number(radius) || 0, w / 2, h / 2));
  const dx = x - w / 2;
  const dy = y - h / 2;
  const qx = Math.abs(dx) - (w / 2 - r);
  const qy = Math.abs(dy) - (h / 2 - r);
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideLength = Math.hypot(outsideX, outsideY);
  const distance = outsideLength + Math.min(Math.max(qx, qy), 0) - r;

  let nx;
  let ny;
  if (outsideLength > 1e-9) {
    nx = signNonZero(dx) * outsideX / outsideLength;
    ny = signNonZero(dy) * outsideY / outsideLength;
  } else if (qx > qy) {
    nx = signNonZero(dx);
    ny = 0;
  } else {
    nx = 0;
    ny = signNonZero(dy);
  }
  return { distance, nx, ny };
}

/** Transform a local-space normal into its screen-space normal via inverse transpose. */
export function screenNormal(nx, ny, matrix = { a: 1, b: 0, c: 0, d: 1 }) {
  const { a = 1, b = 0, c = 0, d = 1 } = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
    return { nx: 0, ny: 0, distanceScale: 1 };
  }
  const tx = (d * nx - b * ny) / determinant;
  const ty = (-c * nx + a * ny) / determinant;
  const magnitude = Math.hypot(tx, ty);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return { nx: 0, ny: 0, distanceScale: 1 };
  }
  return { nx: tx / magnitude, ny: ty / magnitude, distanceScale: magnitude };
}

function maximumInverseScale(matrix) {
  const { a = 1, b = 0, c = 0, d = 1 } = matrix;
  const determinant = Math.abs(a * d - b * c);
  if (!Number.isFinite(determinant) || determinant < 1e-9) return 1;
  const trace = a * a + b * b + c * c + d * d;
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant));
  const minimumSingularValue = Math.sqrt(Math.max(1e-12, (trace - discriminant) / 2));
  return 1 / minimumSingularValue;
}

function edgeRangesForRow(y, width, height, radius, band) {
  const ranges = [];
  // A normal-distance band widens in x near a circle's horizontal tangent.
  const cornerBand = band + Math.sqrt(2 * radius * band + band * band);
  const add = (left, right) => {
    if (right >= 0 && left <= width) ranges.push([Math.max(0, left), Math.min(width, right)]);
  };

  if (y <= band) add(radius - band, width - radius + band);
  if (height - y <= band) add(radius - band, width - radius + band);
  if (y >= radius - band && y <= height - radius + band) {
    add(-band, band);
    add(width - band, width + band);
  }

  if (radius > 0 && y >= 0 && y <= radius) {
    const dx = Math.sqrt(Math.max(0, radius * radius - (y - radius) ** 2));
    const left = radius - dx;
    const right = width - radius + dx;
    add(left - cornerBand, left + cornerBand);
    add(right - cornerBand, right + cornerBand);
  }
  if (radius > 0 && y >= height - radius && y <= height) {
    const dy = y - (height - radius);
    const dx = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    const left = radius - dx;
    const right = width - radius + dx;
    add(left - cornerBand, left + cornerBand);
    add(right - cornerBand, right + cornerBand);
  }

  ranges.sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/**
 * Rasterize the directive's one-logical-pixel rounded-rectangle rim.
 * The returned RGBA bytes can be written directly to Canvas ImageData.
 */
export function rasterizeSpecularRim({
  width,
  height,
  radius,
  devicePixelRatio = 1,
  transform = { a: 1, b: 0, c: 0, d: 1 },
  intensity = 1,
  thickness = EDGE_WIDTH,
  color = [255, 255, 255],
  applyRing = true,
  includeLight = true,
} = {}) {
  const w = Number(width);
  const h = Number(height);
  const dpr = Math.max(1, Number(devicePixelRatio) || 1);
  const requestedIntensity = Number(intensity);
  const rim = clamp01(Number.isFinite(requestedIntensity) ? requestedIntensity : 1);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: 0, height: 0, data: new Uint8ClampedArray(0), scaleX: 0, scaleY: 0 };
  }

  const supersample = Math.max(1, maximumSingularValue(transform));
  const pixelWidth = Math.max(1, Math.ceil(w * dpr * supersample));
  const pixelHeight = Math.max(1, Math.ceil(h * dpr * supersample));
  const scaleX = pixelWidth / w;
  const scaleY = pixelHeight / h;
  const pixels = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
  const aa = 1 / dpr;
  const requestedThickness = Number(thickness);
  const t = Math.max(0.75, Math.min(1.25, Number.isFinite(requestedThickness) ? requestedThickness : EDGE_WIDTH));
  const perimeterMetric = buildScreenPerimeterMetric(w, h, radius, transform);

  const drawPixel = (px, py) => {
    const x = (px + 0.5) / scaleX;
    const y = (py + 0.5) / scaleY;
    const { distance, nx, ny } = roundedRectDistance(x, y, w, h, radius);
    const normal = screenNormal(nx, ny, transform);
    if (!applyRing && Math.abs(distance) > t + 2 * aa * normal.distanceScale) return;
    const distanceOnScreen = distance / normal.distanceScale;
    const ring = applyRing
      ? clamp01(0.5 - (Math.abs(distanceOnScreen + 0.5 * t) - 0.5 * t) / aa)
      : 1;
    const field = includeLight ? combinedSpecularRimIntensity({
      nx: normal.nx,
      ny: normal.ny,
      localNx: nx,
      localNy: ny,
      x,
      y,
      width: w,
      height: h,
      radius,
      transform,
      perimeterMetric,
    }) : 1;
    const alpha = clamp01(field * ring * rim);
    if (alpha <= 0) return;
    const index = (py * pixelWidth + px) * 4;
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = Math.round(alpha * 255);
  };

  const r = Math.max(0, Math.min(Number(radius) || 0, w / 2, h / 2));
  const band = (t + 2 * aa) * maximumInverseScale(transform);
  for (let py = 0; py < pixelHeight; py += 1) {
    const y = (py + 0.5) / scaleY;
    for (const [left, right] of edgeRangesForRow(y, w, h, r, band)) {
      const first = Math.max(0, Math.floor(left * scaleX) - 1);
      const last = Math.min(pixelWidth - 1, Math.ceil(right * scaleX) + 1);
      for (let px = first; px <= last; px += 1) drawPixel(px, py);
    }
  }

  return { width: pixelWidth, height: pixelHeight, data: pixels, scaleX, scaleY };
}

function matrixForElement(element) {
  let matrix = new DOMMatrix();
  for (let node = element; node && node instanceof Element; node = node.parentElement) {
    const styles = getComputedStyle(node);
    let local = new DOMMatrix();
    const rotate = String(styles.rotate || 'none').trim().split(/\s+/);
    if (rotate[0] !== 'none') {
      const angle = Number.parseFloat(rotate.at(-1));
      const axis = rotate.length > 1 ? rotate[0] : 'z';
      if (Number.isFinite(angle)) {
        if (axis === 'x') local = local.rotateAxisAngle(1, 0, 0, angle);
        else if (axis === 'y') local = local.rotateAxisAngle(0, 1, 0, angle);
        else local = local.rotate(angle);
      }
    }
    const scale = String(styles.scale || 'none').trim();
    if (scale !== 'none') {
      const values = scale.split(/\s+/).map(Number.parseFloat);
      const sx = Number.isFinite(values[0]) ? values[0] : 1;
      const sy = Number.isFinite(values[1]) ? values[1] : sx;
      const sz = Number.isFinite(values[2]) ? values[2] : 1;
      local = local.scale(sx, sy, sz);
    }
    if (styles.transform && styles.transform !== 'none') local = local.multiply(new DOMMatrix(styles.transform));
    matrix = local.multiply(matrix);
  }
  return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d };
}

function pixelAlignedInsets(element, dpr, matrix, rect) {
  // Axis-aligned transforms can be snapped without moving the control itself.
  // Rotated shapes retain their exact attachment and rely on device AA instead.
  if (Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6 || matrix.a <= 0 || matrix.d <= 0) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const snap = value => Math.round(value * dpr) / dpr;
  return {
    left: (snap(rect.left) - rect.left) / matrix.a,
    right: (rect.right - snap(rect.right)) / matrix.a,
    top: (snap(rect.top) - rect.top) / matrix.d,
    bottom: (rect.bottom - snap(rect.bottom)) / matrix.d,
  };
}

function parseRadius(value, width, height) {
  const token = String(value || '').trim().split(/[ /]/)[0];
  const parsed = Number.parseFloat(token);
  if (!Number.isFinite(parsed)) return Math.min(width, height) / 2;
  const valueInPixels = token.endsWith('%') ? parsed * Math.min(width, height) / 100 : parsed;
  return Math.max(0, Math.min(valueInPixels, width / 2, height / 2));
}

function cssNumber(element, property, fallback) {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? clamp01(value) : fallback;
}

function setCustomProperty(element, property, value) {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

function animationChangesGeometry(animation) {
  const keyframes = animation?.effect?.getKeyframes?.() || [];
  return keyframes.some(keyframe => [...GEOMETRY_ANIMATION_KEYS].some(property => property in keyframe));
}

function effectiveOpacity(element) {
  const requested = cssNumber(element, '--rim', 1);
  const system = cssNumber(element, '--rim-system', 1);
  const overlay = element.parentElement?.closest('.glass') ? 0.85 : 1;
  const value = String(requested * system * overlay);
  if (element.style.getPropertyValue('--rim-effective') !== value) {
    setCustomProperty(element, '--rim-effective', value);
  }
}

function renderElement(element) {
  if (!element.isConnected) return;
  effectiveOpacity(element);

  const rect = element.getBoundingClientRect();
  const matrix = matrixForElement(element);
  const scaleX = Math.hypot(matrix.a, matrix.b) || 1;
  const scaleY = Math.hypot(matrix.c, matrix.d) || 1;
  const axisAligned = Math.abs(matrix.b) <= 1e-6 && Math.abs(matrix.c) <= 1e-6;
  const width = Math.max(0, axisAligned ? rect.width / scaleX : element.offsetWidth);
  const height = Math.max(0, axisAligned ? rect.height / scaleY : element.offsetHeight);
  if (width === 0 || height === 0) return;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const insets = pixelAlignedInsets(element, dpr, matrix, rect);
  const rimWidth = Math.max(0.1, width - insets.left - insets.right);
  const rimHeight = Math.max(0.1, height - insets.top - insets.bottom);
  const styles = getComputedStyle(element);
  const radius = parseRadius(styles.borderTopLeftRadius, rimWidth, rimHeight);
  const configuredThickness = Number.parseFloat(styles.getPropertyValue('--rim-w'));
  const thickness = Math.max(0.75, Math.min(1.25, Number.isFinite(configuredThickness) ? configuredThickness : EDGE_WIDTH));
  setCustomProperty(element, '--rim-w', `${thickness}px`);
  const signature = JSON.stringify([rimWidth, rimHeight, radius, thickness, dpr, matrix.a, matrix.b, matrix.c, matrix.d, insets.top, insets.right, insets.bottom, insets.left]);
  if (renderCache.get(element) === signature) return;

  // One antialiased SDF ring is baked into the PNG; no second CSS mask can widen
  // the inner corner or multiply the edge coverage.
  const pixels = rasterizeSpecularRim({ width: rimWidth, height: rimHeight, radius, devicePixelRatio: dpr, transform: matrix, thickness, applyRing: true });
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) return;
  const image = context.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  context.putImageData(image, 0, 0);

  setCustomProperty(element, '--rim-image', `url("${canvas.toDataURL('image/png')}")`);
  setCustomProperty(element, '--rim-inset-top', `${insets.top}px`);
  setCustomProperty(element, '--rim-inset-right', `${insets.right}px`);
  setCustomProperty(element, '--rim-inset-bottom', `${insets.bottom}px`);
  setCustomProperty(element, '--rim-inset-left', `${insets.left}px`);
  setCustomProperty(element, '--rim-radius', `${radius}px`);
  renderCache.set(element, signature);
}

/** Install shape-aware shader rims on explicitly selected small controls only. */
export function installSpecularRim(root = document) {
  const elements = new Set();
  const animated = new Set();
  let frame = 0;
  const refresh = element => renderElement(element);
  const refreshAll = () => elements.forEach(refresh);
  const observer = new ResizeObserver(entries => entries.forEach(entry => refresh(entry.target)));
  const intensityObserver = new MutationObserver(records => {
    const changed = new Set(records.map(record => record.target).filter(element => elements.has(element)));
    changed.forEach(refresh);
  });
  const unregisterElement = element => {
    if (!elements.delete(element)) return;
    observer.unobserve(element);
    animated.delete(element);
    renderCache.delete(element);
  };
  const registerElement = element => {
    if (!(element instanceof Element) || !element.matches('.rim') || elements.has(element)) return;
    elements.add(element);
    observer.observe(element);
    intensityObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
    refresh(element);
  };
  const registerTree = node => {
    if (!(node instanceof Element)) return;
    registerElement(node);
    node.querySelectorAll('.rim').forEach(registerElement);
  };
  const unregisterTree = node => {
    if (!(node instanceof Element)) return;
    unregisterElement(node);
    node.querySelectorAll('.rim').forEach(unregisterElement);
  };
  const cancelAnimationIfIdle = () => {
    if (!animated.size && frame) cancelAnimationFrame(frame), frame = 0;
  };
  const affectedBy = target => [...elements].filter(element => element === target || target.contains?.(element));
  const hasActiveGeometryMotion = element => {
    for (let node = element; node && node instanceof Element; node = node.parentElement) {
      if ([...(node.getAnimations?.() || [])].some(animation =>
        (animation.playState === 'running' || animation.playState === 'pending') && animationChangesGeometry(animation))) return true;
    }
    return false;
  };
  const tick = () => {
    frame = 0;
    animated.forEach(refresh);
    if (animated.size) frame = requestAnimationFrame(tick);
  };
  const scheduleAnimation = () => {
    if (!frame && animated.size) frame = requestAnimationFrame(tick);
  };
  const onTransitionRun = event => {
    if (!GEOMETRY_PROPERTIES.has(event.propertyName)) return;
    affectedBy(event.target).forEach(element => animated.add(element));
    scheduleAnimation();
  };
  const onTransitionEnd = event => {
    if (!GEOMETRY_PROPERTIES.has(event.propertyName)) return;
    const affected = affectedBy(event.target);
    affected.forEach(refresh);
    affected.forEach(element => { if (!hasActiveGeometryMotion(element)) animated.delete(element); });
    cancelAnimationIfIdle();
  };
  const onAnimationStart = event => {
    const animation = event.target.getAnimations?.().find(item => item.animationName === event.animationName);
    if (!animationChangesGeometry(animation)) return;
    affectedBy(event.target).forEach(element => animated.add(element));
    scheduleAnimation();
  };
  const onAnimationEnd = event => {
    const affected = affectedBy(event.target).filter(element => animated.has(element));
    affected.forEach(refresh);
    affected.forEach(element => { if (!hasActiveGeometryMotion(element)) animated.delete(element); });
    cancelAnimationIfIdle();
  };
  const onScroll = () => refreshAll();
  const onResize = () => refreshAll();
  const onRimChange = () => refreshAll();
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const onTransparencyChange = () => elements.forEach(refresh);
  const treeObserver = new MutationObserver(records => {
    records.forEach(record => {
      if (record.type === 'attributes') {
        if (record.target.matches('.rim')) {
          registerElement(record.target);
          refresh(record.target);
        } else unregisterElement(record.target);
        record.target.querySelectorAll('.rim').forEach(refresh);
        return;
      }
      record.removedNodes.forEach(unregisterTree);
      record.addedNodes.forEach(registerTree);
    });
    cancelAnimationIfIdle();
  });

  if (root instanceof Element) registerTree(root);
  else root.querySelectorAll('.rim').forEach(registerElement);
  treeObserver.observe(root, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });

  root.addEventListener('transitionrun', onTransitionRun, true);
  root.addEventListener('transitionend', onTransitionEnd, true);
  root.addEventListener('transitioncancel', onTransitionEnd, true);
  root.addEventListener('animationstart', onAnimationStart, true);
  root.addEventListener('animationend', onAnimationEnd, true);
  root.addEventListener('animationcancel', onAnimationEnd, true);
  root.addEventListener('tarteel-rim-change', onRimChange);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onResize, { passive: true });
  transparency.addEventListener?.('change', onTransparencyChange);

  return () => {
    observer.disconnect();
    intensityObserver.disconnect();
    treeObserver.disconnect();
    animated.clear();
    elements.clear();
    if (frame) cancelAnimationFrame(frame);
    root.removeEventListener('transitionrun', onTransitionRun, true);
    root.removeEventListener('transitionend', onTransitionEnd, true);
    root.removeEventListener('transitioncancel', onTransitionEnd, true);
    root.removeEventListener('animationstart', onAnimationStart, true);
    root.removeEventListener('animationend', onAnimationEnd, true);
    root.removeEventListener('animationcancel', onAnimationEnd, true);
    root.removeEventListener('tarteel-rim-change', onRimChange);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    transparency.removeEventListener?.('change', onTransparencyChange);
  };
}
