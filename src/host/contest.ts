import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Laboratory } from './service.js';
import type { Setup } from './game.js';
import { Program, verifyContestRuntime } from './program.js';
import { RULES, validateMotionAction, type ParticipantObservation, type Side } from '../shared/protocol.js';
import { replay } from './replay.js';
import { ContestRecordings } from './contest-recordings.js';
import { BOT_CHARS, NOTEBOOK_BYTES, ParticipantWorkspace, defaultParticipantsDirectory, participantFiles } from './participant-workspace.js';
import { AI_ALIASES, DEFAULT_AI, validatePrivilegedAI, type PrivilegedAI } from '../shared/privileged-ai.js';

const object = (properties: Record<string,object> = {}, required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const axis = (minimum: number, maximum: number) => ({type:'number',minimum,maximum});
const action = object({moveX:axis(-1,1),moveY:axis(-1,1),spin:axis(-1,1),aimX:axis(0,1),aimY:axis(0,1),durationMs:{type:'integer',minimum:1,maximum:RULES.maxActionMs}});
const actionDescription = [
  '动作必须包含以下全部字段。moveX、moveY 是 [-1,1] 内的横向、纵向移动输入，正值向右、向下。',
  'spin 是 [-1,1] 内的底盘旋转输入，正值顺时针，负值逆时针，0 表示不旋转。',
  'aimX、aimY 是 [0,1] 内的归一化场地瞄准坐标，从场地左上角向右、向下递增，场地区域不含顶部 HUD。',
  `durationMs 是移动与瞄准的保持时长，取 [1,${RULES.maxActionMs}] 内的整数，单位毫秒。`,
].join(' ');
export const scriptSdkDescription = [
  '可读取 lab.side。',
  'await lab.observe()、await lab.act(action) 和 await lab.fire() 均返回 {frameId, image: {mimeType: "image/jpeg", width, height, base64}}。frameId 是图像传输序号。',
  'await lab.fire() 请求单发，每次最多发一颗，冷却中的请求直接丢弃。当前移动与瞄准保持生效。',
  'lab.pixels(observation) 同步解码并返回 {width, height, channels: 3, data: Uint8Array}。data 从图像左上角开始逐行存储，每像素按 R、G、B 交错排列，无 Alpha 通道，通道值为 0–255。',
  '可用 await lab.cancel() 取消动作、await lab.log(value) 写日志、await lab.sleep(ms) 等待（0–5000 毫秒）。',
  actionDescription,
].join(' ');
const attemptTools = [
  {name:'lab_observe',description:'获取完整 JPEG 与传输序号。',inputSchema:object()},
  {name:'lab_act',description:`为已绑定席位提交动作，返回完整 JPEG 与传输序号。${actionDescription}`,inputSchema:object({action})},
  {name:'lab_fire',description:'为已绑定席位请求单发，每次最多发一颗。冷却中的请求直接丢弃。当前移动与瞄准保持生效。返回完整 JPEG 与传输序号。',inputSchema:object()},
  {name:'lab_cancel',description:'取消当前动作。',inputSchema:object()},
  {name:'lab_run_script',description:`为已绑定席位运行 JavaScript，替换前一份脚本。提供 code 时同步保存到 bot.js，省略 code 时运行已保存的 bot.js。${scriptSdkDescription}`,inputSchema:object({code:{type:'string',minLength:1,maxLength:BOT_CHARS}},[])},
  {name:'lab_stop_script',description:'停止本席位脚本。',inputSchema:object()},
  {name:'lab_script_log',description:'读取本席位当前脚本状态和近期日志。',inputSchema:object()},
] as const;
const file = {type:'string',enum:participantFiles};
export const contestTools = [...attemptTools,
  {name:'lab_retry',description:'上一局结束后，以同一席位和相同设置准备新一局。下一次参赛工具调用开始新局。',inputSchema:object()},
  {name:'lab_recordings',description:'列出本连接已结束且保存完成的录像名称和时长（毫秒）。',inputSchema:object()},
  {name:'lab_recording_frame',description:'从本连接已保存的录像按时间取一张 JPEG。recordingName 使用 lab_recordings 列出的 MP4 文件名。timestampMs 是毫秒，0 为准备期第一帧，必须有限且在 [0,录像时长) 内。',inputSchema:object({recordingName:{type:'string'},timestampMs:{type:'number',minimum:0}})},
  {name:'lab_workspace_read',description:'读取本模型的 notebook.md 或 bot.js。文件尚未保存时 content 为 null。此操作不会开局。',inputSchema:object({file})},
  {name:'lab_workspace_write',description:`替换本模型的 notebook.md 或 bot.js。笔记上限为 ${NOTEBOOK_BYTES} 个 UTF-8 字节，脚本使用现有长度限制。此操作不会开局或运行脚本。`,inputSchema:object({file,content:{type:'string',maxLength:BOT_CHARS}})},
] as const;
export const contestInstructions = (side: Side) => `你的席位是 ${side}。目标是赢得一局。请仅使用本连接的 lab 工具。通过 JPEG 画面和自己的脚本日志探索，你可以直接提交动作或编写脚本。lab_workspace_read 与 lab_workspace_write 可保存你的笔记与当前脚本，一局结束后可复盘录像或调用 lab_retry。`;

export type ContestConfig = { side: Side; opponent: 'privileged' | 'spinner' | 'fixed' | 'shooter'; opponentAI?:PrivilegedAI; modelId?:string; modelLabel?: string; reasoningEffortLabel?: string; minFireIntervalMs?:number; directory: string; participantsDirectory?:string };
export type ContestResult = { image: ParticipantObservation } | { value: object };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const active = (status: string) => status === 'running' || status === 'countdown';

// One owner-created attempt, one seat and match ID. Only the adapter receives
// this object; the participant never obtains the Laboratory or the journal.
export class ContestAttempt {
  readonly directory: string;
  readonly instructions: string;
  #lab: Laboratory;
  #program: Program;
  #starting?: Promise<void>;
  #matchId?: string;
  #audit = Promise.resolve();
  #finish?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #abort = new AbortController();
  #closed = false;
  #busy = false;
  #calls = 0;
  #scripts = 0;
  #startedAt?: number;
  readonly recordings: ContestRecordings;
  readonly workspace?: ParticipantWorkspace;

  constructor(private readonly config: ContestConfig, private readonly controllerSeeds?: Setup['controllerSeeds'], recordings?:ContestRecordings) {
    this.directory = path.join(path.resolve(config.directory),randomUUID());
    this.instructions = contestInstructions(config.side);
    const modelId=config.modelId??config.modelLabel;
    if (modelId!==undefined) this.workspace=new ParticipantWorkspace(config.participantsDirectory??defaultParticipantsDirectory,modelId);
    this.recordings=recordings??new ContestRecordings(path.join(this.directory,'recordings'));
    this.#lab = new Laboratory(path.join(this.directory,'referee'),undefined,false,this.recordings.directory);
    this.#program = new Program(path.join(this.directory,'guest'));
  }

  private audit(entry: object) {
    const line = JSON.stringify({at:new Date().toISOString(),...entry})+'\n';
    const written = this.#audit.then(()=>appendFile(path.join(this.directory,'tools.ndjson'),line));
    this.#audit = written.catch(()=>{});
    return written;
  }

  private async start() {
    await mkdir(path.join(this.directory,'guest'),{recursive:true});
    await this.audit({type:'attempt',modelLabel:this.config.modelLabel ?? null,
      modelId:this.config.modelId??this.config.modelLabel??null,
      reasoningEffortLabel:this.config.reasoningEffortLabel ?? null, modelAttested:false,
      side:this.config.side, opponent:this.config.opponent, instructions:this.instructions, tools:contestTools});
    const other = this.config.side === 'red' ? 'blue' : 'red';
    const opponent=this.config.opponent;
    const opponentAI=validatePrivilegedAI(this.config.opponentAI ?? (opponent==='privileged'?DEFAULT_AI:AI_ALIASES[opponent==='shooter'?'fixed':opponent]));
    await this.#lab.admin('start',{setup:{clock:'realtime',scenario:opponent==='spinner'?'spinner':opponent==='privileged'?'duel':'shooter',
      targetSpin:.65,controllers:{[this.config.side]:'agent',[other]:'privileged'},privilegedAI:{[other]:opponentAI},recording:true,controllerSeeds:this.controllerSeeds,minFireIntervalMs:this.config.minFireIntervalMs}});
    this.#matchId = this.#lab.game.matchId;
    this.#startedAt = performance.now();
    this.#lab.startClock();
    this.#timer = setInterval(()=>{
      if(this.#lab.game.status==='ended' || this.#lab.game.status==='stopped') void this.finish().catch(()=>{});
    },50);
    this.#timer.unref();
  }

  private assertBound(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#closed || this.#matchId !== this.#lab.game.matchId || this.#lab.game.setup.controllers[this.config.side] !== 'agent') {
      throw Error('Participant request failed.');
    }
  }

  private async seatCall(method: string, action: unknown, signal: AbortSignal) {
    this.assertBound(signal);
    const result = await this.#lab.participant(method,method==='act'?{side:this.config.side,action}:{side:this.config.side},'agent',signal);
    this.assertBound(signal);
    return result;
  }

  private async imageResult(value: unknown, source: 'model' | 'script') {
    const image = value as ParticipantObservation;
    if (!Number.isSafeInteger(image?.frameId) || image.image?.mimeType!=='image/jpeg') throw Error('Participant request failed.');
    const bytes = Buffer.from(image.image.base64,'base64');
    await this.audit({type:'image',source,frameId:image.frameId,sha256:hash(bytes),bytes:bytes.length});
    return image;
  }

  async call(name: string, args: unknown, requestSignal = new AbortController().signal): Promise<ContestResult> {
    if (this.#closed || this.#busy || ++this.#calls > 1024 || !attemptTools.some(tool=>tool.name===name)) throw Error('Participant request failed.');
    this.#busy = true;
    const signal = AbortSignal.any([requestSignal,this.#abort.signal]);
    const started = performance.now();
    const call = this.#calls;
    try {
      if (args===null || typeof args!=='object' || Array.isArray(args)) throw Error('Participant request failed.');
      const input = args as Record<string,unknown>;
      const keys=Object.keys(input);
      if (name==='lab_act' ? keys.length!==1 || keys[0]!=='action' :
          name==='lab_run_script' ? keys.some(key=>key!=='code') : keys.length!==0) throw Error('Participant request failed.');
      const validated = name==='lab_act' ? validateMotionAction(input.action) : undefined;
      let scriptCode: string|undefined;
      if (name==='lab_run_script') {
        if (!this.workspace) throw Error('Participant request failed.');
        const code=Object.hasOwn(input,'code')?input.code:(await this.workspace.read('bot.js')).content;
        if(typeof code!=='string' || code.length<1 || code.length>BOT_CHARS) throw Error('Participant request failed.');
        scriptCode=code;
      }
      signal.throwIfAborted();
      this.#starting ??= this.start();
      await this.#starting;
      this.assertBound(signal);
      await this.audit({type:'tool',call,name,args:scriptCode===undefined?args:{code:scriptCode},scriptSha256:scriptCode===undefined?undefined:hash(scriptCode)});
      let result: ContestResult;
      switch (name) {
        case 'lab_observe': result={image:await this.imageResult(await this.seatCall('observe',undefined,signal),'model')};break;
        case 'lab_act':
          if (this.#program.info().status==='running') throw Error('Participant request failed.');
          result={image:await this.imageResult(await this.seatCall('act',validated,signal),'model')};break;
        case 'lab_fire':
          if (this.#program.info().status==='running') throw Error('Participant request failed.');
          result={image:await this.imageResult(await this.seatCall('fire',undefined,signal),'model')};break;
        case 'lab_cancel': await this.seatCall('cancel',undefined,signal);result={value:{cancelled:true}};break;
        case 'lab_run_script': {
          if (!active(this.#lab.game.status) || ++this.#scripts>8) throw Error('Participant request failed.');
          const runtime = verifyContestRuntime();
          const revision = this.#scripts;
          await this.audit({type:'script-runtime',revision,runtime:runtime.version});
          await this.#program.stop();
          await this.seatCall('cancel',undefined,signal);
          if (!active(this.#lab.game.status)) throw Error('Participant request failed.');
          if (Object.hasOwn(input,'code')) await this.workspace!.write('bot.js',scriptCode);
          this.assertBound(signal);
          if (!active(this.#lab.game.status)) throw Error('Participant request failed.');
          await this.#program.run(scriptCode,this.config.side,async (method,payload,programSignal)=>{
            const combined = AbortSignal.any([programSignal,this.#abort.signal]);
            const action = (payload as {action?:unknown}).action;
            const result = await this.seatCall(method,action,combined);
            if (method==='act' || method==='fire') await this.audit({type:'script-action',revision,method,action});
            return method==='cancel' ? result : this.imageResult(result,'script');
          },()=>{
            if(this.#lab.game.matchId===this.#matchId) this.#lab.game.cancel(this.config.side,'agent');
            const {status,output} = this.#program.info();
            void this.audit({type:'script-end',revision,status,output}).catch(()=>{});
          });
          result={value:{status:this.#program.info().status}};
          break;
        }
        case 'lab_stop_script': await this.#program.stop();result={value:{status:this.#program.info().status}};break;
        case 'lab_script_log': {
          const {status,output}=this.#program.info();result={value:{status,output}};break;
        }
        default: throw Error('Participant request failed.');
      }
      this.assertBound(signal);
      await this.audit({type:'tool-result',call,ok:true,elapsedMs:performance.now()-started,result:'value' in result?result.value:{frameId:result.image.frameId}});
      return result;
    } catch (error) {
      if (this.#starting) await this.audit({type:'tool-result',call,name,ok:false,elapsedMs:performance.now()-started,diagnostic:error instanceof Error?error.message:'Unknown error'}).catch(()=>{});
      throw Error('Participant request failed.');
    } finally { this.#busy=false; }
  }

  finish() {
    this.#finish ??= this.saveResult();
    return this.#finish;
  }

  async retry(signal: AbortSignal) {
    if (this.#busy || !this.#matchId || this.#lab.game.status!=='ended') throw Error('Participant request failed.');
    signal.throwIfAborted();
    const {controllerSeeds} = this.#lab.game.setup;
    await this.close();
    signal.throwIfAborted();
    return new ContestAttempt(this.config,controllerSeeds,this.recordings);
  }

  listRecordings() {
    const status=this.#lab.recordingInfo().status;
    return {recordings:this.recordings.list(),saving:this.#lab.game.status==='ended'&&(status==='saving'||status==='recording')};
  }

  async close() {
    this.#closed=true;
    this.#abort.abort();
    try { await this.finish(); } finally { await this.#lab.dispose(); }
  }

  private async saveResult() {
    clearInterval(this.#timer);
    if (!this.#starting) return;
    await this.#starting.catch(()=>{});
    clearInterval(this.#timer);
    await this.#program.stop();
    if (this.#matchId && active(this.#lab.game.status)) await this.#lab.admin('stop',{});
    const record = this.#matchId ? this.#lab.game.refereeRecord() : undefined;
    const elapsedMs = this.#startedAt===undefined ? null : performance.now()-this.#startedAt;
    await this.#lab.waitForRecording();
    const recording=this.#lab.recordingInfo();
    if (this.#lab.game.status==='ended') this.recordings.add(recording);
    let replayIdentical = false, replayError: string | undefined;
    try { if (recording.dataPath) replayIdentical = replay(JSON.parse(await readFile(recording.dataPath,'utf8'))).identical; }
    catch (error) { replayError = error instanceof Error ? error.message : String(error); }
    const winner = record?.finalState.winner ?? null;
    const result = {matchId:this.#matchId ?? null, requestedModel:this.config.modelLabel ?? null,
      requestedReasoningEffort:this.config.reasoningEffortLabel ?? null, modelAttested:false, usage:null,
      outcome:winner===this.config.side?'win':winner==='draw'?'draw':winner?'loss':'aborted',winner,
      side:this.config.side,opponent:this.config.opponent, elapsedMs,
      setup:record?.setup, finalStep:record?.finalStep, recording, replayIdentical,replayError,
      script:this.#program.info(), toolCalls:this.#calls, scriptRevisions:this.#scripts };
    await this.#audit;
    await writeFile(path.join(this.directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }
}
