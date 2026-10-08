// First run npm run build --workspace=@ajpwer/frontend to refresh the application CSS.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const { build } = require(path.join(root, 'frontend/node_modules/esbuild'));

(async () => {
  const result = await build({
    entryPoints: [path.join(__dirname, 'payroll-preview-entry.jsx')], bundle: true, write: false,
    outfile: path.join(__dirname, 'payroll-preview-bundle.js'), minify: true, format: 'iife', jsx: 'automatic',
    nodePaths: [path.join(root, 'node_modules'), path.join(root, 'frontend/node_modules')],
    alias: { '@': path.join(root, 'frontend/src') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"VITE_API_URL":"/api/v1","VITE_FACE_MODEL_URL":"/preview-models"}' },
    plugins: [{ name: 'preview-copy', setup(b) {
      b.onLoad({ filter: /CorrectionDrawer\.jsx$/ }, () => ({ loader: 'jsx', contents: `import React from 'react'; import {Drawer} from '@/components/ui/overlay'; export function CorrectionDrawer({employeeId,date,open,onOpenChange}) { const p=(window.payrollPreview.state.todayStaff??[]).find(p=>p.id===employeeId); return <Drawer open={open} onOpenChange={onOpenChange} title={p?.name ?? 'Person'} description={'Sample attendance · '+date}><p>{p?.code}</p><p className="mt-3">Overtime: {Math.floor((p?.ot_min??0)/60)} h {(p?.ot_min??0)%60} min</p><p className="mt-4 text-muted-foreground">Sample attendance for this interactive preview.</p></Drawer>; }` }));
      b.onLoad({ filter: /StructureBuilder\.jsx$/ }, args => ({ loader: 'jsx', contents: fs.readFileSync(args.path, 'utf8')
        .replace('Build it here, then attach it to a pay group: that decides who is paid on it and from which month.', 'Build it here, then choose it in the employee’s Salary section when adding or revising their salary.')
        .replace('No date here: it applies to the people of whichever pay group you attach it to, from the month you choose there.', 'The effective date is chosen on the employee’s salary revision. Each employee can have their own salary structure.') }));
    } }],
  });
  const assets = path.join(root, 'frontend/dist/assets');
  const css = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(f => /^index.*\.css$/.test(f))), 'utf8');
  const fontsPath = path.join(__dirname, 'payroll-preview-fonts.css');
  const fonts = fs.existsSync(fontsPath) ? fs.readFileSync(fontsPath, 'utf8') : '';
  const extra = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
  const script = result.outputFiles.find(f => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
  const previewCSS = `
    html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}
    .preview-toolbar{flex-shrink:0;border-bottom:1px solid var(--border);background:var(--card);color:var(--foreground);position:relative;z-index:30}
    .preview-caption{display:flex;align-items:center;gap:8px;padding:9px 20px;font-size:12px;font-weight:600;color:var(--muted-foreground)}
    .preview-dot{width:7px;height:7px;border-radius:50%;background:var(--primary)}.preview-sample{font-weight:400}
    .preview-reset{margin-left:auto;font:inherit;color:var(--primary);padding:3px 8px;border:1px solid var(--border);border-radius:5px;cursor:pointer}
    .preview-tabs{display:flex;gap:4px;overflow-x:auto;padding:0 16px 9px;scrollbar-width:thin}
    .preview-tabs a{white-space:nowrap;padding:6px 12px;font-size:13px;border-radius:6px;color:var(--muted-foreground);text-decoration:none}
    .preview-tabs a:hover,.preview-tabs a[aria-current=page]{background:var(--accent);color:var(--accent-foreground)}
    .preview-app{min-height:0;flex:1}.preview-app>div{height:100%}
    .preview-employee-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px;margin:24px 0}
    .preview-employee{display:flex;align-items:center;gap:14px;border:1px solid var(--border);border-radius:8px;background:var(--card);padding:20px;text-decoration:none;box-shadow:var(--shadow-sm)}
    .preview-employee:hover{border-color:var(--primary)}.preview-employee>div{flex:1}.preview-employee span:not(.preview-initials),.preview-employee small{display:block;color:var(--muted-foreground);font-size:13px;margin-top:3px}
    .preview-initials{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--secondary);color:var(--secondary-foreground);font-weight:600}
    .preview-tip{padding:16px;border:1px solid var(--border);border-radius:8px;color:var(--muted-foreground);font-size:13px}
    @media(max-width:600px){.preview-caption{padding:8px 12px}.preview-tabs{padding-left:8px}.preview-tabs a{padding:6px 9px}.preview-sample{font-size:11px}}
  `;
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AJ Power — Today and payroll preview</title><style>${fonts}\n${css}\n${extra}\n${previewCSS}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
  fs.writeFileSync(path.join(__dirname, 'payroll-interactive.html'), html + '\n');
  console.log(`Built self-contained payroll preview (${Math.round(Buffer.byteLength(html) / 1024)} KB).`);
})().catch(e => { console.error(e); process.exitCode = 1; });
