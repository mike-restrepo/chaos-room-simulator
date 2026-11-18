import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const DEMO_PROJECT_ID = 'demo-chaos-room';

// Refuse execution if live cloud credentials or Gemini API keys are present.
for (const envVar of [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_API_KEY',
]) {
  if (process.env[envVar] && process.env[envVar].trim().length > 0) {
    console.error(
      `Refusing to run Phase 3A local emulator suite while live credential/secret env var "${envVar}" is set.`,
    );
    process.exit(1);
  }
}

function findJavaBinDir() {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['java'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (probe.status === 0 && probe.stdout.trim()) {
    const firstJava = probe.stdout.trim().split(/\r?\n/)[0];
    if (firstJava && fs.existsSync(firstJava)) {
      return path.dirname(firstJava);
    }
  }

  const candidateRoots = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : null,
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
  ].filter(Boolean);

  for (const root of candidateRoots) {
    if (!fs.existsSync(root)) continue;
    const directJava = path.join(root, process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(directJava)) {
      return root;
    }
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const binDir = path.join(root, entry.name, 'bin');
        const exePath = path.join(binDir, process.platform === 'win32' ? 'java.exe' : 'java');
        if (fs.existsSync(exePath)) {
          return binDir;
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return null;
}

const childEnv = {
  ...process.env,
  GCLOUD_PROJECT: DEMO_PROJECT_ID,
  GOOGLE_CLOUD_PROJECT: DEMO_PROJECT_ID,
  FIREBASE_PROJECT: DEMO_PROJECT_ID,
};

const javaBinDir = findJavaBinDir();
if (!javaBinDir) {
  console.error(
    'Java Runtime (JDK 21+ recommended) was not found on PATH or standard install directories. Install Microsoft OpenJDK 21 before running Firebase emulators.',
  );
  process.exit(1);
}

const pathSep = process.platform === 'win32' ? ';' : ':';
childEnv.PATH = `${javaBinDir}${pathSep}${childEnv.PATH ?? ''}`;
if (!childEnv.JAVA_HOME) {
  childEnv.JAVA_HOME = path.dirname(javaBinDir);
}

const firebaseCliScript = path.join(
  repoRoot,
  'node_modules',
  'firebase-tools',
  'lib',
  'bin',
  'firebase.js',
);
const vitestCommand =
  process.platform === 'win32'
    ? 'npx.cmd vitest run --config vitest.emulator.config.ts'
    : 'npx vitest run --config vitest.emulator.config.ts';

console.log(`Starting Firestore emulator for project "${DEMO_PROJECT_ID}" using Java in ${javaBinDir}...`);

const result = spawnSync(
  process.execPath,
  [
    firebaseCliScript,
    'emulators:exec',
    '--project',
    DEMO_PROJECT_ID,
    '--only',
    'firestore',
    vitestCommand,
  ],
  {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
