import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES as R } from '../src/shared/protocol.js';
import { motionCaps } from '../src/shared/motion.js';
import { DT, createState, neutral, tick, velocity, sweepBody, sweepPlate, wrap, type Bullet } from '../src/host/physics.js';
test('功率50的4米每秒与8rad/s在一秒内按实际物理步积分',()=>{
  assert.equal(R.bodyDiameter,2*R.bodyRadius);assert.equal(R.bodyDiameter,46);assert.equal(R.maxSpeed,4*R.bodyDiameter);assert.equal(R.maxSpin,8);
  const moved=createState(),turned=createState();let rotation=0;
  for(let i=0;i<R.tickHz;i++){
    tick(moved,{red:{...neutral(moved.robots.red),moveX:1},blue:neutral(moved.robots.blue)});
    const before=turned.robots.red.angle;tick(turned,{red:{...neutral(turned.robots.red),spin:1},blue:neutral(turned.robots.blue)});rotation+=wrap(turned.robots.red.angle-before);
  }
  assert.ok(Math.abs(moved.robots.red.x-210-4*46)<1e-9);assert.equal(moved.robots.red.y,300);
  assert.ok(Math.abs(rotation-8)<1e-9);assert.equal(turned.robots.red.x,210);assert.equal(turned.robots.red.y,300);
});
test('新标定下混合运动与其他功率仍按平方根缩放，双方正反及斜向约束一致',()=>{
  for(const power of [25,50,100,225,400])for(const spin of [-1,-.8,-.5,0,.5,.8,1])for(const [moveX,moveY]of [[1,0],[-1,0],[1,1],[-1,-1],[.3,.4]]){
    const v=velocity({...neutral(),moveX,moveY,spin},power),caps=motionCaps(power);
    const full=(v.x**2+v.y**2)/(4*R.bodyDiameter)**2+(v.omega/8)**2;
    assert.ok(full<=power/50+1e-12);
    if(Math.hypot(moveX,moveY)>=1)assert.ok(Math.abs(full-power/50)<1e-12);
    assert.ok(Math.abs(caps.maxSpeed-4*46*Math.sqrt(power/50))<1e-12);
  }
  const mixed=velocity({...neutral(),moveX:1,spin:.8},50),ratio=Math.hypot(1,.8);
  assert.ok(Math.abs(mixed.x-184/ratio)<1e-9);assert.ok(Math.abs(mixed.omega-6.4/ratio)<1e-12);
});
test('高功率移动时，连续底盘碰撞捕获两端不接触的短暂擦边',()=>{
  const r=createState().robots.red,speed=motionCaps(400).maxSpeed,end={...r,x:r.x+speed*DT};
  const b:Bullet={id:1,owner:'blue',x:(r.x+end.x)/2,y:r.y+R.bodyRadius+R.bulletRadius-1e-5,vx:0,vy:0};
  assert.equal(sweepBody(b,{start:r,end:r,omega:0},0),null);assert.equal(sweepBody(b,{start:end,end,omega:0},0),null);
  const hit=sweepBody(b,{start:r,end,omega:0},DT);assert.ok(hit!==null&&hit>0&&hit<DT);
});
test('高功率纯旋转和混合运动时，连续装甲碰撞捕获端点之间的角点擦边',()=>{
  for(const spin of [1,.8]){
    const v=velocity({...neutral(),moveY:1,spin},400),r=createState().robots.red;
    const cornerRadius=Math.hypot(R.radius+R.plateThickness/2,R.plateLength/2);
    const cornerAngle=Math.atan2(R.plateLength/2,R.radius+R.plateThickness/2);
    r.angle=-cornerAngle-v.omega*DT/2;
    const end={...r,x:r.x+v.x*DT,y:r.y+v.y*DT,angle:r.angle+v.omega*DT};
    const b:Bullet={id:1,owner:'blue',x:(r.x+end.x)/2+cornerRadius+R.bulletRadius-1e-5,y:(r.y+end.y)/2,vx:0,vy:0};
    assert.equal(sweepPlate(b,{start:r,end:r,omega:0},0,0),null);assert.equal(sweepPlate(b,{start:end,end,omega:0},0,0),null);
    const hit=sweepPlate(b,{start:r,end,omega:v.omega},0,DT);assert.ok(hit!==null&&hit>0&&hit<DT);
  }
});
