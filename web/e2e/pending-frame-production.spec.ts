import { test, expect, cell, chartOf } from './harness';
test.use({ clockStart: '20261109100000' });
test('minute rollover and style replacement keep subsequent live updates working', async ({page,app}) => {
  const errors: string[] = []; const delivered: number[] = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>socket.on('framereceived',({payload})=>{const message=JSON.parse(String(payload));if(message.type==='bar')delivered.push(message.bar.c);}));
  await page.goto('/?symbol=005930'); await expect(cell(page)).toHaveAttribute('aria-busy','false');
  const chart=chartOf(cell(page)); const box=(await chart.boundingBox())!;
  await cell(page).focus();await page.keyboard.press('T');
  await page.mouse.move(box.x+box.width*.76,box.y+box.height*.4);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.86,box.y+box.height*.3,{steps:10});await page.mouse.up();
  await expect.poll(async()=> (await(await fetch(`${app.url}/api/drawings?symbol=005930`)).json()).length).toBe(1);
  await page.getByRole('combobox',{name:'분봉',exact:true}).selectOption('1m');
  await expect(cell(page)).toHaveAttribute('aria-busy','false');
  const trade=async(price:number,time:string)=>{
    await expect(async()=>{expect(await app.fake.pushReal('0B','005930_AL',{'20':time,'10':`+${price}`,'15':'+1','13':'1000','9081':'KRX','11':'+0','12':'+0.00','25':'2'})).toBeGreaterThan(0);await expect.poll(()=>delivered.includes(price),{timeout:1000}).toBe(true);}).toPass({timeout:15000});
  };
  await trade(201000,'100001');await expect(chart).toHaveAttribute('data-last-close','201000');
  await page.getByRole('button',{name:'봉 모양',exact:true}).click();
  await expect(page.getByRole('menuitemradio',{name:'라인',exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const original=window.requestAnimationFrame.bind(window);const cancel=window.cancelAnimationFrame.bind(window);
    const pending=new Map<number,FrameRequestCallback>();let id=900000;
    window.requestAnimationFrame=callback=>{pending.set(++id,callback);return id;};
    window.cancelAnimationFrame=key=>{if(!pending.delete(key))cancel(key);};
    Reflect.set(window,'releaseReviewFrames',()=>{window.requestAnimationFrame=original;window.cancelAnimationFrame=cancel;for(const callback of pending.values())original(callback);});
  });
  await trade(202000,'100059');await trade(203000,'100100');
  await page.getByRole('menuitemradio',{name:'라인',exact:true}).evaluate(element=>(element as HTMLElement).click());
  await page.evaluate(()=>Reflect.get(window,'releaseReviewFrames')());
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await trade(204000,'100101');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  console.log('PRODUCTION_PENDING_FRAME',JSON.stringify({errors,delivered,lastClose:await chart.getAttribute('data-last-close')}));
  expect.soft(errors).toEqual([]);
  await expect(chart).toHaveAttribute('data-last-close','204000',{timeout:1000});
});
