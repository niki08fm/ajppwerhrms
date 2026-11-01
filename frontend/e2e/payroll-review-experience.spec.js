import {expect,test} from '@playwright/test';
const YM='2026-09';
async function mockReview(page,{steps=[],failAttendance=false,failSubmit=false,readonly=false,holdRefresh=false,deferSubmit=false}={}){
 let fail=failAttendance, release;const gate=new Promise(resolve=>release=resolve);
 const state={writes:[],period:{period_ym:YM,state:'DRAFT',steps_submitted:steps,step_log:[]},refreshHeld:false};
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1','');let data=[];
  if(path==='/auth/me')data={name:'HR manager',role:'HR Admin',permissions:['people.read','attendance.read','payroll.read',...(readonly?[]:['payroll.run'])]};
  else if(path==='/lookups')data={today:'2026-10-30',departments:[],pay_groups:[],sites:[]};
  else if(path==='/dashboard/people')data={approvals:{total:0}};
  else if(path==='/payroll/periods')return route.fulfill({json:{data:[state.period],meta:{suggested:YM,current:'2026-10'}}});
  else if(path===`/payroll/periods/${YM}`){if(state.refreshHeld)await gate;data=state.period;}
  else if(path.endsWith('/attendance')){
   if(fail)return route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Attendance is temporarily unavailable. Please try again.'}}});
   data={rows:[],shortlist:[]};
  }else if(path.endsWith('/joiners'))data={joiners:[],leavers:[],leaving_later:[],pipeline:[]};
  else if(path.includes('/steps/')){
   state.writes.push({path,method:req.method()});
   if(deferSubmit)await gate;
   if(failSubmit)return route.fulfill({status:409,json:{error:{code:'BLOCKING_ISSUES',message:'Review the pending attendance corrections before continuing.'}}});
   const step=Number(path.split('/').at(-2));
   state.period={...state.period,steps_submitted:path.endsWith('/reopen')?state.period.steps_submitted.filter(n=>n<step):[...new Set([...state.period.steps_submitted,step])].sort()};
   state.refreshHeld=holdRefresh;data=state.period;
  }
  await route.fulfill({json:{data}});
 });
 return {...state,get writes(){return state.writes;},release,restoreAttendance:()=>{fail=false;}};
}
test('confirmation moves to the next review using the server result while refresh waits',async({page})=>{
 const s=await mockReview(page,{holdRefresh:true});
 try{
  await page.goto(`/payroll/${YM}?step=1`);await page.getByRole('button',{name:'Confirm attendance',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Step 2 · Joiners and exits',exact:true})).toBeVisible();
  expect(s.writes).toEqual([{path:`/payroll/periods/${YM}/steps/1/submit`,method:'POST'}]);
 }finally{s.release();}
});
test('reopening names the affected reviews and requires a deliberate confirmation',async({page})=>{
 const s=await mockReview(page,{steps:[1,2,3]});await page.goto(`/payroll/${YM}?step=1`);
 await page.getByRole('button',{name:'Reopen review',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Reopen this review?'});
 await expect(dialog).toContainText('Attendance');await expect(dialog).toContainText('Joiners and exits');await expect(dialog).toContainText('Employee checks');
 await dialog.getByRole('button',{name:'Keep review complete'}).click();expect(s.writes).toHaveLength(0);
 await page.getByRole('button',{name:'Reopen review',exact:true}).click();await dialog.getByRole('button',{name:'Reopen review',exact:true}).click();
 await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Confirm attendance',exact:true})).toBeEnabled();
 expect(s.writes).toEqual([{path:`/payroll/periods/${YM}/steps/1/reopen`,method:'POST'}]);
});
test('failed attendance cannot be confirmed and can be retried in place',async({page})=>{
 const s=await mockReview(page,{failAttendance:true});await page.goto(`/payroll/${YM}?step=1`);
 await expect(page.getByRole('button',{name:'Confirm attendance',exact:true})).toBeDisabled();
 await expect(page.getByText('This review could not be loaded',{exact:true})).toBeVisible({timeout:15000});
 s.restoreAttendance();await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('button',{name:'Confirm attendance',exact:true})).toBeEnabled();expect(s.writes).toHaveLength(0);
});
test('a refused confirmation stays on the review and keeps its reason visible',async({page})=>{
 const s=await mockReview(page,{failSubmit:true});await page.goto(`/payroll/${YM}?step=1`);await page.getByRole('button',{name:'Confirm attendance',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Step 1 · Attendance',exact:true})).toBeVisible();
 await expect(page.locator('p[role="alert"]')).toHaveText('Review the pending attendance corrections before continuing.');
 expect(s.writes).toHaveLength(1);
});
test('a viewer can inspect reviews without being offered a writable action',async({page})=>{
 const s=await mockReview(page,{readonly:true});await page.goto(`/payroll/${YM}?step=1`);
 await expect(page.getByText('View-only access',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Confirm attendance',exact:true})).toBeDisabled();expect(s.writes).toHaveLength(0);
});

test('a confirmation finishing after leaving the review does not pull the user back',async({page})=>{
 const s=await mockReview(page,{deferSubmit:true});
 try{
  await page.goto(`/payroll/${YM}?step=1`);await page.getByRole('button',{name:'Confirm attendance',exact:true}).click();await expect.poll(()=>s.writes.length).toBe(1);
  await page.getByRole('button',{name:'Back to overview',exact:true}).click();await expect(page).not.toHaveURL(/step=/);s.release();
  await expect(page.getByText('Attendance confirmed for September 2026.',{exact:true})).toBeVisible();await expect(page).not.toHaveURL(/step=/);
  await expect(page.getByRole('heading',{name:'Payroll',exact:true})).toBeVisible();
 }finally{s.release();}
});
