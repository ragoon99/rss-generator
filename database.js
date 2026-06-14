import fs from 'fs/promises';
import path from 'path';

async function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

export async function readJson(filePath, defaultValue = []) {
  await ensureDir(filePath);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await writeJson(filePath, defaultValue);
      return defaultValue;
    }
    throw err;
  }
}

export async function writeJson(filePath, data) {
  await ensureDir(filePath);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}
