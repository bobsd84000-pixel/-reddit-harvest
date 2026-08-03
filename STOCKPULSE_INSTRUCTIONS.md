# StockPulse MVP — Instructions Build

## Repo
`bobsd84000-pixel/stockpulse`

---

## MVP Specs

**Produit** : Dashboard crypto alertes temps réel + SaaS pricing.

**Durée** : 7-10 jours (parallèle BulkDirect).

**Design** : Dark brutalist, `#FF6B35` accent, Bebas Neue + IBM Plex Mono.

---

## Stack

| Composant | Tech |
|-----------|------|
| Frontend | React (Lovable) + Vercel |
| Backend | Supabase PostgreSQL + Edge Functions |
| Auth | Clerk |
| Crypto Data | CoinGecko API (gratuit) |
| Alertes | Discord webhook + Email (SendGrid ou Resend) |
| Paiement | Lemon Squeezy |
| Monitoring | Sentry (optionnel) |

---

## Architecture DB (Supabase)

### Tables

```sql
-- Users (via Clerk ID)
CREATE TABLE users (
  id UUID PRIMARY KEY,
  clerk_id TEXT UNIQUE,
  email TEXT,
  plan TEXT DEFAULT 'free', -- free, pro, premium
  credits INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Watchlist (monitorées)
CREATE TABLE watchlist (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  crypto_id TEXT, -- "bitcoin", "ethereum", etc
  symbol TEXT, -- "BTC", "ETH"
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Alerts (prix atteints)
CREATE TABLE alerts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  crypto_id TEXT,
  price_target DECIMAL,
  direction TEXT, -- "above" ou "below"
  triggered BOOLEAN DEFAULT FALSE,
  triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Price History (cache, 15min)
CREATE TABLE price_cache (
  id UUID PRIMARY KEY,
  crypto_id TEXT,
  price DECIMAL,
  price_usd DECIMAL,
  change_24h DECIMAL,
  cached_at TIMESTAMPTZ DEFAULT now()
);
```

### RLS Policies
- Tous les users ne voient que leurs watchlist + alerts
- Public read sur price_cache

---

## Features MVP

### Phase 1 (jours 1-3)
- [ ] Landing page SaaS (conversion + pricing)
- [ ] Auth Clerk (signup/login)
- [ ] Dashboard layout (dark theme)
- [ ] Intégration CoinGecko API

### Phase 2 (jours 4-6)
- [ ] Watchlist CRUD (ajouter/retirer cryptos)
- [ ] Affichage prices live + change 24h
- [ ] Alertes prix (create/update/delete)
- [ ] Discord webhook test

### Phase 3 (jours 7-9)
- [ ] Email alerts (Resend gratuit)
- [ ] Lemon Squeezy integration
- [ ] Upgrade plan flow
- [ ] GitHub Actions auto-deploy

### Phase 4 (jour 10)
- [ ] 1ère vidéo TikTok demo
- [ ] README complet
- [ ] Security audit (prompt-guard, RLS)

---

## Endpoints API (Edge Functions)

```
POST   /api/watchlist/add
DELETE /api/watchlist/:id
GET    /api/prices?cryptos=bitcoin,ethereum
POST   /api/alerts/create
GET    /api/alerts
DELETE /api/alerts/:id
POST   /api/alerts/:id/trigger-test
GET    /api/user/plan
POST   /api/upgrade
```

---

## Déploiement

1. Push repo → GitHub
2. Vercel : `vercel link bobsd84000-pixel/stockpulse`
3. Env vars :
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `CLERK_SECRET_KEY`
   - `COINGECKO_API_KEY` (gratuit)
   - `DISCORD_WEBHOOK_URL`
   - `RESEND_API_KEY`
   - `LEMON_SQUEEZY_API_KEY`

4. Supabase : migrations appliquées via Vercel build

---

## Contenu TikTok Daily

**Format** : 15-30s, avatar Tara (HeyGen), hook `#FF6B35` text overlay.

**Scripts** (1/jour, Bloc 1 = Claude API) :
- "Top 3 alertes crypto cette semaine"
- "BTC a breakout 50k — comment l'trader"
- "Portfolio tracker : gérer vos holdings"
- Etc.

**Pipeline** :
1. Claude API script + hook + caption
2. HeyGen Tara narration + video
3. CapCut assembly + overlay
4. TikTok publish

---

## Checklist Lancement

- [ ] Repo init + README
- [ ] Supabase project créé (`stockpulse_prod`)
- [ ] Clerk app setup
- [ ] Vercel deploy (empty)
- [ ] Landing page online
- [ ] 3 cryptos hardcoded (BTC, ETH, SOL)
- [ ] Watchlist basic working
- [ ] 1 vidéo TikTok published
- [ ] Discord webhook test OK
- [ ] Lemon Squeezy pricing live

---

## Notes

- CoinGecko gratuit = 10-50 requests/min, suffisant MVP
- Pas de bot trading v1 (seulement alertes)
- Emails = Resend gratuit (100/jour)
- Discord webhook = gratuit, instant
- Lemon Squeezy = 5% frais (BulkDirect pattern)

---

## Prochain Appel

Specs validées ?
→ Je te build landing + dashboard skeleton Lovable
→ Tu crées Supabase + Clerk
→ On hook le tout Vercel
