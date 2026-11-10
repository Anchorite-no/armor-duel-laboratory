import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SIDE, validateMotionAction, type ParticipantObservation, type Side } from '../shared/protocol.js';
import { BUILD_ID } from '../shared/build.js';
import { contestTools, scriptSdkDescription, type ContestResult } from './contest.js';
import { ContestRecordings } from './contest-recordings.js';
import { ParticipantWorkspace, defaultParticipantsDirectory, validateModelId } from './participant-workspace.js';
import { Program, verifyContestRuntime } from './program.js';
import { Laboratory } from './service.js';
import { replay } from './replay.js';
import { Game, type Setup } from './game.js';
import { VisualFeed } from './vision.js';

const failed = () => Error('Participant request failed.');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const readyTool = {name:'lab_ready',description:'确认本席已准备。script 使用当前保存的 bot.js，manual 使用直接动作。主控等待双方就绪后统一开局。改写 bot.js 会撤回本席就绪。',
  inputSchema:{type:'object',properties:{mode:{type:'string',enum:['script','manual']}},required:['mode'],additionalProperties:false}};
export const duelTools = [...contestTools.filter(tool=>tool.name!=='lab_retry').map(tool=>{
  if (tool.name==='lab_observe') return {...tool,description:'获取完整 JPEG 与传输序号。等待开局时显示静止的初始场景，不开局。'};
  if (tool.name==='lab_run_script') return {...tool,description:`在已开局时启动本局确认的脚本。开局时主控自动启动已确认的脚本。使用 lab_workspace_write 在局间改写 bot.js。${scriptSdkDescription}`,
    inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}};
  return tool;
}),readyTool];
export const duelInstructions = (side: Side) => `你的席位是 ${side}。请仅使用本连接的 lab 工具。画面和录像抽帧为 JPEG。使用自己的文件和脚本日志迭代，局间通过 lab_ready 确认本席准备完毕，由主控统一开局。`;

type Ready = {mode:'manual'} | {mode:'script';code:string};
type Seat = {modelId:string;workspace:ParticipantWorkspace;ready?:Ready;busy:boolean};
type Round = {directory:string;lab:Laboratory;programs:Record<Side,Program>;ready:Record<Side,Ready>;
  abort:AbortController; journal:Promise<void>; calls:Record<Side,number>; launches:Record<Side,number>};
type Phase = 'waiting' | 'starting' | 'playing' | 'saving' | 'review' | 'complete' | 'error' | 'closed';
export type DuelSeriesRules = {stopOnBlueWin?:boolean;maxRounds?:number};
const live = (lab: Laboratory) => ['countdown','running'].includes(lab.game.status);
const setup:Setup={clock:'realtime',scenario:'duel',targetSpin:0.65,controllers:{red:'agent',blue:'agent'}};
function argsWith(input:unknown, ...keys:string[]):Record<string,unknown> {
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==keys.length || keys.some(key=>!Object.hasOwn(input,key))) throw failed();
  return input as Record<string,unknown>;
}

export class ContestDuel {
  readonly #seats:Record<Side,Seat>;
  readonly #recordings:Record<Side,ContestRecordings>;
  #phase:Phase='waiting';
  #round?:Round;
  #number=0;
  #winner:Side|'draw'|null=null;
  #detail?:string;
  #pending?:Promise<unknown>;
  #timer?:NodeJS.Timeout;
  #closing=false;
  #preview?:Promise<ParticipantObservation>;

  constructor(readonly directory:string, modelIds:Record<Side,string>, participantsDirectory=defaultParticipantsDirectory,
    private readonly series:DuelSeriesRules={}) {
    const make = (id:string):Seat => ({modelId:validateModelId(id),workspace:new ParticipantWorkspace(participantsDirectory,id),busy:false});
    this.#seats={red:make(modelIds.red),blue:make(modelIds.blue)};
    if (this.#seats.red.modelId===this.#seats.blue.modelId) throw Error('Dual contest requires two distinct models');
    const recordingsDirectory=path.join(directory,'recordings');
    this.#recordings={red:new ContestRecordings(recordingsDirectory),blue:new ContestRecordings(recordingsDirectory)};
  }

  status() {
    return {buildId:BUILD_ID,phase:this.#phase,round:this.#number,winner:this.#winner,detail:this.#detail,
      matchId:this.#round?.lab.game.matchId,ready:{red:!!this.#seats.red.ready,blue:!!this.#seats.blue.ready}};
  }

  private audit(round:Round,entry:object) {
    const written=round.journal.then(()=>appendFile(path.join(round.directory,'tools.ndjson'),JSON.stringify({at:new Date().toISOString(),...entry})+'\n'));
    round.journal=written;
    return written;
  }

  private initialImage() {
    this.#preview??=(async()=>{
      const game=new Game();
      game.start(setup);
      const vision=new VisualFeed();
      try {const {image}=await vision.observe(()=>game.display());return {frameId:0,image};}
      finally {await vision.dispose();}
    })().catch(error=>{this.#preview=undefined;throw error;});
    return this.#preview;
  }

  async start() {
    if (this.#closing || !['waiting','review'].includes(this.#phase) || SIDE.some(side=>!this.#seats[side].ready || this.#seats[side].busy)) {
      throw Error('Both seats must be ready between rounds.');
    }
    const ready={red:this.#seats.red.ready!,blue:this.#seats.blue.ready!};
    this.#phase='starting';
    const operation=this.startRound(ready);
    this.#pending=operation;
    try {await operation;return this.status();}
    finally {this.#pending=undefined;}
  }

  private async startRound(ready:Round['ready']) {
    const directory=path.join(this.directory,`${++this.#number}-${randomUUID()}`);
    const guests={red:path.join(directory,'red'),blue:path.join(directory,'blue')};
    const lab=new Laboratory(path.join(directory,'referee'),undefined,false,this.#recordings.red.directory);
    const round:Round={directory,lab,ready,programs:{red:new Program(guests.red),blue:new Program(guests.blue)},
      abort:new AbortController(),journal:Promise.resolve(),calls:{red:0,blue:0},launches:{red:0,blue:0}};
    this.#round=round;
    this.#winner=null;
    this.#detail=undefined;
    let release=()=>{};
    const gate=new Promise<void>(resolve=>{release=resolve;});
    try {
      if (SIDE.some(side=>ready[side].mode==='script')) verifyContestRuntime();
      await Promise.all(SIDE.map(side=>mkdir(guests[side],{recursive:true})));
      await this.audit(round,{type:'attempt',round:this.#number,seats:Object.fromEntries(SIDE.map(side=>[side,this.#seats[side].modelId]))});
      const launches=await Promise.allSettled(SIDE.map(side=>ready[side].mode==='script'?this.launch(round,side,gate):undefined));
      const failure=launches.find(result=>result.status==='rejected');
      if (failure) throw failure.reason;
      if (this.#closing) throw Error('Duel is closing');
      await lab.admin('start',{setup:{...setup,recording:true}},undefined,()=>{
        if (lab.recordingInfo().status==='error') throw Error('Could not initialize round recording');
        if (SIDE.some(side=>ready[side].mode==='script' && round.programs[side].info().status!=='running')) throw Error('A staged runner exited before kickoff');
        release();
      });
      for (const side of SIDE) this.#seats[side].ready=undefined;
      this.#phase='playing';
      this.#timer=setInterval(()=>{
        if (!live(lab)) {
          clearInterval(this.#timer);
          const saving=this.finishRound(round).catch(error=>this.setError(error));
          this.#pending=saving;
          void saving.finally(()=>{this.#pending=undefined;});
        }
      },50);
    } catch (error) {
      round.abort.abort();
      await Promise.allSettled(SIDE.map(side=>round.programs[side].stop()));
      await lab.dispose();
      this.setError(error);
      throw error;
    }
  }

  private setError(error:unknown) {
    this.#phase='error';
    this.#detail=error instanceof Error?error.message:String(error);
  }

  private async launch(round:Round,side:Side,gate?:Promise<void>) {
    const ready=round.ready[side];
    if (ready.mode!=='script' || ++round.launches[side]>8) throw failed();
    await this.audit(round,{type:'script',side,code:ready.code,sha256:hash(ready.code)});
    round.abort.signal.throwIfAborted();
    if (!gate && !live(round.lab)) throw failed();
    await round.programs[side].run(ready.code,side,async(method,payload,signal)=>{
      if (method==='act' || method==='fire' || method==='cancel') await this.audit(round,{type:'script-action',side,method,action:(payload as {action?:unknown}).action});
      return this.control(round,side,method,(payload as {action?:unknown}).action,signal);
    },()=>{if(live(round.lab)) round.lab.game.cancel(side,'agent');},gate);
  }

  private async control(round:Round,side:Side,method:string,action:unknown,signal:AbortSignal) {
    if (round!==this.#round || !live(round.lab)) throw failed();
    return round.lab.participant(method,method==='act'?{side,action}:{side},'agent',AbortSignal.any([signal,round.abort.signal]));
  }

  private async finishRound(round:Round) {
    this.#phase='saving';
    const {lab}=round;
    this.#winner=lab.game.status==='ended'?lab.game.metadata().winner??null:null;
    round.abort.abort();
    await Promise.all(SIDE.map(side=>round.programs[side].stop()));
    await lab.saveRecord().catch(()=>{});
    const recording=lab.recordingInfo();
    if (this.#winner) for (const side of SIDE) this.#recordings[side].add(recording);
    const record=lab.game.refereeRecord();
    let replayIdentical=false,replayError:string|undefined;
    try {if (recording.dataPath) replayIdentical=replay(JSON.parse(await readFile(recording.dataPath,'utf8'))).identical;}
    catch (error) {replayError=error instanceof Error?error.message:String(error);}
    const result={round:this.#number,matchId:lab.game.matchId,winner:this.#winner,finalTick:record.finalTick,finalStep:record.finalStep,
      recording,replayIdentical,replayError,scripts:Object.fromEntries(SIDE.map(side=>[side,round.programs[side].info()]))};
    await round.journal;
    await writeFile(path.join(round.directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
    await lab.dispose();
    if (!this.#winner || recording.status!=='saved' || !replayIdentical) this.setError(Error(recording.error??'Round did not end with verified evidence.'));
    else this.#phase=(this.#winner==='blue' && this.series.stopOnBlueWin!==false) ||
      this.#number>=(this.series.maxRounds??Infinity)?'complete':'review';
  }

  async close() {
    this.#closing=true;
    clearInterval(this.#timer);
    await this.#pending?.catch(()=>{});
    clearInterval(this.#timer);
    const round=this.#round;
    if (round) {
      round.abort.abort();
      if (this.#phase==='playing') {
        await round.lab.admin('stop',{});
        await this.finishRound(round).catch(error=>this.setError(error));
      } else {
        await Promise.allSettled(SIDE.map(side=>round.programs[side].stop()));
        await round.lab.dispose();
      }
    }
    this.#phase='closed';
  }

  async seat(side:Side, name:unknown, args:unknown, signal:AbortSignal):Promise<ContestResult|{frame:{timestampMs:number;data:string}}> {
    if (this.#closing || !duelTools.some(tool=>tool.name===name)) throw failed();
    signal.throwIfAborted();
    const seat=this.#seats[side];
    if (seat.busy) throw failed();
    seat.busy=true;
    try {
      const between=['waiting','review'].includes(this.#phase);
      const round=this.#round;
      switch (name) {
        case 'lab_observe':
          if (between) {
            argsWith(args);
            const image=await this.initialImage();
            signal.throwIfAborted();
            return {image};
          }
          break;
        case 'lab_workspace_read': return {value:await seat.workspace.read(argsWith(args,'file').file)};
        case 'lab_workspace_write': {
          const {file,content}=argsWith(args,'file','content');
          if (file==='bot.js' && !between) throw failed();
          const value=await seat.workspace.write(file,content);
          if (file==='bot.js') seat.ready=undefined;
          return {value};
        }
        case 'lab_ready': {
          const {mode}=argsWith(args,'mode');
          if (!between || (mode!=='script' && mode!=='manual')) throw failed();
          if (mode==='script') {
            const {content}=await seat.workspace.read('bot.js');
            if (!content) throw failed();
            seat.ready={mode,code:content};
          } else seat.ready={mode};
          return {value:{ready:true,mode}};
        }
        case 'lab_recordings':
          argsWith(args);
          return {value:{recordings:this.#recordings[side].list(),saving:this.#phase==='saving'}};
        case 'lab_recording_frame': {
          const {recordingName,timestampMs}=argsWith(args,'recordingName','timestampMs');
          return {frame:await this.#recordings[side].frame(recordingName,timestampMs,signal)};
        }
        case 'lab_script_log': {
          argsWith(args);
          const info=round?.programs[side].info();
          return {value:{status:info?.status??'idle',output:info?.output??''}};
        }
      }
      if (!round || this.#phase!=='playing' || !live(round.lab) || ++round.calls[side]>1024) throw failed();
      const action=name==='lab_act'?validateMotionAction(argsWith(args,'action').action):undefined;
      if (name!=='lab_act') argsWith(args);
      await this.audit(round,{type:'tool',side,name,args});
      if (name==='lab_run_script' || name==='lab_stop_script') {
        if (name==='lab_run_script') await this.launch(round,side);
        else await round.programs[side].stop();
        return {value:{status:round.programs[side].info().status}};
      }
      if (name!=='lab_observe' && round.programs[side].info().status==='running') throw failed();
      const value=await this.control(round,side,(name as string).slice(4),action,signal);
      if (name==='lab_cancel') return {value:{cancelled:true}};
      return {image:value as ParticipantObservation};
    } finally {seat.busy=false;}
  }
}
