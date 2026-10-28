import { build } from 'esbuild';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';

const outdir = 'static/dist';
await mkdir(outdir, { recursive: true });
const result = await build({
  entryPoints: ['static/js/app.js', 'static/js/theme-init.js', 'static/js/analytics.js', 'static/css/app.css'],
  outdir, bundle: true, splitting: true, format: 'esm', target: 'es2022',
  entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]', minify: true,
  legalComments: 'external', metafile: true,
  loader: { '.woff2': 'file', '.svg': 'file' }, assetNames: '[name]-[hash]',
});
const manifest = {};
for (const [path, details] of Object.entries(result.metafile.outputs)) {
  if (details.entryPoint) manifest[details.entryPoint.split('/').pop()] = `/${path}`;
}
const keep = new Set(Object.keys(result.metafile.outputs).map(path => path.split('/').pop()));
for (const file of await readdir(outdir)) {
  if (file.endsWith('.LEGAL.txt') && keep.has(file.slice(0, -10))) keep.add(file);
}
for (const file of await readdir(outdir)) if (!keep.has(file)) await unlink(`${outdir}/${file}`);
await writeFile('static/build.json', JSON.stringify(manifest));
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.metafile.outputs).map(([path, info]) => [path, info.bytes])), null, 2));

// Size budgets (bytes, minified). A lazy tool chunk that grows past its budget fails the build.
const KB = 1024;
const BUDGETS = [
  ['app-*.js', /^app-[A-Z0-9]{8}\.js$/, 30 * KB],
  ['tools-*.js (shell)', /^tools-[A-Z0-9]{8}\.js$/, 16 * KB],
  ['tools-form-*.js (form engine, loaded with the first tool)', /^tools-form-[A-Z0-9]{8}\.js$/, 14 * KB],
  ['tools-child|logs|sheets-*.js', /^tools-(child|logs|sheets)-[A-Z0-9]{8}\.js$/, 18 * KB],
  ['app-*.css', /^app-[A-Z0-9]{8}\.css$/, 56 * KB],
];
const outputs = Object.entries(result.metafile.outputs);
const over = [];
for (const [label, pattern, limit] of BUDGETS) {
  for (const [path, info] of outputs) {
    if (pattern.test(path.split('/').pop()) && info.bytes > limit) over.push(`${path}: ${info.bytes} B > ${limit} B (${label})`);
  }
}
const contribution = (inputs, limit, label) => {
  const total = outputs.reduce((sum, [, info]) => sum + Object.entries(info.inputs).filter(([input]) => inputs.includes(input)).reduce((n, [, i]) => n + i.bytesInOutput, 0), 0);
  console.log(`${label}: ${total} B (budget ${limit} B)`);
  if (total > limit) over.push(`${label}: ${total} B > ${limit} B`);
};
contribution(['static/js/charts.js'], 12 * KB, 'charts.js');
contribution(['static/js/local-log.js', 'static/js/print.js'], 3 * KB, 'local-log.js + print.js');
if (over.length) {
  console.error(`Over budget:\n  ${over.join('\n  ')}`);
  process.exit(1);
}
