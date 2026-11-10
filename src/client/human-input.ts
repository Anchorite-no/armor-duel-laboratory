import type { Action, OwnerObservation, Side } from '../shared/protocol.js';
import { keyboardSide } from '../shared/room.js';
import type { Setup } from './types.js';
import { keyboardSpin, mouseButtons } from './controls.js';

export interface InputContext {
  phase:'room'|'battle'; connection:string; setup?:Setup; matchId?:string;
  status?:OwnerObservation['status']; side:Side; focused:boolean; blocked:boolean;
}
export function humanSide(setup?:Setup):Side|undefined {
  if(!setup)return;
  const sides=(['red','blue'] as const).filter(side=>setup.controllers[side]==='human');
  if(sides.length!==1)return;
  const side=sides[0];
  return !setup.room||keyboardSide(setup.room)===side?side:undefined;
}
export function canUseHumanInput(context:InputContext) {
  return context.phase==='battle'&&context.connection==='ready'&&!context.blocked&&!!context.matchId&&
    ['running','countdown'].includes(context.status??'')&&humanSide(context.setup)===context.side;
}
// Shared by native event handlers and sending: an observer never acquires local
// button/rotation state. Changing round, side or control mode clears held input.
export class HumanInput {
  readonly keys=new Set<string>();
  spin=0; fire=false; aimAssist=false; aimX=.5; aimY=.5;
  #scope='';
  #presses=new Map<string,number>();#serial=0;#samples=new WeakMap<object,Map<string,number>>();
  reset() { this.keys.clear();this.#presses.clear();this.spin=0;this.fire=false;this.aimAssist=false;this.aimX=.5;this.aimY=.5; }
  private bind(context:InputContext) {
    const scope=`${context.matchId}:${context.side}:${humanSide(context.setup)}`;
    if(scope!==this.#scope){this.reset();this.#scope=scope;}
    if(!canUseHumanInput(context)||!context.focused){this.reset();return false;}
    return true;
  }
  keyDown(context:InputContext,key:string,repeat=false) {
    if(!this.bind(context)||repeat||this.keys.has(key)||!['w','a','s','d','q','e','x',' '].includes(key))return false;
    this.keys.add(key);if(['w','a','s','d',' '].includes(key))this.#presses.set(key,++this.#serial);this.spin=keyboardSpin(this.spin,key);return true;
  }
  keyUp(context:InputContext,key:string) { if(!this.bind(context))return false;return this.keys.delete(key); }
  buttons(context:InputContext,buttons:number) {
    if(!this.bind(context))return false;
    const next=mouseButtons(buttons);if(next.fire&&!this.fire)this.#presses.set('mouse',++this.#serial);this.fire=next.fire;this.aimAssist=next.aimAssist;return true;
  }
  aim(context:InputContext,x:number,y:number) { if(!this.bind(context))return false;this.aimX=x;this.aimY=y;return true; }
  packet(context:InputContext):{side:Side;matchId:string;aimAssist:boolean;action:Action}|undefined {
    if(!this.bind(context))return;
    const held=(key:string)=>this.keys.has(key)||this.#presses.has(key);
    const moveX=Number(held('d'))-Number(held('a'));
    const moveY=Number(held('s'))-Number(held('w'));
    const spin=moveX||moveY?this.spin:Math.sign(this.spin);
    const movementScale=spin && (moveX||moveY) ? .8/Math.hypot(moveX,moveY) : 1;
    const packet={side:context.side,matchId:context.matchId!,aimAssist:this.aimAssist,action:{
      moveX:moveX*movementScale,moveY:moveY*movementScale,spin,aimX:this.aimX,aimY:this.aimY,fire:this.fire||held(' ')||this.#presses.has('mouse'),durationMs:100,
    }};
    this.#samples.set(packet,new Map(this.#presses));return packet;
  }
  acknowledge(packet:object){
    for(const [key,serial]of this.#samples.get(packet)??[])if(this.#presses.get(key)===serial)this.#presses.delete(key);
    this.#samples.delete(packet);
  }
}
