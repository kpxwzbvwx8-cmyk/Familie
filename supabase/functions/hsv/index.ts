// HSV-Spielplan: holt die Spiele des Hamburger SV von OpenLigaDB (Bundesliga, 2. Bundesliga, DFB-Pokal)
// und liefert sie vereinheitlicht zurück. Zwischenspeicher: 30 Minuten.
import { bearer, cors, json, memberFromToken } from '../_shared/common.ts';

type Match = {
  id: number; kickoff: string; league: string; round: string; home: string; away: string;
  homeIcon: string | null; awayIcon: string | null; isHome: boolean; finished: boolean;
  result: string | null; stadium: string | null; city: string | null;
};

const LEAGUES: [string, string][] = [['bl1', 'Bundesliga'], ['bl2', '2. Bundesliga'], ['dfb', 'DFB-Pokal']];
let cache: { at: number; data: Match[] } | null = null;

const isHsv = (name = '') => /hamburger sv/i.test(name) && !/\bII\b|U\d\d/i.test(name);

async function fetchLeague(shortcut: string, label: string, season: number): Promise<Match[]> {
  try {
    const r = await fetch(`https://api.openligadb.de/getmatchdata/${shortcut}/${season}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return [];
    const list = await r.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => isHsv(m.team1?.teamName) || isHsv(m.team2?.teamName))
      .map((m) => {
        const end = (m.matchResults ?? []).find((x: { resultTypeID: number }) => x.resultTypeID === 2) ?? (m.matchResults ?? []).at(-1);
        return {
          id: m.matchID,
          kickoff: m.matchDateTimeUTC ?? m.matchDateTime,
          league: label,
          round: m.group?.groupName ?? '',
          home: m.team1?.teamName ?? '?',
          away: m.team2?.teamName ?? '?',
          homeIcon: m.team1?.teamIconUrl ?? null,
          awayIcon: m.team2?.teamIconUrl ?? null,
          isHome: isHsv(m.team1?.teamName),
          finished: Boolean(m.matchIsFinished),
          result: end ? `${end.pointsTeam1}:${end.pointsTeam2}` : null,
          stadium: m.location?.locationStadium ?? null,
          city: m.location?.locationCity ?? null,
        };
      });
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const me = await memberFromToken(bearer(req));
  if (!me) return json({ error: 'Nicht angemeldet' }, 401);
  if (cache && Date.now() - cache.at < 30 * 60e3) return json({ matches: cache.data, cached: true });

  // Saison beginnt im Sommer: ab Juli die laufende, davor die des Vorjahres – zur Sicherheit beide Nachbarsaisons
  const now = new Date();
  const season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const jobs = [];
  for (const s of [season - 1, season, season + 1]) for (const [k, l] of LEAGUES) jobs.push(fetchLeague(k, l, s));
  const all = (await Promise.all(jobs)).flat();
  const unique = [...new Map(all.map((m) => [m.id, m])).values()].sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  if (unique.length) cache = { at: Date.now(), data: unique };
  return json({ matches: unique, cached: false });
});
