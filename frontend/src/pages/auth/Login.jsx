import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Notice } from '@/components/states';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const qc = useQueryClient();

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/auth/login', { email, password });
      qc.setQueryData(['me'], r.data);
      nav(sp.get('next') || '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-primary p-10 text-primary-foreground lg:flex">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
            <path d="M17.5 5 9 18h6l-1.5 9L23 13h-6.2L17.5 5z" fill="currentColor" />
          </svg>
          <span className="font-display text-xl font-semibold">AJPWER Workforce</span>
        </div>
        <div>
          <p className="font-display text-3xl leading-snug">Attendance, payroll and settlement for AJ Power Engineering.</p>
          <p className="mt-3 max-w-md text-[13px] opacity-80">
            Punches at geofenced sites become paid days under each pay group's rules. Payroll runs with full Indian statutory deduction, snapshots every payslip, and reports labour cost by project.
          </p>
        </div>
        <p className="text-[12px] opacity-70">Site tablets sign in at /tablet with their own site login.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold">Sign in</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">HR administrator account.</p>
          </div>
          {error && <Notice tone="destructive">{error}</Notice>}
          <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
          <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Button type="submit" size="lg" loading={busy}>
            Sign in
          </Button>
          <p className="text-[12px] text-muted-foreground">Five failed attempts lock sign-in for fifteen minutes.</p>
        </form>
      </div>
    </div>
  );
}
