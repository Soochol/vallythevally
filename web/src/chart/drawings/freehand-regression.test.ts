import { expect, test } from 'vitest';
import { step, IDLE, type Context, type Input, type Interaction } from './interaction';
import { defineTool, type Placement, type ToolContext } from './toolSpec';
import { hline } from './tools/hline';
import type { DrawingPoint } from './types';
const ctx: ToolContext={toScreen:p=>({x:p.t,y:p.price}),fromScreen:p=>({t:p.x,price:p.y}),xOf:t=>t,yOf:p=>p,shiftBars:(t,n)=>t+n,barsBetween:()=>({count:1,volume:1}),paneWidth:800,paneHeight:500,formatPrice:String,formatTime:String,logScale:false};
const mods={ctrl:false,alt:false,shift:false};
function run(placement: Placement, events: Input[], finalize?: (p: readonly DrawingPoint[])=>DrawingPoint[]){
 const tool=defineTool({...hline,tool:'channel',placement,finalize});
 const c: Context={tool,selected:[],drawings:[],lockAll:false,registeredModes:new Set(),ctx,point:ctx.fromScreen};
 let state: Interaction=IDLE;let effects: ReturnType<typeof step>['effects']=[];
 for(const e of events){const result=step(state,e,c);state=result.state;effects.push(...result.effects);}
 return {state,effects};
}
const down=(x:number,y:number):Input=>({kind:'down',at:{x,y},mods,hit:{kind:'empty'}});
const move=(x:number,y:number):Input=>({kind:'move',at:{x,y},mods});
const up=(x:number,y:number):Input=>({kind:'up',at:{x,y},mods});
test('freehand finalizer receives end of a long stroke before limiting saved points',()=>{
 const events:Input[]=[down(0,10),...Array.from({length:1100},(_,i)=>move((i+1)/2,10)),up(600,10)];
 const r=run({kind:'freehand',min:2,max:1000},events,ps=>{const a=ps[0],b=ps.at(-1);return a&&b?[a,b]:[]});
 expect(r.effects).toMatchObject([{kind:'place',points:[{t:0,price:10},{t:600,price:10}]}]);
});
