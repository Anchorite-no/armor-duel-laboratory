import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const endpointPrefix=process.platform==='win32'?'\\\\.\\pipe\\lab-duel-':path.join(tmpdir(),'lab-duel-');
export const makeDuelEndpoint=()=>endpointPrefix+randomUUID();
export function isDuelEndpoint(endpoint:unknown):endpoint is string {
  return typeof endpoint==='string' && endpoint.startsWith(endpointPrefix) && /^[0-9a-f-]{36}$/.test(endpoint.slice(endpointPrefix.length));
}

export function duelRequest(endpoint:string, role:'owner'|'seat', key:string, payload:object, signal:AbortSignal) {
  if (!isDuelEndpoint(endpoint)) throw Error('Invalid duel endpoint');
  const body=JSON.stringify(payload);
  return new Promise<{status:number;value:any}>((resolve,reject)=>{
    const req=request({socketPath:endpoint,path:`/${role}`,method:'POST',agent:false,signal,
      headers:{authorization:`Bearer ${key}`,'content-length':Buffer.byteLength(body)}},async response=>{
      try {
        const chunks:Buffer[]=[];
        let size=0;
        for await (const chunk of response) {
          size+=chunk.length;
          if (size>3*1024*1024) throw Error('Response too large');
          chunks.push(chunk);
        }
        resolve({status:response.statusCode??500,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))});
      } catch (error) {reject(error);}
    });
    req.on('error',reject);
    req.end(body);
  });
}
