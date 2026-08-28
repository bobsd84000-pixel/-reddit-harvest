---
name: reddit-harvest
description: Récolte des posts et commentaires Reddit et les injecte dans le pipeline BulkDirect (Supabase). Utilise cette skill dès que l'utilisateur parle de scraper Reddit, de surveiller un subreddit, de collecter des signaux, de veille concurrentielle, d'extraire des discussions, de remplir la base BulkDirect, ou mentionne "harvest", "récolte", "scan Reddit" — même sans dire explicitement "scraper". Utilise-la aussi quand un dash de veille renvoie une erreur CORS sur Reddit.
compatibility: Vercel (route API) + Supabase + Reddit OAuth. iPhone-friendly, zéro CLI.
---

# Reddit Harvest

Scraper Reddit branché sur BulkDirect. Le navigateur n'appelle jamais Reddit directement — une route Vercel fait le proxy avec OAuth, puis écrit dans Supabase.

## Pourquoi un proxy

Safari bloque `reddit.com/search.json` en CORS. C'est le mur qui a limité LAST30DAYS. La route Vercel règle trois choses d'un coup : CORS, rate limit (60 req/min authentifié contre 10 en anonyme), et les secrets restent côté serveur.

## Architecture

```
iPhone Safari
  → POST /api/harvest        (route Vercel)
  → OAuth Reddit             (client_credentials)
  → GET /r/<sub>/search      (Reddit API)
  → normalisation + dédoublonnage
  → INSERT reddit_signals    (Supabase)
  → agents BulkDirect prennent le relais
```

Correspondance avec les 4 agents BulkDirect :

| Agent | Ce que fait cette skill |
|---|---|
| Planificateur | reçoit `subreddits[]`, `keywords[]`, `days` |
| Exécuteur Reddit | **c'est cette skill** — la route `/api/harvest` |
| Ingénieur Pipeline | normalisation + dédoublonnage dans la route |
| QA Reviewer | colonne `quality` calculée à l'insert |

## Étape 1 — Table Supabase

À exécuter une fois dans le SQL Editor du projet `icpdgjzlmdculnrxmjiy` :

```sql
create table reddit_signals (
  id            bigserial primary key,
  post_id       text unique not null,
  subreddit     text not null,
  title         text not null,
  body          text,
  author        text,
  url           text,
  score         int  default 0,
  num_comments  int  default 0,
  engagement    int  generated always as (score + num_comments * 2) stored,
  quality       numeric(3,2) default 0,
  keyword       text,
  created_utc   timestamptz not null,
  harvested_at  timestamptz default now()
);

create index on reddit_signals (subreddit, created_utc desc);
create index on reddit_signals (engagement desc);

alter table reddit_signals enable row level security;

create policy "service role only"
  on reddit_signals for all
  using (auth.role() = 'service_role');
```

`engagement` pondère les commentaires ×2 : une discussion vaut plus qu'un upvote passif.

## Étape 2 — Route Vercel

Fichier `api/harvest.js` à la racine du repo `bobsd84000-pixel/bulk-direct-II`.

```javascript
// Proxy Reddit authentifié + insertion Supabase.
// Body attendu : { subreddits: [], keywords: [], days: 30, limit: 100 }

import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Jeton Reddit — 24 h de validité, mis en cache entre les invocations tièdes
let jeton = null, expire = 0;

async function getJeton() {
  if (jeton && Date.now() < expire) return jeton;
  const auth = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');

  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'bulkdirect/1.0'
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`OAuth Reddit ${r.status}`);
  const d = await r.json();
  jeton = d.access_token;
  expire = Date.now() + (d.expires_in - 60) * 1000;
  return jeton;
}

// Score de qualité : titre exploitable, corps présent, pas supprimé
function qualite(p) {
  let q = 0.4;
  if (p.title && p.title.length > 25) q += 0.2;
  if (p.selftext && p.selftext.length > 120) q += 0.2;
  if (p.author && p.author !== '[deleted]') q += 0.2;
  return Math.min(q, 1);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erreur: 'POST uniquement' });
  }

  const {
    subreddits = [],
    keywords = [],
    days = 30,
    limit = 100
  } = req.body || {};

  if (!subreddits.length) {
    return res.status(400).json({ erreur: 'subreddits requis' });
  }

  try {
    const tok = await getJeton();
    const seuil = Date.now() / 1000 - days * 86400;
    const vus = new Set();
    const lignes = [];

    for (const sub of subreddits) {
      for (const kw of keywords.length ? keywords : ['']) {
        const url =
          `https://oauth.reddit.com/r/${sub}/search` +
          `?q=${encodeURIComponent(kw)}&restrict_sr=1` +
          `&sort=top&t=month&limit=${Math.min(limit, 100)}`;

        const r = await fetch(url, {
          headers: {
            Authorization: `Bearer ${tok}`,
            'User-Agent': 'bulkdirect/1.0'
          }
        });
        if (!r.ok) continue;

        const j = await r.json();
        for (const { data: p } of j.data?.children || []) {
          if (p.created_utc < seuil) continue;
          // Dédoublonnage sur les 60 premiers caractères du titre
          const cle = p.title.slice(0, 60).toLowerCase();
          if (vus.has(cle)) continue;
          vus.add(cle);

          lignes.push({
            post_id: p.id,
            subreddit: p.subreddit,
            title: p.title,
            body: p.selftext || null,
            author: p.author,
            url: `https://reddit.com${p.permalink}`,
            score: p.score,
            num_comments: p.num_comments,
            quality: qualite(p),
            keyword: kw || null,
            created_utc: new Date(p.created_utc * 1000).toISOString()
          });
        }
        // Respect du rate limit Reddit
        await new Promise(s => setTimeout(s, 1100));
      }
    }

    // QA : on rejette sous 0,6
    const gardes = lignes.filter(l => l.quality >= 0.6);

    const { error } = await db
      .from('reddit_signals')
      .upsert(gardes, { onConflict: 'post_id', ignoreDuplicates: true });

    if (error) throw error;

    return res.status(200).json({
      recoltes: lignes.length,
      gardes: gardes.length,
      rejetes: lignes.length - gardes.length,
      subreddits
    });
  } catch (e) {
    return res.status(500).json({ erreur: e.message });
  }
}
```

## Étape 3 — Variables d'environnement

Vercel → projet BulkDirect → Settings → Environment Variables :

```
REDDIT_CLIENT_ID          déjà présent
REDDIT_CLIENT_SECRET      déjà présent
VITE_SUPABASE_URL         déjà présent
SUPABASE_SERVICE_KEY      À AJOUTER — Supabase → Settings → API → service_role
```

La clé `service_role` contourne le RLS. Elle ne sort jamais du serveur, jamais dans un fichier `VITE_*`.

## Étape 4 — Appel

```javascript
const r = await fetch('/api/harvest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    subreddits: ['startups', 'SaaS', 'Entrepreneur'],
    keywords: ['outil de veille', 'trop cher', 'je cherche un'],
    days: 30
  })
});
// → { recoltes: 214, gardes: 187, rejetes: 27, subreddits: [...] }
```

## Limites à connaître

| Symptôme | Cause | Fix |
|---|---|---|
| `OAuth Reddit 401` | secret Reddit périmé | régénérer sur reddit.com/prefs/apps |
| 504 au-delà de 5 subreddits | timeout Vercel 10 s | découper en plusieurs appels |
| 0 ligne insérée | RLS bloque | vérifier `SUPABASE_SERVICE_KEY` |
| Doublons en base | `post_id` absent | l'upsert gère, ne pas retirer `onConflict` |

Reddit plafonne les recherches à 100 résultats par requête, quelle que soit la valeur de `limit`. Pour aller plus loin il faut paginer sur `after`, ou multiplier les mots-clés.

## Ne pas faire

- Appeler Reddit depuis le navigateur. C'est le mur CORS, la route existe pour ça.
- Dépasser 1 requête/seconde. Reddit coupe l'accès sans avertissement.
- Descendre le seuil QA sous 0,6 : la base se remplit de posts supprimés et de titres d'une ligne.

---
**Version** : 2026-08-03 | **Repo** : `bobsd84000-pixel/bulk-direct-II` | **Table** : `reddit_signals`
