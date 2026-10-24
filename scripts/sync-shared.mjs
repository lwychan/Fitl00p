// src/diabetes-engine.js, nightscout-adapter.js and readiness-model.js are the single source
// of truth. The Edge Functions need ES modules, so this writes
// supabase/functions/_shared/<name>.js from them: same code, with the
// browser/CommonJS export swapped for `export default`.
//
//   node scripts/sync-shared.mjs          write the server copies
//   node scripts/sync-shared.mjs --check  exit 1 if a copy is stale
import fs from 'node:fs';

const MODULES = [
  { name: 'diabetes-engine',    global: 'DiabetesEngine' },
  { name: 'nightscout-adapter', global: 'NightscoutAdapter' },
  { name: 'readiness-model',    global: 'ReadinessModel' },
];
const check = process.argv.includes('--check');
let stale = false;

for (const { name, global } of MODULES) {
  const src = fs.readFileSync(`src/${name}.js`, 'utf8').replace(/\r\n/g, '\n');
  const exportBlock = new RegExp(
    `if \\(typeof module !== 'undefined' && module\\.exports\\) \\{\\n  module\\.exports = ${global};\\n\\} else if \\(typeof window !== 'undefined'\\) \\{\\n  window\\.${global} = ${global};\\n\\}`
  );
  if (!/^\(function \(\) \{$/m.test(src) || !exportBlock.test(src)) {
    throw new Error(`src/${name}.js: IIFE opener or export block not found — update this script`);
  }
  const out =
    `// GENERATED from src/${name}.js by scripts/sync-shared.mjs — edit that file, not this one.\n` +
    src
      .replace(/^\(function \(\) \{$/m, `const ${global}NS = (function () {`)
      .replace(exportBlock, `return ${global};`) +
    `\nexport default ${global}NS;\n`;

  const dest = `supabase/functions/_shared/${name}.js`;
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n') : null;
  if (current === out) continue;
  if (check) { console.error(`${dest} is out of date — run: node scripts/sync-shared.mjs`); stale = true; }
  else { fs.writeFileSync(dest, out); console.log(`wrote ${dest}`); }
}
if (stale) process.exit(1);
