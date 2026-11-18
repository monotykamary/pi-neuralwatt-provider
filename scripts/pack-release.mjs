import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(process.argv[2] ?? join(root, 'dist', 'pack'));
const temp = await mkdtemp(join(tmpdir(), 'neuralwatt-pack-'));
const stage = join(temp, 'package');
function run(args, cwd) {
  const child = Bun.spawnSync(args, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (child.exitCode !== 0) throw new Error(`${args.join(' ')} failed (${child.exitCode})`);
}
try {
  run([process.execPath, 'run', 'build'], root);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // Reuse Bun's package file selection (including .npmignore), then stage the
  // release-only manifest and split JS. A git/checkout install still uses TS
  // without a build, and published explicit source paths remain available.
  run([process.execPath, 'pm', 'pack', '--destination', temp], root);
  run(['tar', '-xzf', join(temp, `${manifest.name}-${manifest.version}.tgz`)], temp);
  await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
  await writeFile(join(stage, '.npmignore'), '');
  manifest.types = manifest.main;
  manifest.main = './dist/index.js';
  manifest.pi.extensions = manifest.pi.extensions.map(entry => entry.replace(/^\.\//, './dist/').replace(/\.ts$/, '.js'));
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await mkdir(destination, { recursive: true });
  run([process.execPath, 'pm', 'pack', '--destination', destination], stage);
} finally {
  await rm(temp, { recursive: true, force: true });
}
