import { glyphs, white, type Color, type Painter } from '../shared/scene.js';
import { paintHudText } from '../shared/hud-font.js';
export function canvasPainter(ctx:CanvasRenderingContext2D):Painter {
  const color=(c:Color)=>`rgb(${c.join(',')})`;
  let fill='';
  const setFill=(c:Color)=>{const next=color(c);if(next!==fill){ctx.fillStyle=next;fill=next;}};
  const rect=(x:number,y:number,w:number,h:number,c:Color,opacity=1)=>{
    setFill(c);
    const alpha=ctx.globalAlpha;
    if(opacity!==1)ctx.globalAlpha=alpha*opacity;
    ctx.fillRect(x,y,w,h);
    if(opacity!==1)ctx.globalAlpha=alpha;
  };
  return {
    pixel:(x,y,c)=>rect(Math.round(x),Math.round(y),1,1,c),rect,
    circle:(x,y,r,c,ring=false)=>{ctx.beginPath();ctx.arc(x,y,ring?Math.max(0,r-0.75):r,0,Math.PI*2);if(ring){ctx.strokeStyle=color(c);ctx.lineWidth=1.5;ctx.stroke();}else{setFill(c);ctx.fill();}},
    line:(x,y,xx,yy,c,radius=0)=>{ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(xx,yy);ctx.strokeStyle=color(c);ctx.lineWidth=Math.max(1,radius*2);ctx.lineCap='round';ctx.stroke();},
    text:(s,x,y,c=white,scale=2)=>{
      setFill(c);
      if(typeof scale==='number') {
        for(const ch of s.toUpperCase()) {
          const rows=glyphs[ch]?.split('/')??[];
          rows.forEach((row,j)=>[...row].forEach((v,i)=>{if(v==='1')ctx.fillRect(x+i*scale,y+j*scale,scale,scale);}));
          x+=4*scale;
        }
        return;
      }
      const original=ctx.globalAlpha;
      let opacity=1;
      paintHudText(s,x,y,scale,(left,row,width,next)=>{
        if(next!==opacity){ctx.globalAlpha=original*next;opacity=next;}
        ctx.fillRect(left,row,width,1);
      });
      if(opacity!==1)ctx.globalAlpha=original;
    },
  };
}
