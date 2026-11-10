import { SIDE, RULES } from '../shared/protocol.js';
import type { DisplayFrame } from '../shared/scene.js';
export const DISPLAY_HZ = 60;
export const DISPLAY_DELAY_MS = 1000 / 30;
const angleBetween = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b-a), Math.cos(b-a)) * t;
export const displayTime = (frame:DisplayFrame) => frame.status==='countdown' ? RULES.preparationMs-frame.countdownMs : frame.timestampMs;
export function interpolateFrames(a: DisplayFrame, b: DisplayFrame, time: number): DisplayFrame {
  if (a.matchId !== b.matchId || a.status !== b.status || !['running','countdown'].includes(a.status) || displayTime(b) <= displayTime(a) || displayTime(b)-displayTime(a)>100) return b;
  const t = Math.max(0, Math.min(1, (time-displayTime(a))/(displayTime(b)-displayTime(a))));
  if (t === 1) return b;
  const mix = (x:number,y:number) => x+(y-x)*t;
  const robots = {...a.scene.robots};
  for (const side of SIDE) {
    const x=a.scene.robots[side],y=b.scene.robots[side];
    robots[side]={...x,x:mix(x.x,y.x),y:mix(x.y,y.y),angle:angleBetween(x.angle,y.angle,t),turret:angleBetween(x.turret,y.turret,t)};
  }
  const next = new Map(b.scene.bullets.map(x=>[x.id,x]));
  return {...a,timestampMs:mix(a.timestampMs,b.timestampMs),countdownMs:mix(a.countdownMs,b.countdownMs),scene:{...a.scene,tick:mix(a.scene.tick,b.scene.tick),robots,bullets:a.scene.bullets.map(x=>{
    const y=next.get(x.id); return y?{...x,x:mix(x.x,y.x),y:mix(x.y,y.y)}:x;
  })}};
}
export class FrameBuffer {
  #frames: DisplayFrame[]=[];
  #received=0;
  push(frame:DisplayFrame,received:number) {
    const last=this.#frames.at(-1);
    if (!last || last.matchId!==frame.matchId || last.status!==frame.status || frame.timestampMs<last.timestampMs) this.#frames=[];
    if (!last || !this.#frames.length || displayTime(frame)!==displayTime(last) || !['running','countdown'].includes(frame.status)) { this.#frames.push(frame); this.#received=received; }
    if(this.#frames.length>12)this.#frames.shift();
  }
  sample(now:number):DisplayFrame|undefined {
    const last=this.#frames.at(-1);if(!last)return;
    if(!['running','countdown'].includes(last.status))return last;
    // Interpolate real authority samples only; never extrapolate a collision.
    const time=Math.min(displayTime(last),displayTime(last)+now-this.#received-DISPLAY_DELAY_MS);
    for(let i=1;i<this.#frames.length;i++)if(displayTime(this.#frames[i])>=time)return interpolateFrames(this.#frames[i-1],this.#frames[i],time);
    return last;
  }
}
