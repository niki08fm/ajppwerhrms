import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Notice } from '@/components/states';

export default function Login() {
  const [who, setWho] = useState('');
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
      const id = who.trim();
      if (id.includes('@')) {
        // An email is HR.
        const r = await api.post('/auth/login', { email: id, password });
        qc.setQueryData(['me'], r.data);
        nav(sp.get('next') || '/', { replace: true });
      } else {
        // Match the dedicated site sign-in; attendance actions request location separately.
        await api.post('/auth/site-login', { login: id.toLowerCase(), password });
        qc.invalidateQueries({ queryKey: ['site-me'] });
        nav('/tablet', { replace: true });
      }
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
          <p className="mt-3 max-w-md text-[14px] opacity-80">
            Manage site attendance, prepare monthly payroll and keep employee records together.
          </p>
        </div>
        <p className="text-[13px] opacity-70">HR uses a work email. Site staff use their assigned site login ID.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold">Sign in</h1>
            <p className="mt-1 text-[14px] text-muted-foreground">Use your work email or the login ID assigned to your site.</p>
          </div>
          {error && <Notice tone="destructive">{error}</Notice>}
          <Field label="Email or site login ID" hint={who && !who.includes('@') ? 'Location is requested when recording site attendance.' : undefined}>
            {(id) => <Input id={id} autoComplete="username" autoCapitalize="none" spellCheck={false} required value={who} onChange={(e) => setWho(e.target.value)} autoFocus />}
          </Field>
          <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Button type="submit" size="lg" loading={busy}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
