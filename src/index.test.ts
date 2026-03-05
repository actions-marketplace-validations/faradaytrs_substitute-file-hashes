import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm, readFile, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import { processFiles } from './index.ts';

describe('substitute-file-hashes', () => {
  let testDir: string;
  let workspaceRoot: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    testDir = await mkdtemp(join(tmpdir(), 'substitute-file-hashes-test-'));
    workspaceRoot = join(testDir, 'workspace');
    await mkdir(workspaceRoot, { recursive: true });
    process.chdir(workspaceRoot);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  it('should resolve mixed hashFile paths (./, ../, and root-relative)', async () => {
    const currentFilePath = join(workspaceRoot, 'apps/swarm/docker-stack.yml');
    const caddyPath = join(workspaceRoot, 'apps/swarm/caddy/load-balancer/Caddyfile');
    const sharedPath = join(workspaceRoot, 'apps/shared/config.json');
    const rootRelativePath = join(workspaceRoot, 'apps/swarm/wa.config.json');

    const caddyContent = 'route / { respond "ok" }';
    const sharedContent = '{"feature":"enabled"}';
    const rootRelativeContent = '{"wa":"config"}';

    await writeFileWithParents(caddyPath, caddyContent);
    await writeFileWithParents(sharedPath, sharedContent);
    await writeFileWithParents(rootRelativePath, rootRelativeContent);

    const deploymentContent = `
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    caddy-hash: \${{ hashFile('./caddy/load-balancer/Caddyfile') }}
    shared-hash: \${{ hashFile('../shared/config.json') }}
    root-hash: \${{ hashFile('apps/swarm/wa.config.json') }}
`;
    await writeFileWithParents(currentFilePath, deploymentContent);

    const result = await processFiles('apps/swarm/docker-stack.yml', 'sha256', true);
    assert.strictEqual(result.processedCount, 1, 'Should process one file');
    assert.strictEqual(result.modifiedCount, 1, 'Should modify one file');

    const updatedContent = await readFile(currentFilePath, 'utf8');
    assert.ok(updatedContent.includes(`caddy-hash: ${sha256(caddyContent)}`), 'Should resolve ./ path from current file directory');
    assert.ok(updatedContent.includes(`shared-hash: ${sha256(sharedContent)}`), 'Should resolve ../ path from current file directory');
    assert.ok(updatedContent.includes(`root-hash: ${sha256(rootRelativeContent)}`), 'Should resolve root-relative path from workspace root');
    assert.ok(!updatedContent.includes('hashFile('), 'All placeholders should be replaced');
  });

  it('should replace hashFile(path) with full hash', async () => {
    const sourcePath = join(workspaceRoot, 'configs/a.txt');
    const manifestPath = join(workspaceRoot, 'manifests/full-hash.yaml');
    const sourceContent = 'alpha-content';
    await writeFileWithParents(sourcePath, sourceContent);
    await writeFileWithParents(
      manifestPath,
      `value: \${{ hashFile('configs/a.txt') }}\n`
    );

    await processFiles('manifests/full-hash.yaml', 'sha256', true);
    const updatedContent = await readFile(manifestPath, 'utf8');
    assert.ok(updatedContent.includes(`value: ${sha256(sourceContent)}`), 'Should use full hash when length is not provided');
  });

  it('should replace hashFile(path, N) with truncated hash', async () => {
    const sourcePath = join(workspaceRoot, 'configs/b.txt');
    const manifestPath = join(workspaceRoot, 'manifests/short-hash.yaml');
    const sourceContent = 'beta-content';
    await writeFileWithParents(sourcePath, sourceContent);
    await writeFileWithParents(
      manifestPath,
      `value: \${{ hashFile('configs/b.txt', 8) }}\n`
    );

    await processFiles('manifests/short-hash.yaml', 'sha256', true);
    const updatedContent = await readFile(manifestPath, 'utf8');
    assert.ok(updatedContent.includes(`value: ${sha256(sourceContent).slice(0, 8)}`), 'Should use first N hash characters');
  });

  it('should process mixed hashFile expressions with and without N in one file', async () => {
    const onePath = join(workspaceRoot, 'configs/one.txt');
    const twoPath = join(workspaceRoot, 'configs/two.txt');
    const manifestPath = join(workspaceRoot, 'manifests/mixed-lengths.yaml');
    const oneContent = 'one-content';
    const twoContent = 'two-content';
    await writeFileWithParents(onePath, oneContent);
    await writeFileWithParents(twoPath, twoContent);

    await writeFileWithParents(
      manifestPath,
      `full: \${{ hashFile('configs/one.txt') }}\nshort: \${{ hashFile('configs/two.txt', 12) }}\n`
    );

    await processFiles('manifests/mixed-lengths.yaml', 'sha256', true);
    const updatedContent = await readFile(manifestPath, 'utf8');
    assert.ok(updatedContent.includes(`full: ${sha256(oneContent)}`), 'Should keep full hash for single-arg expression');
    assert.ok(updatedContent.includes(`short: ${sha256(twoContent).slice(0, 12)}`), 'Should truncate hash for two-arg expression');
  });

  it('should fail for invalid hash length 0', async () => {
    const sourcePath = join(workspaceRoot, 'configs/invalid-zero.txt');
    const manifestPath = join(workspaceRoot, 'manifests/invalid-zero.yaml');
    await writeFileWithParents(sourcePath, 'invalid-zero');
    await writeFileWithParents(manifestPath, `value: \${{ hashFile('configs/invalid-zero.txt', 0) }}\n`);

    await assert.rejects(
      () => processFiles('manifests/invalid-zero.yaml', 'sha256', true),
      /Expected integer >= 1/
    );
  });

  it('should fail for invalid hash length -1', async () => {
    const sourcePath = join(workspaceRoot, 'configs/invalid-negative.txt');
    const manifestPath = join(workspaceRoot, 'manifests/invalid-negative.yaml');
    await writeFileWithParents(sourcePath, 'invalid-negative');
    await writeFileWithParents(manifestPath, `value: \${{ hashFile('configs/invalid-negative.txt', -1) }}\n`);

    await assert.rejects(
      () => processFiles('manifests/invalid-negative.yaml', 'sha256', true),
      /Expected integer >= 1/
    );
  });

  it('should fail for non-numeric hash length', async () => {
    const sourcePath = join(workspaceRoot, 'configs/invalid-string.txt');
    const manifestPath = join(workspaceRoot, 'manifests/invalid-string.yaml');
    await writeFileWithParents(sourcePath, 'invalid-string');
    await writeFileWithParents(manifestPath, `value: \${{ hashFile('configs/invalid-string.txt', '8') }}\n`);

    await assert.rejects(
      () => processFiles('manifests/invalid-string.yaml', 'sha256', true),
      /Expected integer >= 1/
    );
  });

  it('should fail when requested hash length is greater than hash length', async () => {
    const sourcePath = join(workspaceRoot, 'configs/invalid-long.txt');
    const manifestPath = join(workspaceRoot, 'manifests/invalid-long.yaml');
    await writeFileWithParents(sourcePath, 'invalid-long');
    await writeFileWithParents(manifestPath, `value: \${{ hashFile('configs/invalid-long.txt', 999) }}\n`);

    await assert.rejects(
      () => processFiles('manifests/invalid-long.yaml', 'sha256', true),
      /Requested 999, but hash length is 64/
    );
  });

  it('should not modify file if target file does not exist and throwIfFileNotExists is false', async () => {
    const deploymentFilePath = join(workspaceRoot, 'apps/swarm/deployment-missing.yaml');
    const deploymentContent = `
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    config-hash: \${{ hashFile('./missing.json') }}
`;
    await writeFileWithParents(deploymentFilePath, deploymentContent);

    const result = await processFiles('apps/swarm/deployment-missing.yaml', 'sha256', false);

    assert.strictEqual(result.processedCount, 1, 'Should process 1 file');
    assert.strictEqual(result.modifiedCount, 0, 'Should modify 0 files');

    const updatedContent = await readFile(deploymentFilePath, 'utf8');
    assert.strictEqual(updatedContent, deploymentContent, 'File content should remain unchanged');
  });

  it('should fail if target file does not exist and throwIfFileNotExists is true', async () => {
    const deploymentFilePath = join(workspaceRoot, 'apps/swarm/deployment-strict.yaml');
    const deploymentContent = `
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    config-hash: \${{ hashFile('./missing-strict.json') }}
`;
    await writeFileWithParents(deploymentFilePath, deploymentContent);

    await assert.rejects(
      () => processFiles('apps/swarm/deployment-strict.yaml', 'sha256', true),
      /File not found for hashFile/
    );
  });

  it('should leave placeholder unchanged for outside-workspace path when throwIfFileNotExists is false', async () => {
    const deploymentFilePath = join(workspaceRoot, 'apps/swarm/deployment-outside-false.yaml');
    const deploymentContent = `
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    config-hash: \${{ hashFile('../../../../outside.json') }}
`;
    await writeFileWithParents(deploymentFilePath, deploymentContent);

    const result = await processFiles('apps/swarm/deployment-outside-false.yaml', 'sha256', false);
    assert.strictEqual(result.processedCount, 1, 'Should process 1 file');
    assert.strictEqual(result.modifiedCount, 0, 'Should modify 0 files');

    const updatedContent = await readFile(deploymentFilePath, 'utf8');
    assert.strictEqual(updatedContent, deploymentContent, 'File content should remain unchanged');
  });

  it('should fail for outside-workspace path when throwIfFileNotExists is true', async () => {
    const deploymentFilePath = join(workspaceRoot, 'apps/swarm/deployment-outside-true.yaml');
    const deploymentContent = `
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    config-hash: \${{ hashFile('../../../../outside.json') }}
`;
    await writeFileWithParents(deploymentFilePath, deploymentContent);

    await assert.rejects(
      () => processFiles('apps/swarm/deployment-outside-true.yaml', 'sha256', true),
      /outside workspace/
    );
  });
});

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeFileWithParents(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}
