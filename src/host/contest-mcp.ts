// Owner-launched MCP over stdio. File operations are scoped to the bound model.
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ContestAttempt, contestTools, type ContestConfig } from './contest.js';
import { validateFireInterval } from '../shared/protocol.js';
import { AI_ALIASES, DEFAULT_AI, validatePrivilegedAI } from '../shared/privileged-ai.js';
import { NotebookSizeError } from './participant-workspace.js';
import { duelInstructions, duelTools } from './contest-duel.js';
import { duelRequest, isDuelEndpoint } from './contest-duel-transport.js';

function option(name: string, fallback?: string) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(arg=>arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
const side = option('side','red');
const opponent = option('opponent','spinner');
if ((side!=='red' && side!=='blue') || (opponent!=='spinner' && opponent!=='fixed' && opponent!=='shooter' && opponent!=='privileged')) throw Error('Invalid contest seat or opponent');
const isSource = import.meta.url.replaceAll('\\','/').includes('/src/host/');
const directory = process.env.LAB_CONTEST_DIRECTORY ??
  fileURLToPath(new URL(isSource?'../../.local/contests/':'../.local/contests/',import.meta.url));
const fireInterval = option('min-fire-interval-ms');
const preset=opponent==='privileged'?DEFAULT_AI:AI_ALIASES[opponent==='shooter'?'fixed':opponent];
const opponentAI=validatePrivilegedAI({
  movement:option('opponent-movement',preset.movement),
  rotation:option('opponent-rotation',preset.rotation),
  shooting:option('opponent-shooting',preset.shooting),
});
const config: ContestConfig = {side,opponent,opponentAI,directory,modelId:option('model-id'),modelLabel:option('model-label'),reasoningEffortLabel:option('reasoning-effort-label'),
  participantsDirectory:process.env.LAB_PARTICIPANT_DIRECTORY,
  minFireIntervalMs:validateFireInterval(fireInterval===undefined?undefined:Number(fireInterval))};
const duel = process.argv.includes('--duel') ? loadDuelSeat() : undefined;
let attempt = duel ? undefined : new ContestAttempt(config);
function loadDuelSeat() {
  const seat=JSON.parse(process.env.LAB_DUEL_SEAT??'null');
  if (!seat || (seat.side!=='red' && seat.side!=='blue') || !isDuelEndpoint(seat.endpoint) ||
      typeof seat.key!=='string' || !/^[0-9a-f]{64}$/.test(seat.key)) throw Error('Missing or invalid duel seat configuration');
  return seat as {side:'red'|'blue';endpoint:string;key:string};
}
const protocols = ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'];
const active = new Map<string|number,AbortController>();
const reader = createInterface({input:process.stdin,crlfDelay:Infinity});
let initialized = false;
let closing: Promise<void> | undefined;

function close() {
  if (closing) return closing;
  for (const controller of active.values()) controller.abort();
  closing = (attempt?.close()??Promise.resolve()).catch(()=>{process.exitCode=1;});
  reader.close();
  return closing;
}
reader.on('close',()=>{void close();});
process.stdout.on('error',()=>{void close();});
process.once('SIGINT',()=>{void close();});
process.once('SIGTERM',()=>{void close();});

async function reply(id: string | number | null, result: object, error=false) {
  if(closing) return;
  if(!process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,[error?'error':'result']:result})+'\n')) await once(process.stdout,'drain');
}

async function receive(line: string) {
  if (line.length>256*1024) { await reply(null,{code:-32600,message:'Request too large'},true); return; }
  let request;
  try { request=JSON.parse(line); } catch { await reply(null,{code:-32700,message:'Parse error'},true); return; }
  if (request?.jsonrpc!=='2.0' || typeof request.method!=='string') {await reply(null,{code:-32600,message:'Invalid request'},true);return;}
  const {id,method,params}=request;
  if (method==='notifications/cancelled') { active.get(params?.requestId)?.abort(); return; }
  if (id===undefined) return;
  if (typeof id!=='number' && typeof id!=='string') { await reply(null,{code:-32600,message:'Invalid request ID'},true); return; }
  if (method==='initialize' && !initialized) {
    initialized=true;
    await reply(id,{protocolVersion:protocols.includes(params?.protocolVersion)?params.protocolVersion:'2025-06-18',
      serverInfo:{name:'laboratory-contest',version:'1.0.0'},capabilities:{tools:{}},instructions:duel?duelInstructions(duel.side):attempt!.instructions});
  } else if (method==='ping') await reply(id,{});
  else if (initialized && method==='tools/list') await reply(id,{tools:duel?duelTools:contestTools});
  else if (initialized && method==='tools/call' && !active.has(id)) {
    const controller = new AbortController();
    active.set(id,controller);
    try {
      const args = params?.arguments === undefined ? {} : params.arguments;
      if (duel) {
        const {status,value:result}=await duelRequest(duel.endpoint,'seat',duel.key,{side:duel.side,name:params?.name,args},
          AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]));
        if (status!==200) {
          const oversize=new NotebookSizeError();
          if (result?.error===oversize.message) throw oversize;
          throw Error('Participant request failed.');
        }
        if ('frame' in result) {
          const {timestampMs,data}=result.frame;
          await reply(id,{content:[{type:'text',text:JSON.stringify({timestampMs})},{type:'image',mimeType:'image/jpeg',data}]});
        } else await reply(id,{content:resultContent(result)});
        return;
      }
      if (!attempt) throw Error('Participant request failed.');
      if (params?.name==='lab_workspace_read' || params?.name==='lab_workspace_write') {
        const writing=params.name==='lab_workspace_write',workspace=attempt.workspace;
        if (!workspace || !args || typeof args!=='object' || Array.isArray(args) ||
            Object.keys(args).length!==(writing?2:1) || !Object.hasOwn(args,'file') ||
            (writing && !Object.hasOwn(args,'content'))) throw Error('Participant request failed.');
        controller.signal.throwIfAborted();
        const value=writing?await workspace.write(args.file,args.content):await workspace.read(args.file);
        await reply(id,{content:[{type:'text',text:JSON.stringify(value)}]});
        return;
      }
      if (params?.name==='lab_recordings') {
        if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length) throw Error('Participant request failed.');
        await reply(id,{content:[{type:'text',text:JSON.stringify(attempt.listRecordings())}]});
        return;
      }
      if (params?.name==='lab_recording_frame') {
        if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length!==2 ||
            !Object.hasOwn(args,'recordingName') || !Object.hasOwn(args,'timestampMs')) throw Error('Participant request failed.');
        const {timestampMs,data}=await attempt.recordings.frame(args.recordingName,args.timestampMs,controller.signal);
        await reply(id,{content:[{type:'text',text:JSON.stringify({timestampMs})},{type:'image',mimeType:'image/jpeg',data}]});
        return;
      }
      const result = params?.name==='lab_retry'
        ? await retry(args,controller.signal)
        : await attempt.call(params?.name,args,controller.signal);
      await reply(id,{content:resultContent(result)});
    } catch(error) {
      await reply(id,{isError:true,content:[{type:'text',text:error instanceof NotebookSizeError?error.message:'Participant request failed.'}]});
    }
    finally { active.delete(id); }
  } else await reply(id,{code:-32601,message:'Method not found'},true);
}

function resultContent(result: Awaited<ReturnType<ContestAttempt['call']>>) {
  return 'image' in result ? [{type:'text',text:JSON.stringify({frameId:result.image.frameId})},
    {type:'image',mimeType:'image/jpeg',data:result.image.image.base64}] : [{type:'text',text:JSON.stringify(result.value)}];
}

async function retry(args: unknown, signal: AbortSignal) {
  if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length || active.size!==1) throw Error('Participant request failed.');
  if (!attempt) throw Error('Participant request failed.');
  attempt = await attempt.retry(signal);
  return {value:{ready:true}};
}
reader.on('line',line=>{void receive(line).catch(()=>close());});
