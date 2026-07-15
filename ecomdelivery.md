### Identifiants API

Accès activé

Créée le : —Modifiée le : —

**Attention :** utilisez ces identifiants uniquement sur vos propres applications (web, mobile…). Ne les partagez jamais avec des sites tiers : en cas d'utilisation détectée sur un site malveillant, votre accès API sera désactivé.

### Quota

Vos limites et le quota consommé (par minute, heure et jour). Les compteurs se réinitialisent à chaque intervalle.

| Quota | Plafond | Utilisées | Restantes |
| --- | --- | --- | --- |
| Requêtes par minute | 50 | 0 | 50 |
| Requêtes par heure | 2 000 | 0 | 2 000 |
| Requêtes par jour | 20 000 | 0 | 20 000 |

Au-delà de ces limites, les requêtes échouent avec une erreur `429 Too Many Requests`. Patientez l'intervalle suivant pour réessayer.

### Introduction

**E-com Delivery API v2** permet de gérer vos colis et d'accéder aux référentiels (wilayas, communes, stopdesks, situations, tarifs) depuis vos propres applications.

Base URL : `https://ecom-dz.com/api_v2`. Toutes les requêtes et réponses sont au format JSON (UTF-8) ; les dates sont en ISO 8601.

`GET /test` — vérifier que vos identifiants sont valides.

### Authentification, Limites & Test

🔑 Authentification

Chaque requête doit inclure vos deux identifiants dans les en-têtes HTTP :

```
X-API-Key:   <KEY>     # le champ « KEY »   (clé fixe)
X-API-Token: <TOKEN>   # le champ « Token » (régénérable)
```

**KEY** → en-tête `X-API-Key` ; **Token** → en-tête `X-API-Token`. Les deux valeurs sont dans la section « Identifiants API » en haut de cette page.

Exemple (vérification des identifiants) :

```
curl -H "X-API-Key: <KEY>" \
     -H "X-API-Token: <TOKEN>" \
     https://ecom-dz.com/api_v2/test
```

Identifiants invalides ou accès désactivé → réponse `401`.

⏱️ Limites de débit

Limites par défaut :

-   50 requêtes / minute
-   2000 requêtes / heure
-   20000 requêtes / jour

**Sur chaque réponse** (tous les endpoints), des en-têtes HTTP indiquent votre consommation et la version de l'API :

-   `X-Quota-1min`, `X-Quota-1h`, `X-Quota-24h` — quota déjà **consommé** (minute / heure / jour). À ne pas confondre avec la colonne _« Restantes »_ du tableau Quota (qui affiche, elle, le **restant**).
-   `X-Api-Version` — version de l'API

En cas de dépassement → `429 Too Many Requests` ; patientez l'intervalle suivant pour réessayer.

✅ Test API

Vérifie vos identifiants et renvoie l'identité de votre compte fournisseur.

```
GET https://ecom-dz.com/api_v2/test
```

Réponse — 200

```
{ "id_fournisseur": 8, "nom_fournisseur": "FOURNISSEUR" }
```

### Wilayas, Communes & Stopdesks

🗺️ Wilayas

Liste des wilayas, avec les modes de livraison disponibles pour chacune.

```
GET https://ecom-dz.com/api_v2/wilayas
```

Réponse — 200

```
[
  { "id": 1,  "libelle": "Adrar", "domicile": true, "stopdesk": true },
  { "id": 5,  "libelle": "Batna", "domicile": true, "stopdesk": true },
  { "id": 16, "libelle": "Alger", "domicile": true, "stopdesk": true }
]
```

`domicile` / `stopdesk` : modes de livraison desservis pour la wilaya.

📍 Communes

Communes d'une wilaya (paramètre `id_wilaya`) ; **sans** le paramètre → toutes les communes.

```
GET https://ecom-dz.com/api_v2/communes?id_wilaya=16
```

Réponse — 200

```
[
  { "id": 523, "id_wilaya": 16, "commune": "Alger Centre", "code_postal": 16001, "livrable": true },
  { "id": 566, "id_wilaya": 16, "commune": "Ain Benian",  "code_postal": 16044, "livrable": true }
]
```

`livrable: false` = commune non desservie (création de colis refusée). À domicile, le champ `commune` du colis doit correspondre à un libellé de cette liste.

🏢 Stopdesks

Bureaux stopdesk d'une wilaya. À la création d'un colis en stopdesk (`stopdesk=1`), renseignez le `code_stopdesk` du bureau choisi dans cette liste.

```
GET https://ecom-dz.com/api_v2/stopdesks?id_wilaya=16
```

Réponse — 200

```
[
  {
    "id": 125,
    "id_wilaya": 16,
    "nom_bureau": "Bab Ezzouar",
    "code_stopdesk": "16B",
    "adresse": "Devant clinique médicale, En face Ecole Hilal School",
    "adresse_maps": "https://maps.app.goo.gl/qG22tYtJ4WuWX6W6A",
    "tel_contact": "0560301762, 0770608746",
    "commune": "Bab Ezzouar"
  }
]
```

### Situations & États logistiques

🏷️ Situations

Libellés des situations — pour interpréter le champ `situation` des colis et configurer les `events` des webhooks.

```
GET https://ecom-dz.com/api_v2/situations
```

Réponse — 200

```
[
  { "id": 1,  "libelle": "EnCours" },
  { "id": 7,  "libelle": "Livrée" },
  { "id": 14, "libelle": "Encaisser" },
  { "id": 15, "libelle": "Recouvert" }
]
```

🕒 États logistiques

Libellés des **états logistiques** — l'état **physique** d'un colis dans la chaîne (préparation, bureau, livraison, livré…). Même format que les situations.

```
GET https://ecom-dz.com/api_v2/etats-logistiques
```

Réponse — 200

```
[
  { "id": 1, "libelle": "En Préparation" },
  { "id": 3, "libelle": "Au Bureau" },
  { "id": 5, "libelle": "En livraison" },
  { "id": 8, "libelle": "Récupérer" }
]
```

**Nouveau :** la situation et l'état logistique sont désormais renvoyés **en libellé ET en id** partout — `situation` + `id_situation`, `etat_logistique` + `id_etat_logistique` — sur `GET /colis`, `GET /colis/{tracking}`, `GET /colis/maj`, `POST /colis/statuts` et l'**événement webhook**. Le champ `situation` historique reste inchangé (non-breaking).

### Tarifs

Vos tarifs : frais globaux du compte + tarif de livraison par wilaya.

```
GET https://ecom-dz.com/api_v2/tarifs
```

Réponse — 200

```
{
  "id_fournisseur": 8,
  "service": 35,
  "emballage": 65,
  "wilayas": [
    { "wilaya": 1,  "domicile": 1100, "stopdesk": 750, "annuler": 0 },
    { "wilaya": 16, "domicile": 450,  "stopdesk": 200, "annuler": 0 }
  ]
}
```

`tarif_si_livrer` (réponse création/MAJ) reprend `domicile` ou `stopdesk` selon le mode ; `tarif_si_annuler` = `annuler`. `service` (35) et `emballage` (65) sont des frais globaux, **facturés en plus**.

### Création de colis

Endpoint

```
POST https://ecom-dz.com/api_v2/colis
```

Authentification (en-têtes obligatoires)

| En-tête | Valeur |
| --- | --- |
| X-API-Key | votre **KEY** (le champ « KEY » — clé fixe) |
| X-API-Token | votre **Token** (le champ « Token » — régénérable) |
| Content-Type | application/json |

Corps de la requête

Un tableau JSON de **1 à 100 colis** (création par lot). Chaque colis est un objet :

| Champ | Type | Obligatoire | Contraintes | Description |
| --- | --- | --- | --- | --- |
| nom\_complet | string | ✅ toujours | 1–20 car. | Nom du destinataire |
| mobile\_1 | string | ✅ toujours | 1–25 car. | 1ᵉ téléphone |
| id\_wilaya | int | ✅ toujours | 1–58 | Wilaya de livraison |
| commune | string | ✅ si domicile | ≤ 50 car. | Nom de la commune (validé par nom + wilaya) |
| code\_stopdesk | string | ✅ si stopdesk | ≤ 10 car. | Code du stopdesk (validé par wilaya) |
| article | string | ✅ si compte SANS stock | ≤ 255 car. | Désignation article (ignoré si compte stock) |
| ref\_article | string | ✅ si compte AVEC stock | ≤ 10 car. | Réf produit (validée ; l’article est repris du produit) |
| mobile\_2 | string | ❌ | ≤ 25 car. | 2ᵉ téléphone (défaut "") |
| adresse | string | ❌ | ≤ 30 car. | Adresse (défaut "") |
| quantite | int | ❌ | ≥ 1 | Défaut 1 |
| total | number | ❌ | ≥ 0 | Montant à ramasser en dinar algérien (DA) — défaut 0 |
| stopdesk | int | ❌ | 0 ou 1 | 0 = domicile (défaut), 1 = stopdesk |
| echange | int | ❌ | 0 ou 1 | Colis échange (défaut 0) — aucune règle (total libre) |
| note\_fournisseur | string | ❌ | ≤ 255 car. | Note (défaut "") |
| id\_externe | string | ❌ | ≤ 20 car. | Votre référence interne (défaut "") |

⚠️ Les champs inconnus sont refusés (`422`). Le champ `source` est forcé à `api_v2` côté serveur. Le `tracking` est généré par le serveur — ne l'envoyez pas.

Règles de validation (casse + accents ignorés)

-   **Téléphones** (`mobile_1` / `mobile_2`) : envoyez un numéro au format normalisé `0770123456`. Le système sait corriger les numéros avec **espaces**, **sans le 0** initial ou préfixés `+213` — mais envoyez de préférence le bon format pour éviter toute erreur.
-   C'est `stopdesk` qui décide du champ utilisé. `stopdesk=0` (défaut si absent) → on lit `commune` (un `code_stopdesk` envoyé est ignoré). `stopdesk=1` → on lit `code_stopdesk` (la `commune` envoyée est ignorée, déduite du bureau).
-   **Domicile** (stopdesk=0) : la commune doit exister dans la wilaya, sinon `commune introuvable…` ; absente → `commune requise`. Elle est ré-enregistrée avec son orthographe officielle.
-   **Stopdesk** (stopdesk=1) : le code\_stopdesk doit être un code stopdesk valide de la wilaya, sinon erreur. La commune enregistrée = celle liée au stopdesk.
-   **Compte stock** : ref\_article doit correspondre à un de vos produits, sinon erreur ; l'article est repris automatiquement du produit.
-   **Compte sans stock** : article obligatoire.
-   Commune **non livrable** (`livrable: false`) → création refusée.

Pour remplir les listes : `GET /wilayas`, `GET /communes?id_wilaya=`, `GET /stopdesks?id_wilaya=`.

Réponse — 201 Created

```
{
  "total": 2,
  "crees": 1,
  "echecs": 1,
  "resultats": [
    { "index": 0, "ok": true,  "tracking": "ECBGB031", "id_colis": 827841,
      "tarif_si_livrer": 450, "tarif_si_annuler": 0, "erreur": null },
    { "index": 1, "ok": false, "tracking": null, "id_colis": null,
      "tarif_si_livrer": null, "tarif_si_annuler": null,
      "erreur": "commune introuvable dans la wilaya 16 (commune=zzz)" }
  ]
}
```

Best-effort : chaque ligne réussit ou échoue indépendamment. `index` = position dans le tableau envoyé.

⚠️ Comportement voulu : la **création renvoie HTTP 201** et la **modification HTTP 200 même si une ligne échoue** (`ok: false`). Ne vous fiez **pas** au seul code HTTP — vérifiez toujours `resultats[i].ok` / `ok` et `erreur`. Les codes `4xx` ne surviennent que pour une erreur **globale** (auth, quota, validation, > 100 colis).

En-têtes de réponse (sur toutes les réponses) : `X-Api-Version`, `X-Quota-1min`, `X-Quota-1h`, `X-Quota-24h`.

Erreurs par ligne (resultats\[i\].erreur, ok=false)

| Message | Cause |
| --- | --- |
| article requis | compte sans stock, article vide |
| ref\_article requis (fournisseur stock) | compte stock, ref\_article vide |
| réf article inconnue (ref=X) | ref\_article ne correspond à aucun produit |
| commune requise | domicile sans commune |
| commune introuvable dans la wilaya N (commune=X) | commune absente de la wilaya |
| code\_stopdesk requis (stopdesk) | stopdesk sans code\_stopdesk |
| stopdesk introuvable (code=X, wilaya=N) | code stopdesk invalide pour la wilaya |

Erreurs globales (toute la requête échoue)

| HTTP | error.code | Cause |
| --- | --- | --- |
| 401 | identifiants\_api\_manquants | en-têtes X-API-Key/X-API-Token absents |
| 401 | api\_non\_autorise | clé ou secret invalide |
| 429 | quota\_depasse | quota dépassé (50/min, 2000/h, 20000/24h) |
| 422 | (validation) | champ obligatoire manquant, contrainte non respectée, ou champ inconnu |
| 422 | trop\_de\_colis | plus de 100 colis dans la requête |
| 400 | fournisseur\_non\_tarife | aucune tarification configurée pour le compte |

**Toutes les erreurs** (auth, quota, validation, métier) utilisent le **même format** : `{ "error": { "code", "message", "details"? } }`.

```
{ "error": { "code": "api_non_autorise", "message": "Clé ou token API invalide, ou accès désactivé" } }
```

Pour une erreur de **validation** (champ requis manquant, mauvais type, champ inconnu), `details` liste les champs fautifs (`champ` = chemin, `raison` = cause) :

```
{
  "error": {
    "code": "validation",
    "message": "Données invalides",
    "details": [
      { "champ": "0.nom_complet", "raison": "Field required" },
      { "champ": "0.id_wilaya",   "raison": "Input should be less than or equal to 58" }
    ]
  }
}
```

Exemple de requête

```
[
  {
    "nom_complet": "Amine B.",
    "mobile_1": "0770 12 34 56",
    "id_wilaya": 16,
    "commune": "Alger Centre",
    "article": "Casque audio",
    "quantite": 1,
    "total": 4500,
    "id_externe": "CMD-1001"
  },
  {
    "nom_complet": "Sara K.",
    "mobile_1": "0560 99 88 77",
    "id_wilaya": 16,
    "stopdesk": 1,
    "code_stopdesk": "16B",
    "article": "Montre",
    "total": 7000,
    "id_externe": "CMD-1002"
  }
]
```

### Détail d’un colis

Endpoint

```
GET https://ecom-dz.com/api_v2/colis/{tracking}
```

Détail d'un colis : les **mêmes champs que la liste** + son `historique`. Scellé à votre compte ; renvoyé même si le colis a été supprimé.

Réponse — 200

```
{
  "tracking": "ECBGH960",
  "date_creation": "2026-06-12 20:49:16+00:00",
  "situation": "EnCours",
  "id_situation": 1,
  "etat_logistique": "Au Bureau",
  "id_etat_logistique": 3,
  "nom_complet": "Test Detail",
  "mobile": "0770000000",
  "commune": "Alger Centre",
  "id_wilaya": 16,
  "article": "Article test",
  "quantite": 1,
  "total": 1500,
  "note_fournisseur": null,
  "stopdesk": 0,
  "id_externe": null,
  "encaisser": false,
  "recouvert": false,
  "historique": [
    { "date": "2026-06-12 20:49:16+00:00", "ville": 16, "situation": "En Préparation", "commentaire": "Création Api_v2" }
  ]
}
```

Erreur : `404` `colis_introuvable` (tracking inconnu ou n'appartenant pas à votre compte). Chaque étape d'`historique` : `date`, `ville` (wilaya), `situation` (libellé), `commentaire`.

### Impression

Renvoie le **bordereau prêt à imprimer** d'un colis (étiquette aux dimensions exactes, logo, code-barres Code128, infos expéditeur / client / produit / total). Authentification habituelle par `X-API-Key` + `X-API-Token`, comme les autres endpoints.

Endpoint

```
GET https://ecom-dz.com/api_v2/colis/{tracking}/bordereau?format=10x10
```

Paramètre `format` : `10x10` (100 × 100 mm) ou `10x13` (100 × 130 mm). Réponse `200` : le bordereau (page HTML aux dimensions exactes, prête à imprimer ou à convertir en PDF). Un appel par colis.

```
GET https://ecom-dz.com/api_v2/colis/EC095EGB/bordereau?format=10x13
X-API-Key: <votre cle>
X-API-Token: <votre token>
```

Erreur : `404` `colis_introuvable` (tracking inconnu ou n'appartenant pas à votre compte).

Impression par lot

```
POST https://ecom-dz.com/api_v2/colis/bordereaux
```

Plusieurs colis en un seul document (**1 page par colis**). Corps JSON :

```
POST https://ecom-dz.com/api_v2/colis/bordereaux
X-API-Key: <votre cle>
X-API-Token: <votre token>
Content-Type: application/json

{
  "trackings": ["EC095EGB", "EC044MEB"],
  "format": "10x13"
}
```

`trackings` : liste de **1 à 100** colis (obligatoire). `format` optionnel : `10x10` ou `10x13` (défaut `10x13`). Réponse `200` : le document des bordereaux prêt à imprimer · `422` si la requête est invalide.

### Modifier un colis

Endpoint

```
PUT https://ecom-dz.com/api_v2/colis/{tracking}
```

Modifie un colis **uniquement s'il est encore en préparation**. Le corps est un **objet unique** (pas un tableau). Mêmes champs et mêmes règles de validation que la création, **sauf `id_externe`** qui n'est **pas modifiable** via le PUT (il reste celui défini à la création). Authentification et en-têtes de réponse identiques.

Corps — champs

| Champ | Type | Obligatoire | Description |
| --- | --- | --- | --- |
| nom\_complet | string | ✅ toujours | Nom du destinataire |
| mobile\_1 | string | ✅ toujours | Téléphone principal |
| id\_wilaya | int | ✅ toujours | Wilaya de livraison |
| commune | string | ✅ si domicile | Commune (validée par nom + wilaya) |
| code\_stopdesk | string | ✅ si stopdesk | Code stopdesk (validé par wilaya) |
| article | string | ✅ si compte SANS stock | Désignation (ignoré si compte stock) |
| ref\_article | string | ✅ si compte AVEC stock | Réf produit |
| mobile\_2 | string | ❌ | 2ᵉ téléphone (défaut "") |
| adresse | string | ❌ | Adresse (défaut "") |
| quantite | int | ❌ | Défaut 1 |
| total | number | ❌ | Montant à ramasser en dinar algérien (DA) — défaut 0 |
| stopdesk | int | ❌ | 0 = domicile, 1 = stopdesk |
| echange | int | ❌ | Colis échange (défaut 0) |
| note\_fournisseur | string | ❌ | Note (défaut "") |

Exemple de requête

```
curl -X PUT https://ecom-dz.com/api_v2/colis/ECBGE309 \
  -H "X-API-Key: <KEY>" \
  -H "X-API-Token: <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "nom_complet": "Amine B.",
    "mobile_1": "0770123456",
    "id_wilaya": 16,
    "stopdesk": 1,
    "code_stopdesk": "16B",
    "article": "Casque audio",
    "quantite": 2,
    "total": 2500
  }'
```

Réponse — 200

```
{
  "tracking": "ECBGE309",
  "ok": true,
  "tarif_si_livrer": 200,
  "tarif_si_annuler": 0,
  "commune": "Bab Azzoua",
  "article": "Casque audio",
  "erreur": null
}
```

`ok: true` → modifié ; tarifs recalculés ; commune/article normalisés (ex. en stopdesk, la commune devient celle du bureau).

Erreur métier — 200 avec ok:false

```
{
  "tracking": "ECBGE309",
  "ok": false,
  "tarif_si_livrer": null,
  "tarif_si_annuler": null,
  "commune": null,
  "article": null,
  "erreur": "commune introuvable dans la wilaya 16 (commune=zzz_invalide)"
}
```

Erreurs

-   `404` `colis_introuvable` — tracking inconnu (ou n'appartenant pas au fournisseur).
-   `422` validation — `nom_complet`/`mobile_1`/`id_wilaya` requis, champ inconnu, ou contrainte non respectée (format `{ error: { code: "validation", details } }`).
-   Erreur métier dans `erreur` (HTTP 200, `ok:false`) : commune introuvable, stopdesk introuvable, article requis, ou colis non modifiable car plus en préparation.

### Supprimer un colis

Endpoint

```
DELETE https://ecom-dz.com/api_v2/colis/{tracking}
```

Suppression **soft** : le colis passe en « Supprimée », **uniquement s'il est encore en préparation**.

Réponse — 200

```
{ "tracking": "ECBGH960", "ok": true }
```

Codes

-   `200` — colis supprimé.
-   `404` `colis_introuvable` — tracking inconnu ou n'appartenant pas à votre compte.
-   `409` — colis **non supprimable** (déjà sorti de préparation).

### Liste des colis

Endpoint

```
GET https://ecom-dz.com/api_v2/colis
```

Liste paginée de vos colis (triés par date décroissante). `total` et `total_pages` ne sont renvoyés **qu'en page 1** (`null` ensuite).

💡 Astuce — récupérez seulement les nouveautés

Plutôt que de parcourir **toute** votre liste à chaque fois, filtrez par **date d'action** (`type_date=action`) sur la journée en cours : vous obtenez uniquement les colis qui ont **bougé aujourd'hui** (nouveaux + mis à jour). Idéal pour une **synchronisation incrémentale**.

```
GET https://ecom-dz.com/api_v2/colis?type_date=action&date_debut=2026-06-12&date_fin=2026-06-12
```

Paramètres (query)

| Paramètre | Type | Défaut | Description |
| --- | --- | --- | --- |
| page | int | 1 | Numéro de page (1 = première) |
| limit | int | 50 | Taille de page (max 100) |
| id\_wilaya | int | — | Filtre par wilaya |
| date\_debut | date | — | Filtre date début (YYYY-MM-DD) |
| date\_fin | date | — | Filtre date fin (YYYY-MM-DD) |
| type\_date | enum | creation | Date filtrée : creation, livree, receptionne, action |
| tracking | string | — | Un ou plusieurs trackings, séparés par des virgules |

Exemple de requête

```
GET https://ecom-dz.com/api_v2/colis?page=1&limit=50&id_wilaya=16&type_date=creation
GET https://ecom-dz.com/api_v2/colis?tracking=EC285AGB,ECBGE309
```

Réponse — 200

```
{
  "total": 582,
  "page": 1,
  "limit": 50,
  "total_pages": 12,
  "items": [
    {
      "tracking": "EC285AGB",
      "date_creation": "2026-06-11 03:37:10+00:00",
      "situation": "EnCours",
      "id_situation": 1,
      "etat_logistique": "Au Bureau",
      "id_etat_logistique": 3,
      "nom_complet": "Sara K.",
      "mobile": "0556343456",
      "commune": "Sidi Mhamed Ben Aouda",
      "id_wilaya": 48,
      "article": "Casque audio",
      "quantite": 1,
      "total": 9600,
      "note_fournisseur": null,
      "stopdesk": 0,
      "id_externe": "2026061121",
      "encaisser": false,
      "recouvert": false
    }
  ]
}
```

Champs d'un item : `tracking`, `date_creation`, `situation` (libellé) + `id_situation` (id), `etat_logistique` (libellé) + `id_etat_logistique` (id), `nom_complet`, `mobile`, `commune`, `id_wilaya`, `article`, `quantite`, `total`, `note_fournisseur`, `stopdesk`, `id_externe`. Deux booléens distincts pour le paiement : `recouvert` (`true` = montant **reversé au fournisseur**) et `encaisser` (`true` = colis **encaissé**).

📄 Pagination — au-delà de total\_pages

Vaut pour `GET /colis` et `GET /colis/maj`.

-   `total` et `total_pages` ne sont renvoyés qu'à la **page 1** (`null` sur les pages suivantes) → le client doit les **mémoriser** depuis la page 1.
-   Demander une page **au-delà de total\_pages** (ou une liste vide) → `HTTP 200` avec `items: []` (tableau vide). **Pas d'erreur, pas de 404.** `total`/`total_pages` restent `null` (puisque page > 1).
-   Aucune borne max sur `page` (`page ≥ 1`, `limit` entre 1 et 100). Une page très loin = `items: []` + requête plus lente (offset profond) → ne « sondez » pas des pages très élevées inutilement.
-   Cas limite : si **0 résultat**, la page 1 renvoie `total: 0`, `total_pages: 0`, `items: []`.

Itération recommandée (2 façons sûres)

-   **Par compteur** : lire `total_pages` en page 1, puis itérer `page = 2 … total_pages`.
-   **Par page vide** (le plus robuste) : continuer à incrémenter `page` tant que `items` n'est pas vide ; s'arrêter dès qu'une page renvoie `items: []`. Recommandé : marche même sans relire `total_pages`, et tolérant aux ajouts de colis entre deux pages.

En résumé : dépasser `total_pages` n'est **pas une erreur** — c'est juste une liste vide. Le signal de fin de pagination = `items: []`.

### Historique des colis

Endpoint

```
POST https://ecom-dz.com/api_v2/colis/historique
```

Historique **par lot** (1 à 40 trackings), scellé à votre compte. Le corps est `{ "trackings": [ … ] }`. Un tracking qui n'appartient pas au fournisseur → `trouve: false` (historique vide).

Exemple de requête

```
curl -X POST https://ecom-dz.com/api_v2/colis/historique \
  -H "X-API-Key: <KEY>" \
  -H "X-API-Token: <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "trackings": ["ECBGE309", "ECBGE375"] }'
```

Réponse — 200

```
{
  "resultats": [
    {
      "tracking": "ECBGE309",
      "id_externe": "CMD-1001",
      "trouve": true,
      "historique": [
        { "date": "2026-06-09 09:12:00+00:00", "ville": 16, "situation": "En Préparation", "commentaire": "Création Api_v2" },
        { "date": "2026-06-09 14:30:00+00:00", "ville": 16, "situation": "Au Bureau", "commentaire": null },
        { "date": "2026-06-10 08:05:00+00:00", "ville": 16, "situation": "Sortir en livraison", "commentaire": null },
        { "date": "2026-06-10 11:20:00+00:00", "ville": 16, "situation": "Ne Réponde pas #1", "commentaire": "Client injoignable" },
        { "date": "2026-06-10 16:45:00+00:00", "ville": 16, "situation": "Livrée", "commentaire": "Remis au client" }
      ]
    },
    {
      "tracking": "INEXISTANT999",
      "id_externe": null,
      "trouve": false,
      "historique": []
    }
  ]
}
```

Chaque étape : `date`, `ville` (wilaya de l'action), `situation` (libellé), `commentaire`.

Erreurs

-   `422` — `trackings` vide ou > 40 (validation).
-   `401` — KEY/Token invalide ou accès désactivé.

### Statuts par lot

Endpoint

```
POST https://ecom-dz.com/api_v2/colis/statuts
```

Statut **par lot**, scellé à votre compte : interrogez par `trackings` et/ou `id_externes` (≤ 100 chacun). Un **tracking** est unique → 1 résultat ; un **id\_externe** peut correspondre à plusieurs colis → liste `colis[]`.

Exemple de requête

```
curl -X POST https://ecom-dz.com/api_v2/colis/statuts \
  -H "X-API-Key: <KEY>" \
  -H "X-API-Token: <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "trackings": ["ECBGE309"], "id_externes": ["CMD-1001"] }'
```

Réponse — 200

```
{
  "trackings": [
    {
      "tracking": "ECBGE309",
      "id_externe": "CMD-1001",
      "trouve": true,
      "nom_complet": "Ali Ahmed",
      "commune": "Bab Ezzouar",
      "id_wilaya": 16,
      "situation": "Livrée",
      "id_situation": 7,
      "etat_logistique": "Livrée",
      "id_etat_logistique": 9,
      "date_action": "2026-06-10 16:45:00+00:00",
      "encaisser": true,
      "recouvert": false,
      "total": 8950,
      "tarif_si_livrer": 400,
      "tarif_si_annuler": 200
    }
  ],
  "id_externes": [
    {
      "id_externe": "CMD-1001",
      "trouve": true,
      "colis": [
        {
          "tracking": "ECBGE309",
          "id_externe": "CMD-1001",
          "situation": "Livrée",
          "id_situation": 7,
          "etat_logistique": "Livrée",
          "id_etat_logistique": 9,
          "date_action": "2026-06-10 16:45:00+00:00",
          "total": 8950
        }
      ]
    }
  ]
}
```

Par colis : `situation` (libellé) + `id_situation`, `etat_logistique` + `id_etat_logistique`, `date_action`, `total`, `encaisser`, `recouvert`, `tarif_si_livrer`, `tarif_si_annuler`. Identifiant non trouvé → `trouve: false`.

Erreurs

-   `422` — aucun identifiant fourni, ou > 100 par liste (validation).
-   `401` — KEY/Token invalide ou accès désactivé.

### Paiements

💳 Liste des paiements

```
GET https://ecom-dz.com/api_v2/paiements?page=1&limit=50
```

Liste paginée de vos paiements (les plus récents d'abord).

Réponse — 200

```
{
  "total": 23,
  "page": 1,
  "limit": 50,
  "total_pages": 1,
  "items": [
    {
      "id": 1042,
      "code": "FAXXXXXX",
      "date": "2026-06-12",
      "montant": 18650,
      "nb_colis": 42,
      "colis_livres": 39,
      "colis_annules": 3,
      "recuperer": true,
      "total_livrer": 21000,
      "total_annuler": 0,
      "total_poids": 0,
      "total_service": 1470,
      "total_emballage": 880,
      "remboursement": 0
    }
  ]
}
```

Pagination identique à la liste des colis (`page`, `limit` max 100 ; `total`/`total_pages` renvoyés en page 1). `montant` = net à récupérer (DA).

🧾 Détail d'un paiement

```
GET https://ecom-dz.com/api_v2/paiements/1042
```

Le récap du paiement + la liste des colis (`lignes`) qui le composent.

Réponse — 200

```
{
  "id": 1042,
  "code": "FAXXXXXX",
  "date": "2026-06-12",
  "montant": 18650,
  "nb_colis": 42,
  "colis_livres": 39,
  "colis_annules": 3,
  "recuperer": true,
  "total_livrer": 21000,
  "total_annuler": 0,
  "total_poids": 0,
  "total_service": 1470,
  "total_emballage": 880,
  "remboursement": 0,
  "lignes": [
    {
      "tracking": "ECBGE309",
      "id_externe": "CMD-1001",
      "article": "Casque audio",
      "situation": "Livrée",
      "id_wilaya": 16,
      "total": 9600,
      "tarif_livrer": 450,
      "tarif_annuler": 0,
      "tarif_poids": 0,
      "tarif_service": 35,
      "tarif_emballage": 65,
      "commentaire": null
    }
  ]
}
```

Champs d'une ligne : `tracking`, `id_externe`, `article`, `situation`, `id_wilaya`, `total`, les tarifs (`tarif_livrer`, `tarif_annuler`, `tarif_poids`, `tarif_service`, `tarif_emballage`) et `commentaire`.

### Liste des produitsStock

Endpoint

```
GET https://ecom-dz.com/api_v2/produits
```

Liste de vos produits (`ref_article` + désignation). Surtout utile pour les **comptes stock**, où `ref_article` est requis à la création et doit correspondre à un produit de cette liste.

Réponse — 200

```
[
  { "ref_article": "AP49509", "article": "Casque audio" },
  { "ref_article": "TS-100", "article": "Montre" }
]
```

Compte stock : un `ref_article` absent de cette liste → erreur `réf article inconnue (ref=…)` à la création.

### Demande de ramassage

Endpoint

```
POST https://ecom-dz.com/api_v2/ramassage
```

Crée une **demande de ramassage** (enlèvement de vos colis chez vous). Vous ne fournissez que le nombre de colis, le type de véhicule, la commune et l'heure souhaitée (+ `google_map`, `mobile`, `note` facultatifs) ; le reste (nom, bureau, wilaya) est déduit du token. La demande est créée en **situation 1** (nouvelle).

Corps de la requête

| Champ | Type | Obligatoire | Description |
| --- | --- | --- | --- |
| nb\_colis | int | ✅ toujours | Nombre de colis à ramasser |
| type\_vehicule | int | ✅ toujours | Type de véhicule (1=Moto, 2=Voiture, 3=Pickup, 4=Fourgon) |
| commune | string | ✅ toujours | Commune de ramassage |
| heure | string | ✅ toujours | Heure souhaitée (texte libre, ex. « 14h30 ») |
| google\_map | string | ❌ | Lien / point Google Maps |
| mobile | string | ❌ | Contact (défaut : mobile du fournisseur) |
| note | string | ❌ | Note libre |

Types de véhicule (`type_vehicule`)

1Moto2Voiture3Pickup4Fourgon

Exemple de requête

```
POST https://ecom-dz.com/api_v2/ramassage
Content-Type: application/json

{
  "nb_colis": 12,
  "type_vehicule": 2,
  "commune": "Alger Centre",
  "heure": "14h30",
  "google_map": "https://maps.app.goo.gl/xxxx",
  "mobile": "0550000000",
  "note": "Sonner au portail"
}
```

Réponse — 201 Created

```
{
  "id": 1042,
  "nb_colis": 12,
  "type_vehicule": 2,
  "commune": "Alger Centre",
  "heure": "14h30",
  "google_map": "https://maps.app.goo.gl/xxxx",
  "mobile": "0550000000",
  "note": "Sonner au portail",
  "id_situation": 1
}
```

Champs inconnus refusés (`422`). `id_situation: 1` = demande nouvelle.

### WebhooksWebhook

Recevez un `POST` sur **votre** URL à chaque changement de situation d'un colis. Vous gérez votre abonnement via 4 endpoints :

PUT`/webhook`— Créer / mettre à jour l'abonnement

| Champ | Type | Oblig. | Description |
| --- | --- | --- | --- |
| url | string | ✅ | URL HTTPS de réception |
| secret | string | ❌ | Clé pour la signature HMAC |
| events | array | ❌ | Libellés de situations, ou \["\*"\] = tout |
| active | bool | ❌ | Activer / désactiver |

```
PUT https://ecom-dz.com/api_v2/webhook

{
  "url": "https://mon-site.com/webhook",
  "secret": "ma_cle_secrete",
  "events": ["*"],
  "active": true
}
```

Réponse : `{ actif, url, events }` — le secret n'est jamais renvoyé.

GET`/webhook`— Voir mon abonnement (sans le secret)

```
{ "actif": true, "url": "https://mon-site.com/webhook", "events": ["*"] }
```

DELETE`/webhook`— Supprimer l'abonnement

Renvoie l'abonnement vidé : `{ actif: false, url: null, events: [] }`.

POST`/webhook/test`— Envoyer un événement de test à votre URL

```
POST https://ecom-dz.com/api_v2/webhook/test

{ "event": "Livrée" }
```

→ `{ ok, detail, event }`. Sans URL configurée → `422 webhook_non_configure`.

GET`/webhook/events`— Libellés d'événements souscriptibles (pour events)

```
[ "EnCours", "En Préparation", "Sortir en livraison", "Livrée", "Encaisser", "Recouvert", … ]
```

Union des libellés Situation et Win. Mettez ces valeurs dans `events` (ou `["*"]`).

GET`/webhook/logs`— Mes dernières livraisons webhook

Paramètre `limit` (1 à 200, défaut 50). Plus récentes d'abord.

```
[
  {
    "id": "evt_abc123",
    "tracking": "ECBGE309",
    "situation": "Livrée",
    "date_event": "2026-06-12 10:00:00",
    "statut": "livré",
    "tentative": 1,
    "detail": "HTTP 200",
    "erreur": null,
    "envoye_le": "2026-06-12 10:00:01"
  }
]
```

`statut` : `livré` / `en_retry` / `abandonné`.  
`tentative` : numéro de la tentative de livraison (`1` = 1ʳᵉ tentative, incrémenté à chaque réessai).

📥 Événement reçu (POST sur VOTRE URL)

```
POST https://mon-site.com/webhook
x-webhook-signature: sha256=<hmac>
x-webhook-timestamp: 1781204074
x-webhook-id: evt_abc123
Content-Type: application/json

{
  "id": "evt_abc123",
  "date": "2026-06-11 19:54:34",
  "tracking": "ECBGE309",
  "ville": 16,
  "situation": "Livrée",
  "id_situation": 7,
  "etat_logistique": "Livrée",
  "id_etat_logistique": 9,
  "commentaire": "Remis au client"
}
```

🔐 Vérifier la signature

`x-webhook-signature` = `sha256=` + HMAC-SHA256(**corps brut**, votre `secret`). Recalculez de votre côté et comparez avant de traiter — rejetez si ça ne correspond pas.

🔁 Politique de retries

-   **Succès** = réponse `HTTP 2xx` en **moins de 10 s**. Sinon → mise en file de retry.
-   **Backoff** : 1 min → 5 min → 30 min → 2 h → 6 h, soit **5 tentatives** (~8-9 h), puis **abandonné** (dead-letter).
-   Retries traités à chaque cycle worker (toutes les `3 min`) quand le délai est écoulé.
-   **Idempotence** via `id` / `X-Webhook-Id` : un même événement peut arriver plusieurs fois → **dédupliquez**.
-   Redirections **non suivies**, URL internes/privées refusées (anti-SSRF) → **URL publique obligatoire**.
-   Désactiver / supprimer l'abonnement **abandonne** ses retries en attente.
-   Suivi : `GET /webhook/logs` (statut, tentative, erreur).

⏱️ Timestamp & signature

-   En-têtes : `X-Webhook-Signature: sha256=<hmac>`, `X-Webhook-Id`, `X-Webhook-Timestamp` (epoch en secondes).
-   **Signature** = `HMAC-SHA256(secret, corps_brut)` en hexadécimal → vérifiez en **temps constant** sur le corps brut.
-   **Tolérance timestamp** : ⚠️ l'API n'en impose **aucune** côté serveur — c'est au récepteur de rejeter les requêtes trop vieilles. Recommandation : **±5 minutes**. (La signature ne couvre que le corps, pas le timestamp.)

### Résumé

Endpoint

```
GET https://ecom-dz.com/api_v2/colis/resume
```

Vue d'ensemble de vos colis : total, taux de livraison, et répartition par situation.

Paramètres (query)

| Paramètre | Type | Description |
| --- | --- | --- |
| depuis | date | Début de période (YYYY-MM-DD, optionnel) |
| jusqua | date | Fin de période (YYYY-MM-DD, optionnel) |

Réponse — 200

```
{
  "total": 207,
  "taux_livraison": 33,
  "taux_domicile": 0,
  "taux_stopdesk": 100,
  "par_situation": [
    { "situation": "EnCours", "nombre": 185 },
    { "situation": "Livrée", "nombre": 1 },
    { "situation": "Commande Confirmée", "nombre": 11 }
  ],
  "par_etat_logistique": [
    { "etat_logistique": "En Préparation", "nombre": 168 },
    { "etat_logistique": "En Traitement", "nombre": 34 },
    { "etat_logistique": "Au Bureau", "nombre": 1 }
  ]
}
```

`taux_livraison`, `taux_domicile`, `taux_stopdesk` sont des pourcentages. `par_situation` = compteur par libellé de situation ; `par_etat_logistique` = compteur par état logistique.

### Tester avec Postman

Pour tester l'API directement dans **Postman**, télécharge la collection prête à l'emploi puis importe-la (**Postman → Import → fichier**). Tous les endpoints sont pré-configurés.

Comment l'utiliser

1.  Importer le fichier dans Postman (ou « Copier le JSON » → Import → Raw text).
2.  Ouvrir les **Variables** de la collection et renseigner `cle` et `token` (et `tracking` pour les endpoints par colis).
3.  Lancer n'importe quelle requête : l'authentification est déjà câblée.

La collection inclut `baseUrl` = `https://ecom-dz.com/api_v2`, les en-têtes `X-API-Key`/`X-API-Token` sur chaque requête, et des exemples de corps. Tes clés ne sont **jamais** incluses dans le fichier — elles restent dans tes variables Postman locales.

### Changelog

Historique des versions de l'API publique.

💡 Récupérez ce changelog par programmation : `GET https://ecom-dz.com/api_v2/changelog` (paramètre `limit`, 1–200, défaut 50 ; plus récentes d'abord). Réponse : `{ version_actuelle, entries: [{ version, date, type, message }] }`.