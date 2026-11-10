import { deflateSync } from 'node:zlib';
import { RULES as R, type OwnerObservation } from '../shared/protocol.js';
import { paintScene, glyphs, white, type Color, type DisplayScene } from '../shared/scene.js';
import { paintHudText, type HudSize } from '../shared/hud-font.js';
const W=R.width,H=R.height+80;
const colorRows = new Map<string, Buffer>();
const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function chunk(type: string, data: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff; for (const b of payload) crc = crcTable[(crc ^ b) & 255] ^ crc >>> 8;
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}
function rasterize(state: DisplayScene, status: OwnerObservation['status'], countdownMs = 0): Buffer {
  const bytes = Buffer.alloc((W * 3 + 1) * H);
  const pixel = (x: number, y: number, c: Color) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= W || y >= H) return; const i = y * (W * 3 + 1) + 1 + x * 3; bytes[i] = c[0]; bytes[i + 1] = c[1]; bytes[i + 2] = c[2]; };
  const rect = (x: number, y: number, w: number, h: number, c: Color, opacity=1) => {
    const x0=Math.max(0,Math.floor(x)),x1=Math.min(W,Math.ceil(x+w));if(x1<=x0)return;
    if (opacity<1) {
      const keep=1-opacity,r=c[0]*opacity,g=c[1]*opacity,b=c[2]*opacity;
      for (let j=Math.max(0,Math.floor(y));j<Math.min(H,y+h);j++) {
        const start=j*(W*3+1)+1;
        for (let i=start+x0*3;i<start+x1*3;i+=3) {
          bytes[i]=Math.round(bytes[i]*keep+r);
          bytes[i+1]=Math.round(bytes[i+1]*keep+g);
          bytes[i+2]=Math.round(bytes[i+2]*keep+b);
        }
      }
      return;
    }
    const key=c.join(',');let row=colorRows.get(key);if(!row){row=Buffer.alloc(W*3).fill(Buffer.from(c));colorRows.set(key,row);}
    for(let j=Math.max(0,Math.floor(y));j<Math.min(H,y+h);j++)row.copy(bytes,j*(W*3+1)+1+x0*3,0,(x1-x0)*3);
  };
  const circle = (x: number, y: number, r: number, c: Color, ring = false) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const d = i * i + j * j; if (d <= r * r && (!ring || d >= (r - 1.5) ** 2)) pixel(x + i, y + j, c); } };
  const line = (x: number, y: number, xx: number, yy: number, c: Color, radius = 0) => { const n = Math.ceil(Math.hypot(xx - x, yy - y)); for (let i = 0; i <= n; i++) { const f = n ? i / n : 0; circle(x + (xx - x) * f, y + (yy - y) * f, radius, c); } };
  const text = (s: string, x: number, y: number, c: Color = white, scale: HudSize|number = 2) => {
    if (typeof scale === 'number') {
      for (const ch of s.toUpperCase()) {
        const rows = glyphs[ch]?.split('/') ?? [];
        rows.forEach((row, j) => [...row].forEach((v, i) => { if (v === '1') rect(x + i * scale, y + j * scale, scale, scale, c); }));
        x += 4 * scale;
      }
      return;
    }
    paintHudText(s,x,y,scale,(left,row,width,opacity)=>{
      if (row<0 || row>=H) return;
      const end = Math.min(W,left+width);
      let i = row * (W*3+1) + 1 + Math.max(0,left)*3;
      for (let px=Math.max(0,left);px<end;px++) {
        bytes[i]=Math.round(bytes[i]*(1-opacity)+c[0]*opacity);i++;
        bytes[i]=Math.round(bytes[i]*(1-opacity)+c[1]*opacity);i++;
        bytes[i]=Math.round(bytes[i]*(1-opacity)+c[2]*opacity);i++;
      }
    });
  };
  paintScene({matchId:'raster',timestampMs:state.tick*1000/R.tickHz,countdownMs,status,scene:state}, {pixel,rect,circle,line,text});
  return bytes;
}
export function renderPixels(state: DisplayScene, status: OwnerObservation['status'], countdownMs = 0): { width: number; height: number; data: Uint8Array } {
  const raw = rasterize(state, status, countdownMs), data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) data.set(raw.subarray(y * (W * 3 + 1) + 1, (y + 1) * (W * 3 + 1)), y * W * 3);
  return { width: W, height: H, data };
}
export function render(state: DisplayScene, status: OwnerObservation['status'], countdownMs = 0): Buffer {
  const bytes = rasterize(state, status, countdownMs);
  const header = Buffer.alloc(13); header.writeUInt32BE(W); header.writeUInt32BE(H, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
