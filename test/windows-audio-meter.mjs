import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2] || 9222);
const mode = process.argv[3] || 'playing';
const expectedFile = process.argv[4] || '';
const endpoint = `http://127.0.0.1:${port}`;

async function getIslandTarget() {
  const deadline = Date.now() + 12_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (!response.ok) throw new Error(`DevTools target list returned HTTP ${response.status}`);
      const targets = await response.json();
      const target = targets.find(item => item.type === 'page' && /island\.html(?:$|[?#])/i.test(item.url));
      if (target?.webSocketDebuggerUrl) return target;
      lastError = `island.html target not listed; found ${targets.map(item => item.url).join(', ')}`;
    } catch (cause) {
      const nested = cause?.cause;
      lastError = `${String(cause)}${nested ? ` (${nested.code || ''} ${nested.message || nested})` : ''}`;
    }
    await delay(200);
  }
  throw new Error(`Timed out connecting to WebView2 DevTools on ${endpoint}: ${lastError}`);
}

function createClient(url) {
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  const runtimeErrors = [];
  const consoleErrors = [];
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails?.text || 'Runtime exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args?.map(arg => arg.value ?? arg.description ?? '').join(' '));
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed')), { once: true });
  });
  const send = async (method, params = {}) => {
    await opened;
    const id = ++sequence;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    return response;
  };
  return { socket, send, runtimeErrors, consoleErrors };
}

const target = await getIslandTarget();
const client = createClient(target.webSocketDebuggerUrl);
try {
  await client.send('Runtime.enable');
  await client.send('Performance.enable');
  const expression = `(() => {
    const island = document.querySelector('#isl');
    const bars = [...document.querySelectorAll('.full .wave i')];
    const empty = document.querySelector('#musicEmpty');
    return {
      state: island?.dataset.state || '',
      viewState: island?.dataset.viewState || '',
      audioState: island?.dataset.audioState || '',
      waveform: island?.dataset.waveform || '',
      fileName: document.querySelector('#ttl')?.textContent || '',
      levels: bars.map(bar => Number.parseFloat(bar.style.getPropertyValue('--level')) || 0),
      emptyDisplay: empty ? getComputedStyle(empty).display : 'missing'
    };
  })()`;
  const snapshot = async () => {
    const response = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Unable to read island state');
    return response.result?.value;
  };
  const performanceMetrics = async () => {
    const result = await client.send('Performance.getMetrics').catch(() => null);
    return Object.fromEntries((result?.metrics || []).map(item => [item.name, item.value]));
  };

  const startMetrics = await performanceMetrics();
  const observations = [];
  const wallStarted = Date.now();
  let cancellations = null;
  if (mode === 'cancel') {
    const cancellationExpression = `(() => {
      const island = document.querySelector('#isl');
      const before = island?.dataset.state || '';
      const checks = [];
      const run = (type, pointerId) => {
        island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true, pointerId, clientX: 10, clientY: 10 }));
        const pressed = island.classList.contains('press');
        if (type === 'blur') window.dispatchEvent(new Event('blur'));
        else island.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId }));
        checks.push({ type, pressed, cleared: !island.classList.contains('press') });
      };
      run('pointercancel', 7201);
      run('lostpointercapture', 7202);
      run('blur', 7203);
      return { stateBefore: before, stateAfter: island?.dataset.state || '', checks };
    })()`;
    const response = await client.send('Runtime.evaluate', { expression: cancellationExpression, returnByValue: true });
    cancellations = response.result?.value;
    if (response.exceptionDetails || !cancellations || cancellations.stateBefore !== cancellations.stateAfter || cancellations.checks.length !== 3 || cancellations.checks.some(item => !item.pressed || !item.cleared)) {
      throw new Error(`Interrupted pointer gestures did not cancel cleanly: ${JSON.stringify(cancellations || response.exceptionDetails)}`);
    }
  } else {
    const deadline = Date.now() + (mode === 'playing' ? 5_000 : 8_000);
    while (Date.now() < deadline) {
      const value = await snapshot();
      observations.push(value);
      const fileMatches = !expectedFile || value.fileName.includes(expectedFile);
      const ready = mode === 'playing'
        ? value.audioState === 'playing' && fileMatches && value.waveform === 'live'
        : mode === 'silence'
          ? value.audioState === 'playing' && fileMatches && value.waveform === 'silence'
        : mode === 'paused'
          ? value.audioState === 'paused' && value.waveform === 'paused'
          : mode === 'no-track'
            ? value.audioState === 'no-track' && value.viewState === 'expanded' && value.emptyDisplay !== 'none'
            : false;
      const requiredFrames = mode === 'playing' ? 10 : mode === 'silence' ? 10 : 1;
      const matchingFrames = observations.filter(item => mode === 'playing' ? item.waveform === 'live' : mode === 'silence' ? item.waveform === 'silence' : true).length;
      if (ready && matchingFrames >= requiredFrames) break;
      await delay(100);
    }
  }

  const last = observations.at(-1) || {};
  if (mode === 'playing') {
    const live = observations.filter(value => value.audioState === 'playing' && value.waveform === 'live' && (!expectedFile || value.fileName.includes(expectedFile)));
    const distinctPerBar = (last.levels || []).map((_, index) => new Set(live.map(value => Number(value.levels[index] || 0).toFixed(3))).size);
    const changes = distinctPerBar.some(count => count > 1);
    const visible = (last.levels || []).some(level => level > 0.10);
    if (live.length < 5 || !visible || !changes) {
      throw new Error(`Real playback levels did not animate: mode=${mode}, file=${last.fileName}, audioState=${last.audioState}, waveform=${last.waveform}, liveFrames=${live.length}, levels=${JSON.stringify(last.levels)}, distinctPerBar=${JSON.stringify(distinctPerBar)}`);
    }
  } else if (mode === 'paused') {
    if (last.audioState !== 'paused' || last.waveform !== 'paused' || last.levels.length !== 5 || last.levels.some(level => Math.abs(level - 0.07) > 0.005)) {
      throw new Error(`Pause did not settle the five bars: ${JSON.stringify(last)}`);
    }
  } else if (mode === 'silence') {
    const silent = observations.filter(value => value.audioState === 'playing' && value.waveform === 'silence' && (!expectedFile || value.fileName.includes(expectedFile)));
    if (silent.length < 3 || last.levels.length !== 5 || last.levels.some(level => Math.abs(level - 0.07) > 0.005)) {
      throw new Error(`Digital silence did not settle all five bars without invented motion: ${JSON.stringify({ last, silentFrames: silent.length })}`);
    }
  } else if (mode === 'no-track') {
    if (last.audioState !== 'no-track' || last.viewState !== 'expanded' || last.emptyDisplay === 'none') {
      throw new Error(`Removing the last track did not restore the expanded empty state: ${JSON.stringify(last)}`);
    }
  } else if (mode !== 'cancel') {
    throw new Error(`Unsupported assertion mode: ${mode}`);
  }

  const endMetrics = await performanceMetrics();
  const wallSeconds = Math.max(0.001, (Date.now() - wallStarted) / 1000);
  const taskSeconds = Number(endMetrics.TaskDuration) - Number(startMetrics.TaskDuration);
  const cpuPercent = Number.isFinite(taskSeconds) && wallSeconds >= 0.5 ? Math.max(0, taskSeconds / wallSeconds * 100) : null;
  if (['playing', 'silence'].includes(mode) && cpuPercent !== null && cpuPercent > 25) {
    throw new Error(`Renderer task CPU approximation exceeded the 25% budget during sustained ${mode} measurement: ${cpuPercent.toFixed(2)}% over ${wallSeconds.toFixed(2)}s`);
  }
  if (client.runtimeErrors.length || client.consoleErrors.length) {
    throw new Error(`WebView reported runtime errors: ${JSON.stringify({ runtime: client.runtimeErrors, console: client.consoleErrors })}`);
  }
  console.log(JSON.stringify({
    targetUrl: target.url,
    mode,
    expectedFile,
    observations: observations.length,
    liveFrames: observations.filter(value => value.waveform === 'live').length,
    final: last,
    cancellations,
    distinctPerBar: mode === 'playing' ? last.levels.map((_, index) => new Set(observations.map(value => Number(value.levels[index] || 0).toFixed(3))).size) : undefined,
    rendererTaskCpuPercentApprox: cpuPercent,
    runtimeErrors: client.runtimeErrors.length,
    consoleErrors: client.consoleErrors.length
  }, null, 2));
} finally {
  client.socket.close();
}
