// Supabase-Zugangsdaten (öffentlich – Schutz erfolgt über Row Level Security).
// Wird beim Veröffentlichen über GitHub Actions automatisch aus den Repository-Variablen
// SUPABASE_PROJECT_REF und SUPABASE_KEY erzeugt. Für lokale Tests hier eintragen.
window.FAMILIE_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
  version: 'dev',
  privacy: { controller: '', contact: '', retention: '', transfers: '' },
};
