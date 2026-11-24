// Nach der Migration liegen vorhandene Maskottchen bereits im privaten Projekt.
// Bei einer Erstinstallation fehlt die alte Familienzeile. Hierfür verwenden wir
// den ursprünglichen Datensatz aus derselben App-Version wie die Migration.
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const familyCode = process.env.TEAM_MASCOT_FAMILY_CODE?.trim();
if (!familyCode) throw new Error('Die private Familienzuordnung fehlt.');
const migration = readFileSync(join(__dirname, '../supabase/migrations/20261121210000_familienbereiche.sql'), 'utf8');
const legacyTeam = JSON.parse(migration.split('$team$')[1]);
execFileSync('psql', ['-Xq', '-1', '-v', 'ON_ERROR_STOP=1', '--dbname', process.argv[2]], {
  env: { ...process.env, TEAM_MASCOT_FAMILY_CODE: familyCode, MASCOT_TEMPLATE: JSON.stringify(legacyTeam) },
  input: `\\getenv family_code TEAM_MASCOT_FAMILY_CODE
\\getenv template MASCOT_TEMPLATE
insert into public.app_secrets(key,value) values ('team_mascots', :'template'::jsonb) on conflict (key) do update set value = public.app_secrets.value || jsonb_build_object('egg', excluded.value->'egg')
where jsonb_typeof(public.app_secrets.value->'egg') is distinct from 'object';
insert into public.app_secrets(key,value) values ('team_mascot_code',to_jsonb(:'family_code'::text))
on conflict (key) do update set value = excluded.value;
`,
  stdio: ['pipe', 'ignore', 'inherit'],
});
