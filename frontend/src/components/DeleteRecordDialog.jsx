import {useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {api,errorMessage} from '@/services/api';
import {ErrorState,SkeletonRows,Notice} from '@/components/states';
import {Button} from '@/components/ui/button';
import {Field,Input} from '@/components/ui/form';
import {Dialog} from '@/components/ui/overlay';
const types={employee:{label:'employee',path:'employees'},structure:{label:'salary structure',path:'structures'},group:{label:'pay group',path:'pay-groups'}};
export default function DeleteRecordDialog({kind,id,onClose,onDeleted,onManage}){
 const qc=useQueryClient(),type=types[kind],[typed,setTyped]=useState('');
 const path=`/${type.path}/${id}`;
 const preview=useQuery({queryKey:['deletion-preview',kind,id],queryFn:()=>api.get(`${path}/deletion`).then(r=>r.data),staleTime:0});
 const data=preview.data;
 const remove=useMutation({mutationFn:()=>api.del(path,{confirm_name:typed}),onSuccess:()=>{
  toast.success(`${type.label[0].toUpperCase()+type.label.slice(1)} deleted. Historical records are retained.`);
  onDeleted?.();onClose();
  for(const key of ['people','employee','structures','structure','pay-groups','pay-group','pay-group-employees','deletion-preview','lookups','departments','sites','site','today','dashboard','period','periods','payroll-summary','payroll-preview','payroll-issues'])qc.invalidateQueries({queryKey:[key]});
 },onError:error=>{toast.error(errorMessage(error));preview.refetch();}});
 return <Dialog open onOpenChange={open=>{if(!open&&!remove.isPending)onClose();}} title={`Delete ${type.label}`} description="Check the exact record and its effects before confirming." footer={<><Button variant="outline" disabled={remove.isPending} onClick={onClose}>Cancel</Button><Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={!data?.can_delete||typed!==data.name||preview.isFetching||remove.isPending} loading={remove.isPending} onClick={()=>remove.mutate()}><Trash2/> Delete {type.label}</Button></>}>
  {preview.isLoading?<SkeletonRows rows={4}/>:preview.isError?<ErrorState error={preview.error} onRetry={()=>preview.refetch()} compact/>:data&&<div className="flex flex-col gap-4">
   <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3"><div className="text-[12px] uppercase tracking-wide text-muted-foreground">{type.label}</div><strong className="break-words text-lg">{data.name}</strong>{data.code&&<div className="font-mono text-sm">{data.code}</div>}</div>
   <div><h3 className="mb-2 font-semibold">What will happen</h3><ul className="list-disc space-y-2 pl-5 text-sm">{data.effects.map(effect=><li key={effect}>{effect}</li>)}</ul></div>
   {!!data.blockers.length&&<Notice tone="warning"><div><strong>Resolve this first</strong><ul className="mt-2 list-disc space-y-1 pl-4">{data.blockers.map(reason=><li key={reason}>{reason}</li>)}</ul>{onManage&&data.assigned_count>0&&<Button variant="outline" size="sm" className="mt-3" onClick={onManage}>Manage linked employees</Button>}</div></Notice>}
   {!!data.employees.length&&<div className="max-h-44 overflow-auto rounded-md border"><table className="data-table w-full"><thead><tr><th>Linked employee</th><th>Assignment</th></tr></thead><tbody>{data.employees.slice(0,30).map(e=><tr key={e.id}><td>{e.name}<div className="text-xs text-muted-foreground">{e.code}</div></td><td>{e.source||e.status}{e.effective_from&&<div className="text-xs text-muted-foreground">From {e.effective_from}</div>}</td></tr>)}</tbody></table>{data.employees.length>30&&<p className="p-2 text-sm">{data.employees.length-30} more. Open Manage linked employees to review all.</p>}</div>}
   <Field label={<>Type <strong className="select-all">{data.name}</strong> to confirm</>}>{inputId=><Input id={inputId} aria-label={`Type ${type.label} name to confirm deletion`} autoComplete="off" spellCheck={false} value={typed} onChange={e=>setTyped(e.target.value)} disabled={!data.can_delete||remove.isPending} placeholder="Enter the complete name exactly"/>}</Field>
  </div>}
 </Dialog>;
}
