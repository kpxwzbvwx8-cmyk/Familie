// Make deployment failures readable in GitHub annotations while redacting credentials.
const { readFileSync } = require('node:fs');
let log = readFileSync(process.argv[2], 'utf8');
for (const [name, value] of Object.entries(process.env)) {
  if (value?.length >= 4 && /TOKEN|PASSWORD|SECRET|KEY|PROJECT_REF/.test(name)) {
    log = log.split(value).join('[redacted]');
  }
}
log = log.replace(/https?:\/\/[^\s"']+/g, '[URL]')
  .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database URL]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
  .replace(/sbp_[a-f0-9]+/gi, '[token]');
const lines = log.split(/\r?\n/).filter(line => /error|fail|unauthor|forbid|unavailable|not found|invalid|could not|cannot|\b[45]\d\d\b/i.test(line));
const message = (lines.slice(-12).join('\n') || 'Veröffentlichung fehlgeschlagen. Bitte das Job-Protokoll prüfen.').slice(0, 3500);
console.log('::error::' + message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
