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
const query = (input,env) => execFileSync('psql',['-XqAt','-v','ON_ERROR_STOP=1','--dbname',db],{input,env,encoding:'utf8'}).trim();
const env = {...process.env, CANDIDATE:candidate};
const family = query(`\\getenv candidate CANDIDATE
select code from public.family where regexp_replace(code,'[[:space:]]','','g') =
  regexp_replace(upper(:'candidate'),'[[:space:]]','','g');`,env);
if (!family || family.includes('\n')) throw Error('Die Familie konnte nicht eindeutig zugeordnet werden.');
process.env.TEAM_MASCOT_FAMILY_CODE = family;
require('./configure-mascots.js');
const ok = query(`\\getenv code TEAM_MASCOT_FAMILY_CODE
select exists(select from public.family f join public.app_secrets t on t.key='team_mascot_code' and t.value=to_jsonb(f.code)
  join public.app_secrets m on m.key='team_mascots' and jsonb_typeof(m.value->'egg')='object'
  where f.code=:'code' and 2=(select count(*) from public.pets p where p.family_id=f.id and p.legacy_profile->>'id' in ('pokemon-speedy','pokemon-idefix')));`,process.env);
if (ok !== 't') throw Error('Kontrolle der Familienzuordnung fehlgeschlagen.');
console.log('::notice::Ei und beide ursprünglichen Tierpässe in der zugeordneten Familie bestätigt.');
