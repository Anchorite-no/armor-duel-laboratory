import { hudAtlas, hudCharacters } from './hud-atlas.js';
import { hudChineseAtlas, hudChineseCharacters } from './hud-chinese-atlas.js';
import { hudCountdownAtlas, hudCountdownCharacters } from './hud-countdown-atlas.js';

const atlases = {...hudAtlas,...hudCountdownAtlas};
export type HudSize = keyof typeof atlases;
type Span = readonly [x: number, y: number, width: number, coverage: number];

function decode(characters:string, [advance,height,encoded]: readonly [number,number,string], offset=0) {
  const bytes = atob(encoded);
  const coverage = (index: number) => (bytes.charCodeAt(index >> 1) >> (4 * (index & 1))) & 15;
  return [...characters].map((character, glyph) => {
    const spans: Span[] = [];
    for (let y=0; y<height; y++) {
      const row = (glyph * height + y) * advance;
      for (let x=0; x<advance;) {
        const opacity = coverage(row+x);
        let end = x+1;
        while (end<advance && coverage(row+end)===opacity) end++;
        if (opacity) spans.push([x,y+offset,end-x,opacity/4]);
        x=end;
      }
    }
    return [character,{advance,spans}] as const;
  });
}

function font(size:keyof typeof hudAtlas) {
  const latin=hudAtlas[size],chinese=hudChineseAtlas[size];
  const offset=Math.round((latin[1]-chinese[1])/2);
  return new Map([...decode(hudCharacters,latin),...decode(hudChineseCharacters,chinese,offset)]);
}
const fonts = {label:font('label'),score:font('score'),result:font('result'),
  countdown:new Map(decode(hudCountdownCharacters,hudCountdownAtlas.countdown))};
export function hudWidth(text: string, size: HudSize) {
  let width=0;
  for (const character of text.toUpperCase()) width+=fonts[size].get(character)?.advance??atlases[size][0];
  return width;
}

export function paintHudText(text: string, x: number, y: number, size: HudSize, span: (x:number,y:number,width:number,opacity:number)=>void) {
  x=Math.round(x);
  y=Math.round(y);
  for (const character of text.toUpperCase()) {
    const glyph = fonts[size].get(character);
    if (glyph) for (const [dx,dy,width,opacity] of glyph.spans) span(x+dx,y+dy,width,opacity);
    x+=glyph?.advance??atlases[size][0];
  }
}
