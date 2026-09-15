// Proxies the ExerciseDB open API server-side to fetch exercise GIF URLs.
// Uses scored name matching to return the best GIF, not just the first result.
//
// Ported from src/netlify/functions/exercise-media.js — mechanical
// translation to Deno.serve; logic unchanged.

Deno.serve(async (req: Request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const qs = new URL(req.url).searchParams;
  const name = qs.get('name');
  const excludeId = qs.get('exclude') || null;
  if (!name) return new Response(JSON.stringify({ error: 'Missing name parameter' }), { status: 400, headers });

  // ── Name normalisation ──────────────────────────────────────
  // Strip equipment qualifiers so e.g. "Barbell Bench Press" and
  // "Bench Press" score as the same underlying movement.
  const normalise = (str: string) => str
    .toLowerCase()
    .replace(/\b(barbell|dumbbell|cable|machine|ez[- ]?bar|smith|band|resistance)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ── Known synonym groups ─────────────────────────────────────
  // Cases where common gym terminology differs from whatever specific
  // wording ExerciseDB happens to use internally. Grouped so any member
  // can be searched for when another member is what the routine calls it.
  const ALIAS_GROUPS = [
    ['trap bar deadlift', 'hex bar deadlift'],
    ['wheel rollout', 'ab wheel rollout', 'ab roller'],
    ['rear delt fly', 'reverse fly', 'rear deltoid fly', 'reverse pec deck fly'],
    ['chin up', 'close grip pull up', 'supinated pull up'],
    ['pull up', 'pullup'],
    ['sumo deadlift', 'sumo stance deadlift'],
    ['single leg romanian deadlift', 'single leg rdl', 'b stance romanian deadlift'],
    ['straight arm pulldown', 'straight arm lat pulldown'],
    ['chest dip', 'dip', 'triceps dip', 'parallel bar dip'],
    ['hanging leg raise', 'hanging knee raise', 'captains chair leg raise'],
    ['cable crunch', 'kneeling cable crunch', 'rope crunch'],
    ['lateral raise', 'side lateral raise', 'dumbbell lateral raise'],
    ['seated dumbbell press', 'seated shoulder press', 'seated dumbbell shoulder press'],
  ];

  function aliasesFor(normalisedQuery: string) {
    const out: string[] = [];
    for (const group of ALIAS_GROUPS) {
      if (group.includes(normalisedQuery)) {
        group.forEach(g => { if (g !== normalisedQuery) out.push(g); });
      }
    }
    return out;
  }

  // ── Progressive fallback for compound/modified names ─────────
  // "Single-Leg Romanian Deadlift" not found verbatim? Try without the
  // leading qualifier, then just the core two-word movement — this covers
  // new exercise names without needing a hand-written alias for every one.
  function fallbackVariants(normalisedQuery: string) {
    const words = normalisedQuery.split(' ').filter(Boolean);
    const variants: string[] = [];
    if (words.length > 2) {
      variants.push(words.slice(1).join(' '));
      variants.push(words.slice(-2).join(' '));
    }
    if (words.length > 3) variants.push(words.slice(-3).join(' '));
    return variants;
  }

  // Score: how many words from the query appear in the candidate name
  function score(query: string, candidate: string) {
    const qWords = normalise(query).split(' ').filter(Boolean);
    const cNorm  = normalise(candidate);
    const hits   = qWords.filter(w => cNorm.includes(w)).length;
    // Bonus for exact match
    const exact  = normalise(query) === cNorm ? 10 : 0;
    // Penalty for very different lengths (avoids "Leg Press" matching "Leg Press Machine Seated")
    const lenPenalty = Math.abs(query.split(' ').length - candidate.split(' ').length) * 0.5;
    return hits + exact - lenPenalty;
  }

  // Below this, treat it as no real match rather than showing a
  // confidently wrong GIF — a clear "not found" state is better than
  // an unrelated exercise demonstration.
  const MIN_ACCEPT_SCORE = 1;

  const normalisedName = normalise(name);
  const searchNames = [
    name.toLowerCase(),
    normalisedName,
    ...aliasesFor(normalisedName),
    ...fallbackVariants(normalisedName),
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let bestEx: any = null;
  let bestScore = -Infinity;

  for (const searchTerm of searchNames) {
    const searchUrl = `https://oss.exercisedb.dev/api/v1/exercises?name=${encodeURIComponent(searchTerm)}&limit=20`;

    try {
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; fitl00p/1.0)',
          'Accept': 'application/json',
          'Referer': 'https://oss.exercisedb.dev/',
        },
      });

      if (!res.ok) continue;

      const data = await res.json();
      const exercises = data.data || [];

      for (const ex of exercises) {
        if (!ex.gifUrl) continue;
        if (excludeId && ex.exerciseId === excludeId) continue;
        const s = score(name, ex.name);
        if (s > bestScore) {
          bestScore = s;
          bestEx = ex;
        }
      }

      // If we found a good match, stop searching
      if (bestScore >= 2) break;

    } catch {
      continue;
    }
  }

  if (!bestEx || bestScore < MIN_ACCEPT_SCORE) {
    return new Response(JSON.stringify({ error: 'Exercise not found', name, bestScore }), { status: 404, headers });
  }

  return new Response(JSON.stringify({
    exerciseId:       bestEx.exerciseId,
    name:             bestEx.name,
    gifUrl:           bestEx.gifUrl,
    targetMuscles:    bestEx.targetMuscles    || [],
    secondaryMuscles: bestEx.secondaryMuscles || [],
    bodyParts:        bestEx.bodyParts        || [],
    instructions:     bestEx.instructions     || [],
    matchScore:       bestScore,
  }), { status: 200, headers });
});
