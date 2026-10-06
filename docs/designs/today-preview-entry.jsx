import React from 'react';
import { AppShell } from '../../frontend/src/components/shell.jsx';
import { SessionProvider } from '../../frontend/src/context/SessionContext.jsx';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from '../../frontend/src/pages/dashboard/Dashboard.jsx';
const today='2026-10-06';
const sites=[{id:'north',name:'North site'},{id:'south',name:'South site'},{id:'workshop',name:'Workshop'}];
const departments=[{id:'eng',name:'Engineering'},{id:'ops',name:'Operations'}];
const staff=[
 ['Anita Rao','north','eng',0,15],['Ravi Kumar','south','ops',95,0],['Kiran Reddy','north','ops',65,0],
 ['Priya Patel','south','eng',0,0],['Arun Nair','workshop','ops',0,0],['Deepa Roy','workshop','eng',45,0],
 ['Neha Verma','north','eng',0,0],['Manoj Singh','south','ops',0,20],['Meera Shah',null,'eng',0,0,'absent'],
 ['Sana Ali',null,'eng',0,0,'absent'],['Vijay Das',null,'ops',0,0,'leave'],['Ajay Paul',null,'ops',0,0,'leave']
].map(([name,site,dept_id,ot_min,late_min,status],i)=>({id:`p${i}`,name,code:`EMP${String(i+1).padStart(3,'0')}`,sites:site?[site]:[],current_site_id:site&&i!==6?site:null,dept_id,ot_min,late_min,early_min:i===6?30:0,expected:status!=='leave',open_now:!!site&&i!==6,in_min:site?540+late_min:null,out_min:i===6?1020:null,status:status==='absent'?'ABSENT':status==='leave'?'ON_LEAVE':'PRESENT',views:status?[status]:['in',...(i!==6?['onsite']:['early']),...(ot_min?['ot']:[]),...(late_min?['late']:[])]}));
// Kiran moved from South to North today; current headcount must use North only.
staff[2].sites=['south','north'];
window.previewStaff=staff;
window.fetch=async(input)=>{
 const url=new URL(String(input),'https://preview.invalid');let data;
 if(url.pathname.endsWith('/auth/me')) data={name:'HR Admin',role:'HR Admin',email:'preview@example.test',permissions:[]};
 else if(url.pathname.endsWith('/dashboard/people')) data={approvals:{total:3}};
 else if(url.pathname.endsWith('/search')) data=staff.filter(p=>p.name.toLowerCase().includes((url.searchParams.get('q')||'').toLowerCase()));
 else if(url.pathname.endsWith('/dashboard/overview')){
  const date=url.searchParams.get('date')||today;const is_today=date===today;
  data={date,today,is_today,sites,departments,people:staff.map(p=>({...p,open_now:is_today&&p.open_now,current_site_id:is_today?p.current_site_id:null,out_min:!is_today&&p.sites.length?1080+p.ot_min:p.out_min,views:is_today?p.views:p.views.filter(v=>v!=='onsite')})),waiting_total:3,waiting:[{key:'leave',n:2,label:'Leave requests',names:['Vijay Das','Ajay Paul'],to:'/approvals'},{key:'punch',n:1,label:'Punch correction',names:['Arun Nair'],to:'/approvals'}],oldest:{name:'Vijay Das',hours:3,label:'Leave request'},moves:[]};
 }else if(url.pathname.endsWith('/dashboard/month')){
  const ym=url.searchParams.get('ym')||'2026-10';const n=new Date(Number(ym.slice(0,4)),Number(ym.slice(5)),0).getDate();
  data={ym,days:Array.from({length:n},(_,i)=>{
    const date=`${ym}-${String(i+1).padStart(2,'0')}`, epoch=Math.floor(Date.parse(date+'T12:00:00Z')/86400000);
    const off=new Date(date+'T12:00:00Z').getUTCDay()===0;
    const value=(offset)=>off?1:Math.max(1,Math.round(2.8+1.4*Math.sin((epoch+offset)*1.32)+0.8*Math.cos((epoch+offset)*2.41)));
    const counts=date===today?Object.fromEntries(sites.map(s=>[s.id,staff.filter(p=>p.sites.includes(s.id)).length])):{north:value(1),south:value(3),workshop:Math.max(0,value(5)-1)};
    const present=date===today?staff.filter(p=>p.views.includes('in')).length:Object.values(counts).reduce((sum,value)=>sum+value,0);
    return {date,future:date>today,off,present,expected:12,rate:Math.round(present/12*100),sites:counts};
  })};
 }else return new Response(JSON.stringify({error:{message:'This action needs the connected app. This preview contains sample data only.'}}),{status:400});
 return new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json'}});
};
const qc=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function PreviewDestination(){return <div className="rounded-lg border bg-card p-5"><h1 className="text-xl font-semibold">Design preview</h1><p className="my-3 text-muted-foreground">This link opens a different screen in the connected app. Here you can review Today, filter sites and dates, and open attendance and overtime details using sample data.</p><Link to="/" className="text-primary underline">Back to Today</Link></div>}
function Preview(){return <SessionProvider><Routes><Route element={<AppShell/>}><Route path="/" element={<Dashboard/>}/><Route path="*" element={<PreviewDestination/>}/></Route></Routes></SessionProvider>;}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={qc}><MemoryRouter><Preview/></MemoryRouter></QueryClientProvider>);
