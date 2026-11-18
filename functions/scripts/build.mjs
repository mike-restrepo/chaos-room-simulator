import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const functionsDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(functionsDir, '..');
const distDir = path.join(functionsDir, 'dist');
const outFile = path.join(distDir, 'index.js');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// Verify TypeScript compilation across functions and shared workspace references.
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
execFileSync(process.execPath, [tscBin, '-b', functionsDir], {
  stdio: 'inherit',
  cwd: repoRoot,
});

// Bundle functions/src/index.ts with @chaos-room/shared inlined so the built artifact
// does not depend on workspace symlinks outside the functions/ deployment directory.
await esbuild.build({
  entryPoints: [path.join(functionsDir, 'src', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
});

// Copy a deployment-clean package.json marker or verify bundle exists.
const builtCode = fs.readFileSync(outFile, 'utf8');
if (builtCode.includes('@chaos-room/shared')) {
  throw new Error('Build failed self-containment check: found @chaos-room/shared reference in dist/index.js');
}

console.log(`Built self-contained Cloud Functions bundle: ${outFile} (${builtCode.length} bytes)`);
