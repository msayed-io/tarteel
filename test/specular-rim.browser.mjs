import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { roundedRectBoundaryPoint, roundedRectDistance } from '../src/lib/specular-rim.js';
import { checkAffineRimPixels } from './affine-rim-pixels.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = '/test/fixtures/specular-rim-browser.html';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('Path outside project root');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

function pixel(image, x, y) {
  const px = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const channels = image.data.length / (image.width * image.height);
  const offset = (py * image.width + px) * channels;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function maximumRed(image, x, y, radius) {
  let maximum = 0;
  const left = Math.max(0, Math.floor(x - radius));
  const right = Math.min(image.width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius));
  const bottom = Math.min(image.height - 1, Math.ceil(y + radius));
  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) maximum = Math.max(maximum, pixel(image, px, py)[0]);
  }
  return maximum;
}

function calibratedAlpha(actual, calibration, actualX, actualY, calibrationX, calibrationY) {
  const actualRed = pixel(actual, Math.floor(actualX), Math.floor(actualY))[0];
  const maskCoverage = pixel(calibration, Math.floor(calibrationX), Math.floor(calibrationY))[0];
  assert.ok(maskCoverage > 0, 'the calibration mask exposes the corresponding peak pixel');
  return actualRed / maskCoverage;
}

function calibratedAlphaNear(actual, calibration, x, y, radius) {
  let best = { x: 0, y: 0, coverage: 0 };
  const left = Math.max(0, Math.floor(x - radius));
  const right = Math.min(calibration.width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius));
  const bottom = Math.min(calibration.height - 1, Math.ceil(y + radius));
  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const coverage = pixel(calibration, px, py)[0];
      if (coverage > best.coverage) best = { x: px, y: py, coverage };
    }
  }
  assert.ok(best.coverage > 0, 'a nearby station has measurable CSS-mask coverage');
  const actualRed = pixel(actual, best.x, best.y)[0];
  if (actualRed === 0) console.log('station pixel debug', { x, y, radius, best, actualSize: [actual.width, actual.height], calibrationSize: [calibration.width, calibration.height] });
  return actualRed / best.coverage;
}

function stationPoint(width, height, radius, lower, fraction, extent) {
  const top = width - 2 * radius;
  const side = height - 2 * radius;
  const arc = radius * Math.PI / 2;
  const perimeter = 2 * (top + side) + 4 * arc;
  const peak = lower ? top + arc + side + arc / 2 : perimeter - arc / 2;
  return roundedRectBoundaryPoint(width, height, radius, peak + extent * fraction);
}

async function capture(page, selector) {
  return PNG.sync.read(await page.locator(selector).screenshot());
}

function cssAlphaOver(background, output) {
  const span = 255 - background;
  return span === 0 ? 0 : (output - background) / span;
}

function assertNear(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected.toFixed(3)} ± ${tolerance}, got ${actual.toFixed(3)}`);
}

async function cssImage(page, selector) {
  return page.locator(selector).evaluate(element => getComputedStyle(element).getPropertyValue('--rim-image').trim());
}

function pngInfo(cssValue) {
  const encoded = cssValue.match(/base64,([^\")]+)/)?.[1];
  if (!encoded) return 'no PNG data URL';
  const bytes = Buffer.from(encoded, 'base64');
  const image = PNG.sync.read(bytes);
  return `${image.width}x${image.height}/${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
}

async function verifyIslandAppearance(browser) {
  const source = await readFile(resolve(root, 'island.html'), 'utf8');
  const staticHtml = source.replace(/<script type="module">[\s\S]*?<\/script>/, '');
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  await page.setContent(staticHtml, { waitUntil: 'load' });
  await page.locator('#isl').evaluate(element => {
    element.dataset.state = 'tools';
    element.style.width = '480px';
    element.style.height = '430px';
    element.style.borderRadius = '28px';
  });
  await page.waitForTimeout(500);
  const measure = () => page.evaluate(() => {
    const selectors = ['#isl', '.island-surface', '.layer.tools', '#tb', '#tback', '#chSpeed button', '#chSleep button'];
    const geometry = selectors.map(selector => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [selector, rect.x, rect.y, rect.width, rect.height, style.transform, style.borderRadius];
    });
    return {
      background: getComputedStyle(document.querySelector('.island-surface')).backgroundColor,
      glassDisplay: getComputedStyle(document.querySelector('.island-surface > .glass')).display,
      blur: getComputedStyle(document.querySelector('.g-blur')).backdropFilter,
      geometry,
      toolsButtonHasRim: document.querySelector('#tb').classList.contains('rim'),
      toolsRimCount: document.querySelectorAll('.tools .rim').length,
      glassLayers: [...document.querySelector('.glass').children].map(element => element.className),
    };
  });
  const glass = await measure();
  assert.equal(glass.background, 'rgba(0, 0, 0, 0)', 'glass mode preserves the original transparent surface');
  assert.notEqual(glass.glassDisplay, 'none', 'glass mode keeps the original layer visible');
  assert.match(glass.blur, /blur\(6px\)/, 'the existing glass blur rule remains active in expanded mode');
  assert.deepEqual(glass.glassLayers, ['g-blur', 'g-tint', 'g-black'], 'the original layered glass stack is intact');
  assert.equal(glass.toolsButtonHasRim, false, 'the tools button has no specular rim');
  assert.equal(glass.toolsRimCount, 0, 'no internal tools control has a specular rim');

  await page.locator('html').evaluate(element => { element.dataset.islandAppearance = 'black'; });
  const black = await measure();
  assert.equal(black.background, 'rgb(0, 0, 0)', 'black mode uses a solid black surface');
  assert.equal(black.glassDisplay, 'none', 'black mode hides the glass layer rather than restyling it');
  assert.equal(black.blur, glass.blur, 'switching material does not alter the original glass CSS');
  assert.deepEqual(black.geometry, glass.geometry, 'switching material preserves island, tools, and control geometry');
  assert.deepEqual(black.glassLayers, glass.glassLayers, 'the hidden layer remains the same original stack');
  await context.close();
  console.log('PASS browser Dynamic appearance: original CSS glass remains intact; black mode changes material only; tool rims are absent.');
}

async function run() {
  await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolveListen()));
  const address = server.address();
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    await verifyIslandAppearance(browser);
    for (const dpr of [1, 2, 3]) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}${fixturePath}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.rimTestReady === true);
      await page.waitForTimeout(60);
      assert.deepEqual(errors, [], `Chromium page errors at DPR ${dpr}×`);
      assert.ok(await page.evaluate(() => getComputedStyle(document.getElementById('blackProbe'), '::after').backgroundImage.startsWith('url(')),
        `the actual rasterized rim PNG is attached at DPR ${dpr}×`);

      const black = await capture(page, '#blackHost');
      const light = await capture(page, '#lightHost');
      const scale = dpr;
      const topX = (10 + 175) * scale;
      const topY = (10 + 0.5) * scale;
      const centerX = (10 + 175) * scale;
      const centerY = (10 + 30) * scale;
      const blackRim = pixel(black, topX, topY)[0];
      const blackBase = pixel(black, centerX, centerY)[0];
      const lightRim = pixel(light, topX, topY)[0];
      const lightBase = pixel(light, centerX, centerY)[0];
      const blackAlpha = cssAlphaOver(blackBase, blackRim);
      const lightAlpha = cssAlphaOver(lightBase, lightRim);
      if (blackRim === blackBase) {
        console.log('rim CSS debug', black.width, black.height, black.data.length / (black.width * black.height), pixel(black, 0, 0), pixel(black, 20, 20), pixel(black, 185, 40), await page.evaluate(() => {
          const element = document.getElementById('blackProbe');
          const host = document.getElementById('blackHost');
          const pseudo = getComputedStyle(element, '::after');
          const rect = element.getBoundingClientRect();
          return { hostBg: getComputedStyle(host).backgroundColor, elementBg: getComputedStyle(element).backgroundColor,
            rect: [rect.x, rect.y, rect.width, rect.height], image: getComputedStyle(element).getPropertyValue('--rim-image').slice(0, 80),
            display: pseudo.display, opacity: pseudo.opacity, background: pseudo.backgroundImage.slice(0, 80), mask: pseudo.maskComposite,
            webkitMask: pseudo.webkitMaskComposite, padding: pseudo.padding, radii: pseudo.borderRadius };
        }));
      }
      assertNear(blackAlpha, 0.1275, 0.035, `black-background upper-straight I(n) pixel at DPR ${dpr}×`);
      assertNear(lightAlpha, blackAlpha, 0.035, `light-background alpha invariance at DPR ${dpr}×`);
      assert.ok(Math.max(...pixel(black, centerX, centerY)) <= 1, `black interior remains clean at DPR ${dpr}×`);
      assertNear(lightBase, 192, 2, `light-background interior at DPR ${dpr}×`);

      let lineRows = 0;
      for (let row = 0; row < 2 * dpr; row += 1) {
        if (pixel(black, centerX, (10 + (row + 0.5) / dpr) * scale)[0] > 8) lineRows += 1;
      }
      assert.equal(lineRows, dpr, `one CSS-pixel straight stroke spans exactly ${dpr} device pixels at DPR ${dpr}×`);

      const pill = await capture(page, '#blackHost');
      const calibrationPill = await capture(page, '#calPillHost');
      const peakAt = (x, y) => calibratedAlpha(pill, calibrationPill,
        (10 + x) * scale, (10 + y) * scale, (10 + x) * scale, (10 + y) * scale);
      const offset = 30 * (1 - 1 / Math.sqrt(2)) + 0.5 / Math.sqrt(2);
      const upperPeak = peakAt(offset, offset);
      const lowerPeak = peakAt(350 - offset, 60 - offset);
      assertNear(upperPeak, 0.60, 0.10, `upper-left rounded-corner peak at DPR ${dpr}×`);
      assertNear(lowerPeak, 0.34, 0.10, `lower-right rounded-corner peak at DPR ${dpr}×`);
      const topExtent = Math.min(48, 0.32 * (350 + 60) / Math.SQRT2);
      const bottomExtent = Math.min(36, 0.30 * (350 + 60) / Math.SQRT2);
      const fractions = [0, 0.25, 0.5, 0.75, 1];
      const upperStops = [0.60, 0.2896875, 0.1275, 0.0684375, 0.06];
      const lowerStops = [0.34, 0.178125, 0.095, 0.064375, 0.06];
      const stationSamples = { upper: [], lower: [] };
      fractions.forEach((fraction, index) => {
        for (const [lower, extent, expected] of [
          [false, topExtent, upperStops[index]],
          [true, bottomExtent, lowerStops[index]],
        ]) {
          const point = stationPoint(350, 60, 30, lower, fraction, extent);
          const actual = calibratedAlphaNear(pill, calibrationPill, (10 + point.x) * scale, (10 + point.y) * scale, 0.75 * scale);
          assertNear(actual, expected, 0.055, `${lower ? 'lower' : 'upper'} cubic fade station ${fraction} at DPR ${dpr}×`);
          stationSamples[lower ? 'lower' : 'upper'].push(Number(actual.toFixed(5)));
        }
      });
      const upperStraightMidpoint = calibratedAlphaNear(
        pill, calibrationPill, centerX, (10 + 0.5) * scale, 0.75 * scale);
      const lowerStraightMidpoint = calibratedAlphaNear(
        pill, calibrationPill, centerX, (10 + 59.5) * scale, 0.75 * scale);
      assertNear(upperStraightMidpoint, 0.1275, 0.035, `I(n) at upper straight midpoint at DPR ${dpr}×`);
      assertNear(lowerStraightMidpoint, 0.095, 0.035, `I(n) at lower straight midpoint at DPR ${dpr}×`);
      const upperRecovery = stationPoint(350, 60, 30, false, 54 / 48, 48);
      const lowerRecovery = stationPoint(350, 60, 30, true, 42 / 36, 36);
      assertNear(calibratedAlphaNear(pill, calibrationPill, (10 + upperRecovery.x) * scale,
        (10 + upperRecovery.y) * scale, 0.75 * scale), 0.09375, 0.04,
      `upper smooth handoff to I(n) at DPR ${dpr}×`);
      assertNear(calibratedAlphaNear(pill, calibrationPill, (10 + lowerRecovery.x) * scale,
        (10 + lowerRecovery.y) * scale, 0.75 * scale), 0.0775, 0.04,
      `lower smooth handoff to I(n) at DPR ${dpr}×`);

      const circle44 = await capture(page, '#circle44');
      const circle36 = await capture(page, '#circle36');
      const smallOffset44 = 22 * (1 - 1 / Math.sqrt(2)) + 0.5 / Math.sqrt(2);
      const smallOffset36 = 18 * (1 - 1 / Math.sqrt(2)) + 0.5 / Math.sqrt(2);
      const calCircle44 = await capture(page, '#calCircle44Host');
      const calCircle36 = await capture(page, '#calCircle36Host');
      const circle44Peak = calibratedAlpha(circle44, calCircle44, smallOffset44 * scale, smallOffset44 * scale,
        (10 + smallOffset44) * scale, (10 + smallOffset44) * scale);
      const circle36Peak = calibratedAlpha(circle36, calCircle36, smallOffset36 * scale, smallOffset36 * scale,
        (10 + smallOffset36) * scale, (10 + smallOffset36) * scale);
      assertNear(circle44Peak, 0.60, 0.12, `44×44 corner peak at DPR ${dpr}×`);
      assertNear(circle36Peak, 0.60, 0.12, `36×36 corner peak at DPR ${dpr}×`);
      assertNear(circle44Peak, circle36Peak, 0.12, `small-control peak consistency at DPR ${dpr}×`);

      await page.evaluate(() => window.setRedRim());
      const red = await capture(page, '#redHost');
      const redEdge = pixel(red, topX, topY);
      const redCenter = pixel(red, centerX, centerY);
      const redInner = pixel(red, centerX, (10 + 2.5) * scale);
      assert.ok(redEdge[0] - redEdge[1] > 8, `the rendered 1px edge uses the temporary red at DPR ${dpr}×`);
      assert.ok(Math.max(...redCenter.map((v, i) => Math.abs(v - [192, 192, 192][i]))) <= 2,
        `red does not leak into the element interior at DPR ${dpr}×`);
      assert.ok(Math.max(...redInner.map((v, i) => Math.abs(v - [192, 192, 192][i]))) <= 2,
        `red does not leak past the 1px rim at DPR ${dpr}×`);
      const channels = red.data.length / (red.width * red.height);
      let redLeaksOutsideRim = 0;
      const redLeakSamples = [];
      const aaHalfPixel = 0.5 / scale;
      for (let py = 0; py < red.height; py += 1) {
        const y = (py + 0.5) / scale - 10;
        for (let px = 0; px < red.width; px += 1) {
          const offset = (py * red.width + px) * channels;
          if (red.data[offset] - red.data[offset + 1] <= 4) continue;
          const x = (px + 0.5) / scale - 10;
          const { distance } = roundedRectDistance(x, y, 350, 60, 30);
          if (distance < -1 - aaHalfPixel || distance > aaHalfPixel) {
            redLeaksOutsideRim += 1;
            if (redLeakSamples.length < 8) redLeakSamples.push({ x, y, distance, rgb: [...red.data.slice(offset, offset + 3)] });
          }
        }
      }
      assert.equal(redLeaksOutsideRim, 0,
        `temporary red remains within the 1 CSS-pixel SDF stroke and its half-device-pixel AA at DPR ${dpr}×; ${redLeaksOutsideRim} outside pixels ${JSON.stringify(redLeakSamples)}`);
      console.log(`MEASURED pixels DPR ${dpr}× ${JSON.stringify({ peaks: [upperPeak, lowerPeak], midpoints: [upperStraightMidpoint, lowerStraightMidpoint], stations: stationSamples, smallPeaks: [circle44Peak, circle36Peak], strokePx: lineRows / dpr, redOutsidePixels: redLeaksOutsideRim })}`);
      console.log(`PASS browser pixels DPR ${dpr}×: 1 CSS-pixel SDF stroke, red-ring containment, both backgrounds, both peaks, all 10 cubic stops, and 44/36px controls.`);

      const nested = await capture(page, '#nestedHost');
      const nestedAlpha = cssAlphaOver(pixel(nested, centerX, centerY)[0], pixel(nested, topX, topY)[0]);
      assertNear(nestedAlpha, blackAlpha * 0.85, 0.015, `nested glass scales the actual rim pixels by 0.85 at DPR ${dpr}×`);
      await checkAffineRimPixels(page, dpr);

      const movingBeforeImage = await cssImage(page, '#moveProbe');
      const backgroundSample = async () => {
        const image = await capture(page, '#motionHost');
        const edge = pixel(image, topX, topY)[0];
        const base = pixel(image, centerX, centerY)[0];
        return { alpha: cssAlphaOver(base, edge), base };
      };
      const movingBefore = await backgroundSample();
      await page.evaluate(() => window.animateBackdrop());
      await page.waitForTimeout(200);
      const movingDuring = await backgroundSample();
      const movingDuringImage = await cssImage(page, '#moveProbe');
      await page.waitForTimeout(250);
      const movingAfter = await backgroundSample();
      const movingAfterImage = await cssImage(page, '#moveProbe');
      for (const [name, sample] of [['before', movingBefore], ['during', movingDuring], ['after', movingAfter]]) {
        assertNear(sample.alpha, 0.1275, 0.035, `${name} animated-background rim alpha at DPR ${dpr}×`);
      }
      assert.ok(movingAfter.base > movingBefore.base + 25, `the moving background visibly changed at DPR ${dpr}×`);
      assert.equal(movingDuringImage, movingBeforeImage, `background motion does not regenerate or shift the rim at DPR ${dpr}×`);
      assert.equal(movingAfterImage, movingBeforeImage, `the final moving background retains the same rim field at DPR ${dpr}×`);
      console.log(`PASS browser animated background DPR ${dpr}×: constant rim field and alpha over three animation frames.`);

      const rtlImage = await cssImage(page, '#rtlProbe');
      const ltrImage = await cssImage(page, '#blackProbe');
      assert.equal(rtlImage, ltrImage, `RTL must not mirror the screen-fixed light at DPR ${dpr}×`);

      const rotated = await capture(page, '#rotProbe');
      const rotatedOff = 30 * (1 - 1 / Math.sqrt(2)) + 0.5 / Math.sqrt(2);
      const rotatedUpperLeft = maximumRed(rotated, rotatedOff * scale, rotatedOff * scale, 1.5 * scale) / 255;
      const rotatedUpperRight = maximumRed(rotated, (60 - rotatedOff) * scale, rotatedOff * scale, 1.5 * scale) / 255;
      assert.ok(rotatedUpperLeft > 0.34, `screen upper-left highlight follows the rotated shape at DPR ${dpr}×`);
      assert.ok(rotatedUpperRight < 0.18, `screen upper-right is not illuminated by a rotating light at DPR ${dpr}×`);

      const beforeMove = await cssImage(page, '#moveProbe');
      await page.mouse.move((20 + 10 + 175), (220 + 10 + 30));
      await page.mouse.down();
      await page.evaluate(() => {
        const element = document.getElementById('moveProbe');
        window.rimMotionEvents = [];
        for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) {
          document.getElementById('app').addEventListener(type, event => {
            if (event.target === element) window.rimMotionEvents.push(`${type}:${event.propertyName}`);
          }, true);
        }
        element.style.width = '250px';
        element.style.height = '80px';
        element.style.borderRadius = '40px';
        element.style.scale = '0.965';
      });
      await page.waitForTimeout(115);
      const duringState = await page.locator('#moveProbe').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { width: rect.width, cssWidth: Number.parseFloat(style.width), active: element.matches(':active'),
          transform: style.transform, image: style.getPropertyValue('--rim-image').trim() };
      });
      const during = { width: duringState.width };
      const duringMove = duringState.image;
      assert.ok(duringState.cssWidth < 349 && duringState.cssWidth > 250 && duringState.active && duringState.transform !== 'none',
        `geometry is sampled during a real active press/resize at DPR ${dpr}×; CSS width ${duringState.cssWidth.toFixed(2)}, visual width ${during.width.toFixed(2)}, active ${duringState.active}`);
      assert.notEqual(duringMove, beforeMove, `the rim pixel image is regenerated during geometry motion at DPR ${dpr}×`);
      await page.mouse.up();
      await page.waitForTimeout(280);
      const finalState = await page.locator('#moveProbe').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, image: getComputedStyle(element).getPropertyValue('--rim-image').trim() };
      });
      const afterMove = finalState.image;
      const motionEvents = await page.evaluate(() => window.rimMotionEvents);
      assert.ok(afterMove !== duringMove,
        `the rim image follows final geometry at DPR ${dpr}×; width ${during.width.toFixed(2)} → ${finalState.width.toFixed(2)} CSS px; PNG ${pngInfo(beforeMove)} → ${pngInfo(duringMove)} → ${pngInfo(afterMove)}; events ${motionEvents.join(',')}`);

      const beforeScroll = await cssImage(page, '#scrollProbe');
      await page.evaluate(() => window.scrollTo(0, 800));
      await page.waitForTimeout(80);
      const afterScroll = await cssImage(page, '#scrollProbe');
      assert.equal(afterScroll, beforeScroll, `scroll preserves the local rim and pixel-stable image at DPR ${dpr}×`);
      const scrollShot = await capture(page, '#scrollHost');
      const scrollTop = pixel(scrollShot, (10 + 175) * scale, (10 + 0.5) * scale)[0] / 255;
      assertNear(scrollTop, 0.1275, 0.035, `scrolled edge I(n) pixel at DPR ${dpr}×`);

      if (dpr === 1) {
        const session = await context.newCDPSession(page);
        let reducedMediaSupported = true;
        try {
          await session.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
          });
        } catch {
          reducedMediaSupported = false;
        }
        if (!reducedMediaSupported) {
          throw new Error('Chromium could not emulate prefers-reduced-transparency; the browser pixel gate cannot verify the required OS preference path.');
        }
        await page.waitForFunction(() => matchMedia('(prefers-reduced-transparency: reduce)').matches);
        await page.waitForFunction(() => getComputedStyle(document.getElementById('blackProbe')).getPropertyValue('--rim-effective').trim() === '0.5');
        const reduced = await page.evaluate(() => ({
          alpha: getComputedStyle(document.getElementById('glassTest')).backgroundColor,
          blur: getComputedStyle(document.getElementById('glassTest')).backdropFilter,
          rimOpacity: getComputedStyle(document.getElementById('blackProbe'), '::after').opacity,
        }));
        const opaqueColor = reduced.alpha.match(/[0-9.]+/g) || [];
        assert.deepEqual(opaqueColor.slice(0, 3).map(Number), [30, 32, 37], 'reduced-transparency glass fill uses the specified opaque RGB');
        assert.ok(opaqueColor.length === 3 || Number(opaqueColor[3]) === 1, 'reduced-transparency glass fill has alpha 1');
        assert.equal(reduced.blur, 'none', 'reduced-transparency removes backdrop blur');
        assert.equal(reduced.rimOpacity, '0.5', 'reduced-transparency keeps the rim at half intensity');
        const normalAlpha = cssAlphaOver(blackBase, blackRim);
        const halfScreenshot = await capture(page, '#blackHost');
        const halfRim = pixel(halfScreenshot, topX, topY)[0];
        assertNear(cssAlphaOver(blackBase, halfRim), normalAlpha * 0.5, 0.03, 'reduced-transparency screenshot renders half-strength rim');
        console.log('PASS browser reduced-transparency: opaque fill, no blur, and half-intensity rim verified in Chromium pixels.');
        await session.detach();
      }

      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
