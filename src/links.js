import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Vínculo entre o usuário do Discord e o Account ID do Deadlock (vale em todos os servidores).
const FILE = 'links.json';

function load() {
  try {
    return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

export const getLink = (userId) => load()[userId] ?? null;

export function setLink(userId, accountId) {
  const all = load();
  all[userId] = accountId;
  writeFileSync(FILE, JSON.stringify(all));
}

export function removeLink(userId) {
  const all = load();
  const had = userId in all;
  delete all[userId];
  writeFileSync(FILE, JSON.stringify(all));
  return had;
}
