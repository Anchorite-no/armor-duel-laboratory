import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TracedLaboratory as Laboratory } from './support.js';
import { ScriptLibrary } from '../src/host/library.js';
import { createState, neutral, tick } from '../src/host/physics.js';
import { createRoomSetup, switchRoomSeat, validateRoomSetup } from '../src/client/room.js';
import { RoomPanel, type RoomPanelProps } from '../src/client/RoomPanel.js';
import { validateTuning } from '../src/shared/protocol.js';
import { finishPreparation } from './support.js';
import { replay } from '../src/host/replay.js';
const directory = () => path.resolve('.local/room-tests', randomUUID(), 'referee');
test('共享生命值与攻击力真正对双方生效，命中与记录使用所选数值', () => {
  const state = createState({ hp: 200, damage: 37 });
  state.robots.red.angle=0;state.robots.blue.angle=Math.PI;
  state.bullets = [
    { id: 1, owner: 'blue', x: state.robots.red.x - 80, y: state.robots.red.y + 8, vx: 50000, vy: 0 },
    { id: 2, owner: 'red', x: state.robots.blue.x + 80, y: state.robots.blue.y + 8, vx: -50000, vy: 0 },
  ];
  tick(state, { blue: neutral(state.robots.blue), red: neutral(state.robots.red) });
  assert.equal(state.robots.blue.hp, 163); assert.equal(state.robots.red.hp, 163);
  assert.ok(state.events.filter(e => e.type === 'hit').every(e => e.damage === 37));
  for (const tuning of [{ hp: 0, damage: 10 }, { hp: 1001, damage: 10 }, { hp: 100, damage: 101 }, { hp: 100, damage: NaN }]) assert.throws(() => validateTuning(tuning));
});
test('房间连接失败、脚本缺失或数值无效时，进入按钮不可用', async () => {
  const library = new ScriptLibrary(path.join(directory(), '../scripts.json')), scripts = await library.list();
  const base: RoomPanelProps = { setup: createRoomSetup(), scripts, playerSide: 'blue', connection: 'ready', connectionError: '', busy: false, change() {}, selectSide() {}, enter() {}, retry() {}, continueMatch() {} };
  for (const props of [{ ...base, connection: 'error' as const }, { ...base, scripts: [] }, { ...base, busy: true }, { ...base, setup: { ...base.setup, tuning: { hp: 0, damage: 10 } } }]) {
    const markup = renderToStaticMarkup(React.createElement(RoomPanel, props));
    assert.match(markup, /data-testid="enter-match" disabled/);
  }
  assert.ok(!renderToStaticMarkup(React.createElement(RoomPanel, base)).includes('data-testid="enter-match" disabled'));
  const eve = { ...base.setup, room: { seats: {blue:'builtin:computer',red:'builtin:computer'} } };
  const markup = renderToStaticMarkup(React.createElement(RoomPanel, { ...base, setup: eve }));
  assert.match(markup, /蓝方控制者/); assert.match(markup, /红方控制者/); assert.doesNotMatch(markup,/PVE|EVE|键盘已绑定/);
});
test('切换玩家席位保留脚本选择和统一配置，准备期间不启动宿主', () => {
  const setup = createRoomSetup(); setup.tuning = { hp: 240, damage: 23 }; setup.countdownMs = 5000;
  const next = switchRoomSeat(setup, 'blue', 'red');
  assert.equal(next.room?.seats.red,'keyboard');assert.equal(next.room?.seats.blue,'builtin:privileged');
  assert.deepEqual(next.tuning, { hp: 240, damage: 23 }); assert.equal(next.countdownMs, 5000); assert.equal(setup.room?.seats.red,'keyboard');
});
test('PVE 按房间选择玩家与脚本，错误配置不结束原对局', async () => {
  const lab = new Laboratory(directory());
  try {
    const setup = createRoomSetup(); setup.countdownMs = 0; setup.tuning = { hp: 250, damage: 31 }; setup.room!.seats={blue:'builtin:spinner',red:'keyboard'};
    await lab.admin('start', { setup });
    assert.deepEqual(lab.game.setup.controllers, { blue: 'privileged', red: 'human' });
    assert.deepEqual(lab.game.observe().rules, { hp: 250, damage: 31, power: 50 }); assert.equal(lab.game.observe().hud.blue.hp, 250); assert.equal(lab.game.observe().hud.red.hp, 250);
    const match = lab.game.matchId; const invalid = structuredClone(setup); invalid.room!.seats.blue='missing';
    assert.ok(validateRoomSetup(invalid, await lab.library.list()).length > 0);
    await assert.rejects(lab.admin('start', { setup: invalid }), /脚本不可用/);
    assert.equal(lab.game.matchId, match); assert.equal(lab.game.status, 'countdown');
    const record = lab.game.refereeRecord(); assert.equal(record.rules.hp, 250); assert.equal(record.rules.damage, 31); assert.equal(record.setup.scriptBindings?.[0].id, 'builtin:privileged');
  } finally { await lab.dispose(); }
});
test('命名脚本持久保存、校验语法，列表不输出源码，内置脚本不暴露实现', async () => {
  const dir = directory(), filename = path.join(dir, '../scripts.json');
  const lib = new ScriptLibrary(filename); const saved = await lib.save('命名试射', 'await lab.log("hello");');
  const reloaded = new ScriptLibrary(filename), listed = await reloaded.list();
  assert.ok(listed.some(s => s.id === saved.id && s.name === '命名试射'));
  assert.ok(listed.every(s => !('code' in s))); assert.equal((await reloaded.get(saved.id)).code, 'await lab.log("hello");');
  await assert.rejects(lib.save('错误脚本', 'await (;;;'), /语法错误/);
  await assert.rejects(lib.save('命名试射', '0'), /名称已存在/);
  const lab = new Laboratory(dir); await assert.rejects(lab.admin('scriptSource', { id: 'builtin:computer' }), /不提供/); await lab.dispose();
});
test('EVE 两个命名自定义脚本只在开局后运行，双方实际提交动作，停止后清理', async () => {
  const lab = new Laboratory(directory());
  const script = `await lab.log('executed:' + lab.side); await lab.act({moveX:0.2,moveY:0,spin:0,aimX:0.5,aimY:0.5,durationMs:500}); await lab.sleep(5000);`;
  try {
    const blue = await lab.library.save('蓝方脚本', script), red = await lab.library.save('红方脚本', script);
    assert.equal(lab.game.status, 'ready'); assert.equal(lab.programs.blue.info().status, 'idle'); assert.equal(lab.programs.red.info().status, 'idle');
    const setup = createRoomSetup(); setup.room!.seats = { blue: blue.id, red: red.id }; setup.tuning = { hp: 300, damage: 19 };
    await lab.admin('start', { setup }); assert.equal(lab.game.status, 'countdown'); assert.equal(lab.programs.blue.info().status,'running');assert.equal(lab.programs.red.info().status,'running');
    lab.startClock(); lab.pump();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && new Set(lab.game.refereeRecord().actions.filter(a => a.action && a.source === 'script').map(a => a.side)).size < 2) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(new Set(lab.game.refereeRecord().actions.filter(a => a.action && a.source === 'script').map(a => a.side)), new Set(['blue', 'red']));
    assert.match(lab.programs.blue.info().output, /executed:blue/); assert.match(lab.programs.red.info().output, /executed:red/);
    await lab.admin('stop', null); assert.equal(lab.programs.blue.info().status, 'stopped'); assert.equal(lab.programs.red.info().status, 'stopped');
    const record = lab.game.refereeRecord(); assert.deepEqual(record.setup.scriptBindings?.map(s => s.name), ['蓝方脚本', '红方脚本']);
    assert.ok(record.setup.scriptBindings?.every(s => s.hash.length === 64)); assert.equal(replay(record).identical, true);
  } finally { await lab.dispose(); }
});
test('内置 EVE 双方实际开火，不能用键鼠替换任一脚本控制', async () => {
  const lab = new Laboratory(directory());
  try {
    const setup = createRoomSetup(); setup.room!.seats={blue:'builtin:computer',red:'builtin:computer'}; setup.countdownMs = 0;
    await lab.admin('start', { setup }); finishPreparation(lab.game);lab.game.advance(240);
    assert.ok(lab.game.observe().hud.blue.shots > 0); assert.ok(lab.game.observe().hud.red.shots > 0);
    await assert.rejects(lab.admin('input', { matchId:lab.game.matchId,side: 'blue', action: { ...neutral(), durationMs: 100 } }), /本机键鼠席位/);
    await assert.rejects(lab.participant('scriptSource', { id: 'builtin:computer' }, 'script'));
  } finally { await lab.dispose(); }
});
