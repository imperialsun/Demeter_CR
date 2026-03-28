# Securite et confidentialite

## Modele de securite general

Demeter Speech est une application front-end.

Points cle:

- auth de type gate client-side,
- aucun IAM serveur integre dans ce repo,
- securisation runtime via headers navigateur + hardening conteneur,
- surveillance via workflows de securite GitHub.

## Authentification

Implantation:

- `src/lib/auth.ts`,
- `src/routes/LoginPage.tsx`,
- hashes login injectes dans `vite.config.ts` (`__LOGIN_HASHES__`).

Proprietes:

- verification locale bcrypt (`compareSync`),
- etat auth stocke dans `localStorage` (`demeter-authenticated`).

Limite importante:

- ce mecanisme ne remplace pas un controle d acces serveur.

## Gestion des tokens API

Tokens concernes:

- Hugging Face,
- Mistral.

Strategie:

- pas de persistance en clair dans `demeter-asr-settings`,
- chiffrement AES-GCM via WebCrypto,
- stockage ciphertext + IV dans IndexedDB `demeter-secure-vault`.

Composants:

- `src/lib/secure-token-vault.ts`,
- `src/store/asr-store.ts` (sync settings <-> vault).

## Isolation navigateur et WASM

Headers requis pour WASM multithread:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Appliques via:

- Vite dev/preview (`vite.config.ts`),
- Nginx runtime (`docker/nginx/transcode.conf`),
- labels Traefik (defense en profondeur).

## Hardening conteneur

Dans `compose.yml` (service `front`):

- `read_only: true`,
- `tmpfs` pour zones ecriture,
- `cap_drop: [ALL]`.

## Securite CI/CD

Workflows principaux:

- `ci.yml`: lint, tests, couverture.
- `codeql.yml`: analyse statique securite.
- `trivy.yml`: scan FS + image (HIGH/CRITICAL).
- `prod-smoke.yml`: verification dispo + headers securite.

## Confidentialite des flux

### Local transcription / LLM local

- traitement audio/texte local navigateur,
- donnees non envoyees a un provider cloud (hors telechargement modeles si cache vide).

### Cloud transcription / LLM cloud

- donnees envoyees au provider selectionne,
- tokens transmis uniquement au provider cible.

## Recommandations operatoires

- definir `LOGIN_PASSWORDS` fort en production,
- restreindre acces reseau au service si necessaire,
- monitorer resultats Trivy/CodeQL regulierement,
- revoir politique retention exports locaux utilisateur.

## References

- root policy: [`SECURITY.md`](../../SECURITY.md)
- CI securite: [`ci-quality-observability.md`](ci-quality-observability.md)
- deploiement: [`deployment-operations.md`](deployment-operations.md)
