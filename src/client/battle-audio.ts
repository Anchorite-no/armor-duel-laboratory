import { RULES } from '../shared/protocol.js';
import type { DisplayFrame } from '../shared/scene.js';

export type BattleSound = 'shot' | 'hit' | 'destroy';
const preference = 'laboratory.battle-audio';
export function readBattleAudio() {
  try { return localStorage.getItem(preference)==='on'; } catch { return false; }
}
export function saveBattleAudio(enabled: boolean) {
  try { localStorage.setItem(preference,enabled?'on':'off'); } catch { /* Storage is optional. */ }
}

export class SoundEvents {
  #cursor?: {matchId:string;status:DisplayFrame['status'];tick:number};
  reset() { this.#cursor=undefined; }
  take(frame: DisplayFrame): BattleSound[] {
    const {matchId,status,scene:{tick,events}}=frame;
    const previous=this.#cursor;
    this.#cursor={matchId,status,tick};
    if (previous?.matchId!==matchId || previous.status!=='running' || tick<=previous.tick || (status!=='running' && status!=='ended')) return [];
    const earliest=Math.max(previous.tick,tick-Math.floor(RULES.tickHz*.12));
    const sounds=new Set<BattleSound>();
    for (const event of events) {
      if (event.tick<earliest || event.tick>=tick) continue;
      if ((event.type==='hit' || event.type==='overheat') && event.hp===0) sounds.add('destroy');
      else if (event.type==='hit') sounds.add('hit');
      else if (event.type==='shot') sounds.add('shot');
    }
    return [...sounds];
  }
}

const recipes = {
  shot: {wave:'square',from:310,to:92,length:.075,volume:.065,cutoff:1100,q:1.05,gap:.05},
  hit: {gap:.075},
  destroy: {wave:'sawtooth',from:124,to:29,length:.29,volume:.15,cutoff:480,q:2,gap:.24},
} as const;
type Voice = {nodes:AudioScheduledSourceNode[]; output:GainNode; effects:AudioNode[]};
const armorResonances = [
  {frequency:1344,volume:.13,length:.068},
  {frequency:2175.6,volume:.053,length:.043},
  {frequency:3298.8,volume:.025,length:.027},
] as const;

export class BattleAudio {
  #enabled: boolean;
  #context?: AudioContext;
  #master?: GainNode;
  #noise?: AudioBuffer;
  #voices=new Set<Voice>();
  #last=new Map<BattleSound,number>();
  #events=new SoundEvents();
  constructor(enabled: boolean) { this.#enabled=enabled; }

  setEnabled(enabled: boolean) {
    this.#enabled=enabled;
    this.silence();
    if (this.#master && this.#context) this.#master.gain.setValueAtTime(enabled ? .7 : 0,this.#context.currentTime);
    if (enabled) this.unlock();
  }
  unlock() {
    if (!this.#enabled) return;
    try {
      if (!this.#context) {
        const context=new AudioContext(), master=context.createGain();
        master.gain.value=.7;
        master.connect(context.destination);
        this.#context=context;this.#master=master;
        const noise=context.createBuffer(1,Math.ceil(context.sampleRate*.30),context.sampleRate);
        const samples=noise.getChannelData(0);
        for (let i=0;i<samples.length;i++) samples[i]=Math.random()*2-1;
        this.#noise=noise;
      }
      if (this.#context.state!=='running') void this.#context.resume().catch(()=>{});
    } catch { /* Audio support must not affect the game. */ }
  }
  frame(frame: DisplayFrame) {
    if (frame.status==='paused' || frame.status==='stopped') {this.silence();return;}
    if (!this.#enabled || this.#context?.state!=='running') {this.#events.reset();return;}
    const sounds=this.#events.take(frame);
    if (sounds.includes('destroy')) this.play('destroy');
    for (const sound of sounds) if (sound!=='destroy') this.play(sound);
  }
  private play(kind: BattleSound) {
    const context=this.#context!, now=context.currentTime, recipe=recipes[kind];
    if (now-(this.#last.get(kind)??-Infinity)<recipe.gap) return;
    if (this.#voices.size>=4) {
      if (kind!=='destroy') return;
      this.endVoice(this.#voices.values().next().value!);
    }
    this.#last.set(kind,now);
    if (kind==='hit') {this.playMetalHit(context,now);return;}
    const toneRecipe=recipes[kind];
    const output=context.createGain(),tone=context.createOscillator(),burst=context.createBufferSource(),filter=context.createBiquadFilter();
    const end=now+toneRecipe.length, peak=now+.006;
    output.gain.setValueAtTime(.0001,now);
    output.gain.linearRampToValueAtTime(toneRecipe.volume,peak);
    output.gain.exponentialRampToValueAtTime(.0001,end);
    output.connect(this.#master!);
    tone.type=toneRecipe.wave;
    tone.frequency.setValueAtTime(toneRecipe.from,now);tone.frequency.exponentialRampToValueAtTime(toneRecipe.to,end);
    tone.connect(output);
    burst.buffer=this.#noise!;
    filter.type='lowpass';filter.frequency.value=toneRecipe.cutoff;
    filter.Q.value=toneRecipe.q;
    burst.connect(filter);filter.connect(output);
    const voice={nodes:[tone,burst],output,effects:[filter]};
    this.#voices.add(voice);
    tone.onended=()=>this.endVoice(voice);
    tone.start(now);burst.start(now);
    tone.stop(end);burst.stop(now+toneRecipe.length*.75);
  }
  private playMetalHit(context:AudioContext,now:number) {
    const output=context.createGain();
    output.connect(this.#master!);
    const parts=armorResonances.map(({frequency,volume,length})=>{
      const tone=context.createOscillator(),envelope=context.createGain();
      tone.frequency.setValueAtTime(frequency,now);
      envelope.gain.setValueAtTime(.0001,now);
      envelope.gain.linearRampToValueAtTime(volume,now+.0015);
      envelope.gain.exponentialRampToValueAtTime(.0001,now+length);
      tone.connect(envelope);envelope.connect(output);
      return {tone,envelope,length};
    });
    const voice={nodes:parts.map(p=>p.tone),output,effects:parts.map(p=>p.envelope)};
    this.#voices.add(voice);
    parts[0].tone.onended=()=>this.endVoice(voice);
    for (const {tone,length} of parts) {tone.start(now);tone.stop(now+length);}
  }
  private endVoice(voice: Voice) {
    if (!this.#voices.delete(voice)) return;
    for (const node of voice.nodes) {node.onended=null;try {node.stop();} catch {} node.disconnect();}
    for (const effect of voice.effects) effect.disconnect();
    voice.output.disconnect();
  }
  silence() {
    this.#events.reset();this.#last.clear();
    for (const voice of this.#voices) this.endVoice(voice);
  }
  dispose() {
    this.silence();
    const context=this.#context;
    this.#context=undefined;this.#master=undefined;this.#noise=undefined;
    if (context && context.state!=='closed') void context.close().catch(()=>{});
  }
}
