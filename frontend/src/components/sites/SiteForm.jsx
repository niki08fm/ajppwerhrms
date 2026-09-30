import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { generateSitePassword, SITE_RADIUS_DEFAULT_M, siteSchema, sitePasswordSchema, siteUpdateSchema } from '@ajpwer/shared';
import { api, ApiError, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { Mono } from '@/components/bits';
import { Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog, Switch } from '@/components/ui/overlay';
import { SiteMap } from './SiteMap';

export const PASSWORD_ONCE_TEXT = "Write this down or share it with the site in-charge now. It won't be shown again.";

/** First error per field from a zod result, for showing under each input. */
function fieldErrors(result) {
  if (result.success) return {};
  const out = {};
  for (const i of result.error.issues) {
    const k = i.path[0];
    if (k && !out[k]) out[k] = i.message;
  }
  return out;
}

/** Password box with show/hide and "Generate" (12 characters, no look-alikes). */
export function PasswordInput({ value, onChange, error, label = 'Password' }) {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} required error={error} hint="At least 8 characters, with a letter and a number. Or generate a strong one.">
      {(id, invalid) => (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input id={id} type={shown ? 'text' : 'password'} autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} className="pr-8 font-mono" />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'}>
              {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              onChange(generateSitePassword());
              setShown(true);
            }}
          >
            <Wand2 /> Generate
          </Button>
        </div>
      )}
    </Field>
  );
}

/** Shows the login and password once, with Copy. */
export function PasswordOnceDialog({ creds, onClose }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Login ID: ${creds.login}\nPassword: ${creds.password}`);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy. Select the password and copy it by hand.');
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Tablet login" description={PASSWORD_ONCE_TEXT} footer={<Button onClick={onClose}>I have saved it</Button>}>
      <div className="flex flex-col gap-3 text-[14px]">
        <div>
          Login ID: <Mono className="text-[14px]">{creds.login}</Mono>
        </div>
        <div className="flex items-center gap-2">
          <span>
            Password: <Mono className="select-all text-[15px] font-semibold">{creds.password}</Mono>
          </span>
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy /> Copy
          </Button>
        </div>
        <Notice>
          The tablet signs in at <Mono>/tablet</Mono> and only works inside the site's boundary.
        </Notice>
      </div>
    </Dialog>
  );
}

/** HR types a new password or generates one; the reply is shown once. Every signed-in tablet is signed out. */
export function ResetPasswordDialog({ site, onClose, onDone }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const save = useMutation({
    mutationFn: () => api.post(`/sites/${site.id}/password`, { password }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['sites'] });
      qc.invalidateQueries({ queryKey: ['site-day', site.id] });
      onDone(r.data);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    const v = fieldErrors(sitePasswordSchema.safeParse({ password }));
    if (!password) return setError('Type a password or click Generate.');
    if (v.password) return setError(v.password);
    save.mutate();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reset password — ${site.name}`}
      description="Every tablet signed in to this site is signed out on its next request and must sign in with the new password."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            Reset password
          </Button>
        </>
      }
    >
      <PasswordInput value={password} onChange={setPassword} error={error} label="New password" />
    </Dialog>
  );
}

const blank = { code: '', name: '', address: '', state: 'Andhra Pradesh', project_id: '', lat: null, lng: null, radius_m: SITE_RADIUS_DEFAULT_M, is_active: true, login: '', password: '' };

/**
 * Add or edit a site: details, the map with its geofence, and (on add) the tablet
 * login. A changed centre or radius applies to the next sign-in and punch only.
 */
export function SiteFormDialog({ site, onClose, onCreated }) {
  const editing = !!site;
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const [f, setF] = useState(() => (site ? { ...blank, ...site, address: site.address ?? '', project_id: site.project_id ?? '', password: '' } : blank));
  const [errors, setErrors] = useState({});
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const onMove = useCallback((p) => setF((x) => ({ ...x, lat: p.lat, lng: p.lng })), []);

  const body = () => {
    const b = {
      code: f.code,
      name: f.name,
      address: f.address.trim() || null,
      state: f.state,
      project_id: f.project_id || null,
      lat: f.lat,
      lng: f.lng,
      radius_m: f.radius_m === '' ? NaN : Number(f.radius_m),
      is_active: f.is_active,
      login: f.login,
    };
    if (!editing) b.password = f.password;
    return b;
  };

  const save = useMutation({
    mutationFn: (b) => (editing ? api.patch(`/sites/${site.id}`, b) : api.post('/sites', b)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['sites'] });
      qc.invalidateQueries({ queryKey: ['sites-network'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      if (editing) {
        qc.invalidateQueries({ queryKey: ['site-day', site.id] });
        toast.success('Site saved. A new location or radius applies from the next sign-in and punch.');
      } else onCreated?.(r.data.credentials);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.field) setErrors({ [e.field]: e.message });
      toast.error(errorMessage(e));
    },
  });

  const submit = () => {
    const b = body();
    const errs = {};
    if (b.lat === null || b.lng === null) errs.lat = 'Mark the site on the map.';
    if (!editing && !b.password) errs.password = 'Type a password or click Generate.';
    const parsed = editing ? siteUpdateSchema.safeParse(b) : siteSchema.safeParse(b);
    Object.assign(errs, { ...fieldErrors(parsed), ...errs });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate(b);
  };

  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={editing ? `Edit ${site.name}` : 'Add a site'}
      description="The state defaults professional tax for people hired to work here; it does not decide it."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {editing ? 'Save site' : 'Create site'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_1.3fr]">
        <div className="flex flex-col gap-3">
          <Field label="Site name" required error={errors.name}>
            {(id, invalid) => <Input id={id} value={f.name} onChange={(e) => set('name')(e.target.value)} aria-invalid={invalid} />}
          </Field>
          <Field label="Code" required hint="Upper-case, e.g. ALPHA" error={errors.code}>
            {(id, invalid) => <Input id={id} className="font-mono uppercase" value={f.code} onChange={(e) => set('code')(e.target.value.toUpperCase())} aria-invalid={invalid} />}
          </Field>
          <Field label="Address" error={errors.address}>
            {(id) => <Input id={id} value={f.address} onChange={(e) => set('address')(e.target.value)} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="State">
              {(id) => (
                <Select id={id} value={f.state} onChange={(e) => set('state')(e.target.value)}>
                  {lk?.states.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Project">
              {(id) => (
                <Select id={id} value={f.project_id} onChange={(e) => set('project_id')(e.target.value)}>
                  <option value="">None</option>
                  {lk?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="flex items-center gap-2 text-[13px]">
            <Switch id="site-active" checked={f.is_active} onCheckedChange={set('is_active')} label="Active" />
            <label htmlFor="site-active">Active {f.is_active ? '(yes)' : '(no — the tablet cannot sign in)'}</label>
          </div>

          <div className="mt-2 flex flex-col gap-3 border-t pt-3">
            <h3 className="font-display text-[15px] font-semibold">Tablet login</h3>
            <Field label="Login ID" required error={errors.login} hint="4–32 letters, numbers or dashes. Not case-sensitive at sign-in.">
              {(id, invalid) => <Input id={id} className="font-mono" autoCapitalize="none" value={f.login} onChange={(e) => set('login')(e.target.value)} aria-invalid={invalid} />}
            </Field>
            {editing ? (
              <p className="text-[12px] text-muted-foreground">To change the password, use Reset password on the site page.</p>
            ) : (
              <PasswordInput value={f.password} onChange={set('password')} error={errors.password} />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <SiteMap lat={f.lat} lng={f.lng} radius={f.radius_m} onChange={onMove} onRadius={set('radius_m')} />
          {(errors.lat || errors.lng || errors.radius_m) && (
            <p className="text-[12px] text-destructive" role="alert">
              {errors.lat || errors.lng || errors.radius_m}
            </p>
          )}
          {editing && <p className="text-[12px] text-muted-foreground">A new location or radius applies to the next sign-in and the next punch. Past punches keep their recorded distance.</p>}
        </div>
      </div>
    </Dialog>
  );
}
