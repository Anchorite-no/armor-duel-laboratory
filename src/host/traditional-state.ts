// Privileged, host-only robot snapshot. Never import this into participant APIs.
import { RULES, SIDE, type OwnerObservation, type Side } from '../shared/protocol.js';
import { motionCaps } from '../shared/motion.js';
import { DT, wrap, type Robot, type State } from './physics.js';
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
function freeze<T>(value: T): DeepReadonly<T> {
  if(value && typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
  return value as DeepReadonly<T>;
}
export type Poses = Record<Side, Pick<Robot,'x'|'y'|'angle'|'turret'>>;
export type ActualMotion = Record<Side,{vx:number;vy:number;omega:number;turretOmega:number}>;
export function robotPoses(robots: Record<Side,Robot>): Poses {
  return {blue:{x:robots.blue.x,y:robots.blue.y,angle:robots.blue.angle,turret:robots.blue.turret},red:{x:robots.red.x,y:robots.red.y,angle:robots.red.angle,turret:robots.red.turret}};
}
export function stationaryMotion(): ActualMotion { return {blue:{vx:0,vy:0,omega:0,turretOmega:0},red:{vx:0,vy:0,omega:0,turretOmega:0}}; }
export function observedMotion(before: Poses, after: Record<Side,Robot>): ActualMotion {
  return Object.fromEntries(SIDE.map(side=>{const a=before[side],b=after[side];return[side,{vx:(b.x-a.x)/DT,vy:(b.y-a.y)/DT,omega:wrap(b.angle-a.angle)/DT,turretOmega:wrap(b.turret-a.turret)/DT}];})) as ActualMotion;
}
export function traditionalSnapshot(state: Pick<State,'tick'|'tuning'|'robots'>, motion: ActualMotion, timestampMs:number, status:OwnerObservation['status'], fireIntervalTicks=RULES.tickHz/RULES.fireHz) {
  const robots=Object.fromEntries(SIDE.map(side=>{
    const r=state.robots[side];
    return[side,{
      side:r.side,x:r.x,y:r.y,angle:r.angle,turret:r.turret,hp:r.hp,ammo:r.ammo,shots:r.shots,hits:r.hits,nextShot:r.nextShot,
      heatUnits:r.heatUnits??0,cooldownTicks:Math.max(0,r.nextShot-state.tick),
      cooldownMs:Math.max(0,r.nextShot-state.tick)*1000/RULES.tickHz,
      ...motion[side],
      armor:Array.from({length:4},(_,index)=>{const angle=r.angle+index*Math.PI/2;return{index,angle,x:r.x+Math.cos(angle)*RULES.radius,y:r.y+Math.sin(angle)*RULES.radius,normal:{x:Math.cos(angle),y:Math.sin(angle)},length:RULES.plateLength,thickness:RULES.plateThickness};}),
    }];
  })) as Record<Side,{
    side:Side;x:number;y:number;angle:number;turret:number;hp:number;ammo:number;shots:number;hits:number;nextShot:number;heatUnits:number;cooldownTicks:number;cooldownMs:number;
    vx:number;vy:number;omega:number;turretOmega:number;
    armor:{index:number;angle:number;x:number;y:number;normal:{x:number;y:number};length:number;thickness:number}[];
  }>;
  // All objects below are fresh copies. No leases, actions, programs, bullets or sessions.
  return freeze({timestampMs,battleTick:state.tick,battleTimestampMs:state.tick*1000/RULES.tickHz,status,tuning:{...state.tuning},geometry:{width:RULES.width,height:RULES.height,bodyRadius:RULES.bodyRadius,armorRadius:RULES.radius,plateLength:RULES.plateLength,plateThickness:RULES.plateThickness,barrelLength:RULES.barrelLength,barrelRadius:RULES.barrelRadius,muzzleOffset:RULES.barrelLength+RULES.barrelRadius+RULES.bulletRadius+0.01,bulletSpeed:RULES.bulletSpeed,bulletRadius:RULES.bulletRadius,fireHz:RULES.fireHz,fireIntervalTicks,turretSpeed:RULES.turretSpeed,...motionCaps(state.tuning.power)},robots});
}
export type TraditionalSnapshot = ReturnType<typeof traditionalSnapshot>;
