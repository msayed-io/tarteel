import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.argv[2] || 0);
const phase = process.argv[3] || 'first';
const endpoint = `http://127.0.0.1:${port}`;
const artifactDir = process.env.TARTEEL_SETTINGS_ARTIFACT_DIR || join(process.cwd(), 'artifacts', 'settings-ui-smoke');
const sessionDir = process.env.TARTEEL_SETTINGS_SESSION_DIR || join(process.cwd(), '.settings-smoke-session');
const appConfigDir = join(process.env.APPDATA || '', 'com.tarteel.desktop');
const expectedPath = join(sessionDir, 'expected.json');
const resultPath = join(artifactDir, 'result.json');
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];
const evidence = { phase, startedAt: new Date().toISOString(), checks: [], environment: 'isolated Windows WebView2 runner' };
let browser;
let referenceBrowser;
let mainPage;

function check(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  evidence.checks.push(label);
}

async function waitUntil(read, predicate, label, timeoutMs = 15_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

async function readJson(page, key) {
  return page.evaluate(storageKey => {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; }
  }, key);
}

async function invoke(page, command, args = {}) {
  return page.evaluate(async ({ command: name, args: payload }) => {
    const bridge = window.__TAURI_INTERNALS__;
    if (!bridge || typeof bridge.invoke !== 'function') throw new Error('Tauri IPC bridge is unavailable in the packaged WebView.');
    return bridge.invoke(name, payload);
  }, { command, args });
}

async function connect() {
  const deadline = Date.now() + 30_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (!browser) browser = await chromium.connectOverCDP(endpoint, { timeout: 4_000 });
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const url = page.url();
          if (url && url !== 'about:blank' && !/^(?:devtools|chrome|edge):/i.test(url) && !/island\.html(?:$|[?#])/i.test(url)) {
            const hasAppRoot = await page.evaluate(() => Boolean(document.querySelector('#root'))).catch(() => false);
            if (hasAppRoot) {
              mainPage = page;
              break;
            }
          }
        }
        if (mainPage) break;
      }
      if (mainPage) break;
      const targets = browser.contexts().flatMap(context => context.pages().map(page => page.url()));
      lastError = `CDP connected but no rendered main WebView target with #root appeared; current targets: ${JSON.stringify(targets)}`;
    } catch (cause) {
      lastError = String(cause);
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
    }
    await delay(300);
  }
  if (!browser || !mainPage) throw new Error(`Could not attach to the main WebView2 page at ${endpoint}: ${lastError}`);
  console.log(`Attached to the rendered main WebView at ${mainPage.url()}.`);
  mainPage.on('pageerror', error => pageErrors.push(String(error)));
  mainPage.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  mainPage.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || 'unknown request failure' }));
  mainPage.setDefaultTimeout(12_000);
  try {
    await mainPage.waitForFunction(() => document.querySelector('#root')?.textContent?.trim().length > 0, null, { timeout: 30_000 });
  } catch (cause) {
    const dom = await mainPage.evaluate(() => {
      const root = document.querySelector('#root');
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        rootFound: Boolean(root),
        rootText: root?.textContent?.slice(0, 500) ?? null,
        rootHtml: root?.innerHTML?.slice(0, 1500) ?? null,
        bodyText: document.body?.innerText?.slice(0, 1000) ?? null,
        scriptSources: [...document.scripts].map(script => script.src || '(inline)'),
      };
    }).catch(error => ({ evaluationError: String(error) }));
    const screenshot = join(artifactDir, `failure-${phase}-main-webview.png`);
    await mainPage.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    throw new Error(`Main WebView did not render #root; url=${mainPage.url()} dom=${JSON.stringify(dom)} pageErrors=${JSON.stringify(pageErrors)} consoleErrors=${JSON.stringify(consoleErrors)} failedRequests=${JSON.stringify(failedRequests)} screenshot=${screenshot}`, { cause });
  }
  const crash = await mainPage.locator('body').innerText();
  assert.ok(!crash.includes('تعذّر عرض واجهة تَرتيل'), `The packaged app hit its React error boundary: ${crash.slice(0, 500)}`);
  return mainPage;
}

async function connectIsland() {
  const deadline = Date.now() + 10_000;
  let targets = [];
  while (Date.now() < deadline) {
    if (!browser) throw new Error('The shared WebView2 CDP connection is unavailable.');
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (/island\.html(?:$|[?#])/i.test(page.url())) return page;
      }
    }
    targets = browser.contexts().flatMap(context => context.pages().map(page => page.url()));
    await delay(200);
  }
  throw new Error(`No Dynamic Island WebView target was found on shared CDP endpoint ${endpoint}; current targets: ${JSON.stringify(targets)}.`);
}

async function openSettings(page) {
  if (await page.locator('.settings-page').count()) return;
  const openButton = page.locator('button[aria-label="إعدادات الصلاة والموقع"]');
  await openButton.waitFor({ state: 'visible' });
  await openButton.click();
  await page.locator('.settings-page').waitFor({ state: 'visible' });
}

async function switchTab(page, id, screenshotName) {
  const tab = page.locator(`#${id}`);
  await tab.click();
  await page.locator(`#${id}`).waitFor({ state: 'visible' });
  await page.waitForFunction(tabId => document.getElementById(tabId)?.getAttribute('aria-selected') === 'true', id);
  const activePanel = id === 'settings-tab-prayer' ? '#pane-prayer' : id === 'settings-tab-audio' ? '#pane-audio' : '#pane-island';
  await page.locator(activePanel).waitFor({ state: 'visible' });
  check(await page.locator(activePanel).evaluate(element => !element.hidden), `tab ${id} exposes its real panel`);
  await page.waitForTimeout(350);
  if (screenshotName) await page.screenshot({ path: join(artifactDir, screenshotName), fullPage: false });
}

async function createReferencePage(page) {
  const { width, height, scale } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
  referenceBrowser = await chromium.launch({ headless: true });
  const context = await referenceBrowser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const referencePage = await context.newPage();
  const html = await readFile(join(process.cwd(), 'test/fixtures/settings-reference-static.html'), 'utf8');
  assert.doesNotMatch(html, /<script\b|\son(?:click|input|change)\s*=|\sdata-[\w-]+\s*=/i, 'The visual reference must not contain executable preview behavior or simulation markers.');
  await referencePage.setContent(html, { waitUntil: 'load' });
  await referencePage.evaluate(async () => { await document.fonts.ready; return true; });
  return referencePage;
}

async function compareReferenceVisual(page, referencePage, paneId, screenshotName) {
  const index = ['pane-prayer', 'pane-audio', 'pane-island'].indexOf(paneId);
  assert.ok(index >= 0, `Unknown settings pane '${paneId}'.`);
  const state = await page.evaluate(() => {
    const range = document.querySelector('#ps-volume');
    const selectData = [...document.querySelectorAll('#pane-prayer select')].map(select => ({
      value: select.value,
      text: select.selectedOptions[0]?.textContent || '',
    }));
    const checkboxData = ['#ps-sound', '#ps-mute', '#ps-autostart'].map(selector => {
      const input = document.querySelector(selector);
      const label = document.querySelector(`${selector}-label`);
      return { label: label?.textContent?.trim() || '', checked: Boolean(input?.checked) };
    });
    const chips = selector => [...document.querySelectorAll(selector)].map(chip => chip.innerHTML);
    return {
      placementIndex: [...document.querySelectorAll('#pane-island .card-seg[aria-label="وضع الموضع"] [role="radio"]')].findIndex(button => button.getAttribute('aria-checked') === 'true'),
      appearanceIndex: [...document.querySelectorAll('#pane-island .card-seg[aria-label="مادة الجزيرة"] [role="radio"]')].findIndex(button => button.getAttribute('aria-checked') === 'true'),
      offsets: [...document.querySelectorAll('#pane-island .xy b')].map(label => label.textContent),
      notificationGranted: document.querySelector('#ps-notify')?.getAttribute('aria-pressed') === 'true',
      notificationText: document.querySelector('#ps-notify')?.textContent?.trim() || '',
      locationName: document.querySelector('#pane-prayer .loc-name')?.textContent || '',
      locationChips: chips('#pane-prayer .loc .chips .chip'),
      appliedChips: chips('#pane-prayer .applied .chips .chip'),
      selects: selectData,
      switches: checkboxData,
      volume: Number(range?.value || 0),
      volumeProgress: range ? getComputedStyle(range).getPropertyValue('--p').trim() : '',
      volumeLabel: document.querySelector('#pane-prayer .row-vol .pill')?.textContent?.trim() || '',
      audioModeIndex: [...document.querySelectorAll('#pane-audio .opt')].findIndex(option => option.querySelector('input')?.checked),
    };
  });
  assert.ok(state.placementIndex >= 0 && state.appearanceIndex >= 0, 'The real placement and appearance controls expose their selected states.');
  await referencePage.evaluate(({ paneId, index }) => {
    const nav = document.querySelector('#nav');
    nav.style.setProperty('--i', String(index));
    [...nav.querySelectorAll('.seg-item')].forEach((tab, tabIndex) => tab.setAttribute('aria-selected', String(tabIndex === index)));
    for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('is-active', pane.id === paneId);
  }, { paneId, index });
  await referencePage.evaluate(state => {
    const groups = [
      ['.card-seg[aria-label="وضع الموضع"]', state.placementIndex],
      ['.card-seg[aria-label="مادة الجزيرة"]', state.appearanceIndex],
    ];
    for (const [selector, selected] of groups) {
      const group = document.querySelector(selector);
      if (!group) continue;
      group.style.setProperty('--i', String(selected));
      group.querySelectorAll('[role="radio"]').forEach((button, index) => {
        button.setAttribute('aria-checked', String(index === selected));
        button.setAttribute('aria-selected', String(index === selected));
      });
    }
    document.querySelector('.remote')?.classList.toggle('is-off', state.placementIndex === 0);
    document.querySelectorAll('.remote .dp').forEach(button => { button.disabled = state.placementIndex === 0; });
    document.querySelectorAll('.xy b').forEach((label, index) => { if (state.offsets[index] !== undefined) label.textContent = state.offsets[index]; });
    const notificationRow = [...document.querySelectorAll('.pane .row')].find(row => row.textContent.includes('إذن إشعار التنبيه المسبق'));
    const notificationButton = notificationRow?.querySelector('button');
    notificationButton?.classList.toggle('granted', state.notificationGranted);
    notificationButton?.setAttribute('aria-pressed', String(state.notificationGranted));
    if (notificationButton && state.notificationText) {
      const checkIcon = notificationButton.querySelector('svg');
      if (!state.notificationGranted) checkIcon?.remove();
      const textNode = [...notificationButton.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (textNode) textNode.textContent = state.notificationText;
      else notificationButton.insertBefore(document.createTextNode(state.notificationText), notificationButton.firstChild);
    }
    const syncChips = (selector, markup) => {
      const container = document.querySelector(selector);
      if (!container) return;
      container.replaceChildren(...markup.map(html => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const template = document.createElement('template');
        template.innerHTML = html;
        for (const element of template.content.querySelectorAll('*')) {
          if (element.tagName !== 'BDI') element.replaceWith(document.createTextNode(element.textContent || ''));
        }
        chip.append(template.content);
        return chip;
      }));
    };
    const locationName = document.querySelector('.loc-name');
    if (locationName) locationName.textContent = state.locationName;
    syncChips('.loc .chips', state.locationChips);
    syncChips('.applied .chips', state.appliedChips);
    const referenceSelects = [...document.querySelectorAll('#pane-prayer select')];
    state.selects.forEach((value, index) => {
      const select = referenceSelects[index];
      if (!select) return;
      const option = document.createElement('option');
      option.value = value.value;
      option.textContent = value.text;
      select.replaceChildren(option);
      select.value = value.value;
    });
    for (const item of state.switches) {
      const label = [...document.querySelectorAll('.row-label')].find(node => node.textContent.trim() === item.label);
      const input = label?.closest('.row')?.querySelector('input[type="checkbox"]');
      if (input) input.checked = item.checked;
    }
    const volume = document.querySelector('#pane-prayer .range');
    if (volume) {
      volume.value = String(state.volume);
      if (state.volumeProgress) volume.style.setProperty('--p', state.volumeProgress);
    }
    const volumeLabel = document.querySelector('#pane-prayer .row-vol .pill');
    if (volumeLabel) volumeLabel.textContent = state.volumeLabel;
    const audioOptions = [...document.querySelectorAll('#pane-audio .opt')];
    audioOptions.forEach((option, index) => {
      const input = option.querySelector('input');
      if (input) input.checked = index === state.audioModeIndex;
    });
  }, state);
  const settlePane = targetPage => targetPage.locator(`#${paneId}`).evaluate(async pane => {
    await Promise.all(pane.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  await Promise.all([settlePane(referencePage), settlePane(page)]);
  await page.evaluate(async () => { await document.fonts.ready; return true; });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await Promise.all([
    page.mouse.move(viewport.width - 2, viewport.height - 2),
    referencePage.mouse.move(viewport.width - 2, viewport.height - 2),
    page.evaluate(() => document.activeElement?.blur?.()),
    referencePage.evaluate(() => document.activeElement?.blur?.()),
  ]);
  await Promise.all([page.waitForTimeout(100), referencePage.waitForTimeout(100)]);

  const entries = [
    { key: 'wrap', reference: '.wrap', actual: '.wrap', rect: ['x', 'y', 'width'], props: ['display', 'box-sizing', 'max-width', 'padding-left', 'padding-right', 'margin-left', 'margin-right', 'gap'] },
    { key: 'topbar', reference: '.topbar', actual: '.topbar', rect: ['x', 'y', 'width', 'height'], props: ['display', 'align-items', 'justify-content', 'gap', 'padding', 'border-radius', 'background-color', 'box-shadow'] },
    { key: 'brand', reference: '.brand', actual: '.brand', rect: ['x', 'y', 'width', 'height'], props: ['display', 'align-items', 'gap', 'padding', 'border-radius', 'background-color', 'box-shadow'] },
    { key: 'tabs', reference: '#nav', actual: '#settings-nav', rect: ['x', 'y', 'width', 'height'], props: ['display', 'gap', 'padding', 'border-radius', 'background-color', 'box-shadow'] },
    { key: 'page-heading', reference: '.page-head', actual: '.page-head', rect: ['x', 'y', 'width'], props: ['display', 'gap', 'margin-top', 'margin-bottom'] },
    { key: 'heading-text', reference: '.page-head h1', actual: '.page-head h1', props: ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color'] },
    { key: 'panes', reference: '.panes', actual: '.panes', rect: ['x', 'y', 'width'], props: ['display', 'grid-template-columns', 'gap', 'align-items'] },
    { key: 'active-pane', reference: '.pane.is-active', actual: '.pane.is-active', rect: ['x', 'y', 'width'], props: ['display', 'grid-template-columns', 'gap', 'align-items'] },
    { key: 'section-titles', reference: '.pane.is-active .sec-title', actual: '.pane.is-active .sec-title', props: ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'margin-bottom'] },
    { key: 'cards', reference: '.pane.is-active .card', actual: '.pane.is-active .card', props: ['display', 'padding', 'gap', 'border-radius', 'border-top-width', 'border-top-style', 'border-top-color', 'background-color', 'box-shadow', 'backdrop-filter'] },
    { key: 'hints', reference: '.pane.is-active .hint', actual: '.pane.is-active .hint', props: ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'margin-top'] },
  ];
  const visualProperties = [
    'box-sizing', 'display', 'position', 'z-index', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'align-items', 'align-content', 'justify-items', 'justify-content', 'flex-direction', 'flex-wrap',
    'gap', 'row-gap', 'column-gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius', 'outline-width', 'outline-style', 'outline-color',
    'content', 'inset', 'top', 'right', 'bottom', 'left', 'background-size', 'background-position', 'pointer-events',
    'mask', 'mask-image', 'mask-composite', '-webkit-mask', '-webkit-mask-image', '-webkit-mask-composite', 'clip-path',
    'color', 'background-color', 'background-image', 'box-shadow', 'backdrop-filter', 'filter',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line', 'white-space', 'text-overflow',
    'opacity', 'transform', 'transform-origin', 'transition-property', 'transition-duration', 'transition-timing-function', 'animation-name', 'animation-duration', 'animation-timing-function',
    'overflow', 'overflow-x', 'overflow-y', 'cursor', 'visibility', 'direction', 'unicode-bidi', 'text-shadow', 'font-kerning', 'font-feature-settings', 'font-variant',
    'text-rendering', 'word-break', 'overflow-wrap', 'hyphens', 'appearance', '-webkit-appearance', 'scrollbar-width', 'scrollbar-gutter', 'accent-color', 'fill', 'stroke', 'stroke-width',
    '--bg', '--card', '--card-line', '--raised', '--pill', '--text', '--muted', '--rim-rgb', '--rim', '--rim-w', '--R', '--i', '--n', '--p',
  ];
  const addVisualEntries = pairs => {
    for (const [key, reference, actual, rect = []] of pairs) entries.push({ key, reference, actual, rect, props: [] });
  };
  addVisualEntries([
    ['brand-mark', '.brand-mark', '.brand-mark', ['x', 'y', 'width', 'height']],
    ['brand-name', '.brand-name', '.brand-name', ['x', 'y', 'width', 'height']],
    ['tab-items', '#nav .seg-item', '#settings-nav .seg-item', ['x', 'y', 'width', 'height']],
    ['tab-thumb', '#nav .seg-thumb', '#settings-nav .seg-thumb', ['x', 'y', 'width', 'height']],
    ['page-subtitle', '.page-head .sub', '.page-head .sub', ['x', 'y', 'width', 'height']],
    ['columns', '.pane.is-active .col', '.pane.is-active .col', ['x', 'y', 'width', 'height']],
    ['sections', '.pane.is-active .sec', '.pane.is-active .sec', ['x', 'y', 'width', 'height']],
    ['card-leads', '.pane.is-active .lead', '.pane.is-active .lead', ['x', 'y', 'width', 'height']],
    ['all-section-icons', '.pane.is-active svg', '.pane.is-active svg', ['x', 'y', 'width', 'height']],
  ]);
  entries.push(
    { key: 'glass-edge-pseudo', reference: '.pane.is-active .glass', actual: '.pane.is-active .glass', pseudo: '::after', props: [] },
    { key: 'rim-edge-pseudo', reference: '.pane.is-active .rim', actual: '.pane.is-active .rim', pseudo: '::after', props: [] },
    { key: 'section-accent-pseudo', reference: '.pane.is-active .sec-title', actual: '.pane.is-active .sec-title', pseudo: '::before', props: [] },
    { key: 'topbar-shade-pseudo', reference: '.topbar', actual: '.topbar', pseudo: '::before', props: [] },
  );
  if (paneId === 'pane-prayer' || paneId === 'pane-audio') entries.push(
    { key: 'switch-knob-pseudo', reference: '.pane.is-active .switch .track', actual: '.pane.is-active .switch .track', pseudo: '::before', props: [] },
  );
  if (paneId === 'pane-prayer') entries.push(
    { key: 'volume-track-pseudo', reference: '.pane.is-active .row-vol .range', actual: '.pane.is-active .row-vol .range', pseudo: '::-webkit-slider-runnable-track', props: [] },
    { key: 'volume-thumb-pseudo', reference: '.pane.is-active .row-vol .range', actual: '.pane.is-active .row-vol .range', pseudo: '::-webkit-slider-thumb', props: [] },
  );
  if (paneId === 'pane-prayer') entries.push(
    { key: 'location-card', reference: '.pane.is-active .loc', actual: '.pane.is-active .loc', props: ['display', 'align-items', 'gap'] },
    { key: 'prayer-controls', reference: '.pane.is-active .row', actual: '.pane.is-active .row', props: ['display', 'align-items', 'gap'] },
    { key: 'selects', reference: '.pane.is-active select', actual: '.pane.is-active select', props: ['font-family', 'font-size', 'font-weight', 'color', 'background-color', 'border-radius', 'padding'] },
    { key: 'action-buttons', reference: '.pane.is-active .btn', actual: '.pane.is-active .btn', props: ['display', 'align-items', 'justify-content', 'gap', 'font-family', 'font-size', 'font-weight', 'border-radius', 'background-color', 'box-shadow'] },
  );
  if (paneId === 'pane-prayer') addVisualEntries([
    ['location-pin', '.loc-pin', '.loc-pin', ['x', 'y', 'width', 'height']],
    ['location-name', '.loc-name', '.loc-name', ['x', 'y', 'width', 'height']],
    ['location-chips', '.loc .chip', '.loc .chip'],
    ['location-action', '.loc-foot .btn', '.loc-foot .btn', ['x', 'y', 'width', 'height']],
    ['field-grid', '.fields', '.fields', ['x', 'y', 'width', 'height']],
    ['fields', '.field', '.field', ['x', 'y', 'width', 'height']],
    ['field-labels', '.field-label', '.field-label', ['x', 'y', 'width', 'height']],
    ['select-shells', '.sel', '.sel', ['x', 'y', 'width', 'height']],
    ['select-controls', '.sel select', '.sel select', ['x', 'y', 'width', 'height']],
    ['select-arrows', '.sel .chev', '.sel .chev', ['x', 'y', 'width', 'height']],
    ['applied-strip', '.applied', '.applied', ['x', 'y', 'width', 'height']],
    ['applied-label', '.applied-label', '.applied-label', ['x', 'y', 'width', 'height']],
    ['row-icons', '.pane.is-active .ico', '.pane.is-active .ico', ['x', 'y', 'width', 'height']],
    ['row-labels', '.pane.is-active .row-label', '.pane.is-active .row-label', ['x', 'y', 'width', 'height']],
    ['row-controls', '.pane.is-active .row-ctl', '.pane.is-active .row-ctl', ['x', 'y', 'width', 'height']],
    ['switch-tracks', '.pane.is-active .switch .track', '.pane.is-active .switch .track', ['x', 'y', 'width', 'height']],
    ['volume-pills', '.row-vol .pill', '.row-vol .pill', ['x', 'y', 'width', 'height']],
    ['volume-sliders', '.row-vol .range', '.row-vol .range', ['x', 'y', 'width', 'height']],
    ['slider-lines', '.row-vol .slider-line', '.row-vol .slider-line', ['x', 'y', 'width', 'height']],
    ['card-footers', '.pane.is-active .card-foot', '.pane.is-active .card-foot', ['x', 'y', 'width', 'height']],
  ]);
  if (paneId === 'pane-audio') entries.push(
    { key: 'audio-options', reference: '.pane.is-active .opt', actual: '.pane.is-active .opt', props: ['display', 'align-items', 'gap', 'padding', 'border-radius', 'background-color'] },
    { key: 'audio-labels', reference: '.pane.is-active .opt-txt', actual: '.pane.is-active .opt-txt', props: ['display', 'gap', 'font-family', 'font-size', 'line-height', 'color'] },
    { key: 'switches', reference: '.pane.is-active .switch', actual: '.pane.is-active .switch', props: ['display', 'width', 'height', 'border-radius'] },
  );
  if (paneId === 'pane-audio') addVisualEntries([
    ['audio-options-grid', '.pane.is-active .opts', '.pane.is-active .opts', ['x', 'y', 'width', 'height']],
    ['audio-option-indicators', '.pane.is-active .opt-ind', '.pane.is-active .opt-ind', ['x', 'y', 'width', 'height']],
    ['audio-option-labels', '.pane.is-active .opt-txt', '.pane.is-active .opt-txt', ['x', 'y', 'width', 'height']],
    ['audio-play-dots', '.pane.is-active .play-dot', '.pane.is-active .play-dot', ['x', 'y', 'width', 'height']],
    ['audio-note-rows', '.pane.is-active .note-row', '.pane.is-active .note-row', ['x', 'y', 'width', 'height']],
    ['audio-switch-tracks', '.pane.is-active .switch .track', '.pane.is-active .switch .track', ['x', 'y', 'width', 'height']],
    ['audio-row-labels', '.pane.is-active .row-label', '.pane.is-active .row-label', ['x', 'y', 'width', 'height']],
  ]);
  if (paneId === 'pane-island') entries.push(
    { key: 'remote-segments', reference: '.pane.is-active .card-seg', actual: '.pane.is-active .card-seg', props: ['display', 'grid-template-columns', 'gap', 'padding', 'border-radius', 'background-color', 'box-shadow'] },
    { key: 'remote-segment-thumbs', reference: '.pane.is-active .seg-thumb', actual: '.pane.is-active .seg-thumb', props: ['position', 'width', 'height', 'transform', 'border-radius', 'background-color', 'box-shadow'] },
    { key: 'remotes', reference: '.pane.is-active .remote', actual: '.pane.is-active .remote', rect: ['x', 'y', 'width', 'height'], props: ['position', 'display', 'border-radius', 'background-color', 'box-shadow'] },
    { key: 'remote-core', reference: '.pane.is-active .remote-core', actual: '.pane.is-active .remote-core', rect: ['x', 'y', 'width', 'height'], props: ['position', 'display', 'border-radius', 'background-color', 'box-shadow'] },
    { key: 'remote-buttons', reference: '.pane.is-active .dp', actual: '.pane.is-active .dp', rect: ['x', 'y', 'width', 'height'], props: ['position', 'display', 'align-items', 'justify-content', 'border-radius', 'background-color'] },
    { key: 'offset-labels', reference: '.pane.is-active .xy', actual: '.pane.is-active .xy', props: ['display', 'gap', 'font-family', 'font-size', 'line-height', 'color'] },
  );
  if (paneId === 'pane-island') addVisualEntries([
    ['dynamic-segment-items', '.pane.is-active .card-seg .seg-item', '.pane.is-active .card-seg .seg-item', ['x', 'y', 'width', 'height']],
    ['dynamic-remote-panel', '.pane.is-active .remote-panel', '.pane.is-active .remote-panel', ['x', 'y', 'width', 'height']],
    ['dynamic-direction-icons', '.pane.is-active .remote .dp svg', '.pane.is-active .remote .dp svg', ['x', 'y', 'width', 'height']],
    ['dynamic-capsule', '.pane.is-active .remote-core .cap', '.pane.is-active .remote-core .cap', ['x', 'y', 'width', 'height']],
    ['dynamic-offset-values', '.pane.is-active .xy > *', '.pane.is-active .xy > *', ['x', 'y', 'width', 'height']],
  ]);
  const requiredEntries = new Set([
    'wrap', 'topbar', 'brand', 'tabs', 'page-heading', 'heading-text', 'panes', 'active-pane', 'section-titles', 'cards',
    'brand-mark', 'brand-name', 'tab-items', 'tab-thumb', 'page-subtitle', 'columns', 'sections', 'all-section-icons',
    'rim-edge-pseudo', 'section-accent-pseudo', 'topbar-shade-pseudo',
  ]);
  if (paneId === 'pane-prayer') [
    'location-card', 'prayer-controls', 'selects', 'action-buttons', 'location-pin', 'location-name', 'location-chips',
    'location-action', 'field-grid', 'fields', 'field-labels', 'select-shells', 'select-controls', 'select-arrows',
    'applied-strip', 'applied-label', 'row-icons', 'row-labels', 'row-controls', 'switch-tracks', 'volume-pills',
    'volume-sliders', 'slider-lines', 'card-footers', 'switch-knob-pseudo', 'volume-track-pseudo', 'volume-thumb-pseudo',
  ].forEach(key => requiredEntries.add(key));
  if (paneId === 'pane-audio') [
    'audio-options', 'audio-labels', 'switches', 'audio-options-grid', 'audio-option-indicators', 'audio-option-labels',
    'audio-note-rows', 'audio-switch-tracks', 'audio-row-labels', 'switch-knob-pseudo',
  ].forEach(key => requiredEntries.add(key));
  if (paneId === 'pane-island') [
    'remote-segments', 'remote-segment-thumbs', 'remotes', 'remote-core', 'remote-buttons', 'offset-labels',
    'dynamic-segment-items', 'dynamic-remote-panel', 'dynamic-direction-icons', 'dynamic-capsule', 'dynamic-offset-values',
  ].forEach(key => requiredEntries.add(key));
  for (const key of requiredEntries) {
    assert.ok(entries.some(entry => entry.key === key), `${paneId}: required visual check '${key}' is not configured`);
  }

  const collect = async (targetPage, side) => targetPage.evaluate(({ entries, side, visualProperties }) => {
    const result = {};
    for (const entry of entries) {
      const selector = entry[side];
      const nodes = [...document.querySelectorAll(selector)];
      result[entry.key] = nodes.map(node => {
        const style = getComputedStyle(node, entry.pseudo || null);
        const rect = node.getBoundingClientRect();
        const props = [...new Set([...(entry.props || []), ...visualProperties])];
        return {
          rect: Object.fromEntries((entry.rect || []).map(key => [key, rect[key]])),
          style: Object.fromEntries(props.map(key => [key, style.getPropertyValue(key).trim()])),
        };
      });
    }
    return result;
  }, { entries, side, visualProperties });
  const reference = await collect(referencePage, 'reference');
  const actual = await collect(page, 'actual');
  const collectSvgSymbols = targetPage => targetPage.evaluate(id => [...document.querySelectorAll(`#${id} svg`)].map(svg => {
    const use = svg.querySelector('use');
    const href = use?.getAttribute('href') || use?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const symbol = href.startsWith('#') ? document.getElementById(href.slice(1)) : null;
    return {
      href,
      viewBox: svg.getAttribute('viewBox') || '',
      symbolViewBox: symbol?.getAttribute('viewBox') || '',
      shape: (symbol?.innerHTML || svg.innerHTML).replace(/\s+/g, ' ').trim(),
    };
  }), paneId);
  const [referenceIcons, actualIcons] = await Promise.all([collectSvgSymbols(referencePage), collectSvgSymbols(page)]);
  assert.deepEqual(actualIcons, referenceIcons, `${paneId}: SVG references, viewBoxes, or icon shapes differ from the HTML design`);
  const readVisibleText = targetPage => targetPage.evaluate(id => {
    const root = document.getElementById(id);
    const walk = node => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        return text ? [text] : [];
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'SVG') return [];
      if (node.tagName === 'SELECT') {
        const text = node.selectedOptions[0]?.textContent?.replace(/\s+/g, ' ').trim() || '';
        return text ? [text] : [];
      }
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return [];
      return [...node.childNodes].flatMap(walk);
    };
    return walk(root).join(' ').replace(/\s+/g, ' ').trim();
  }, paneId);
  const [referenceText, actualText] = await Promise.all([readVisibleText(referencePage), readVisibleText(page)]);
  assert.equal(actualText, referenceText, `${paneId}: visible text differs from the HTML design`);
  await page.screenshot({ path: join(artifactDir, screenshotName), fullPage: false });
  await referencePage.screenshot({ path: join(artifactDir, `reference-${screenshotName}`), fullPage: false });
  for (const entry of entries) {
    const refNodes = reference[entry.key];
    const appNodes = actual[entry.key];
    const props = [...new Set([...(entry.props || []), ...visualProperties])];
    if (requiredEntries.has(entry.key)) {
      assert.ok(refNodes.length > 0, `${paneId}/${entry.key}: required reference element is missing`);
      assert.ok(appNodes.length > 0, `${paneId}/${entry.key}: required app element is missing`);
    }
    assert.equal(appNodes.length, refNodes.length, `${entry.key}: element count differs (app ${appNodes.length}, reference ${refNodes.length})`);
    for (let index = 0; index < appNodes.length; index += 1) {
      for (const property of props) {
        assert.equal(appNodes[index].style[property], refNodes[index].style[property], `${paneId}/${entry.key}[${index}] ${property} differs`);
      }
      for (const property of entry.rect || []) {
        const difference = Math.abs(appNodes[index].rect[property] - refNodes[index].rect[property]);
        assert.ok(difference <= 1, `${paneId}/${entry.key}[${index}] ${property} differs by ${difference.toFixed(2)} CSS px`);
      }
    }
  }
  const comparison = { paneId, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })), matchedSelectors: entries.length, matchedNodes: Object.values(actual).reduce((sum, nodes) => sum + nodes.length, 0) };
  evidence.visualComparisons ||= [];
  evidence.visualComparisons.push(comparison);
  evidence.checks.push(`SVG icon references and shape paths match the HTML design: ${paneId}`);
  evidence.checks.push(`Visible text matches the HTML design: ${paneId}`);
  evidence.checks.push(`Windows computed-style and layout parity against the script-free reference: ${paneId}`);
  return comparison;
}

async function installLocationProbe(page) {
  return page.evaluate(() => {
    const geo = navigator.geolocation;
    if (!geo || typeof geo.getCurrentPosition !== 'function') return false;
    const original = geo.getCurrentPosition.bind(geo);
    const records = [];
    const wrapped = function (success, failure, options) {
      return original(position => {
        records.push({ kind: 'success', latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy });
        if (success) success(position);
      }, error => {
        records.push({ kind: 'error', code: Number(error?.code) || null, message: String(error?.message || '').slice(0, 240) });
        if (failure) failure(error);
      }, options);
    };
    try {
      geo.getCurrentPosition = wrapped;
      window.__tarteelLocationProbe = { geo, original, wrapped, records };
      return geo.getCurrentPosition === wrapped;
    } catch {
      window.__tarteelLocationProbe = { geo, original, wrapped, records };
      return false;
    }
  });
}

async function locationProbeRecords(page) {
  return page.evaluate(() => {
    const probe = window.__tarteelLocationProbe;
    if (!probe) return [];
    if (probe.geo.getCurrentPosition === probe.wrapped) probe.geo.getCurrentPosition = probe.original;
    return probe.records.map(({ kind, code, message, accuracy }) => ({
      kind, code, message,
      hasCoordinates: kind === 'success',
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
    }));
  });
}

function chooseSafePreAlarm(schedule, now = Date.now()) {
  const events = Array.isArray(schedule?.events) ? schedule.events : [];
  for (const minutes of [5, 10, 15, 30]) {
    const unsafe = events.some(event => {
      const lead = Number(event.at) - minutes * 60_000;
      return Number.isFinite(lead) && lead >= now - 120_000 && lead <= now + 180_000;
    });
    if (!unsafe) return minutes;
  }
  return 0;
}

async function waitForSavedConfig(page, expected, timeoutMs = 15_000) {
  return waitUntil(() => readJson(page, 'tarteel.prayer.settings'), value => {
    if (!value?.location) return false;
    return Object.entries(expected).every(([key, wanted]) => value[key] === wanted);
  }, 'the debounced prayer settings snapshot', timeoutMs);
}

async function readNativeJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function waitForNativePreferences(expected) {
  const file = join(appConfigDir, 'adhan-preferences.json');
  return waitUntil(() => readNativeJson(file), value => value && Object.entries(expected).every(([key, wanted]) => value[key] === wanted), `native adhan preferences at ${file}`, 10_000);
}

async function readPlacement(page) {
  return invoke(page, 'get_island_placement');
}

async function setRangeThroughKeyboard(page, selector, value) {
  const slider = page.locator(selector);
  await slider.focus();
  await slider.press('Home');
  for (let index = 0; index < value; index += 1) await slider.press('ArrowUp');
  const actual = Number(await slider.inputValue());
  assert.equal(actual, value, `The real range control should accept ${value}; actual ${actual}`);
}

async function seedTemporaryLocation(page) {
  const location = {
    latitude: 30.0444,
    longitude: 31.2357,
    accuracy: 40,
    timeZone: 'Africa/Cairo',
    cityNameAr: 'القاهرة',
    countryNameAr: 'مصر',
    source: 'test-fixture',
    resolvedAt: Date.now(),
  };
  const config = {
    location,
    showNext: false,
    pauseAtAdhan: true,
    notificationsAllowed: false,
    adhanSound: false,
    adhanVolume: 80,
    adhanMuted: false,
    preAlarmMinutes: 0,
    adjust: {},
    methodId: 'auto',
    school: 'auto',
  };
  await page.evaluate(({ config, audio }) => {
    localStorage.setItem('tarteel.prayer.settings', JSON.stringify(config));
    localStorage.setItem('tarteel.audio.settings', JSON.stringify(audio));
    localStorage.setItem('tarteel.library', '[]');
    localStorage.removeItem('tarteel.prayer.schedule');
  }, { config, audio: { speed: 1, sleepMode: 'off', sleepMinutes: 0, sleepDeadline: null, spatialMode: 'natural' } });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#root')?.textContent?.trim().length > 0, null, { timeout: 20_000 });
  await openSettings(page);
  evidence.location.fixtureUsed = true;
  evidence.location.fixtureLabel = 'temporary Cairo fixture, isolated profile only';
  return location;
}

async function firstRun(page) {
  await openSettings(page);
  await mkdir(artifactDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  evidence.location = { fixtureUsed: false, supported: false, outcome: 'unknown', geolocation: [] };

  const probeInstalled = await installLocationProbe(page);
  evidence.location.supported = probeInstalled;
  let locationButton = page.locator('.loc-foot button');
  await locationButton.waitFor({ state: 'visible' });
  await locationButton.click();
  try {
    await page.waitForFunction(() => {
      const button = document.querySelector('.loc-foot button');
      return button && button.getAttribute('aria-busy') !== 'true';
    }, null, { timeout: 50_000 });
  } catch {
    evidence.location.requestTimedOut = true;
  }
  await page.waitForTimeout(250);
  evidence.location.geolocation = await locationProbeRecords(page);
  let config = await readJson(page, 'tarteel.prayer.settings');
  if (config?.location?.source !== 'device') {
    try {
      config = await waitUntil(() => readJson(page, 'tarteel.prayer.settings'), value => value?.location?.source === 'device', 'the real Windows location result to reach the debounced settings store', 8_000);
    } catch {}
  }
  const location = config?.location;
  const realLocation = location?.source === 'device'
    && Number.isFinite(Number(location.latitude))
    && Number.isFinite(Number(location.longitude))
    && Boolean(location.timeZone);
  if (realLocation) {
    evidence.location.outcome = 'device-service-returned-a-location';
    evidence.location.timeZone = location.timeZone;
    evidence.location.accuracy = Number.isFinite(location.accuracy) ? location.accuracy : null;
    evidence.location.hasArabicPlace = Boolean((await page.locator('.loc-name').innerText()).trim());
    if (await page.locator('#ps-sound').isChecked()) await page.locator('#ps-sound').uncheck();
  } else {
    const failure = evidence.location.geolocation.find(item => item.kind === 'error');
    evidence.location.outcome = failure ? `device-service-error-${failure.code ?? 'unknown'}` : evidence.location.requestTimedOut ? 'device-service-timeout' : 'no-device-fix';
    evidence.location.errorCode = failure?.code ?? null;
    evidence.location.errorMessage = failure?.message || '';
    await seedTemporaryLocation(page);
    config = await readJson(page, 'tarteel.prayer.settings');
  }

  await page.locator('#ps-title').waitFor({ state: 'visible' });
  await page.waitForTimeout(700);
  config = await readJson(page, 'tarteel.prayer.settings');
  check(Boolean(config?.location), 'a location record is present for settings persistence tests');
  evidence.location.source = config.location.source;
  evidence.location.timeZone = config.location.timeZone || null;
  evidence.location.accuracy = Number.isFinite(config.location.accuracy) ? config.location.accuracy : null;
  evidence.location.verified = realLocation;
  evidence.location.fixtureUsed = config.location.source === 'test-fixture';
  evidence.location.unverifiedReason = evidence.location.fixtureUsed
    ? `Windows geolocation was not verified: ${evidence.location.outcome}`
    : null;
  evidence.location.locationHash = createHash('sha256').update(JSON.stringify(config.location)).digest('hex');
  evidence.location.hasArabicPlace = Boolean((await page.locator('.loc-name').innerText()).trim());

  const chips = await page.locator('#pane-prayer .loc .chip').allTextContents();
  check(chips.some(text => text.includes(config.location.timeZone)), 'the prayer page renders the stored IANA time zone');
  if (Number.isFinite(config.location.accuracy)) check(chips.some(text => text.includes('دقة')), 'the prayer page renders the real or test-profile accuracy');
  await page.screenshot({ path: join(artifactDir, 'settings-prayer-first-run.png'), fullPage: false });

  const schedule = await waitUntil(() => readJson(page, 'tarteel.prayer.schedule'), value => Array.isArray(value?.value?.events) && value.value.events.length > 0, 'the real prayer schedule generated from the active location', 15_000);
  const preAlarmMinutes = chooseSafePreAlarm(schedule.value);
  await page.locator('#ps-method').selectOption('egyptian');
  await page.locator('#ps-school').selectOption('2');
  await page.locator('#ps-pre').selectOption(String(preAlarmMinutes));
  evidence.prayer = { methodId: 'egyptian', school: 2, preAlarmMinutes };
  const applied = (await page.locator('#pane-prayer .applied').innerText()).trim();
  check(Boolean(applied) && !applied.includes('—'), 'the applied calculation method and Asr school are derived from real schedule logic');

  const notify = page.locator('#ps-notify');
  await page.waitForTimeout(500);
  const permissionBefore = await notify.getAttribute('aria-pressed') === 'true';
  if (!permissionBefore) {
    await notify.click();
    await page.waitForTimeout(1_500);
  }
  const browserPermission = await page.evaluate(() => window.Notification?.permission || 'unsupported');
  const nativePermission = await invoke(page, 'plugin:notification|is_permission_granted').catch(() => null);
  const permissionAfter = await notify.getAttribute('aria-pressed') === 'true';
  const permissionFromSystem = browserPermission === 'default' || browserPermission === 'unsupported'
    ? nativePermission
    : browserPermission === 'granted';
  evidence.notifications = {
    permissionBefore,
    permissionAfter,
    browserPermission,
    nativePermission,
    outcome: await notify.innerText(),
  };
  if (typeof permissionFromSystem === 'boolean') check(permissionAfter === permissionFromSystem, 'the notification control reflects the actual WebView/Windows permission response');

  const sound = page.locator('#ps-sound');
  if (await sound.isChecked()) await sound.uncheck();
  await sound.check();
  await sound.uncheck();
  await setRangeThroughKeyboard(page, '#ps-volume', 37);
  await page.locator('#ps-mute').check();
  evidence.adhan = { enabled: false, volume: 37, muted: true };

  await switchTab(page, 'settings-tab-audio', 'settings-audio-first-run.png');
  const radios = page.locator('#pane-audio input[name="rec"]');
  assert.equal(await radios.count(), 3, 'the audio tab exposes all three real audio modes');
  await radios.nth(1).check();
  check((await readJson(page, 'tarteel.audio.settings'))?.spatialMode === 'spatial', 'spatial mode is persisted by its existing handler');
  await radios.nth(2).check();
  check((await readJson(page, 'tarteel.audio.settings'))?.spatialMode === 'mosque', 'mosque mode is persisted by its existing handler');
  await radios.nth(0).check();
  check((await readJson(page, 'tarteel.audio.settings'))?.spatialMode === 'natural', 'natural mode is persisted by its existing handler');
  await page.locator('#ps-autostart').check();
  await waitUntil(() => invoke(page, 'is_autostart_enabled'), value => value === true, 'Windows autostart registration', 10_000);
  evidence.autostart = true;

  await switchTab(page, 'settings-tab-island', 'settings-dynamic-first-run.png');
  await waitUntil(() => page.locator('#pane-island .card[aria-busy="false"]').count(), count => count >= 2, 'Dynamic native services to finish loading', 10_000);
  const placementButtons = page.locator('#pane-island .card-seg[aria-label="وضع الموضع"] button[role="radio"]');
  const initialPlacement = await readPlacement(page);
  assert.equal(initialPlacement.mode, 'auto', 'isolated profile begins with the default Auto placement');
  await placementButtons.nth(1).click();
  await waitUntil(() => readPlacement(page), value => value.mode === 'manual', 'manual placement mode to reach Rust IPC', 10_000);
  const steps = [
    ['up', 'تحريك لأعلى', 'offsetY', -2],
    ['right', 'تحريك لليمين', 'offsetX', 2],
    ['down', 'تحريك لأسفل', 'offsetY', 2],
    ['left', 'تحريك لليسار', 'offsetX', -2],
  ];
  let current = await readPlacement(page);
  for (const [, label, field, delta] of steps) {
    const before = Number(current[field]);
    await page.getByRole('button', { name: label, exact: true }).click();
    current = await waitUntil(() => readPlacement(page), value => Math.abs(Number(value[field]) - (before + delta)) < 0.001, `${label} nudge to update the native position`, 10_000);
    check(Math.abs(Number(current[field]) - (before + delta)) < 0.001, `${label} nudge changes the real Dynamic offset by two logical pixels`);
  }
  await placementButtons.nth(0).click();
  await waitUntil(() => readPlacement(page), value => value.mode === 'auto', 'Auto mode to reach Rust IPC', 10_000);
  await placementButtons.nth(1).click();
  current = await waitUntil(() => readPlacement(page), value => value.mode === 'manual', 'Manual mode to be restored before restart', 10_000);
  evidence.placement = { mode: current.mode, offsetX: current.offsetX, offsetY: current.offsetY };

  const appearanceButtons = page.locator('#pane-island .card-seg[aria-label="مادة الجزيرة"] button[role="radio"]');
  await appearanceButtons.nth(1).click();
  await waitUntil(() => invoke(page, 'get_island_appearance'), value => value === 'black', 'Solid Black appearance to reach Rust IPC', 10_000);
  await appearanceButtons.nth(0).click();
  await waitUntil(() => invoke(page, 'get_island_appearance'), value => value === 'glass', 'Glass appearance to reach Rust IPC', 10_000);
  await appearanceButtons.nth(1).click();
  await waitUntil(() => invoke(page, 'get_island_appearance'), value => value === 'black', 'Solid Black appearance to be restored before restart', 10_000);
  evidence.appearance = 'black';

  const expectedConfig = { methodId: 'egyptian', school: 2, preAlarmMinutes, adhanSound: false, adhanVolume: 37, adhanMuted: true };
  config = await waitForSavedConfig(page, expectedConfig);
  const audioPrefs = await waitUntil(() => readJson(page, 'tarteel.audio.settings'), value => value?.spatialMode === 'natural', 'the final audio-mode value to persist', 10_000);
  const nativePreferences = await waitForNativePreferences({ enabled: false, volume: 37, muted: true });
  const placementFile = await readNativeJson(join(appConfigDir, 'island-position.json'));
  const appearanceFile = await readNativeJson(join(appConfigDir, 'island-appearance.json'));
  check(nativePreferences.enabled === false && nativePreferences.volume === 37 && nativePreferences.muted === true, 'native adhan preferences match the real controls');
  check(placementFile?.mode === 'manual' && Number(placementFile.offsetX) === Number(current.offsetX) && Number(placementFile.offsetY) === Number(current.offsetY), 'Dynamic placement is persisted to the app config directory');
  check(appearanceFile === 'black', 'Dynamic appearance is persisted to the app config directory');

  const expected = {
    locationHash: evidence.location.locationHash,
    locationSource: config.location.source,
    locationVerification: {
      verified: evidence.location.verified,
      fixtureUsed: evidence.location.fixtureUsed,
      outcome: evidence.location.outcome,
      errorCode: evidence.location.errorCode ?? null,
      errorMessage: evidence.location.errorMessage || '',
      unverifiedReason: evidence.location.unverifiedReason,
    },
    locationTimeZone: config.location.timeZone,
    locationAccuracy: Number.isFinite(config.location.accuracy) ? config.location.accuracy : null,
    methodId: config.methodId,
    school: config.school,
    preAlarmMinutes: config.preAlarmMinutes,
    adhanSound: config.adhanSound,
    adhanVolume: config.adhanVolume,
    adhanMuted: config.adhanMuted,
    notificationsAllowed: evidence.notifications.permissionAfter,
    spatialMode: audioPrefs.spatialMode,
    autostart: true,
    placement: evidence.placement,
    appearance: evidence.appearance,
  };
  await writeFile(expectedPath, JSON.stringify(expected, null, 2), 'utf8');
  evidence.persistedBeforeRestart = { ...expected, locationHash: expected.locationHash.slice(0, 12) };

  await page.getByRole('button', { name: 'رجوع إلى المكتبة', exact: true }).click();
  await page.locator('.settings-page').waitFor({ state: 'detached' });
  check(await page.locator('button[aria-label="إعدادات الصلاة والموقع"]').isVisible(), 'Back returns to the existing library route');
  await openSettings(page);
  await page.screenshot({ path: join(artifactDir, 'settings-back-navigation.png'), fullPage: false });

  check(pageErrors.length === 0, 'the real settings page has no uncaught JavaScript errors', pageErrors);
  evidence.status = evidence.location?.verified ? 'passed' : 'passed-with-location-unverified';
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(artifactDir, `first-run-${Date.now()}.json`), JSON.stringify(evidence, null, 2), 'utf8');
}

async function verifyAfterRestart(page) {
  await mkdir(artifactDir, { recursive: true });
  const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
  evidence.location = expected.locationVerification;
  if (!evidence.location?.verified) console.warn(`LIVE LOCATION UNVERIFIED: ${evidence.location?.unverifiedReason || 'No Windows location result was recorded.'}`);
  await openSettings(page);
  check(await page.locator('#settings-tab-prayer').getAttribute('aria-selected') === 'true', 'the prayer tab is selected after a fresh app relaunch');
  const config = await readJson(page, 'tarteel.prayer.settings');
  check(createHash('sha256').update(JSON.stringify(config.location)).digest('hex') === expected.locationHash, 'the same location data survives app relaunch');
  check(config.methodId === expected.methodId && config.school === expected.school, 'calculation method and Asr school survive app relaunch');
  check(config.preAlarmMinutes === expected.preAlarmMinutes, 'pre-alarm selection survives app relaunch');
  check(config.adhanSound === expected.adhanSound && config.adhanVolume === expected.adhanVolume && config.adhanMuted === expected.adhanMuted, 'sound, volume, and mute values survive app relaunch');
  check(await page.locator('#ps-method').inputValue() === expected.methodId, 'the method select renders the stored value after relaunch');
  check(await page.locator('#ps-school').inputValue() === String(expected.school), 'the Asr school select renders the stored value after relaunch');
  check(await page.locator('#ps-pre').inputValue() === String(expected.preAlarmMinutes), 'the pre-alarm select renders the stored value after relaunch');
  check(await page.locator('#ps-sound').isChecked() === expected.adhanSound, 'the adhan sound switch renders the stored value after relaunch');
  check(Number(await page.locator('#ps-volume').inputValue()) === expected.adhanVolume, 'the adhan volume slider renders the stored value after relaunch');
  check(await page.locator('#ps-mute').isChecked() === expected.adhanMuted, 'the temporary mute switch renders the stored value after relaunch');
  const locationChips = await page.locator('#pane-prayer .loc .chip').allTextContents();
  check(locationChips.some(text => text.includes(expected.locationTimeZone)), 'the IANA time zone is visible after relaunch');
  if (Number.isFinite(expected.locationAccuracy)) check(locationChips.some(text => text.includes('دقة')), 'the location accuracy is visible after relaunch');
  await page.screenshot({ path: join(artifactDir, 'settings-prayer-after-restart.png'), fullPage: false });
  const referencePage = await createReferencePage(page);
  await compareReferenceVisual(page, referencePage, 'pane-prayer', 'settings-prayer-after-restart.png');

  const notificationState = await page.locator('#ps-notify').getAttribute('aria-pressed') === 'true';
  const browserPermission = await page.evaluate(() => window.Notification?.permission || 'unsupported');
  const nativePermission = await invoke(page, 'plugin:notification|is_permission_granted').catch(() => null);
  const permissionFromSystem = browserPermission === 'default' || browserPermission === 'unsupported'
    ? nativePermission
    : browserPermission === 'granted';
  check(notificationState === expected.notificationsAllowed, 'notification permission state is read again from Windows after relaunch');
  if (typeof permissionFromSystem === 'boolean') check(notificationState === permissionFromSystem, 'notification permission remains consistent with the Windows/WebView permission service');
  const nativePreferences = await waitForNativePreferences({ enabled: expected.adhanSound, volume: expected.adhanVolume, muted: expected.adhanMuted });
  check(nativePreferences.enabled === expected.adhanSound && nativePreferences.volume === expected.adhanVolume && nativePreferences.muted === expected.adhanMuted, 'native adhan preference file survives app relaunch');

  await switchTab(page, 'settings-tab-audio', 'settings-audio-after-restart.png');
  await compareReferenceVisual(page, referencePage, 'pane-audio', 'settings-audio-after-restart.png');
  const radios = page.locator('#pane-audio input[name="rec"]');
  check(await radios.count() === 3, 'all three actual recitation modes remain available after relaunch');
  check(await radios.nth(0).isChecked(), 'the selected natural recitation mode survives app relaunch');
  const autostart = page.locator('#ps-autostart');
  await waitUntil(() => autostart.isChecked(), value => value === true, 'the Windows autostart switch to re-read the real registry value', 10_000);
  check(await invoke(page, 'is_autostart_enabled') === true, 'Windows autostart registration is present after app relaunch');
  await autostart.uncheck();
  await waitUntil(() => invoke(page, 'is_autostart_enabled'), value => value === false, 'Windows autostart to be disabled through the real control', 10_000);
  check(await invoke(page, 'is_autostart_enabled') === false, 'the real autostart control removes its registration');

  await switchTab(page, 'settings-tab-island', 'settings-dynamic-after-restart.png');
  await compareReferenceVisual(page, referencePage, 'pane-island', 'settings-dynamic-after-restart.png');
  const expectedPlacement = await readNativeJson(join(appConfigDir, 'island-position.json'));
  const expectedAppearance = await readNativeJson(join(appConfigDir, 'island-appearance.json'));
  const actualPlacement = await readPlacement(page);
  check(actualPlacement.mode === expected.placement.mode && Number(actualPlacement.offsetX) === Number(expected.placement.offsetX) && Number(actualPlacement.offsetY) === Number(expected.placement.offsetY), 'Dynamic mode and offsets are restored in the UI through Rust after relaunch');
  check(expectedPlacement?.mode === expected.placement.mode && Number(expectedPlacement.offsetX) === Number(expected.placement.offsetX) && Number(expectedPlacement.offsetY) === Number(expected.placement.offsetY), 'Dynamic placement file survives app relaunch');
  check(await invoke(page, 'get_island_appearance') === expected.appearance && expectedAppearance === expected.appearance, 'Dynamic appearance is restored by Rust after relaunch');
  const manual = page.locator('#pane-island .card-seg[aria-label="وضع الموضع"] button[role="radio"]').nth(1);
  const black = page.locator('#pane-island .card-seg[aria-label="مادة الجزيرة"] button[role="radio"]').nth(1);
  check(await manual.getAttribute('aria-checked') === 'true', 'manual placement control reflects saved state after relaunch');
  check(await black.getAttribute('aria-checked') === 'true', 'solid black appearance control reflects saved state after relaunch');
  const xy = await page.locator('#pane-island .xy').allTextContents();
  check(xy.length === 2 && xy[0].includes('X') && xy[1].includes('Y'), 'the circular remote displays the real X/Y offsets after relaunch');

  await switchTab(page, 'settings-tab-prayer');
  await page.locator('#ps-sound').check();
  await page.locator('#ps-mute').uncheck();
  await waitForNativePreferences({ enabled: true, volume: expected.adhanVolume, muted: false });
  await invoke(page, 'set_alarm_schedule', { events: [] });

  await page.getByRole('button', { name: 'تجربة صوت الأذان', exact: true }).click();
  const islandPage = await connectIsland();
  await islandPage.waitForFunction(() => document.querySelector('#isl')?.dataset.state === 'alert', null, { timeout: 10_000 });
  check((await islandPage.locator('#alS').innerText()).includes('دون إشعار ويندوز'), 'the preview card states that it plays adhan audio only, without a Windows toast');
  const playingState = await waitUntil(() => invoke(page, 'adhan_state'), value => value?.playing === true, 'the native adhan engine to report active playback', 8_000);
  check(playingState.playing === true, 'the settings preview starts the native adhan engine');
  await islandPage.locator('#alD').click({ force: true });
  const stoppedState = await waitUntil(() => invoke(page, 'adhan_state'), value => value?.playing === false, 'the alert dismissal control to stop native adhan playback', 8_000);
  check(stoppedState.playing === false, 'the alert dismissal control stops native adhan playback through the real handler');
  await waitUntil(() => readJson(page, 'tarteel.adhan.alert'), value => value === null, 'the preview alert record to be cleared', 5_000);

  evidence.afterRestart = {
    locationSource: expected.locationSource,
    timeZone: expected.locationTimeZone,
    accuracy: expected.locationAccuracy,
    methodId: expected.methodId,
    school: expected.school,
    preAlarmMinutes: expected.preAlarmMinutes,
    adhan: { enabled: expected.adhanSound, volume: expected.adhanVolume, muted: expected.adhanMuted },
    notificationPermission: notificationState,
    autostartInitiallyEnabled: true,
    autostartDisabledAfterCheck: await invoke(page, 'is_autostart_enabled') === false,
    spatialMode: expected.spatialMode,
    placement: expected.placement,
    appearance: expected.appearance,
    adhanPreviewStarted: true,
    adhanStoppedFromAlert: true,
  };
  await invoke(page, 'set_alarm_schedule', { events: [] });
  await invoke(page, 'stop_adhan');
  await invoke(page, 'set_autostart', { enabled: false });
  check(pageErrors.length === 0, 'the relaunched settings page has no uncaught JavaScript errors', pageErrors);
  evidence.status = evidence.location?.verified ? 'passed' : 'passed-with-location-unverified';
  evidence.finishedAt = new Date().toISOString();
  await writeFile(resultPath, JSON.stringify(evidence, null, 2), 'utf8');
}

async function cleanupOnly(page) {
  const results = {};
  for (const [key, command, args] of [
    ['stopAdhan', 'stop_adhan', {}],
    ['clearAlarmSchedule', 'set_alarm_schedule', { events: [] }],
    ['disableAutostart', 'set_autostart', { enabled: false }],
  ]) {
    try { results[key] = await invoke(page, command, args); } catch (cause) { results[key] = `cleanup-error: ${String(cause).slice(0, 240)}`; }
  }
  const errors = Object.entries(results).filter(([, result]) => typeof result === 'string' && result.startsWith('cleanup-error:'));
  const finishedAt = new Date().toISOString();
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'cleanup.json'), JSON.stringify({ at: finishedAt, status: errors.length ? 'failed' : 'passed', results }, null, 2), 'utf8');
  if (errors.length) {
    try {
      const previous = JSON.parse(await readFile(resultPath, 'utf8'));
      previous.status = 'failed';
      previous.cleanupErrors = errors.map(([key, result]) => ({ key, result }));
      previous.finishedAt = finishedAt;
      await writeFile(resultPath, JSON.stringify(previous, null, 2), 'utf8');
    } catch { }
  }
  assert.equal(errors.length, 0, `Windows settings cleanup failed: ${JSON.stringify(errors)}`);
}

try {
  await mkdir(artifactDir, { recursive: true });
  if (phase === 'cleanup') {
    await connect();
    await cleanupOnly(mainPage);
  } else {
    await connect();
    if (phase === 'first') await firstRun(mainPage);
    else if (phase === 'verify') await verifyAfterRestart(mainPage);
    else throw new Error(`Unsupported phase '${phase}'.`);
  }
  console.log(JSON.stringify(evidence, null, 2));
} catch (cause) {
  evidence.status = 'failed';
  evidence.error = String(cause?.stack || cause).slice(0, 5000);
  evidence.finishedAt = new Date().toISOString();
  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, `failure-${phase}.json`), JSON.stringify(evidence, null, 2), 'utf8');
  } catch {}
  throw cause;
} finally {
  if (referenceBrowser) await referenceBrowser.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
