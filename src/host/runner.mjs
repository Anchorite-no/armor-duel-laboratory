// The only readable file in the experimental subprocess. No authoritative state here.
import { createInterface } from 'node:readline';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import jpeg from 'jpeg-js';
const pending = new Map();
let sequence = 0, started = false;
const send = (method, payload) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject, method });
  process.stdout.write(JSON.stringify({ id, method, payload }) + '\n');
});
const lab = Object.freeze({
  observe: () => send('observe', null),
  act: action => send('act', action),
  fire: () => send('fire', null),
  cancel: () => send('cancel', null),
  log: value => send('log', String(value)),
  sleep: ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(5000, Number(ms) || 0)))),
  // Pixel decoding only; no detector, tracker, aim assistance or authoritative data.
  pixels: observation => {
    if(observation?.image?.mimeType!=='image/jpeg')throw Error('pixels 仅接受 JPEG 图像');
    const bytes=Buffer.from(observation.image.base64,'base64');
    if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)throw Error('无效 JPEG');
    const {width,height,data}=jpeg.decode(bytes,{useTArray:true,formatAsRGBA:false,tolerantDecoding:false,maxResolutionInMP:3,maxMemoryUsageInMB:64});
    if(width!==observation.image.width||height!==observation.image.height)throw Error('JPEG尺寸不匹配');
    return { width, height, channels: 3, data };
  },
});
createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { process.exit(1); }
  if (!started) {
    if (message.stage === true) { process.stdout.write('{"ready":true}\n'); return; }
    started = true;
    try { await new (Object.getPrototypeOf(async function(){}).constructor)('lab', '"use strict";\n' + message.code)(Object.freeze({ ...lab, side: message.side })); process.exit(0); }
    catch (error) {
      const diagnostic = { name: error instanceof Error ? error.name : 'Error',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) };
      const output = message.contest ? JSON.stringify(diagnostic) + '\n' : String(error);
      process.stderr.write(output, () => process.exit(1));
    }
  } else {
    const p = pending.get(message.id); if (!p) return;
    pending.delete(message.id);
    if(message.error){p.reject(new Error('Participant request failed.'));return;}
    if(['observe','act','fire'].includes(p.method)){
      const v=message.value;if(!v||!Number.isSafeInteger(v.frameId)||v.image?.mimeType!=='image/jpeg'){p.reject(new Error('参赛观察格式无效'));return;}
      p.resolve(Object.freeze({frameId:v.frameId,image:Object.freeze({mimeType:'image/jpeg',width:v.image.width,height:v.image.height,base64:v.image.base64})}));
    }else if(p.method==='cancel')p.resolve({cancelled:true});else p.resolve(message.value);
  }
});
