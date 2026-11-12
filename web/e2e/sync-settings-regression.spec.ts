import { selectOption } from "./select-option";
import { test, expect, cell, chartOf, type App } from './harness';
import type { Page } from '@playwright/test';
import type { Drawing } from '../src/api/generated/Drawing';

const drawings = async (app: App): Promise<Drawing[]> => (await fetch(`${app.url}/api/drawings?symbol=IDX%3A001`)).json();
async function mirror(page: Page) {
  return JSON.parse(await chartOf(cell(page)).locator('.drawing-mirror').getAttribute('data-drawings') ?? '[]');
}
async function open(page: Page) {
  await page.goto('/');
  await expect(chartOf(cell(page))).toHaveAttribute('data-bar-count', /^[1-9]\d*$/);
}
async function draw(page: Page) {
  const r = (await chartOf(cell(page)).boundingBox())!;
  await cell(page).focus(); await page.keyboard.press('H');
  await page.mouse.click(r.x+r.width*.75,r.y+r.height*.4);
}

test('first slow GET must retain preexisting drawings after creation', async ({page,app}, info) => {
  await open(page); await draw(page);
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  const existing=(await drawings(app))[0]!;
  let release!:()=>void; const gate=new Promise<void>(resolve=>release=resolve);
  let started=false;
  await page.route('**/api/drawings?**',async route=>{
    started=true;
    const response=await route.fetch();
    await gate;
    await route.fulfill({response}).catch(()=>{});
  });
  await page.reload();
  await expect(chartOf(cell(page))).toHaveAttribute('data-bar-count',/^[1-9]\d*$/);
  await expect.poll(()=>started).toBe(true);
  await draw(page);
  await expect.poll(async ()=>(await drawings(app)).length).toBe(2);
  release();
  await expect.poll(async ()=>(await mirror(page)).length).toBe(2);
  console.log('SLOW_GET',JSON.stringify({existing:existing.id,server:(await drawings(app)).map(d=>d.id),visible:await mirror(page)}));
  await page.screenshot({path:info.outputPath('slow-get.png')});
  expect((await mirror(page)).map((d:{id:string})=>d.id)).toContain(existing.id);
});

test('server accepted extreme timestamp must not blank settings', async ({page,app}, info)=>{
  await open(page); await draw(page);
  await expect.poll(async ()=>(await drawings(app)).length).toBe(1);
  const d=(await drawings(app))[0]!;
  const body={...d,points:[{...d.points[0]!,t:9007199254740991}],revision:d.revision+100};
  const res=await fetch(`${app.url}/api/drawings/${d.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  expect(res.status).toBe(200);
  await page.reload(); await expect.poll(async ()=>(await mirror(page)).length).toBe(1);
  await page.getByRole('button',{name:'개체 목록 열기'}).click();
  await page.getByRole('button',{name:'고르기: 수평선'}).click();
  await page.getByRole('button',{name:'드로잉 세부 설정',exact:true}).click();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('summary').filter({hasText:/^좌표$/}).click();
  await expect(page.getByRole('spinbutton',{name:'점 1 가격'})).toBeVisible();
  await expect(page.getByLabel('점 1 시각')).toHaveCount(0);
  console.log('EXTREME_TIME',JSON.stringify({status:res.status,errors,body:await page.locator('body').innerText()}));
  await page.screenshot({path:info.outputPath('extreme-time.png')});
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('spinbutton',{name:'점 1 가격'}).fill('5500');
  await page.getByRole('button',{name:'확인',exact:true}).click();
  await expect.poll(async ()=>(await drawings(app))[0]?.points[0]?.price).toBe(5500);
  expect((await drawings(app))[0]?.points[0]?.t).toBe(9007199254740991);
  expect(errors).toEqual([]);
});

test('late PUT response must not allow undo to delete newer other-tab work', async ({page,app},info)=>{
  await open(page);
  let release!:()=>void; const gate=new Promise<void>(r=>release=r);
  let accepted!:()=>void; const putAccepted=new Promise<void>(r=>accepted=r);
  await page.route('**/api/drawings/*',async route=>{
    if(route.request().method()!=='PUT') return route.continue();
    const response=await route.fetch(); accepted(); await gate; await route.fulfill({response});
  });
  await draw(page); await putAccepted;
  const initial=(await drawings(app))[0]!;
  const other=await page.context().newPage();
  await other.goto(app.url); await expect.poll(async ()=>(await mirror(other)).length).toBe(1);
  await other.getByRole('button',{name:'개체 목록 열기'}).click();
  await other.getByRole('button',{name:'고르기: 수평선'}).click();
  await selectOption(other.getByRole('toolbar',{name:'드로잉 스타일'}).getByLabel('선 굵기'), '4');
  await expect.poll(async ()=>(await drawings(app))[0]?.style).toMatchObject({line:{width:4}});
  const remote=(await drawings(app))[0]!;
  await page.bringToFront();
  const loaded=page.waitForResponse(r=>r.url().includes('/api/drawings?')&&r.request().method()==='GET');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await (await loaded).finished();
  await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  release();
  await expect.poll(()=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('vv.unsaved.drawing.')).length)).toBe(0);
  await cell(page).focus(); await page.keyboard.press('Control+z');
  await expect.soft(page.getByText('다른 곳에서 바뀐 드로잉이라 되돌리지 않았습니다')).toBeVisible();
  expect((await drawings(app)).find(d=>d.id===initial.id)?.style).toMatchObject({line:{width:4}});
  await page.screenshot({path:info.outputPath('late-ack-loss.png')});
  console.log('BROWSER_LATE_ACK',JSON.stringify({initialRevision:initial.revision,newerRevision:remote.revision,newerStyle:remote.style,afterUndo:await drawings(app)}));
  expect((await drawings(app)).map(d=>d.id)).toContain(initial.id);
});

test('visible extreme timestamp has a safe numeric editor and preserves unrelated edits', async ({page,app}) => {
  await open(page); await draw(page);
  await expect.poll(async ()=>(await drawings(app)).length).toBe(1);
  const d=(await drawings(app))[0]!;
  const point=d.points[0]!;
  const response=await fetch(`${app.url}/api/drawings/${d.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...d,tool:'trendline',points:[{...point,t:Number.MAX_SAFE_INTEGER},{...point,t:point.t+86400}],revision:d.revision+100})});
  expect(response.status).toBe(200);
  await page.reload(); await expect.poll(async ()=>(await mirror(page)).length).toBe(1);
  await page.getByRole('button',{name:'개체 목록 열기'}).click();
  await page.getByRole('button',{name:'고르기: 추세선'}).click();
  await page.getByRole('button',{name:'드로잉 세부 설정',exact:true}).click();
  await page.locator('summary').filter({hasText:/^좌표$/}).click();
  const seconds=page.getByRole('textbox',{name:'점 1 시각 (Unix 초)'});
  await expect(seconds).toHaveValue(String(Number.MAX_SAFE_INTEGER));
  await seconds.fill('9007199254740992');
  await expect(seconds).toHaveValue(String(Number.MAX_SAFE_INTEGER));
  await page.getByRole('spinbutton',{name:'점 1 가격'}).fill('5600');
  await page.getByRole('button',{name:'확인',exact:true}).click();
  await expect.poll(async ()=>(await drawings(app))[0]?.points[0]?.price).toBe(5600);
  expect((await drawings(app))[0]?.points[0]?.t).toBe(Number.MAX_SAFE_INTEGER);
});
