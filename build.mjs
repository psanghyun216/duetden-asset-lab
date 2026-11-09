import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', target: ['es2020', 'safari15'], minify: true, outfile: 'dist/app.js', loader: { '.json': 'json' } });
for (const f of ['index.html', 'style.css']) cpSync(f, `dist/${f}`);
cpSync('public', 'dist', { recursive: true });
// GitHub Pages 가 밑줄 폴더 등을 건드리지 않게
cpSync('index.html', 'dist/404.html');
import { writeFileSync } from 'node:fs';
writeFileSync('dist/.nojekyll', '');
console.log('built dist/');
