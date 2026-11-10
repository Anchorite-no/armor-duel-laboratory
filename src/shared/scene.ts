// Owner display geometry only. Never exported by participant observation or runner.
import { RULES as R, SIDE, type Side, type OwnerObservation, type Tuning } from './protocol.js';
import { hudWidth, type HudSize } from './hud-font.js';
export type Color = readonly [number, number, number];
export interface DisplayRobot { side: Side; x: number; y: number; angle: number; turret: number; hp: number; ammo: number; shots: number; hits: number; heatUnits?: number }
export interface DisplayScene { tick: number; tuning: Tuning; robots: Record<Side, DisplayRobot>; bullets: {id:number;owner:Side;x:number;y:number;vx:number;vy:number}[]; events: {tick:number;type:string;[key:string]:unknown}[]; winner: Side | 'draw' | null; overheatDeaths?: Side[] }
export interface DisplayFrame { matchId: string; timestampMs: number; countdownMs: number; status: OwnerObservation['status']; scene: DisplayScene }
export interface Painter { pixel(x:number,y:number,c:Color):void; rect(x:number,y:number,w:number,h:number,c:Color,opacity?:number):void; circle(x:number,y:number,r:number,c:Color,ring?:boolean):void; line(x:number,y:number,xx:number,yy:number,c:Color,radius?:number):void; text(s:string,x:number,y:number,c?:Color,size?:HudSize|number):void }
export const bg:Color=[54,60,72],grid:Color=[75,82,96],white:Color=[231,235,242];
// Reference: user-provided RoboMaster live match screenshot (11:48 / 30:11).
// Charcoal arena, black metal chassis, blue/red LEDs, white markings; project colors, not official swatches.
export const colors={blue:[42,174,255],red:[255,65,82]} as const;
const hudColors={blue:[132,211,255],red:[255,134,145]} as const;
const sideNames={red:'红方',blue:'蓝方'} as const;
// Thin, precomputed bands give both Canvas and the software rasterizer the same fade.
const trailColors = {
  blue: [[55,65,81],[58,86,112],[68,122,166],[99,174,225],[174,224,255]],
  red: [[65,60,73],[95,64,78],[146,77,88],[212,104,110],[255,178,153]],
} as const;
export const glyphs: Record<string, string> = {
  '%':'101/001/010/100/101','0':'111/101/101/101/111','1':'010/110/010/010/111','2':'111/001/111/100/111','3':'111/001/111/001/111','4':'101/101/111/001/001','5':'111/100/111/001/111','6':'111/100/111/101/111','7':'111/001/010/010/010','8':'111/101/111/101/111','9':'111/101/111/001/111',
  A:'010/101/111/101/101',B:'110/101/110/101/110',C:'111/100/100/100/111',D:'110/101/101/101/110',E:'111/100/110/100/111',F:'111/100/110/100/100',G:'111/100/101/101/111',H:'101/101/111/101/101',I:'111/010/010/010/111',J:'001/001/001/101/111',K:'101/101/110/101/101',L:'100/100/100/100/111',M:'101/111/111/101/101',N:'101/111/111/111/101',O:'111/101/101/101/111',P:'111/101/111/100/100',Q:'111/101/101/111/001',R:'110/101/110/101/101',S:'111/100/111/001/111',T:'111/010/010/010/010',U:'101/101/101/101/111',V:'101/101/101/101/010',W:'101/101/111/111/101',X:'101/101/010/101/101',Y:'101/101/010/010/010',Z:'111/001/010/100/111',':':'000/010/000/010/000','.':'000/000/000/000/010','-':'000/000/111/000/000','/':'001/001/010/100/100',
};

export function paintScene(frame: DisplayFrame, painter: Painter, resultBanner = true) {
  const {pixel,rect,circle,line,text}=painter; const state=frame.scene,status=frame.status,countdownMs=frame.countdownMs;
  const W=R.width,H=R.height+80;
  const centerText=(value:string,y:number,color:Color,size:HudSize)=>text(value,(W-hudWidth(value,size))/2,y,color,size);
  rect(0,0,W,H,bg);
  // Flat floor paint only: no added obstacles or raised collision geometry.
  rect(0,0,W,78,[19,23,30]);
  for(let row=0;row<5;row++)for(let col=0;col<8;col++){
    const x=col*120+(row%2)*32,y=80+row*120;
    rect(x,y,92,86,(row+col)%3===0?[59,66,79]:[52,58,70]);
    line(x,y+88,x+110,y+88,[62,69,82]);
  }
  rect(0,80,6,H-80,[58,67,130]);rect(W-6,80,6,H-80,[58,67,130]);
  rect(W/2-68,0,136,3,[135,170,189]);
  rect(0,78,W,2,[110,125,140]);
  for (const x of [30,W-31]) line(x,110,x,H-31,[115,126,145]);
  line(30,110,W-31,110,[130,141,158]);line(30,H-31,W-31,H-31,[130,141,158]);
  // White chamfered spawn-zone markings and cobalt floor boundary stripes.
  for(const x of [210,750]){
    const points=[[x-85,350],[x-55,320],[x+55,320],[x+85,350],[x+85,410],[x+55,440],[x-55,440],[x-85,410]];
    for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];line(a[0],a[1],b[0],b[1],[141,152,170],1);}
    line(x-102,300,x+102,300,[92,103,190]);line(x-102,460,x+102,460,[92,103,190]);
  }
  for(let y=140;y<H-40;y+=40)line(W/2,y,W/2,y+16,[133,144,161]);
  circle(W/2,380,72,[104,115,134],true);
  for (const x of [45,W-46])for(const y of [125,H-46]){const sx=x<W/2?1:-1,sy=y<H/2?1:-1;line(x,y,x+sx*28,y,[205,212,224],1);line(x,y,x,y+sy*28,[205,212,224],1);}
  const recent = [];
  for (let i = state.events.length - 1; i >= 0; i--) { const e = state.events[i]; if (state.tick - e.tick > R.tickHz * 0.4) break; recent.push(e); }
  // Paint trails under the robots so armor stays readable at close range.
  for (const b of state.bullets) {
    const speed = Math.hypot(b.vx, b.vy) || 1;
    const dx = b.vx / speed * 5, dy = b.vy / speed * 5, y = b.y + 80;
    const palette = trailColors[b.owner];
    for (let i = 0; i < palette.length; i++) {
      const band = palette.length - i;
      line(b.x - dx * band, y - dy * band, b.x - dx * (band - 1), y - dy * (band - 1), palette[i]);
    }
    circle(b.x, y, 3, palette[3]);
    circle(b.x, y, R.bulletRadius, [255, 246, 222]);
  }
  for (const side of SIDE) {
    const r = state.robots[side], c = colors[side], x = r.x, y = r.y + 80;
    const hudX = side === 'red' ? 26 : W - 334;
    text(`${sideNames[side]} ${r.hp}`, hudX, 9, hudColors[side], 'score');
    rect(hudX, 40, 308, 7, [27, 43, 57]); rect(hudX, 40, 308 * r.hp / state.tuning.hp, 7, c);
    for (let bar = 1; bar < 10; bar++) rect(hudX + bar * 30.8, 40, 2, 7, bg);
    text(`弹药 ${r.ammo}`, hudX, 53, [190, 205, 221], 'label');
    if (r.heatUnits !== undefined) {
      const heat = r.heatUnits / R.tickHz;
      const hot = heat > R.heat.limit;
      const tint: Color = hot ? [255, 106, 92] : [226, 177, 99];
      text(`热量 ${hot ? Math.ceil(heat) : Math.floor(heat)}`, hudX + 114, 53, tint, 'label');
      rect(hudX + 211, 60, 97, 5, [48, 43, 42]);
      if (heat > 0) rect(hudX + 211, 60, 97 * Math.min(heat / R.heat.limit, 1), 5, tint);
    }
    const hurt = recent.find(e => e.type === 'hit' && e.target === side && state.tick - e.tick <= R.tickHz * 0.1);
    // The solid disk, rim, hub and armor all use the same chassis center.
    // No oversized offset shadow: it looked like an eccentric body boundary.
    circle(x, y, R.bodyRadius, r.hp === 0 ? [29, 31, 37] : hurt ? [111, 100, 89] : [19, 23, 31]);
    circle(x, y, R.bodyRadius, hurt ? [224, 197, 157] : [106, 116, 134], true);
    for (let p = 0; p < 4; p++) { const a = r.angle + p * Math.PI / 2; line(x + Math.cos(a) * 12, y + Math.sin(a) * 12, x + Math.cos(a) * 21, y + Math.sin(a) * 21, [96, 105, 122], 1); }
    // Metal chassis details remain inside the solid disk.
    for (let bolt=0;bolt<4;bolt++){const a=r.angle+Math.PI/4+bolt*Math.PI/2;circle(x+Math.cos(a)*18,y+Math.sin(a)*18,2,[168,178,195]);}
    circle(x, y, 11, [12, 23, 34]); circle(x, y, 8, r.hp === 0 ? [53, 55, 62] : [47, 55, 69]);
    const tx = x + Math.cos(r.turret) * R.barrelLength, ty = y + Math.sin(r.turret) * R.barrelLength;
    line(x, y, tx, ty, [8, 15, 23], 4);
    line(x, y, tx, ty, r.hp === 0 ? [86, 90, 95] : white, 2);
    line(tx - Math.cos(r.turret + Math.PI / 2) * 3, ty - Math.sin(r.turret + Math.PI / 2) * 3, tx + Math.cos(r.turret + Math.PI / 2) * 3, ty + Math.sin(r.turret + Math.PI / 2) * 3, [242, 247, 251], 1);
    for (let p = 0; p < 4; p++) {
      const a = r.angle + p * Math.PI / 2, co = Math.cos(a), si = Math.sin(a);
      const plateColor = r.hp === 0 ? [83, 72, 72] as const : hurt?.plate === p ? [255, 249, 222] as const : c;
      const offset = r.hp === 0 ? 5 : 0;
      const cx = x + co * (R.radius + offset), cy = y + si * (R.radius + offset);
      const halfX = (Math.abs(co) * R.plateThickness + Math.abs(si) * R.plateLength) / 2;
      const halfY = (Math.abs(si) * R.plateThickness + Math.abs(co) * R.plateLength) / 2;
      // Inverse-map pixel centers into the same finite rectangle as collision.
      // Half-open raster edges avoid adding a pixel at both ends of a dimension.
      for (let py = Math.ceil(cy - halfY); py <= cy + halfY; py++) for (let px = Math.ceil(cx - halfX); px <= cx + halfX; px++) {
        const radial = (px - cx) * co + (py - cy) * si, tangent = -(px - cx) * si + (py - cy) * co;
        if (radial >= -R.plateThickness / 2 && radial < R.plateThickness / 2 && tangent >= -R.plateLength / 2 && tangent < R.plateLength / 2) pixel(px, py, plateColor);
      }
    }
    if (r.hp === 0) { circle(x, y, 43, [227, 149, 86], true); for (let p = 0; p < 8; p++) { const a = p * Math.PI / 4 + r.angle; line(x + Math.cos(a) * 34, y + Math.sin(a) * 34, x + Math.cos(a) * 51, y + Math.sin(a) * 51, [255, 213, 132], 1); } }
  }
  for (const e of recent) {
    const age = (state.tick - e.tick) / R.tickHz;
    if (e.type === 'shot' && age < 0.065 && typeof e.x === 'number') {
      const a = e.angle as number, x = e.x as number, y = (e.y as number) + 80;
      circle(x, y, 5, [255, 232, 166]); line(x, y, x + Math.cos(a) * 12, y + Math.sin(a) * 12, [255, 250, 213], 2);
    }
    if(e.type==='block' && age<0.12){const x=e.x as number,y=(e.y as number)+80;circle(x,y,2+Math.floor(age*40),[189,200,219],true);}
    if (e.type === 'hit' && age < 0.25) {
      const x = e.x as number, y = (e.y as number) + 80, radius = Math.floor(5 + age * 65);
      circle(x, y, radius, age < 0.12 ? [255, 228, 164] : [135, 108, 72], true);
      for (let p = 0; p < 6; p++) { const a = p * Math.PI / 3 + (e.bullet as number) * 0.7; line(x + Math.cos(a) * radius, y + Math.sin(a) * radius, x + Math.cos(a) * (radius + 6), y + Math.sin(a) * (radius + 6), [255, 214, 132]); }
      text(`-${e.damage}`, x - 11, y - 19 - Math.floor(age * 25), [255, 231, 181], 2);
    }
  }
  const seconds = Math.max(0, Math.ceil(R.durationMs / 1000 - state.tick / R.tickHz));
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  centerText(time, 10, seconds <= 10 ? [255, 154, 138] : white, 'score');
  const phase = status === 'paused' ? '已暂停' : status === 'countdown' ? '准备'
    : status === 'ended' ? '已结束' : status === 'stopped' ? '已停止' : '回合 01';
  centerText(phase, 50, [190, 205, 221], 'label');
  if (status==='countdown') {
    rect(0,80,W,H-80,[7,16,27],.13);
    centerText('准备',262,[188,215,219],'label');
    centerText(String(Math.max(1,Math.ceil(countdownMs/1000))),292,[237,250,250],'countdown');
  }
  if (state.winner && resultBanner) {
    const result = state.winner === 'draw' ? '平局' : `${sideNames[state.winner]}胜利`;
    const deaths = state.overheatDeaths;
    rect(310, 352, 340, deaths?.length ? 73 : 52, [10, 18, 28]);
    centerText(result, 361, white, 'result');
    if (deaths?.length) {
      const reason = deaths.length === 2 ? '双方过热损毁' : `${sideNames[deaths[0]]}过热损毁`;
      centerText(reason, 400, [255, 151, 130], 'label');
    }
  }
}
