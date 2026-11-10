import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { lstat, open, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateSide, type Side } from '../shared/protocol.js';
import { ContestDuel, type DuelSeriesRules } from './contest-duel.js';
import { NotebookSizeError } from './participant-workspace.js';
import { duelRequest, isDuelEndpoint, makeDuelEndpoint } from './contest-duel-transport.js';

const [command,descriptor,argument1,argument2,...options]=process.argv.slice(2);
const failed='Participant request failed.';
const key=()=>randomBytes(32).toString('hex');
type Seats = Record<Side,string>;
type Session = {endpoint:string;owner:string;red:string;blue:string;seats?:Seats};

function serveOptions() {
  const series:DuelSeriesRules={};
  let reuse=false,evidence:string|undefined;
  for (const option of options) {
    if (option==='--reuse-session' && !reuse) {reuse=true;continue;}
    if (option.startsWith('--evidence-directory=') && evidence===undefined) {
      evidence=option.slice('--evidence-directory='.length);
      if (!evidence.trim()) throw Error('Evidence directory must be nonempty');
      continue;
    }
    if (/^--stop-on-blue-win=(true|false)$/.test(option) && series.stopOnBlueWin===undefined) {
      series.stopOnBlueWin=option.endsWith('true');continue;
    }
    if (/^--max-rounds=[1-9][0-9]*$/.test(option) && series.maxRounds===undefined) {
      const count=Number(option.slice('--max-rounds='.length));
      if (Number.isSafeInteger(count)) {series.maxRounds=count;continue;}
    }
    throw Error('Invalid or duplicate duel serve option');
  }
  if (reuse && !evidence) throw Error('--reuse-session requires a new --evidence-directory');
  return {series,reuse,evidence};
}

async function readSession():Promise<Session> {
  const info=await lstat(descriptor);
  if (!info.isFile() || info.isSymbolicLink() || info.size>4096) throw Error('Invalid duel session descriptor');
  const session=JSON.parse(await readFile(descriptor,'utf8'));
  const keys=[session?.owner,session?.red,session?.blue];
  if (!isDuelEndpoint(session?.endpoint) || keys.some(value=>typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) || new Set(keys).size!==3) {
    throw Error('Invalid duel session descriptor');
  }
  return session;
}

async function originalSeats(session:Session):Promise<Seats> {
  if (session.seats) return session.seats;
  // Older descriptors lack model IDs. The first round's owner journal binds both seats.
  const directory=path.resolve(descriptor+'.rounds');
  const rounds=(await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory() && /^1-[0-9a-f-]{36}$/.test(entry.name));
  if (rounds.length!==1) throw Error('Could not verify the original seat bindings');
  const journal=await open(path.join(directory,rounds[0].name,'tools.ndjson'),'r');
  try {
    const buffer=Buffer.alloc(4096);
    const {bytesRead}=await journal.read(buffer);
    const text=buffer.subarray(0,bytesRead).toString('utf8');
    const end=text.indexOf('\n');
    if (end<0) throw Error('Could not verify the original seat bindings');
    const entry=JSON.parse(text.slice(0,end));
    if (entry.type!=='attempt' || entry.round!==1 || !entry.seats) throw Error('Could not verify the original seat bindings');
    return entry.seats;
  } finally {await journal.close();}
}

async function requireInactive(endpoint:string) {
  const socket=createConnection(endpoint);
  try {
    socket.setTimeout(1000,()=>socket.destroy(Error('Could not check the duel endpoint')));
    await once(socket,'connect');
    throw Error('The original duel host is still active');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
  } finally {socket.destroy();}
}
function reply(response:ServerResponse,data:object,status=200) {
  response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
  response.end(JSON.stringify(data));
}
async function requestBody(request:IncomingMessage) {
  const chunks:Buffer[]=[];
  let size=0;
  for await (const chunk of request) {
    size+=chunk.length;
    if (size>256*1024) throw Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serve() {
  if (!argument1 || !argument2) throw Error('serve requires red and blue model IDs');
  const {series,reuse,evidence}=serveOptions();
  const seats={red:argument1,blue:argument2};
  const directory=path.resolve(evidence??process.env.LAB_DUEL_EVIDENCE_DIRECTORY??descriptor+'.rounds');
  const duel=new ContestDuel(directory,seats,process.env.LAB_PARTICIPANT_DIRECTORY,series);
  const session=reuse?await readSession():{endpoint:makeDuelEndpoint(),owner:key(),red:key(),blue:key(),seats};
  if (reuse) {
    await requireInactive(session.endpoint);
    const previous=await originalSeats(session);
    if (previous.red!==seats.red || previous.blue!==seats.blue) throw Error('Reused session must keep the original seat bindings');
    const relative=path.relative(path.resolve(descriptor+'.rounds'),directory);
    if (!relative || (!path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep))) {
      throw Error('Choose an evidence directory outside the original round directory');
    }
  }
  let accepting=false;
  let closing:Promise<void>|undefined;
  const server=createServer({maxHeaderSize:4096},(request,response)=>{
    const authorization=request.headers.authorization;
    const role=authorization===`Bearer ${session.owner}`?'owner':authorization===`Bearer ${session.red}`?'red':authorization===`Bearer ${session.blue}`?'blue':undefined;
    if (!accepting || request.method!=='POST' || !role || request.url!==(role==='owner'?'/owner':'/seat') || closing) {
      reply(response,{error:failed},403);
      return;
    }
    const controller=new AbortController();
    response.once('close',()=>{if(!response.writableFinished) controller.abort();});
    void (async()=>{
      try {
        const input=await requestBody(request);
        if (role!=='owner') {
          if (input.side!==role) throw Error(failed);
          reply(response,await duel.seat(role,input.name,input.args,controller.signal));
        } else if (input.command==='status') reply(response,duel.status());
        else if (input.command==='start') reply(response,await duel.start());
        else if (input.command==='stop') {reply(response,{stopping:true});void close();}
        else reply(response,{error:'Invalid owner command'},400);
      } catch(error) {
        const message=error instanceof Error && (role==='owner' || error instanceof NotebookSizeError)?error.message:failed;
        if (!response.destroyed) reply(response,{error:message},400);
      }
    })();
  });
  const close=()=>closing??=(async()=>{
    server.close();
    try {await duel.close();} catch(error) {console.error(error);process.exitCode=1;}
  })();
  await mkdir(path.dirname(path.resolve(descriptor)),{recursive:true});
  server.listen(session.endpoint);
  await once(server,'listening');
  try {
    // Exclusive creation also prevents pointing a resumed host at existing evidence.
    if (reuse) await mkdir(directory);
    else await writeFile(descriptor,JSON.stringify(session),{flag:'wx',mode:0o600});
  }
  catch(error) {await close();throw error;}
  accepting=true;
  process.once('SIGINT',()=>{void close();});
  process.once('SIGTERM',()=>{void close();});
  console.log(JSON.stringify(duel.status()));
}

async function main() {
  if (!descriptor) throw Error('Usage: contest-duel.mjs <serve|status|start|watch|stop|seat-config> <session.json>');
  if (command==='serve') return serve();
  const session=await readSession();
  if (command==='seat-config') {
    const side=validateSide(argument1);
    console.log(JSON.stringify({side,endpoint:session.endpoint,key:session[side]}));
    return;
  }
  if (!['status','start','watch','stop'].includes(command)) throw Error('Invalid owner command');
  do {
    const {status,value:result}=await duelRequest(session.endpoint,'owner',session.owner,{command:command==='watch'?'status':command},AbortSignal.timeout(30_000));
    if (status!==200) throw Error(result.error??'Owner request failed');
    if (command!=='watch' || !['starting','playing','saving'].includes(result.phase??'')) {console.log(JSON.stringify(result));return;}
    await delay(500);
  } while (true);
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
