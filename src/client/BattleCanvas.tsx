import React,{useEffect,useRef} from 'react';
import { RULES, type OwnerObservation } from '../shared/protocol.js';
import { paintScene, type DisplayFrame } from '../shared/scene.js';
import type { Api } from './types.js';
import { canvasPainter } from './canvas.js';
import { DISPLAY_HZ, FrameBuffer } from './display.js';
import type { RecordingInfo } from '../shared/recording.js';
interface DisplayResponse { frame:DisplayFrame;observation:Omit<OwnerObservation,'image'>;controllerError?:string;recording?:RecordingInfo }
export function BattleCanvas({api,onStatus,onError,onFrame}:{api:Api;onStatus(v:DisplayResponse):void;onError(message:string):void;onFrame?(frame:DisplayFrame):void}) {
  const canvas=useRef<HTMLCanvasElement>(null),callbacks=useRef({onStatus,onError,onFrame});callbacks.current={onStatus,onError,onFrame};
  useEffect(()=>{
    const ctx=canvas.current?.getContext('2d',{alpha:false});if(!ctx)return;
    const painter=canvasPainter(ctx),buffer=new FrameBuffer(),controller=new AbortController();
    let disposed=false,timer:ReturnType<typeof setTimeout>,raf=0,next=performance.now(),lastStatus=0,lastPhase='';
    let drawOrigin: number | undefined, lastDrawSlot = -1;
    const poll=async()=>{
      if(disposed)return;
      if(document.hidden){next=performance.now();timer=setTimeout(()=>void poll(),250);return;}
      let failed=false;
      try {
        const v=await api('display',{},AbortSignal.any([controller.signal,AbortSignal.timeout(3000)])) as DisplayResponse;
        if(disposed||document.hidden)return;const now=performance.now();buffer.push(v.frame,now);
        callbacks.current.onFrame?.(v.frame);
        if(now-lastStatus>=100||v.frame.status!==lastPhase){callbacks.current.onStatus(v);lastStatus=now;lastPhase=v.frame.status;}
        if(v.controllerError)callbacks.current.onError(v.controllerError);
      }catch(e){failed=true;if(!disposed)callbacks.current.onError(e instanceof Error?e.message:String(e));}
      finally {if(!disposed){const now=performance.now();next=Math.max(next+1000/DISPLAY_HZ,now);timer=setTimeout(()=>void poll(),failed?500:Math.max(0,next-now));}}
    };
    const draw=(now:number)=>{
      if(disposed)return;
      // The owner page has its own result dialog; JPEG participants still get
      // the default in-image result banner from the host renderer.
      drawOrigin ??= now;
      const slot = Math.floor((now - drawOrigin + 0.25) * DISPLAY_HZ / 1000);
      if (!document.hidden && slot !== lastDrawSlot) {
        lastDrawSlot = slot;
        const frame = buffer.sample(now);
        if (frame) paintScene(frame, painter, false);
      }
      raf=requestAnimationFrame(draw);
    };
    void poll();raf=requestAnimationFrame(draw);
    return()=>{disposed=true;controller.abort();clearTimeout(timer);cancelAnimationFrame(raf);};
  },[api]);
  return <canvas ref={canvas} width={RULES.width} height={RULES.height+80} className="battle-canvas" role="img" aria-label="装甲对决战场、血量和剩余时间"/>;
}
