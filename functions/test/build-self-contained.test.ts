import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const functionsDistFile = path.resolve(__dirname, '../dist/index.js');

describe('functions self-contained deployment bundle', () => {
  it('bundles @chaos-room/shared cleanly without workspace symlinks and imports in an isolated temp dir', async () => {
    expect(fs.existsSync(functionsDistFile)).toBe(true);
    const bundleContent = fs.readFileSync(functionsDistFile, 'utf8');
    const codeWithoutLineComments = bundleContent.replace(/^\s*\/\/.*$/gm, '');

    expect(bundleContent).not.toContain('@chaos-room/shared');
    expect(codeWithoutLineComments).not.toMatch(/packages[\\/]shared/);
    expect(bundleContent).toContain('analyzeIncident');

    const tempDeployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-room-deploy-check-'));
    try {
      const copiedBundle = path.join(tempDeployDir, 'index.js');
      fs.copyFileSync(functionsDistFile, copiedBundle);

      // Syntax check on copied standalone bundle outside the workspace.
      execFileSync(process.execPath, ['--check', copiedBundle], { stdio: 'pipe' });

      // Provide ONLY external runtime dependencies (not @chaos-room/shared) in temp node_modules.
      const tempNodeModules = path.join(tempDeployDir, 'node_modules');
      fs.mkdirSync(tempNodeModules, { recursive: true });
      for (const pkg of ['firebase-admin', 'firebase-functions']) {
        const sourcePkg = path.join(repoRoot, 'node_modules', pkg);
        const targetPkg = path.join(tempNodeModules, pkg);
        fs.symlinkSync(sourcePkg, targetPkg, 'junction');
      }

      const imported = (await import(pathToFileURL(copiedBundle).href)) as Record<string, unknown>;
      expect(typeof imported.analyzeIncident).toBe('function');
    } finally {
      fs.rmSync(tempDeployDir, { recursive: true, force: true });
    }
  }, 20000);
});
