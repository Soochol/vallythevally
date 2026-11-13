import { expect, test } from 'vitest';
import { step, IDLE, FREEHAND_CAPTURE_LIMIT, type Context, type Input, type Interaction } from './interaction';
import { defineTool, type Placement, type ToolContext } from './toolSpec';
import { brush } from './tools/brush';
import { hline } from './tools/hline';
import { trendline } from './tools/trendline';
import type { DrawingPoint } from './types';
const ctx: ToolContext={toScreen:p=>({x:p.t,y:p.price}),fromScreen:p=>({t:p.x,price:p.y}),xOf:t=>t,yOf:p=>p,timeAt:x=>x,priceAt:y=>y,shiftBars:(t,n)=>t+n,barsBetween:()=>({count:1,volume:1}),paneWidth:800,paneHeight:500,formatPrice:String,formatTime:String,logScale:false};
const mods={ctrl:false,alt:false,shift:false};
function run(placement: Placement, events: Input[], finalize?: (p: readonly DrawingPoint[])=>DrawingPoint[]){
 const tool=defineTool({...hline,tool:'channel',placement,finalize});
 const c: Context={tool,selected:[],drawings:[],lockAll:false,registeredModes:new Set(),ctx,point:ctx.fromScreen};
 let state: Interaction=IDLE;let effects: ReturnType<typeof step>['effects']=[];let peak=0;
 for(const e of events){const result=step(state,e,c);state=result.state;effects.push(...result.effects);if(state.kind==='drawing')peak=Math.max(peak,state.points.length);}
 return {state,effects,peak};
}
const down=(x:number,y:number):Input=>({kind:'down',at:{x,y},mods,hit:{kind:'empty'}});
const move=(x:number,y:number):Input=>({kind:'move',at:{x,y},mods});
const up=(x:number,y:number):Input=>({kind:'up',at:{x,y},mods});
test('freehand finalizer receives end of a long stroke before limiting saved points',()=>{
 const events:Input[]=[down(0,10),...Array.from({length:1100},(_,i)=>move((i+1)/2,10)),up(600,10)];
 const r=run({kind:'freehand',min:2,max:1000},events,ps=>{const a=ps[0],b=ps.at(-1);return a&&b?[a,b]:[]});
 expect(r.effects).toMatchObject([{kind:'place',points:[{t:0,price:10},{t:600,price:10}]}]);
});
test('capture overflow stays bounded and keeps later input and the release endpoint in order',()=>{
 const end=FREEHAND_CAPTURE_LIMIT*5+20;
 const events:Input[]=[down(0,10),...Array.from({length:end-1},(_,i)=>move(i+1,10)),up(end,20)];
 let captured:readonly DrawingPoint[]=[];
 const r=run({kind:'freehand',min:2,max:1000},events,ps=>{captured=ps;return [...ps]});
 expect(r.peak).toBe(FREEHAND_CAPTURE_LIMIT);
 expect(captured.length).toBeGreaterThan(1000);
 expect(captured.length).toBeLessThanOrEqual(FREEHAND_CAPTURE_LIMIT);
 expect(captured[0]).toEqual({t:0,price:10});
 expect(captured.at(-2)?.t).toBe(end-1);
 expect(captured.at(-1)).toEqual({t:end,price:20});
 expect(captured.every((p,i)=>i===0||p.t>(captured[i-1]?.t??-1))).toBe(true);
 const placed=r.effects.find(e=>e.kind==='place');
 expect(placed?.points).toHaveLength(1000);
 expect(placed?.points[0]).toEqual({t:0,price:10});
 expect(placed?.points.at(-1)).toEqual({t:end,price:20});
});
test('storage limit follows finalization and preserves the finalized endpoints',()=>{
 const finalized=Array.from({length:2000},(_,t)=>({t,price:10}));
 const r=run({kind:'freehand',min:2,max:1000},[down(0,10),up(10,10)],()=>finalized);
 const placed=r.effects.find(e=>e.kind==='place');
 expect(placed?.points).toHaveLength(1000);
 expect(placed?.points[0]).toEqual(finalized[0]);
 expect(placed?.points.at(-1)).toEqual(finalized.at(-1));
});
test('freehand without a finalizer keeps the release endpoint at the storage limit',()=>{
 const r=run({kind:'freehand',min:2,max:1000},[down(0,10),...Array.from({length:1100},(_,i)=>move(i+1,10)),up(1200,20)]);
 const placed=r.effects.find(e=>e.kind==='place');
 expect(placed?.points).toHaveLength(1000);
 expect(placed?.points[0]).toEqual({t:0,price:10});
 expect(placed?.points.at(-1)).toEqual({t:1200,price:20});
});
test('freehand finalization below the saved minimum does not create an invalid drawing',()=>{
 const r=run({kind:'freehand',min:2,max:1000},[down(0,10),up(10,10)],()=>[{t:0,price:10}]);
 expect(r.effects).toEqual([]);
 expect(r.state).toEqual(IDLE);
});
test('freehand ignores the magnet for the press and every dragged point while other placements still snap',()=>{
 const magnet=(p:{x:number;y:number})=>({t:Math.floor(p.x/100)*100,price:0});
 const draw=(tool:Context['tool'],events:Input[])=>{
  const c: Context={tool,selected:[],drawings:[],lockAll:false,registeredModes:new Set(),ctx,point:magnet};
  let state: Interaction=IDLE;const effects: ReturnType<typeof step>['effects']=[];
  for(const e of events){const result=step(state,e,c);state=result.state;effects.push(...result.effects);}
  return effects;
 };
 const events:Input[]=[down(15,12),move(42,30),move(170,44),up(260,51)];
 expect(draw(brush,events)).toEqual([{kind:'place',tool:brush,points:[{t:15,price:12},{t:42,price:30},{t:170,price:44},{t:260,price:51}]}]);
 expect(draw(trendline,events)).toMatchObject([{kind:'place',points:[{t:0,price:0},{t:200,price:0}]}]);
});
