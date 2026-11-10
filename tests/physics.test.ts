import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, tick, neutral, velocity, sweepPlate, sweepBody, DT, type Bullet } from '../src/host/physics.js';
import { RULES as R } from '../src/shared/protocol.js';
const actions = (s = createState()) => ({ blue: neutral(s.robots.blue), red: neutral(s.robots.red) });
test('双方初始参数和 180° 出生位置完全对称', () => {
  const s = createState(), b = s.robots.blue, r = s.robots.red;
  assert.equal(b.x + r.x, R.width); assert.equal(b.y + r.y, R.height);
  for (const k of ['hp', 'ammo', 'shots', 'hits', 'nextShot'] as const) assert.equal(b[k], r[k]);
  assert.equal(b.x,750);assert.equal(r.x,210);assert.equal(Math.abs(b.angle-r.angle),Math.PI);assert.equal(b.turret-r.turret,Math.PI);
  for (const robot of [b,r]) for (let index=0;index<4;index++) {
    const angle=robot.angle+index*Math.PI/2;
    assert.ok(Math.abs(Math.abs(Math.cos(angle))-Math.SQRT1_2)<1e-12);
    assert.ok(Math.abs(Math.abs(Math.sin(angle))-Math.SQRT1_2)<1e-12);
  }
  assert.deepEqual([r.turret,b.turret],[0,Math.PI]);
});
test('功率为速度平方和，超预算时平移和旋转同比缩放', () => {
  for (const spin of [0,.5,.8,1]) {
    const fraction=1/Math.hypot(1,spin);
    for (const sign of [-1, 1]) {
      const v = velocity({ ...neutral(), moveX: 1, spin: spin * sign },50);
      assert.ok(Math.abs(v.x / R.maxSpeed - fraction) < 1e-12);
      assert.equal(v.y, 0); assert.ok(Math.abs(v.omega-spin*sign*R.maxSpin*fraction)<1e-12);
    }
  }
  const v = velocity({ ...neutral(), spin: 0.8 },50);
  assert.equal(v.x, 0); assert.equal(v.y, 0); assert.equal(v.omega, 0.8 * R.maxSpin);
});

test('斜向与正反向对称，未达功率上限时保持请求幅度', () => {
  for (const spin of [-1, -0.8, -0.5, 0, 0.5, 0.8, 1]) for (const moveX of [-1, -0.3, 0, 0.3, 1]) for (const moveY of [-1, -0.4, 0, 0.4, 1]) {
    const v = velocity({ ...neutral(), moveX, moveY, spin },50);
    const power = (v.x ** 2 + v.y ** 2) / R.maxSpeed ** 2 + (v.omega / R.maxSpin) ** 2;
    assert.ok(Math.abs(power - Math.min(1,Math.min(1,moveX ** 2 + moveY ** 2)+spin ** 2)) < 1e-12);
    assert.ok(power <= 1 + 1e-12);
    const reverse = velocity({ ...neutral(), moveX: -moveX, moveY: -moveY, spin: -spin },50);
    assert.ok(Math.abs(v.x + reverse.x) < 1e-12 && Math.abs(v.y + reverse.y) < 1e-12 && Math.abs(v.omega + reverse.omega) < 1e-12);
  }
  const v = velocity({ ...neutral(), moveX: 0.3, moveY: 0.4, spin: 0.8 },50);
  assert.ok(Math.abs(Math.hypot(v.x, v.y) - R.maxSpeed * 0.5) < 1e-12);
});

test('缩小后的装甲端点、厚度和弹丸半径边界对双方四块装甲一致', () => {
  for (const side of ['blue', 'red'] as const) for (const angle of [0, Math.PI / 7]) for (let plate = 0; plate < 4; plate++) {
    const r = createState().robots[side]; r.angle = angle;
    const a = angle + plate * Math.PI / 2, co = Math.cos(a), si = Math.sin(a);
    const at = (radial: number, tangent: number) => sweepPlate({ id: 1, owner: side === 'blue' ? 'red' : 'blue', x: r.x + co * (R.radius + radial) - si * tangent, y: r.y + si * (R.radius + radial) + co * tangent, vx: 0, vy: 0 }, { start: r, end: r, omega: 0 }, plate, 0);
    for (const sign of [-1, 1]) {
      assert.equal(at(0, sign * 8), 0); // 12/2 + projectile radius
      assert.equal(at(0, sign * 8.001), null);
      assert.equal(at(sign * 4, 0), 0); // 4/2 + projectile radius
      assert.equal(at(sign * 4.001, 0), null);
      assert.equal(at(0, sign * 10), null); // formerly inside 18px armor
      assert.equal(at(sign * 4.25, 0), null); // formerly inside 5px thickness
    }
  }
});

test('连续弹道刚好擦到新装甲端部命中，越过端部不命中', () => {
  const r = createState().robots.red; r.angle = 0;
  for (const sign of [-1, 1]) for (const [tangent, hit] of [[8, true], [8.001, false], [10, false]] as const) {
    const b: Bullet = { id: 1, owner: 'blue', x: r.x + R.radius + 30, y: r.y + sign * tangent, vx: -600, vy: 0 };
    assert.equal(sweepPlate(b, { start: r, end: r, omega: 0 }, 0, 0.1) !== null, hit);
  }
});
test('连续碰撞捕获单步跨越整个机器人的高速弹丸', () => {
  const s = createState();
  s.robots.red.angle=0;
  s.bullets.push({ id: 1, owner: 'blue', x: s.robots.red.x - 80, y: s.robots.red.y + 8, vx: 50000, vy: 0 });
  tick(s, actions(s)); assert.equal(s.robots.red.hp, R.hp-R.damage); assert.equal(s.bullets.length, 0);
  assert.equal(s.events.filter(e => e.type === 'hit').length, 1);
});
test('穿过装甲间隙先击中裸机体时消弹且不扣血', () => {
  const s = createState(); s.robots.red.angle = Math.PI / 4;
  s.bullets.push({ id: 1, owner: 'blue', x: s.robots.red.x - 80, y: s.robots.red.y + 8, vx: 50000, vy: 0 });
  tick(s, actions(s)); assert.equal(s.robots.red.hp, R.hp); assert.equal(s.bullets.length, 0); assert.equal(s.events.filter(e=>e.type==='block').length,1);
});

test('裸机体遮挡背板，沿连续弹道比较实体与装甲首次接触', () => {
  const s=createState(),r=s.robots.red;r.angle=0.3;
  const b:Bullet={id:1,owner:'blue',x:r.x-80,y:r.y+12,vx:50000,vy:0};
  const motion={start:{...r},end:{...r},omega:0};
  const plate=sweepPlate(b,motion,0,DT),body=sweepBody(b,motion,DT);
  assert.ok(plate!==null&&body!==null&&body<plate,'test ray reaches rear armor after body');
  s.bullets=[b];tick(s,actions(s));assert.equal(r.hp,R.hp);assert.equal(s.bullets.length,0);
  assert.equal(s.events.filter(e=>e.type==='hit').length,0);assert.equal(s.events.filter(e=>e.type==='block').length,1);
});

test('炮管不挡弹；圆形底盘与弹丸半径擦边以及移动目标连续碰撞', () => {
  const r=createState().robots.red;r.turret=0;
  const motion={start:r,end:r,omega:0};
  for(const [offset,hit]of [[25,true],[25.001,false]] as const){
    const b:Bullet={id:1,owner:'blue',x:r.x-50,y:r.y+offset,vx:1000,vy:0};
    assert.equal(sweepBody(b,motion,0.1)!==null,hit);
  }
  const barrel:Bullet={id:1,owner:'blue',x:r.x+60,y:r.y,vx:-1000,vy:0};
  const t=sweepBody(barrel,motion,0.1);assert.ok(t!==null&&Math.abs(t-0.035)<1e-6);
  const stationary:Bullet={id:1,owner:'blue',x:r.x-40,y:r.y,vx:0,vy:0};
  assert.notEqual(sweepBody(stationary,{start:r,end:{...r,x:r.x-30},omega:0},0.2),null);
});

test('擦过整个机体外侧不消弹，前方装甲接触早于机体时扣血',()=>{
  for(const [offset,hp,survivors]of [[8,R.hp-R.damage,0],[40,R.hp,1]] as const){
    const s=createState();s.robots.red.angle=0;s.bullets=[{id:1,owner:'blue',x:s.robots.red.x-80,y:s.robots.red.y+offset,vx:50000,vy:0}];
    tick(s,actions(s));assert.equal(s.robots.red.hp,hp);assert.equal(s.bullets.length,survivors);
  }
});

test('炮口生成在自身实体和装甲之外，发射不产生自伤或自吞弹',()=>{
  for(const side of ['blue','red']as const)for(const angle of [0,Math.PI/4,Math.PI,Math.PI*1.5]){
    const s=createState(),r=s.robots[side];r.turret=angle;r.angle=angle;
    const a=actions(s);a[side]={...neutral(r),fire:true};tick(s,a);
    assert.equal(s.bullets.length,1);assert.equal(r.hp,R.hp);
    const b=s.bullets[0];assert.ok(Math.hypot(b.x-r.x,b.y-r.y)>R.barrelLength+R.barrelRadius+R.bulletRadius);
    assert.equal(sweepBody(b,{start:r,end:r,omega:0},0),null);
    for(let p=0;p<4;p++)assert.equal(sweepPlate(b,{start:r,end:r,omega:0},p,0),null);
  }
});
test('旋转中的装甲可扫过静止弹丸，不能只查两个端点', () => {
  const r = createState().robots.red; r.angle = -0.6;
  const end = { ...r, angle: 0.6 };
  const b: Bullet = { id: 1, owner: 'blue', x: r.x + R.radius, y: r.y, vx: 0, vy: 0 };
  const hit = sweepPlate(b, { start: r, end, omega: 6 }, 0, 0.2);
  assert.notEqual(hit, null); assert.ok(hit! > 0 && hit! < 0.2);
});
test('碰撞使用飞行途中位置，目标可在弹丸到达前转走', () => {
  const r = createState().robots.red, b: Bullet = { id: 1, owner: 'blue', x: r.x + R.radius + 40, y: r.y, vx: -200, vy: 0 };
  r.angle = 0;
  const hit = sweepPlate(b, { start: r, end: { ...r, angle: Math.PI / 4 }, omega: Math.PI / 4 / 0.2 }, 0, 0.2);
  assert.equal(hit, null);
});
test('平移目标的连续碰撞检查相对运动', () => {
  const r = createState().robots.red; r.angle = 0;
  const b: Bullet = { id: 1, owner: 'blue', x: r.x + R.radius + 20, y: r.y, vx: 0, vy: 0 };
  const hit = sweepPlate(b, { start: r, end: { ...r, x: r.x + 60 }, omega: 0 }, 0, 0.2);
  assert.ok(hit !== null && hit > 0 && hit < 0.2);
});
test('擦过装甲角点时不能因迭代收敛慢而漏判', () => {
  const r = createState().robots.red; r.angle = 0;
  const b: Bullet = { id: 1, owner: 'blue', x: r.x + R.radius + R.plateThickness / 2 + R.bulletRadius, y: r.y - 40, vx: 0, vy: 800 };
  const hit = sweepPlate(b, { start: r, end: r, omega: 0 }, 0, 0.1);
  assert.ok(hit !== null && hit > 0 && hit < 0.1);
});
test('有限弹速、有限射速、有限炮塔转速', () => {
  const s = createState();
  s.robots.blue.turret = 0; s.robots.red.turret = Math.PI;
  const a = actions(s); a.blue.fire = a.red.fire = true;
  for (let i = 0; i < R.tickHz; i++) tick(s, a);
  for (const side of ['blue','red'] as const) {
    assert.equal(s.robots[side].shots, 20);
    assert.equal(s.robots[side].ammo, R.ammo - 20);
    assert.deepEqual(s.events.filter(e => e.type === 'shot' && e.side === side).map(e => e.tick),
      Array.from({ length: 20 }, (_, i) => i * 12));
  }
  for (const b of s.bullets) assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - R.bulletSpeed) < 1e-9);
  const state = createState(), input = actions(state); input.blue.aimX = 0; tick(state, input);
  assert.ok(Math.abs(Math.atan2(Math.sin(state.robots.blue.turret-Math.PI),Math.cos(state.robots.blue.turret-Math.PI))) <= R.turretSpeed * DT + 1e-9);
});

test('1000px/s对双方一致，单步两端未接触的装甲角点与裸底盘擦边仍消弹', () => {
  assert.equal(R.bulletSpeed,1000);
  for(const side of ['blue','red'] as const) {
    const shot=createState(),firing=actions(shot);firing[side].fire=true;tick(shot,firing);
    assert.equal(shot.bullets.length,1);assert.equal(shot.bullets[0].owner,side);
    assert.ok(Math.abs(Math.hypot(shot.bullets[0].vx,shot.bullets[0].vy)-1000)<1e-9);
    for(const armor of [true,false]) {
      const state=createState(),r=state.robots[side],owner=side==='blue'?'red':'blue';
      r.angle=armor?0:Math.PI/4;
      const halfStep=R.bulletSpeed*DT/2,n=Math.SQRT1_2;
      const vx=armor?-R.bulletSpeed*n:R.bulletSpeed,vy=armor?R.bulletSpeed*n:0;
      const cx=armor?r.x+R.radius+R.plateThickness/2+(R.bulletRadius-1e-5)*n:r.x;
      const cy=armor?r.y+R.plateLength/2+(R.bulletRadius-1e-5)*n:r.y+R.bodyRadius+R.bulletRadius-1e-5;
      const b:Bullet={id:1,owner,x:cx-vx/R.bulletSpeed*halfStep,y:cy-vy/R.bulletSpeed*halfStep,vx,vy};
      const end={...b,x:b.x+vx*DT,y:b.y+vy*DT},motion={start:r,end:r,omega:0};
      for(const endpoint of [b,end])assert.equal(armor?sweepPlate(endpoint,motion,0,0):sweepBody(endpoint,motion,0),null);
      state.bullets=[b];tick(state,actions(state));
      assert.equal(state.bullets.length,0);assert.equal(r.hp,armor?R.hp-R.damage:R.hp);
    }
  }
});
test('同时致命命中为平局，不按蓝红更新顺序决定胜负', () => {
  const s = createState(); s.robots.blue.hp = 10; s.robots.red.hp = 10;
  s.robots.red.angle=0;s.robots.blue.angle=Math.PI;
  s.bullets = [
    { id: 1, owner: 'blue', x: s.robots.red.x - 40, y: s.robots.red.y + 8, vx: 5000, vy: 0 },
    { id: 2, owner: 'red', x: s.robots.blue.x + 40, y: s.robots.blue.y + 8, vx: -5000, vy: 0 },
  ];
  tick(s, actions(s)); assert.equal(s.winner, 'draw');
});
test('镜像动作保持 180° 对称，包括碰撞和开火', () => {
  const s = createState();
  const a = { blue: { ...neutral(), moveX: 1, moveY: 0.2, spin: 0.25, aimX: 1, aimY: 0.5, fire: true }, red: { ...neutral(), moveX: -1, moveY: -0.2, spin: 0.25, aimX: 0, aimY: 0.5, fire: true } };
  for (let i = 0; i < 1500 && !s.winner; i++) {
    tick(s, a); const b = s.robots.blue, r = s.robots.red;
    assert.ok(Math.abs(b.x + r.x - R.width) < 1e-8); assert.ok(Math.abs(b.y + r.y - R.height) < 1e-8);
    assert.equal(b.hp, r.hp); assert.equal(b.shots, r.shots);
  }
});
