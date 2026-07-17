const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { makeQaRoom, qaRoomUrl, localQaBaseURL } = require('./support/qa-coordination.cjs');

const base = localQaBaseURL(process.env.BASE || 'http://127.0.0.1:8791');
const room = makeQaRoom('audio-carrier-longrun');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const profiles = [
  {
    pid: '920000001', playerId: '920000001', name: 'Carrier A', march: 40,
    marchRevision: 0, identityMode: 'playerId', editable: true,
    profileKey: '92000000-0000-4000-8000-000000000001',
    deviceId: '92000000-0000-4000-8000-000000000011'
  },
  {
    pid: '920000002', playerId: '920000002', name: 'Carrier B', march: 50,
    marchRevision: 0, identityMode: 'playerId', editable: true,
    profileKey: '92000000-0000-4000-8000-000000000002',
    deviceId: '92000000-0000-4000-8000-000000000012'
  }
];

async function seed(browser) {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  try {
    await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ roomName, records }) => new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      const timer = setTimeout(() => reject(new Error('seed timeout')), 8_000);
      socket.onopen = () => records.forEach(record => socket.send(JSON.stringify({
        t: 'registerPlayer', pid: record.pid, playerId: record.playerId, name: record.name,
        march: record.march, identityMode: record.identityMode, profileKey: record.profileKey, alliance: ''
      })));
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (message.t !== 'state' || !records.every(record => message.room.players[record.pid])) return;
        clearTimeout(timer); socket.close(); resolve();
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('seed socket failed')); };
    }), { roomName: room, records: profiles });
  } finally {
    await context.close();
  }
}

async function openPlayer(browser, profile) {
  const context = await browser.newContext({ locale: 'en-US' });
  await context.addInitScript(({ roomName, record }) => {
    localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(record));
    localStorage.setItem(`kvk:${roomName}:delivery-device:v1`, record.deviceId);
    window.__probe = { frames: [], carrierEvents: [], sockets: [] };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__probe.sockets.push(this);
        this.addEventListener('message', event => {
          let message = null;
          try { message = JSON.parse(String(event.data)); } catch (_) {}
          if (message && message.t === 'deviceStatusSaved') {
            window.__probe.frames.push({ atMs: Date.now(), direction: 'server', message });
          }
        });
      }
      send(data) {
        let message = null;
        try { message = JSON.parse(String(data)); } catch (_) {}
        if (message && message.t === 'deviceStatus') {
          window.__probe.frames.push({ atMs: Date.now(), direction: 'client', message });
        }
        return super.send(data);
      }
    };
    const NativeAudio = window.Audio;
    window.Audio = function (...args) {
      const media = new NativeAudio(...args);
      window.__probe.carrier = media;
      ['playing', 'pause', 'waiting', 'stalled', 'error', 'ended'].forEach(type =>
        media.addEventListener(type, () => window.__probe.carrierEvents.push({
          atMs: Date.now(), type, paused: media.paused, ended: media.ended,
          readyState: media.readyState, error: media.error && media.error.code
        })));
      return media;
    };
    window.Audio.prototype = NativeAudio.prototype;
    Object.setPrototypeOf(window.Audio, NativeAudio);
  }, { roomName: room, record: profile });
  const page = await context.newPage();
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
  await page.locator('#youChip').waitFor({ state: 'visible', timeout: 8_000 });
  await page.locator('#soundGate').click({ force: true });
  try {
    await page.waitForFunction(() => window.__probe.frames.some(frame =>
      frame.direction === 'server' && frame.message.soundReady === true), null, { timeout: 8_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      acState: window.__ac && window.__ac.state,
      keepAlive: window.__keepAlive,
      statusText: document.querySelector('#audioStatus')?.textContent || '',
      soundGateHidden: document.querySelector('#soundGate')?.hidden,
      socketStates: window.__probe.sockets.map(socket => socket.readyState),
      carrierEvents: window.__probe.carrierEvents,
      frames: window.__probe.frames
    }));
    error.message += `\ncarrier readiness diagnostic: ${JSON.stringify(diagnostic)}`;
    error.stack += `\ncarrier readiness diagnostic: ${JSON.stringify(diagnostic)}`;
    throw error;
  }
  return { context, page, profile };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const players = [];
  try {
    await seed(browser);
    players.push(await openPlayer(browser, profiles[0]));
    players.push(await openPlayer(browser, profiles[1]));
    await delay(15_000);
    const diagnostics = await Promise.all(players.map(({ page, profile }) => page.evaluate(record => {
      const carrier = window.__probe.carrier;
      const firstGreenAt = window.__probe.frames.find(frame =>
        frame.direction === 'server' && frame.message.soundReady === true)?.atMs || Infinity;
      return {
        pid: record.pid,
        acState: window.__ac && window.__ac.state,
        keepAlive: window.__keepAlive,
        visibilityState: document.visibilityState,
        carrier: carrier && {
          paused: carrier.paused, ended: carrier.ended,
          error: carrier.error && carrier.error.code,
          readyState: carrier.readyState
        },
        socketStates: window.__probe.sockets.map(socket => socket.readyState),
        carrierEvents: window.__probe.carrierEvents,
        frames: window.__probe.frames,
        redAfterGreen: window.__probe.frames.filter(frame =>
          frame.atMs > firstGreenAt && frame.direction === 'server' && frame.message.soundReady === false)
      };
    }, profile)));

    for (const diagnostic of diagnostics) {
      assert.equal(diagnostic.acState, 'running');
      assert.equal(diagnostic.visibilityState, 'visible');
      assert.deepEqual(diagnostic.carrier && {
        paused: diagnostic.carrier.paused,
        ended: diagnostic.carrier.ended,
        error: diagnostic.carrier.error
      }, { paused: false, ended: false, error: null });
      assert.deepEqual(diagnostic.socketStates, [1]);
      assert.equal(diagnostic.redAfterGreen.length, 0,
        `a healthy uninterrupted carrier must not flap red: ${JSON.stringify(diagnostic)}`);
    }
    console.log(`PASS two-page carrier long-run room ${room}`);
  } finally {
    for (const player of players) await player.context.close().catch(() => {});
    await browser.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
