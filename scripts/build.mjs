import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const runtime = new URL('runtime/', dist);
const entries = ['index', 'neuralwatt-mcr'];
await rm(dist, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });

// Bundle both entries together: MCR and the provider must use the same model
// cache, config and stream implementation. Leave the host adapter outside the
// bundle; compiled runtime modules must never resolve SDK packages themselves.
const { success, logs, outputs } = await Bun.build({
  root: Bun.fileURLToPath(root),
  entrypoints: entries.map(name => Bun.fileURLToPath(new URL(`${name}.ts`, root))),
  outdir: Bun.fileURLToPath(runtime),
  target: 'node',
  format: 'esm',
  packages: 'external',
  splitting: true,
  naming: { entry: '[name].js', chunk: 'chunk-[hash].js' },
  plugins: [{
    name: 'pi-host-bridge',
    setup(build) {
      build.onResolve({ filter: /^(?:\.\/pi-host|typebox)$/ }, () => ({ path: './pi-host.js', external: true }));
    },
  }],
});
if (!success) throw new AggregateError(logs, 'Could not build Neuralwatt extensions');
if (!outputs.some(output => output.kind === 'chunk')) throw new Error('Expected a shared runtime chunk');

// These small modules are the only ones Jiti needs to load. It maps the peer
// imports to the host (including Pi's bundled/binary virtual modules). Then
// createRequire crosses into native ESM on current Pi's Node and Bun runtimes, bypassing Jiti's
// transformer and sharing the same ESM module cache across both entrypoints.
await copyFile(new URL('pi-host.ts', root), new URL('host-imports.js', dist));
await writeFile(new URL('pi-host.js', runtime), `
export const packageRoot = new URL('../../', import.meta.url);
export let getAgentDir, loadPiAiCompat, loadPiAgent, loadPiProviders, loadPiTui, Type;
export function bindHost(host, typebox) {
  if (!getAgentDir) ({ getAgentDir, loadPiAiCompat, loadPiAgent, loadPiProviders, loadPiTui } = host);
  Type ??= typebox;
}
`);

const scan = new Bun.Transpiler({ loader: 'js' });
for (const output of outputs) {
  for (const { path } of scan.scan(await output.text()).imports) {
    if (!path.startsWith('./') && !isBuiltin(path)) throw new Error(`Unmapped runtime import: ${path}`);
  }
}
for (const name of entries) {
  const mcr = name === 'neuralwatt-mcr';
  const source = await readFile(new URL(`${name}.js`, runtime), 'utf8');
  const { exports } = scan.scan(source);
  if (!exports.includes('default')) throw new Error(`${name}: missing default extension factory`);
  const named = exports.filter(key => key !== 'default');
  await writeFile(new URL(`${name}.js`, dist), `import { createRequire } from 'node:module';
import * as host from './host-imports.js';
${mcr ? "import { Type } from 'typebox';\n" : ''}const requireNative = createRequire(import.meta.url);
requireNative('./runtime/pi-host.js').bindHost(host${mcr ? ', Type' : ''});
const runtime = requireNative('./runtime/${name}.js');
export default runtime.default;
${named.length ? `export const { ${named.join(', ')} } = runtime;\n` : ''}`);
}
