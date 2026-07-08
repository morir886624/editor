// Le déploiement Git de Hostinger (hébergement mutualisé) installe le binaire
// natif de turbo sans le bit d'exécution, d'où l'EACCES quand `turbo run build`
// tente de l'exécuter :
//   EACCES ... /node_modules/.pnpm/@turbo+linux-64@x.y.z/node_modules/@turbo/linux-64/bin/turbo
//
// Ce script (lancé en postinstall ET juste avant le build) remet +x sur tous les
// binaires turbo qu'il trouve. Il n'a AUCUNE dépendance et est sans danger :
// fs.chmodSync est un quasi no-op sous Windows (pour le dev local) et chaque
// chemin absent est ignoré silencieusement.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function fix(binPath) {
  if (!existsSync(binPath)) return;
  try {
    chmodSync(binPath, 0o755);
    console.log('[fix-turbo-perms] +x', binPath);
  } catch (err) {
    console.warn('[fix-turbo-perms] impossible de chmod', binPath, '-', err.message);
  }
}

function safeReaddir(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const candidates = [];

// 1. Layout pnpm : node_modules/.pnpm/@turbo+<plat>@<ver>/node_modules/@turbo/<plat>/bin/turbo
for (const name of safeReaddir('node_modules/.pnpm')) {
  if (!name.startsWith('@turbo+')) continue;
  const scope = join('node_modules/.pnpm', name, 'node_modules', '@turbo');
  for (const plat of safeReaddir(scope)) {
    candidates.push(join(scope, plat, 'bin', 'turbo'));
    candidates.push(join(scope, plat, 'bin', 'turbo.exe'));
  }
}

// 2. Scope hoisté : node_modules/@turbo/<plat>/bin/turbo
for (const plat of safeReaddir('node_modules/@turbo')) {
  candidates.push(join('node_modules/@turbo', plat, 'bin', 'turbo'));
  candidates.push(join('node_modules/@turbo', plat, 'bin', 'turbo.exe'));
}

// 3. Wrapper JS de premier niveau
candidates.push('node_modules/turbo/bin/turbo');

for (const c of candidates) fix(c);
