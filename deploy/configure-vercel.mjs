import { writeFile } from 'node:fs/promises';

const origin = new URL(process.argv[2] || 'invalid');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Pass the public HTTPS API origin only, e.g. https://api.example.com');
}
const config = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  framework: 'vite',
  installCommand: 'npm ci',
  buildCommand: 'npm run build --workspace=@ajpwer/frontend',
  outputDirectory: 'frontend/dist',
  rewrites: [
    { source: '/api/:path*', destination: `${origin.origin}/api/:path*` },
    { source: '/face-models/:path*', destination: `${origin.origin}/face-models/:path*` },
    { source: '/((?!api(?:/|$)|face-models(?:/|$)|assets(?:/|$)).*)', destination: '/index.html' },
  ],
};
await writeFile(new URL('../vercel.json', import.meta.url), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
console.log('Created vercel.json. Review and commit it before importing the repository into Vercel.');
