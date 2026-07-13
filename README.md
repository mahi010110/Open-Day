# Open-Day

Prototype **local-first** de délibération multi-agents : mesurer si un **débat séquentiel visible**
entre plusieurs modèles produit de meilleurs cahiers des charges et architectures qu'un agent unique
ou qu'un fan-out parallèle suivi d'une synthèse.

> Statut : amorçage (tickets 1–2). Aucun agent n'a d'accès fichier, terminal, Git ou réseau : le
> prototype est en **lecture seule par construction**.

## Documentation

- [État de l'art & protocole corrigé](docs/etat-art-scientifique.md) — ce que dit la recherche sur
  la (non‑)supériorité du débat, hypothèse affinée, conditions **A/B/C/D + C+**, contraste D vs C(+).
- [ADR-0001 — Périmètre & invariants](docs/adr/0001-perimetre-invariants.md) — hypothèse testée,
  périmètre inclus/exclu, invariants non négociables, conditions expérimentales.
- [Conception technique du prototype](docs/conception-prototype-debat.md) — **design directeur**
  (architecture, modèle de données, FSM, protocole de délibération, plan d'évaluation, backlog).
- [Étude de faisabilité (cadrage produit)](docs/faisabilite-ide-multi-agents.md) — analyse long
  terme et comparaison avec Hermes Agent, avec ses corrections (section Errata).

## Structure du dépôt

```text
packages/
  domain/      # entités, invariants et machine à états pure (aucune dépendance SDK/VS Code)
  protocol/    # méthodes RPC, notifications et version du protocole (DTO Zod : ticket 3)
services/      # control-plane local (à venir)
apps/          # extension VS Code (à venir)
docs/          # ADR, conception, faisabilité
```

## Développement

Prérequis : Node.js ≥ 22 et pnpm 10.

```bash
pnpm install
pnpm lint        # ESLint (flat config, typescript-eslint)
pnpm typecheck   # tsc --noEmit par package
pnpm test        # Vitest
pnpm ci          # les trois d'affilée
```

## Licence

MIT — voir [LICENSE](LICENSE).
