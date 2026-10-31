import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '@/services/api';
import {useSession} from '@/context/SessionContext';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/overlay';
import {Input} from '@/components/ui/form';
import {EmptyState,ErrorState,SkeletonRows,Notice} from '@/components/states';
import {ReviseDialog} from '@/components/people/profile-tabs/SalaryHistory';
export default function ManageStructureDialog({structure,onClose}){
 const qc=useQueryClient(),{can}=useSession(),[search,setSearch]=useState(''),[selected,setSelected]=useState(null);
 const q=useQuery({queryKey:['deletion-preview','structure',structure.id],queryFn:()=>api.get(`/structures/${structure.id}/deletion`).then(r=>r.data),staleTime:0});
 const person=useQuery({queryKey:['employee',selected],queryFn:()=>api.get(`/employees/${selected}`).then(r=>r.data),enabled:!!selected});
 const rows=(q.data?.employees||[]).filter(e=>`${e.name} ${e.code}`.toLowerCase().includes(search.toLowerCase()));
 const revised=()=>{setSelected(null);for(const key of ['structures','deletion-preview','lookups'])qc.invalidateQueries({queryKey:[key]});};
 if(selected&&person.data)return <ReviseDialog e={person.data} onClose={revised}/>;
 return <Dialog open wide onOpenChange={open=>{if(!open)onClose();}} title={`Employees · ${structure.name}`} description="Change each employee to another salary structure using their effective salary revision. Existing paid history is retained." footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
  {q.isLoading||person.isFetching?<SkeletonRows rows={5}/>:q.isError||person.isError?<ErrorState error={q.error||person.error} onRetry={()=>{q.refetch();if(selected)person.refetch();}} compact/>:<div className="flex flex-col gap-3">
   <Notice tone="info">Current and future salary assignments must move first. A revision dated in the future still leaves the old structure in use until its effective date. For an open offer, revoke it in Hiring and issue a replacement offer using another structure. Changing salary alone does not replace the offered structure.</Notice>
   <Input aria-label="Search structure employees" placeholder="Search by employee name or code" value={search} onChange={e=>setSearch(e.target.value)}/>
   {!rows.length?<EmptyState title={search?'No employees match':'No current or future assignments'} body="Historical salary rows stay linked to the original structure."/>:<div className="overflow-x-auto"><table className="data-table w-full"><thead><tr><th>Employee</th><th>Assignment</th><th>Action</th></tr></thead><tbody>{rows.map(e=><tr key={e.id}><td>{e.name}<div className="text-xs text-muted-foreground">{e.code}</div></td><td>{e.source}{e.effective_from&&<div className="text-xs text-muted-foreground">From {e.effective_from}</div>}</td><td><div className="flex gap-2">{can('salary.write')&&e.source!=='Latest open offer'&&<Button size="sm" variant="outline" onClick={()=>setSelected(e.id)}>Change salary structure</Button>}<Button size="sm" variant="ghost" asChild><Link to={`/people/${e.id}?tab=salary`}>Open profile</Link></Button></div></td></tr>)}</tbody></table></div>}
  </div>}
 </Dialog>;
}
