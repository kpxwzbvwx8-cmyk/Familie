const c = require('node:crypto');
const { execFileSync } = require('node:child_process');
const envelope = require('./mascot-envelope.json');
const decode = s => Buffer.from(s, 'base64');
const seed = c.hkdfSync('sha256', process.env.SUPABASE_ACCESS_TOKEN, process.env.PROJECT_REF, 'Familie/mascot-provisioning/v1', 32);
const privateKey = c.createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),Buffer.from(seed)]),format:'der',type:'pkcs8'});
const publicKey = c.createPublicKey({key:decode(envelope.ephemeral), format:'der',type:'spki'});
const key = c.hkdfSync('sha256',c.diffieHellman({privateKey,publicKey}),'','family-code',32);
const decipher = c.createDecipheriv('aes-256-gcm',key,decode(envelope.iv));
decipher.setAuthTag(decode(envelope.tag));
const candidate = Buffer.concat([decipher.update(decode(envelope.data)),decipher.final()]).toString();
const db = process.argv[2];
console.log('::notice::Private Übergabe entschlüsselt.');
const query = (input,env) => {try { return execFileSync('psql',['-XqAt','-v','ON_ERROR_STOP=1','--dbname',db],{input,env,encoding:'utf8'}).trim(); } catch(err) { console.error('::error::Datenbankabfrage fehlgeschlagen: ' + (err.status ?? err.code)); process.exit(1); } };
const env = {...process.env, CANDIDATE:candidate};
const family = query(`\\getenv candidate CANDIDATE
select code from public.family where regexp_replace(code,'[^[:alnum:]]','','g') =
  regexp_replace(upper(:'candidate'),'[^[:alnum:]]','','g');`,env);
if (!family || family.includes('\n')) { console.error('::error::Kein eindeutiger Familiencode-Treffer.'); process.exit(1); }
process.env.TEAM_MASCOT_FAMILY_CODE = family;
try { require('./configure-mascots.js'); } catch { console.error('::error::Maskottchen-Datensatz konnte nicht gespeichert werden.'); process.exit(1); }
const ok = query(`\\getenv code TEAM_MASCOT_FAMILY_CODE
select exists(select from public.family f join public.app_secrets t on t.key='team_mascot_code' and t.value=to_jsonb(f.code)
  join public.app_secrets m on m.key='team_mascots' and jsonb_typeof(m.value->'egg')='object'
  where f.code=:'code' and 2=(select count(*) from public.pets p where p.family_id=f.id and p.legacy_profile->>'id' in ('pokemon-speedy','pokemon-idefix')));`,process.env);
if (ok !== 't') {console.error('::error::Kontrolle der Familienzuordnung fehlgeschlagen.'); process.exit(1);}
console.log('::notice::Ei und beide ursprünglichen Tierpässe in der zugeordneten Familie bestätigt.');
