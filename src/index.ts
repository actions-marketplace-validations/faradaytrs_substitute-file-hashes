import * as core from '@actions/core';
import { glob } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export async function processFiles(
  filesPattern: string,
  algorithm: string = 'sha256',
  throwIfFileNotExists: boolean = true
): Promise<{ processedCount: number, modifiedCount: number }> {
  core.info(`Searching for files matching: ${filesPattern}`);
  core.info(`Using hashing algorithm: ${algorithm}`);

  const hashRegex = /\$\{\{\s*hashFile\(([^)]*)\)\s*\}\}/g;
  const hashCache = new Map<string, Promise<string>>();
  const workspaceRoot = resolve(process.cwd());

  let processedCount = 0;
  let modifiedCount = 0;

  const getOrCreateHash = (targetAbsolutePath: string): Promise<string> => {
    const cacheKey = targetAbsolutePath;
    const cachedHash = hashCache.get(cacheKey);
    if (cachedHash) {
      return cachedHash;
    }

    const hashPromise = readFile(targetAbsolutePath)
      .then((targetContent) => createHash(algorithm).update(targetContent).digest('hex'))
      .catch((error) => {
        // Avoid caching failed calculations (e.g. temporary filesystem issues).
        hashCache.delete(cacheKey);
        throw error;
      });

    hashCache.set(cacheKey, hashPromise);
    return hashPromise;
  };

  for await (const filePath of glob(filesPattern)) {
    processedCount++;
    const absolutePath = resolve(filePath);
    const content = await readFile(absolutePath, 'utf8');

    let hasModifications = false;
    const newContent = await replaceAsync(content, hashRegex, async (match, argsRaw) => {
      const parsedExpression = parseHashFileExpression(argsRaw, filePath, match);
      const { path: targetPath, length } = parsedExpression;
      try {
        const targetAbsolutePath = resolveHashFilePath(targetPath, absolutePath, workspaceRoot);
        if (!isPathInsideWorkspace(targetAbsolutePath, workspaceRoot)) {
          const outsideWorkspaceMessage = `[${filePath}] Resolved path for hashFile('${targetPath}') is outside workspace: ${targetAbsolutePath}`;
          if (throwIfFileNotExists) {
            throw new Error(outsideWorkspaceMessage);
          }
          core.warning(outsideWorkspaceMessage);
          return match;
        }
        const hash = await getOrCreateHash(targetAbsolutePath);
        const finalHash = applyHashLength(hash, length, filePath, match);
        core.info(`[${filePath}] Replaced ${match} with ${finalHash}`);
        hasModifications = true;
        return finalHash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          const missingFileMessage = `[${filePath}] File not found for hashFile('${targetPath}')`;
          if (throwIfFileNotExists) {
            throw new Error(missingFileMessage);
          }
          core.warning(missingFileMessage);
          return match;
        }
        throw error;
      }
    });

    if (hasModifications) {
      await writeFile(absolutePath, newContent, 'utf8');
      modifiedCount++;
    }
  }

  core.info(`Processed ${processedCount} files, modified ${modifiedCount} files.`);
  return { processedCount, modifiedCount };
}

export function resolveHashFilePath(hashArg: string, currentFilePath: string, workspaceRoot: string): string {
  const isRelativeToCurrentFile = hashArg.startsWith('./') || hashArg.startsWith('../');
  if (isRelativeToCurrentFile) {
    return resolve(dirname(currentFilePath), hashArg);
  }
  return resolve(workspaceRoot, hashArg);
}

function isPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const pathDifference = relative(workspaceRoot, targetPath);
  return pathDifference === '' || (!pathDifference.startsWith('..') && !isAbsolute(pathDifference));
}

function parseHashFileExpression(argsRaw: string, filePath: string, expression: string): { path: string, length?: number } {
  const argsMatch = argsRaw.match(/^\s*(['"])([^'"]+)\1(?:\s*,\s*(.+?)\s*)?$/);
  if (!argsMatch) {
    throw new Error(`[${filePath}] Invalid hashFile expression: ${expression}`);
  }

  const targetPath = argsMatch[2];
  const lengthArg = argsMatch[3];
  if (lengthArg === undefined) {
    return { path: targetPath };
  }

  if (!/^-?\d+$/.test(lengthArg)) {
    throw new Error(`[${filePath}] Invalid hash length in expression ${expression}. Expected integer >= 1.`);
  }

  const length = Number.parseInt(lengthArg, 10);
  if (!Number.isInteger(length) || length < 1) {
    throw new Error(`[${filePath}] Invalid hash length in expression ${expression}. Expected integer >= 1.`);
  }

  return { path: targetPath, length };
}

function applyHashLength(hash: string, length: number | undefined, filePath: string, expression: string): string {
  if (length === undefined) {
    return hash;
  }
  if (length > hash.length) {
    throw new Error(
      `[${filePath}] Invalid hash length in expression ${expression}. Requested ${length}, but hash length is ${hash.length}.`
    );
  }
  return hash.slice(0, length);
}

async function run(): Promise<void> {
  try {
    const filesPattern = core.getInput('files', { required: true });
    const algorithm = core.getInput('algorithm') || 'sha256';
    const throwIfFileNotExists = core.getBooleanInput('throwIfFileNotExists');

    await processFiles(filesPattern, algorithm, throwIfFileNotExists);
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function replaceAsync(str: string, regex: RegExp, asyncFn: (match: string, ...args: any[]) => Promise<string>): Promise<string> {
  const promises: Promise<string>[] = [];
  str.replace(regex, (match, ...args) => {
    const promise = asyncFn(match, ...args);
    promises.push(promise);
    return match;
  });
  const data = await Promise.all(promises);
  return str.replace(regex, () => data.shift() || '');
}

// Only run automatically if not imported as a module
if (process.env.NODE_ENV !== 'test') {
  run();
}
