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

// Score de qualité : titre exploitable, corps présent, auteur non supprimé
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
