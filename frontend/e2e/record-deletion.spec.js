import {expect,test} from '@playwright/test';
import {createPreviewSetupData,previewStructureView} from '../../docs/designs/payroll-preview-setup.js';
const group={id:'group-test',name:'Site staff',headcount:0,pay_day:7,calendar_method:'FIXED_26',weekly_off:['SUN'],shift:{name:'Day',start_min:540,end_min:1080},policies:[],warnings:[],divisor_this_month:26};
async function mock(page,{blocked=false,fail=false,readonly=false}={}){
 const writes=[],setup=createPreviewSetupData(),structure=previewStructureView(setup,setup.structures[0].id);let deleted=false;
 const employee={id:'employee-test',name:'Example Employee',code:'AJTEST',status:'EXITED',read_only:true,joined_on:'2024-01-01',last_day:'2026-09-30',department:{name:'Operations',colour:'chart-1'},pay_group:group,salary:null,onboarding:{required_left:0},rules:{shift:group.shift}};
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1','');let data=[];
  if(req.method()==='DELETE'){
   writes.push({path,body:req.postDataJSON()});
   if(fail){await route.fulfill({status:409,json:{error:{code:'DELETE_BLOCKED',message:'A new employee assignment was added. Move it first.'}}});return;}
   deleted=true;data={deleted:true,history_retained:true};
  }else if(path==='/auth/me')data={name:'HR Admin',role:'HR Admin',permissions:readonly?['setup.read','people.read']:['setup.read','setup.write','people.read','people.write','salary.read','salary.write']};
  else if(path.endsWith('/deletion')){
   const kind=path.startsWith('/employees')?'employee':path.startsWith('/structures')?'structure':'group';
   const row=kind==='employee'?employee:kind==='structure'?structure:group;
   data={id:row.id,name:row.name,code:row.code,kind,can_delete:!blocked,assigned_count:blocked?1:0,blockers:blocked?['Move 1 linked employee to another group first.']:[],employees:blocked?[{...employee,status:'ACTIVE',source:'Current or future salary'}]:[],effects:['Remove this record from active lists.','Keep paid payslips, attendance and audit history.']};
  }else if(path==='/pay-groups')data=deleted?[]:[group];
  else if(path==='/structures')data=deleted?[]:[structure];
  else if(path==='/dashboard/people')data={approvals:{total:0}};
  else if(path==='/lookups')data={today:'2026-10-31',departments:[],structures:[structure],pay_groups:[group],sites:[]};
  else if(path==='/employees/employee-test')data=employee;
  else if(path==='/employees')data=[];
  else if(path.endsWith('/hold'))data={current:null};
  else if(path.endsWith('/leave-balances'))data={types:[]};
  else if(path==='/advances-loans')data={rows:[]};
  await route.fulfill({json:{data,meta:{total:0,nextCursor:null}}});
 });return {writes,structure};
}
for(const kind of ['group','structure'])test(`${kind} deletion requires its exact name and removes only the confirmed record`,async({page})=>{
 const {writes,structure}=await mock(page),label=kind==='group'?'pay group':'salary structure',name=kind==='group'?group.name:structure.name;
 await page.goto(kind==='group'?'/setup/pay-groups':'/setup/structures');
 await page.getByRole('button',{name:`Delete ${label} ${name}`,exact:true}).click();
 const dialog=page.getByRole('dialog'),input=dialog.getByRole('textbox',{name:`Type ${label} name to confirm deletion`}),button=dialog.getByRole('button',{name:`Delete ${label}`,exact:true});
 await expect(dialog).toContainText('Keep paid payslips, attendance and audit history.');
 for(const text of [name.toLowerCase(),name+' ',name.slice(1)]){await input.fill(text);await expect(button).toBeDisabled();}
 await expect.poll(()=>writes.length).toBe(0);await input.fill(name);await expect(button).toBeEnabled();await button.click();
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(writes).toEqual([{path:`/${kind==='group'?'pay-groups':'structures'}/${kind==='group'?group.id:structure.id}`,body:{confirm_name:name}}]);
 await expect(page.getByRole('button',{name:`Delete ${label} ${name}`,exact:true})).toHaveCount(0);
});
test('linked employees block deletion and open the reassignment dialog',async({page})=>{
 await mock(page,{blocked:true});await page.goto('/setup/pay-groups');await page.getByRole('button',{name:'Delete pay group Site staff'}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Example Employee');await expect(dialog.getByRole('button',{name:'Delete pay group',exact:true})).toBeDisabled();
 await dialog.getByRole('button',{name:'Manage linked employees'}).click();await expect(page.getByRole('dialog')).toContainText('Site staff');await expect(page.getByRole('dialog').getByRole('button',{name:'Move selected employees'})).toBeVisible();
});
test('a server refusal keeps the dialog open and shows the reason',async({page})=>{
 const {writes}=await mock(page,{fail:true});await page.goto('/setup/pay-groups');await page.getByRole('button',{name:'Delete pay group Site staff'}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('textbox').fill(group.name);await dialog.getByRole('button',{name:'Delete pay group',exact:true}).click();
 await expect(page.getByText('A new employee assignment was added. Move it first.',{exact:true})).toBeVisible();await expect(dialog).toBeVisible();expect(writes).toHaveLength(1);
});
test('employee deletion has the same exact-name guard and returns to the employee list',async({page})=>{
 const {writes}=await mock(page);await page.goto('/people/employee-test?tab=timeline');await page.getByRole('button',{name:'More employee actions'}).click();await page.getByRole('menuitem',{name:'Delete employee',exact:true}).click();
 const dialog=page.getByRole('dialog'),input=dialog.getByRole('textbox');await expect(dialog).toContainText('AJTEST');await input.fill('AJTEST');await expect(dialog.getByRole('button',{name:'Delete employee',exact:true})).toBeDisabled();
 await input.fill('Example Employee');await dialog.getByRole('button',{name:'Delete employee',exact:true}).click();await expect(page).toHaveURL(/\/people$/);expect(writes).toEqual([{path:'/employees/employee-test',body:{confirm_name:'Example Employee'}}]);
});
test('read-only setup access does not show delete buttons',async({page})=>{
 await mock(page,{readonly:true});await page.goto('/setup/pay-groups');await expect(page.getByRole('heading',{name:'Pay groups',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/Delete pay group/})).toHaveCount(0);
});
