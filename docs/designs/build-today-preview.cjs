// Rebuild after `npm run build --workspace=@ajpwer/frontend` from the repository root.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const { build } = require(path.join(root, 'frontend/node_modules/esbuild'));
(async () => {
  const result = await build({
    entryPoints: [path.join(__dirname, 'today-preview-entry.jsx')], bundle: true, write: false,
    outfile: path.join(__dirname, 'today-preview-bundle.js'),
    minify: true, format: 'iife', jsx: 'automatic',
    nodePaths: [path.join(root, 'node_modules'), path.join(root, 'frontend/node_modules')],
    alias: { '@': path.join(root, 'frontend/src') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_API_URL': '"/api/v1"' },
    plugins: [{ name: 'standalone-design-preview', setup(b) {
      b.onLoad({ filter: /CorrectionDrawer\.jsx$/ }, () => ({ loader: 'jsx', contents: `import React from 'react'; import {Drawer} from '@/components/ui/overlay'; export function CorrectionDrawer({employeeId,date,open,onOpenChange}) { const p=window.previewStaff.find(p=>p.id===employeeId); return <Drawer open={open} onOpenChange={onOpenChange} title={p?.name ?? 'Person'} description={'Sample attendance · '+date}><p>{p?.code} · {p?.dept_id==='eng'?'Engineering':'Operations'}</p><p className="mt-3">Overtime: {Math.floor((p?.ot_min??0)/60)} h {(p?.ot_min??0)%60} min</p><p className="mt-4 text-muted-foreground">This is a sample employee. Attendance corrections are available in the connected app.</p></Drawer>; }` }));
    } }],
  });
  const assets = path.join(root, 'frontend/dist/assets');
  const css = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(f => /^index.*\.css$/.test(f))), 'utf8');
  const extra = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
  const script = result.outputFiles.find(f => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Today — interactive preview</title><style>${css}\n${extra}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
  fs.writeFileSync(path.join(__dirname, 'today-interactive.html'), html.split('\n').map(line => line.trimEnd()).join('\n') + '\n');
  console.log('Built Today preview using the application attendance area chart.');
})().catch(e => { console.error(e); process.exitCode = 1; });
