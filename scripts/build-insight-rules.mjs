// supabase/seed/insight-rules.json is the source of truth for the insight
// rules. This validates every rule (metrics, operators, template keys —
// see src/insights.js) and writes supabase/sql/insight_rules_seed.sql,
// which upserts them into public.insight_rules and removes rules no longer
// in the file.
//
//   node scripts/build-insight-rules.mjs          write the SQL
//   node scripts/build-insight-rules.mjs --check  exit 1 if invalid or stale
import fs from 'node:fs';
import { createRequire } from 'node:module';

const Insights = createRequire(import.meta.url)('../src/insights.js');
const rules = JSON.parse(fs.readFileSync('supabase/seed/insight-rules.json', 'utf8'));

const ids = new Set();
let bad = false;
for (const r of rules) {
  const errs = Insights.validateRule(r);
  if (ids.has(r.id)) errs.push('duplicate id');
  ids.add(r.id);
  if (errs.length) { bad = true; console.error(`${r.id}: ${errs.join('; ')}`); }
}
if (bad) process.exit(1);

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const qn = s => (s == null ? 'null' : q(s));
const values = rules.map(r =>
  `  (${q(r.id)}, ${q(r.category)}, ${q(r.severity)}, ${r.priority}, ${q(JSON.stringify(r.conditions))}::jsonb, ${q(r.title)}, ${q(r.body)}, ${qn(r.headline)}, ${qn(r.reason)}, ${qn(r.action)}, ${q(r.slot || 'app')})`);
const sql = `-- GENERATED from supabase/seed/insight-rules.json by scripts/build-insight-rules.mjs — edit the JSON, not this.
insert into public.insight_rules (id, category, severity, priority, conditions, title, body, headline, reason, action, slot) values
${values.join(',\n')}
on conflict (id) do update set
  category = excluded.category, severity = excluded.severity, priority = excluded.priority,
  conditions = excluded.conditions, title = excluded.title, body = excluded.body,
  headline = excluded.headline, reason = excluded.reason, action = excluded.action, slot = excluded.slot, updated_at = now();

delete from public.insight_rules where id not in (${rules.map(r => q(r.id)).join(', ')});
`;

const dest = 'supabase/sql/insight_rules_seed.sql';
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n') : null;
  if (cur !== sql) { console.error(`${dest} is out of date — run: node scripts/build-insight-rules.mjs`); process.exit(1); }
} else {
  fs.writeFileSync(dest, sql);
  console.log(`wrote ${dest} (${rules.length} rules)`);
}
