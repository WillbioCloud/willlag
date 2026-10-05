#!/usr/bin/env node
'use strict';

/**
 * Gera `src/shared/tweakCatalog.json` a partir do catálogo real do processo
 * principal (public/services/tweakRegistry.js).
 *
 * Por que isso existe:
 *   O renderer e o "modo demonstração" (mockBackend) precisam dos metadados dos
 *   tweaks (rótulos, risco, descrição técnica, opções). Duplicar esses textos na
 *   mão gera drift: alguém muda o tweak no main e a UI mente.
 *
 *   Aqui a fonte de verdade continua sendo o código do main process. Este script
 *   exporta um snapshot JSON que:
 *     - o CRA consegue importar (está dentro de src/);
 *     - é validado por test/tweakCatalog.test.js (falha se estiver desatualizado).
 *
 * Uso:  node scripts/sync-tweak-catalog.js [--check]
 *   --check  não grava; apenas compara e sai com código 1 se divergir (usado no CI/teste)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'shared', 'tweakCatalog.json');

function buildCatalog() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'willlag-catalog-'));
  const stateStore = require(path.join(ROOT, 'public/services/stateStore'));
  stateStore.configure({ dir: tmp });

  const registry = require(path.join(ROOT, 'public/services/tweakRegistry'));
  const validation = registry.validate();

  if (!validation.ok) {
    throw new Error('Catálogo inválido: ' + validation.problems.join('; '));
  }

  const catalog = registry.getCatalog();

  const payload = {
    $schema: 'willlag/tweak-catalog@1',
    generatedAt: new Date().toISOString(),
    generator: 'scripts/sync-tweak-catalog.js',
    note:
      'ARQUIVO GERADO — não edite à mão. Fonte de verdade: public/services/{tcpip,wifi,dnsService,mtuService}.js. ' +
      'Regenere com: node scripts/sync-tweak-catalog.js',
    groups: catalog.groups,
    riskLabels: catalog.riskLabels,
    presets: Object.values(catalog.presets).map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      tweakIds: p.tweakIds,
    })),
    tweaks: catalog.tweaks.map((t) => ({
      id: t.id,
      group: t.group,
      groupLabel: t.groupLabel,
      groupIcon: t.groupIcon,
      label: t.label,
      description: t.description,
      why: t.why,
      risk: t.risk,
      riskLabel: t.riskLabel,
      riskColor: t.riskColor,
      requiresAdmin: t.requiresAdmin,
      scope: t.scope,
      defaultInPreset: t.defaultInPreset,
      sessionCritical: t.sessionCritical,
      rebootRecommended: t.rebootRecommended,
      needsDiscovery: t.needsDiscovery,
      legacy: t.legacy,
      options: t.options,
      order: t.order,
    })),
  };

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    /* melhor esforço */
  }

  return payload;
}

function serialize(payload) {
  // generatedAt muda a cada execução: removemos antes de comparar.
  const clone = { ...payload };
  delete clone.generatedAt;
  return JSON.stringify(clone, null, 2) + '\n';
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const payload = buildCatalog();
  const next = serialize(payload);

  let current = null;
  try {
    current = fs.readFileSync(OUT, 'utf8');
  } catch (err) {
    current = null;
  }

  if (current !== null) {
    let currentNormalized = current;
    try {
      const parsed = JSON.parse(current);
      currentNormalized = serialize(parsed);
    } catch (err) {
      currentNormalized = current;
    }
    if (currentNormalized === next) {
      console.log(`✔ Catálogo de tweaks já está sincronizado (${payload.tweaks.length} tweaks).`);
      return 0;
    }
  }

  if (checkOnly) {
    console.error(
      '✖ Catálogo de tweaks DESATUALIZADO. Rode: node scripts/sync-tweak-catalog.js\n' +
        `  (arquivo: ${path.relative(ROOT, OUT)})`
    );
    return 1;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`✔ Catálogo exportado: ${path.relative(ROOT, OUT)} (${payload.tweaks.length} tweaks, ${payload.presets.length} presets)`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { buildCatalog, serialize };
