import React,{useEffect,useRef} from 'react';
export function UtilityDialog({title,close,children,wide=false}:{title:string;close():void;children:React.ReactNode;wide?:boolean}) {
  const body=useRef<HTMLElement>(null),button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;button.current?.focus();return()=>previous?.focus();},[]);
  return <div className="game-modal-shade" onPointerDown={e=>{if(e.target===e.currentTarget)close();}}>
    <section ref={body} className={`game-modal utility-dialog${wide?' is-wide':''}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return;}
      if(e.key!=='Tab')return;
      const items=body.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)');
      if(!items?.length)return;const first=items[0],last=items[items.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }}><button ref={button} className="game-modal-close" aria-label={`关闭${title}`} onClick={close}>×</button><h2>{title}</h2>{children}</section>
  </div>;
}
