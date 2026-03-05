import * as core from '@actions/core';
import { glob } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export async function processFiles(
  filesPattern: string,
  algorithm: string = 'sha256',
  throwIfFileNotExists: boolean = true
): Promise<{ processedCount: number, modifiedCount: number }> {
  core.info(`Searching for files matching: ${filesPattern}`);
  core.info(`Using hashing algorithm: ${algorithm}`);

  const hashRegex = /\$\{\{\s*hashFile\(['"]([^'"]+)['"]\)\s*\}\}/g;
  const hashCache = new Map<string, Promise<string>>();

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
    const newContent = await replaceAsync(content, hashRegex, async (match, targetPath) => {
      try {
        const targetAbsolutePath = resolve(targetPath);
        const hash = await getOrCreateHash(targetAbsolutePath);
        core.info(`[${filePath}] Replaced ${match} with ${hash}`);
        hasModifications = true;
        return hash;
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
