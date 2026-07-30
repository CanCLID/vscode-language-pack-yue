import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function validatedParent(parent) {
  const resolved = path.resolve(parent);
  await mkdir(resolved, { recursive: true });
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('temporary parent must be a real directory');
  return realpath(resolved);
}

export async function createOwnedTemp(parent, prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9._-]+$/.test(prefix)) throw new Error('temporary prefix is invalid');
  const realParent = await validatedParent(parent);
  const temporary = await mkdtemp(path.join(realParent, prefix));
  if (!contained(realParent, temporary)) throw new Error('created temporary path escaped its parent');
  const metadata = await lstat(temporary);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('created temporary path is not an owned directory');
  return { parent: realParent, path: temporary };
}

export async function removeOwnedTemp(owned) {
  if (!owned || typeof owned.parent !== 'string' || typeof owned.path !== 'string') throw new Error('temporary ownership record is invalid');
  const parent = await validatedParent(owned.parent);
  const target = path.resolve(owned.path);
  if (!contained(parent, target)) throw new Error('temporary cleanup path escaped its parent');
  let metadata;
  try { metadata = await lstat(target); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('temporary cleanup target is not an owned directory');
  const realTarget = await realpath(target);
  if (realTarget !== target || !contained(parent, realTarget)) throw new Error('temporary cleanup target changed identity');
  await rm(target, { recursive: true, force: false });
}
