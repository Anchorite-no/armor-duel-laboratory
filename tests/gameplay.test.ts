import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { colors } from '../src/shared/scene.js';
import { render, renderPixels } from '../src/host/render.js';
import { createState, velocity } from '../src/host/physics.js';
import { TracedGame as Game } from './support.js';
import { replay } from '../src/host/replay.js';
import { computerAction } from '../src/host/opponent.js';
import { validateAction, RULES } from '../src/shared/protocol.js';
import { playSetup } from '../src/client/types.js';
import { traditionalSnapshot,stationaryMotion } from '../src/host/traditional-state.js';
import { pointerAim } from '../src/client/controls.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LaboratoryPage } from '../src/client/GamePage.js';
test('首次进入是房间准备，不展示战场或提前发起开局', () => {
  const markup = renderToStaticMarkup(React.createElement(LaboratoryPage, { api: async () => undefined }));
  assert.match(markup, /class="room-layout"/);assert.doesNotMatch(markup,/研究与复盘|LOCAL ROOM|LABORATORY|本地对局|game-fps|管理脚本/); assert.doesNotMatch(markup,/PVE|EVE|键盘已绑定/); assert.match(markup,/键盘输入/);
  assert.ok(!markup.includes('class="game-stage')); assert.ok(!markup.includes('<textarea')); assert.ok(!markup.includes('lab_observe')); assert.match(markup, /data-testid="enter-match" disabled/);
});
test('底层对战预设默认玩家对基础电脑，训练控制器保持独立', () => {
  const s = playSetup(); assert.equal(s.scenario, 'duel'); assert.equal(s.clock, 'realtime'); assert.equal(s.countdownMs, 5000);
  assert.deepEqual(s.controllers, { red: 'human', blue: 'computer' });
  assert.equal(playSetup('spinner').controllers.blue, 'spinner'); assert.equal(playSetup('shooter').controllers.blue, 'fixed');
});
test('鼠标瞄准随场地缩放准确映射，排除顶部 HUD 和容器外边框', () => {
  for (const scale of [0.4, 0.75, 1, 1.5]) {
    const b = { left: 173, top: 97, width: 960 * scale, height: 680 * scale };
    assert.deepEqual(pointerAim(b.left + 480 * scale, b.top + 380 * scale, b), { x: 0.5, y: 0.5 });
    assert.deepEqual(pointerAim(b.left, b.top + 80 * scale, b), { x: 0, y: 0 });
    assert.deepEqual(pointerAim(b.left + b.width, b.top + b.height, b), { x: 1, y: 1 });
  }
  assert.deepEqual(pointerAim(-100, -100, { left: 0, top: 0, width: 960, height: 680 }), { x: 0, y: 0 });
});
test('图像观测PNG解码与宿主RGB渲染逐字节相同', () => {
  const s = createState(), png = render(s, 'running'), expected = renderPixels(s, 'running');
  const idat: Buffer[] = []; let offset = 8;
  while (offset < png.length) { const size = png.readUInt32BE(offset); if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const decoded = inflateSync(Buffer.concat(idat)), rgb = new Uint8Array(960 * 680 * 3);
  for (let y = 0; y < 680; y++) rgb.set(decoded.subarray(y * 2881 + 1, (y + 1) * 2881), y * 2880);
  assert.deepEqual(expected.data, rgb);
});

test('双方装甲渲染采用12×4矩形，旋转像素仍落在实际装甲内', () => {
  for (const angle of [0, Math.PI / 7]) {
    const s = createState(); s.robots.blue.angle = angle; s.robots.red.angle = angle;
    const frame = renderPixels(s, 'running');
    for (const side of ['blue', 'red'] as const) {
      const r = s.robots[side], color = colors[side];
      let count = 0;
      for (let y = r.y - 40; y <= r.y + 40; y++) for (let x = r.x - 40; x <= r.x + 40; x++) {
        const i = ((y + 80) * frame.width + x) * 3;
        if (!color.every((c, channel) => frame.data[i + channel] === c)) continue;
        count++;
        assert.ok([0, 1, 2, 3].some(p => {
          const a = angle + p * Math.PI / 2, co = Math.cos(a), si = Math.sin(a);
          return Math.abs((x - r.x) * co + (y - r.y) * si - RULES.radius) <= 2 + 1e-9 && Math.abs(-(x - r.x) * si + (y - r.y) * co) <= 6 + 1e-9;
        }));
      }
      assert.ok(count >= 180 && count <= 205, `visible armor area ${count}`);
    }
  }
});
test('全状态规则对手实际移动、旋转和射击，倒计时与电脑动作可确定性重放', () => {
  const g = new Game(); g.start(playSetup());
  g.advance(480); g.advance(480);g.advance(240); assert.equal(g.tickCount, 0);
  const initial = g.refereeRecord().finalState.robots.blue;
  g.advance(480); const actual = g.refereeRecord().finalState.robots.blue;
  assert.ok(Math.hypot(actual.x - initial.x, actual.y - initial.y) > 10); assert.notEqual(actual.angle, initial.angle); assert.ok(actual.shots >= 5);
  const record = g.refereeRecord(); assert.ok(record.actions.some(a => a.source === 'computer'));
  assert.equal(replay(record).identical, true);
});
