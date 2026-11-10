// Fixed privileged sparring policy. Host-only, no model calls or online learning.
import { RULES, type Action, type Side } from '../shared/protocol.js';
import type { TraditionalSnapshot } from './traditional-state.js';
import { CONTROL_HZ } from '../shared/control.js';
import { canFireWithoutOverheat, neutral } from './physics.js';
import type { PrivilegedAI } from '../shared/privileged-ai.js';
export const COMPUTER = { name: '全知传统 AI', implementation: 'omniscient-traditional-v5' } as const;
// v5 spaces requests by at least 100 ms while retaining the v4 heat check.
// Future changes to these rules require a new implementation identifier.
export const TRADITIONAL_POLICY = Object.freeze({
  decisionMs:1000/CONTROL_HZ,preferredRange:300,lowHpRange:400,rangeBand:50,lowHpFraction:.35,
  approach:.65,retreat:.7,strafe:.5,strafePeriodSeconds:2.6,wallMargin:110,wallGain:1.2,
  spinBase:.45,spinWave:.1,spinFrequency:1.1,lowHpSpin:.7,
  maxLeadSeconds:1.25,leadIterations:3,minArmorFacing:.25,fireConeRadians:.1,fireReadyWindowMs:100,fireHz:10,
  rangeJitter:18,periodJitter:.1,
});
// Stateless keyed draws: decisions/replay cannot advance a shared RNG by accident.
function seededDraw(seed:number,tag:number) {
  let value=(seed+Math.imul(tag,0x9e3779b9))>>>0;
  value=Math.imul(value^(value>>>16),0x21f0aaad);
  value=Math.imul(value^(value>>>15),0x735a2d97);
  return ((value^(value>>>15))>>>0)/0x100000000;
}
export function behaviorProfile(seed:number) {
  const draw=(tag:number)=>seededDraw(seed,tag);
  return {
    rangeOffset:(draw(1)*2-1)*TRADITIONAL_POLICY.rangeJitter,
    strafePeriod:TRADITIONAL_POLICY.strafePeriodSeconds*(1+(draw(2)*2-1)*TRADITIONAL_POLICY.periodJitter),
    initialDirection:draw(3)<.5?-1:1,
    strafePhase:draw(4),spinPhase:draw(5)*Math.PI*2,
  };
}
const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));
const wrap=(v:number)=>Math.atan2(Math.sin(v),Math.cos(v));
// Constant-velocity interception estimate, not a query of future simulation state.
export function interceptTime(dx:number,dy:number,vx:number,vy:number,speed:number,maxTime:number):number|null {
  const a=vx*vx+vy*vy-speed*speed,b=2*(dx*vx+dy*vy),c=dx*dx+dy*dy;
  if(c<1e-12)return 0;
  let roots:number[];
  if(Math.abs(a)<1e-9)roots=Math.abs(b)<1e-9?[]:[-c/b];
  else{const d=b*b-4*a*c;if(d<0)return null;const root=Math.sqrt(d);roots=[(-b-root)/(2*a),(-b+root)/(2*a)];}
  const times=roots.filter(t=>Number.isFinite(t)&&t>=0&&t<=maxTime);return times.length?Math.min(...times):null;
}
export function aimingSolution(snapshot:TraditionalSnapshot,side:Side) {
  const own=snapshot.robots[side],target=snapshot.robots[side==='blue'?'red':'blue'],g=snapshot.geometry,p=TRADITIONAL_POLICY;
  const origin={x:own.x+Math.cos(own.turret)*g.muzzleOffset,y:own.y+Math.sin(own.turret)*g.muzzleOffset};
  const centerTime=interceptTime(target.x-origin.x,target.y-origin.y,target.vx,target.vy,g.bulletSpeed,p.maxLeadSeconds);
  let best:{x:number;y:number;time:number;plate:number;score:number}|undefined;
  if(centerTime!==null)for(const armor of target.armor){
    let time=centerTime,x=armor.x,y=armor.y,nx=armor.normal.x,ny=armor.normal.y;
    for(let iteration=0;iteration<=p.leadIterations;iteration++){
      const a=target.omega*time,c=Math.cos(a),s=Math.sin(a),dx=armor.x-target.x,dy=armor.y-target.y;
      x=target.x+target.vx*time+c*dx-s*dy;y=target.y+target.vy*time+s*dx+c*dy;
      nx=c*armor.normal.x-s*armor.normal.y;ny=s*armor.normal.x+c*armor.normal.y;
      if(iteration<p.leadIterations)time=Math.hypot(x-origin.x,y-origin.y)/g.bulletSpeed;
    }
    const distance=Math.max(1,Math.hypot(origin.x-x,origin.y-y)),facing=(nx*(origin.x-x)+ny*(origin.y-y))/distance;
    const score=facing-.15*time;
    if(time<=p.maxLeadSeconds&&facing>=p.minArmorFacing&&x>=0&&x<=g.width&&y>=0&&y<=g.height&&(!best||score>best.score))best={x,y,time,plate:armor.index,score};
  }
  // No plausible intercept: aim toward the current center but hold fire.
  return best?{...best,feasible:true}:{x:target.x,y:target.y,time:0,plate:null,score:0,feasible:false};
}
function intelligentMovement(snapshot:TraditionalSnapshot,side:Side,behavior:ReturnType<typeof behaviorProfile>) {
  const own=snapshot.robots[side],target=snapshot.robots[side==='blue'?'red':'blue'],g=snapshot.geometry,p=TRADITIONAL_POLICY;
  const dx=target.x-own.x,dy=target.y-own.y,distance=Math.max(1,Math.hypot(dx,dy)),ux=dx/distance,uy=dy/distance;
  const low=own.hp<snapshot.tuning.hp*p.lowHpFraction,range=(low?p.lowHpRange:p.preferredRange)+behavior.rangeOffset;
  const radial=own.ammo===0?-p.retreat:distance>range+p.rangeBand?p.approach:distance<range-p.rangeBand?-p.retreat:0;
  const t=snapshot.timestampMs/1000,strafe=(Math.floor(t/behavior.strafePeriod+behavior.strafePhase)%2?-1:1)*behavior.initialDirection*p.strafe;
  const wallX=clamp((p.wallMargin-own.x)/p.wallMargin,0,1)-clamp((own.x-(g.width-p.wallMargin))/p.wallMargin,0,1);
  const wallY=clamp((p.wallMargin-own.y)/p.wallMargin,0,1)-clamp((own.y-(g.height-p.wallMargin))/p.wallMargin,0,1);
  return {moveX:clamp(ux*radial-uy*strafe+p.wallGain*wallX,-1,1),moveY:clamp(uy*radial+ux*strafe+p.wallGain*wallY,-1,1)};
}
function aimedShot(snapshot:TraditionalSnapshot,side:Side,aim:{x:number;y:number;feasible:boolean}) {
  const own=snapshot.robots[side],target=snapshot.robots[side==='blue'?'red':'blue'],g=snapshot.geometry,p=TRADITIONAL_POLICY;
  const error=Math.abs(wrap(Math.atan2(aim.y-own.y,aim.x-own.x)-own.turret));
  const lastShot = own.nextShot - g.fireIntervalTicks;
  const cadenceReady = own.shots === 0 || snapshot.battleTick - lastShot >= RULES.tickHz / p.fireHz;
  return {
    aimX:clamp(aim.x/g.width,0,1),aimY:clamp(aim.y/g.height,0,1),
    fire:snapshot.status==='running'&&own.hp>0&&target.hp>0&&own.ammo>0&&cadenceReady&&own.cooldownMs<=p.fireReadyWindowMs&&aim.feasible&&error<=p.fireConeRadians&&canFireWithoutOverheat(own.heatUnits,own.cooldownTicks),
  };
}
export function computerAction(snapshot:TraditionalSnapshot,side:Side,seed=0):Action {
  const behavior=behaviorProfile(seed),p=TRADITIONAL_POLICY;
  const low=snapshot.robots[side].hp<snapshot.tuning.hp*p.lowHpFraction,t=snapshot.timestampMs/1000;
  return {
    ...intelligentMovement(snapshot,side,behavior),
    spin:low?p.lowHpSpin:p.spinBase+p.spinWave*Math.sin(t*p.spinFrequency+behavior.spinPhase),
    ...aimedShot(snapshot,side,aimingSolution(snapshot,side)),
    durationMs:Math.round(p.decisionMs),
  };
}

export class RandomWalk {
  #target?: Readonly<{x:number;y:number}>;
  #sequence=0;
  #bestDistance=Infinity;
  #progressTick=0;
  constructor(private readonly seed:number) {}

  waypoint(snapshot:TraditionalSnapshot,side:Side,arrival:number) {
    const {battleTick,geometry:{width,height}}=snapshot,{x,y}=snapshot.robots[side];
    const distance=this.#target?Math.hypot(this.#target.x-x,this.#target.y-y):Infinity;
    if (this.#target && distance<=this.#bestDistance-1) {
      this.#bestDistance=distance;
      this.#progressTick=battleTick;
    }
    if (!this.#target || distance<=arrival || battleTick-this.#progressTick>=RULES.tickHz) {
      const tag=2*this.#sequence+16,inset=RULES.arenaInset;
      this.#sequence++;
      this.#target=Object.freeze({
        x:inset+(width-2*inset)*seededDraw(this.seed,tag),
        y:inset+(height-2*inset)*seededDraw(this.seed,tag+1),
      });
      this.#bestDistance=Math.hypot(this.#target.x-x,this.#target.y-y);
      this.#progressTick=battleTick;
    }
    return this.#target;
  }
}

export function privilegedAction(snapshot:TraditionalSnapshot,side:Side,config:PrivilegedAI,seed:number,walk?:RandomWalk):Action {
  const behavior=behaviorProfile(seed),own=snapshot.robots[side];
  const target=snapshot.robots[side==='blue'?'red':'blue'];
  const action={...neutral(own),durationMs:Math.round(TRADITIONAL_POLICY.decisionMs)};
  if (config.movement==='random') {
    if (!walk) throw Error('随机移动需要本局的随机序列');
    const movementShare=config.rotation==='still'?1:.8;
    // Half a control step allows for discrete full-speed movement past the point.
    const arrival=Math.max(.25,snapshot.geometry.maxSpeed*movementShare/(2*CONTROL_HZ));
    const waypoint=walk.waypoint(snapshot,side,arrival);
    const angle=Math.atan2(waypoint.y-own.y,waypoint.x-own.x);
    action.moveX=Math.cos(angle);action.moveY=Math.sin(angle);
  } else if (config.movement==='smart') {
    const {moveX,moveY}=intelligentMovement(snapshot,side,behavior),length=Math.hypot(moveX,moveY);
    if (length) {action.moveX=moveX/length;action.moveY=moveY/length;}
  }
  if (config.rotation==='cw') action.spin=1;
  if (config.rotation==='ccw') action.spin=-1;
  if (config.rotation==='sine') action.spin=Math.sin((snapshot.timestampMs%4000)*2*Math.PI/4000+behavior.spinPhase);
  if (config.movement!=='still' && config.rotation!=='still') {
    action.moveX*=.8;action.moveY*=.8;action.spin*=.6;
  }
  if (config.shooting==='off') return action;
  const aim=config.shooting==='center'?{x:target.x,y:target.y,feasible:true}:aimingSolution(snapshot,side);
  return {...action,...aimedShot(snapshot,side,aim)};
}
