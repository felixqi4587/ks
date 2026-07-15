import stopLegacyKvkScript from './support/legacy-kvk-script-guard.cjs';

stopLegacyKvkScript(import.meta.filename);

const RM = "smoke" + Date.now();
const URL = "wss://kingshoter.kingshot1406.workers.dev/api/ws?k=test&room=" + RM;
const open = () => new Promise(res => { const ws = new WebSocket(URL); ws._m = []; ws.onmessage = e => ws._m.push(JSON.parse(e.data)); ws.onopen = () => res(ws); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const last = ws => ws._m[ws._m.length - 1];
let pass = 0, fail = 0;
const ok = (c, label) => { (c ? pass++ : fail++); console.log((c ? "✓" : "✗ FAIL") + " " + label); };
(async () => {
  const a = await open(), b = await open(); await wait(600);
  ok(last(a)?.t === "state", "initial snapshot on connect");
  a.send(JSON.stringify({ t: "setMarch", pid: "p1", name: "Alice", march: 90, alliance: "A", profileKey: "70000000-0000-4000-8000-000000000001" })); await wait(700);
  ok(last(b)?.room.players.p1?.name === "Alice", "setMarch broadcasts to OTHER client");
  ok(last(b)?.room.presence === 2, "presence = 2");
  a.send(JSON.stringify({ t: "setConfig", password: "pw123", config: { castleName: "KC", enemyWhales: [{ name: "W1", mm: 1, ss: 10 }] }, by: "cmd" })); await wait(700);
  ok(last(b)?.room.config.castleName === "KC" && last(b)?.room.config.enemyWhales.length === 1, "first-claim setConfig (sets password + config)");
  const upd = last(b)?.room.updatedAt;
  a.send(JSON.stringify({ t: "cmd", password: "WRONG", cmd: { type: "double_rally", anchorUTC: 9999999999 } })); await wait(500);
  ok(last(b)?.room.live.command === null, "cmd with WRONG password rejected (no command set)");
  const t = Math.floor(Date.now() / 1000) + 60;
  a.send(JSON.stringify({ t: "cmd", password: "pw123", cmd: { type: "double_rally", anchorUTC: t } })); await wait(700);
  ok(last(b)?.room.live.command?.type === "double_rally", "cmd with RIGHT password broadcasts");
  ok(last(b)?.room.live.command?.anchorUTC === t, "command carries absolute anchorUTC");
  a.send(JSON.stringify({ t: "setConfig", password: "pw123", config: { castleName: "X" }, baseUpdatedAt: "1999-01-01T00:00:00Z" })); await wait(600);
  ok(a._m.some(m => m.t === "error" && m.error === "conflict"), "stale baseUpdatedAt → conflict error (optimistic lock)");
  b.close(); await wait(600);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
