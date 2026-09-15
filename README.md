# Traque — jeu de localisation en direct

Une application web pour jouer à la traque en ville : deux équipes, un maître du jeu
qui valide tout, et un grand écran spectateur qui voit tout.

- **Espions** — ils doivent remplir leurs défis et leur quota de photos **sans se faire
  trouver**. Ils voient les espionnés **en permanence** sur la carte, de quoi anticiper.
  Leur propre position, elle, n'est visible qu'après validation du maître du jeu.
- **Espionnés** — ils **traquent les espions**. Ils demandent l'accès à leur position,
  et le maître du jeu accorde ou refuse.
- **Maître du jeu** — valide les demandes de localisation et les défis qui débloquent
  les jokers, peut ouvrir ou couper un suivi, immobiliser une équipe, envoyer un
  message, gérer les codes, relancer le chrono et **mettre la partie en pause** avec
  un message affiché sur tous les écrans.
- **Spectateur** — écran de commentaire : les deux équipes en direct, le journal et les
  distances, sans aucune action possible.

Le maître du jeu et le spectateur n'apparaissent jamais sur la carte : seuls les
joueurs ont un marqueur.

## Démarrer en local

```bash
npm install
npm start
```

Le serveur affiche les codes d'accès au démarrage :

```
  TRAQUE — http://localhost:3000

  Traqueurs : Espionnés · durée 300 min

  Codes d'accès :
  10458  player  spy    Espion 1
  ...
```

Ouvrez l'adresse, tapez un code à 5 chiffres, et le téléphone est lié à ce rôle
jusqu'à la déconnexion.

### Le GPS des téléphones exige du HTTPS

Les navigateurs ne donnent la position qu'à une origine sécurisée. `localhost` marche
sur votre ordinateur, mais **pas** pour un téléphone sur le même Wi-Fi. Deux options :

```bash
cloudflared tunnel --url http://localhost:3000   # URL https publique instantanée
ngrok http 3000                                   # équivalent
```

Ou déployez l'app — voir la section suivante.

## Déployer sur Render

Le dépôt contient déjà un blueprint `render.yaml`. Deux façons de faire :

**A. Blueprint (le plus simple)** — Render → *New* → *Blueprint* → choisir ce dépôt.
Render lit `render.yaml` et crée le service.

**B. À la main** — Render → *New* → *Web Service* → choisir ce dépôt, puis :

| Réglage | Valeur |
|---|---|
| Language / Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/api/config` |
| Instance Type | `Starter` (voir l'avertissement plus bas) |

Ne définissez **pas** `PORT` : Render le fournit, l'app le lit automatiquement.

### Variables d'environnement à définir dans Render

Onglet *Environment* du service :

```
NODE_VERSION      22.22.2
APP_NAME          TRAQUE
ACCESS_CODES      11111:spy:Espion 1,22222:spy:Espion 2,33333:spied:Espionné 1,44444:spied:Espionné 2,55555:admin:Maître du jeu,66666:viewer:Écran
VAPID_PUBLIC_KEY  <voir ci-dessous>
VAPID_PRIVATE_KEY <voir ci-dessous>
MAPTILER_KEY      <optionnel>
```

`ACCESS_CODES` est essentiel sur Render : le disque est remis à zéro à chaque
redéploiement, donc sans cette variable l'app tire de **nouveaux codes aléatoires** à
chaque redémarrage. Format `code:rôle:nom`, séparés par des virgules — le rôle est
`spy`, `spied`, `admin` ou `viewer`. Gardez ces codes dans Render et pas dans le dépôt :
un dépôt public rendrait vos codes publics.

Pour les notifications push, générez une paire de clés une fois et collez-la dans Render :

```bash
npm run vapid
```

### Avertissement sur le plan gratuit

Une instance gratuite **s'endort après 15 minutes sans trafic** et met ~30 s à se
réveiller. Les positions sont gardées en mémoire : au réveil, la carte est vide tant que
les téléphones n'ont pas renvoyé un point (ce qui arrive tout seul en 8 secondes), et le
chrono ainsi que les jokers déjà joués sont conservés dans `data/state.json`… qui est lui
aussi effacé à chaque redéploiement. Pour 5 h de jeu, prenez le plan **Starter** (7 $/mois,
pas de mise en veille) ou ajoutez un disque persistant monté sur `/opt/render/project/src/data`.

## Les jokers

Chaque joker ne sert **qu'une seule fois**. L'équipe adverse reçoit une notification dès
qu'il est joué.

### Espions — 2 jokers partagés, à débloquer par un défi

| Joker | Défi pour le débloquer | Effet |
|---|---|---|
| Yeux fermés | Prendre une photo de tous les membres des espionnés sur la même photo | Les espionnés vont à l'endroit indiqué et ferment les yeux 30 secondes, sans poursuite possible |
| Défi annulé | Réaliser soi-même le défi que l'on veut réinitialiser | Un défi des espionnés repasse en « non fait » |

Le joueur appuie sur **Défi fait, débloquer**, le maître du jeu vérifie le défi et valide.
Le joker devient jouable ; au moment de le jouer, l'app demande la précision prévue par
la règle (l'endroit, ou le défi concerné) et l'envoie avec la notification.

### Espionnés — 2 jokers, utilisables directement

| Joker | Effet |
|---|---|
| Gel | Les deux espions doivent rester figés sur place pendant 2 minutes |
| Localisation 5 minutes | La position des espions en direct pendant 5 minutes |

Tout est modifiable sans toucher au code : copiez `config/jokers.json.example` en
`config/jokers.json` et changez noms, défis, durées et effets. Voir `config/README.md`
pour la liste des effets disponibles.

## Déroulé d'une partie

1. Chacun se connecte avec son code. Les téléphones des joueurs envoient leur position.
   Les espions voient aussitôt les espionnés sur leur carte, en continu.
2. Les espionnés demandent la position des espions depuis l'onglet **Demandes** :
   **suivi en direct** (fenêtre avec compte à rebours) ou **envoi ponctuel** (un seul
   point figé sur la carte).
3. Le maître du jeu voit la demande dans **Validations** et accorde 3 min, 10 min, ou refuse.
4. Les espions reçoivent aussitôt l'alerte « Vous êtes repérés » sur leur téléphone.
5. Les jokers s'utilisent depuis l'onglet **Jokers** de chaque équipe.
6. Les espionnés remplissent leurs **défis** depuis leur onglet dédié ; certains
   demandent une photo, prise et envoyée depuis le téléphone.
7. Le maître du jeu suit le chrono de 5 h et peut, à tout moment, ouvrir ou couper un
   accès, immobiliser une équipe 30 s ou 2 min (la règle « rester figé 30 secondes après
   avoir envoyé sa position »), écrire aux équipes, **mettre la partie en pause** ou la
   réinitialiser.

## Les défis

Les espionnés ont un onglet **Défis** listant ce qu'ils doivent accomplir. Chaque défi
dit ce qu'il attend comme preuve :

- **rien** — un bouton suffit ;
- **une photo obligatoire**, ou **facultative** si on veut juste laisser une trace ;
- **la validation du maître du jeu**, quand la preuve ne tient pas dans une image.

Pour une photo, le joueur choisit sa source : *Prendre une photo*, *Galerie* ou
*Fichiers* (pratique pour une capture d'écran). Le navigateur la redimensionne avant
l'envoi, et elle n'est visible que par l'équipe concernée et le maître du jeu.

Un défi soumis à validation part dans l'onglet **Validations** du maître du jeu, avec sa
photo s'il y en a une. Tant qu'il n'a pas tranché, le défi reste « en attente » et ne
compte pas ; un refus le remet à faire.

Le maître du jeu voit l'avancement et les photos dans son onglet **Contrôle**, et peut
annuler un défi mal validé. Le joker « Défi annulé » des espions, lui, propose la liste
des défis **déjà validés** : celui qu'ils choisissent repasse en non fait.

La liste par défaut est un exemple — remplacez-la en copiant `config/defis.json.example`
en `config/defis.json`.

## La pause

Depuis **Contrôle**, le maître du jeu met la partie en pause avec un message libre
(« Pause repas, on reprend dans 20 minutes »). Tous les écrans, sauf le sien, affichent
cet écran de pause, et plus personne ne peut jouer un joker, demander une position ou
valider un défi. À la reprise, **le temps de pause est rendu** : le chrono de fin, les
compte à rebours de suivi, les blocages et les immobilisations sont tous décalés d'autant.

## Notifications sur téléphone

Chaque alerte s'affiche dans l'app avec un son et une vibration. Pour recevoir aussi les
alertes **téléphone verrouillé**, appuyez sur *Activer les notifications* : les joueurs
le trouvent tout en bas de l'onglet **Carte**, le maître du jeu dans **Contrôle** et le
spectateur dans **Résumé**, sur la carte « Cet appareil » (même endroit que la
déconnexion).

- **Android / PC** : fonctionne directement dans Chrome, Edge ou Firefox.
- **iPhone** : obligatoirement iOS 16.4 ou plus récent, et **uniquement depuis l'app
  installée**. Safari → Partager → *Sur l'écran d'accueil* → ouvrir Traque depuis l'icône
  → *Activer les notifications*. Tant que l'app est ouverte dans Safari, le bouton le dit
  et propose l'installation : c'est une limite d'iOS, pas de l'app.

## La carte

Trois fonds, le bouton calques (en haut à droite) les enchaîne :

1. **Plan sombre** (par défaut) — assorti à l'interface, façon plan de nuit.
2. **Plan détaillé** — celui qui affiche le plus de commerces et de noms de rues.
3. **Satellite** — imagerie Esri avec les libellés.

Sans aucune clé, l'app utilise les tuiles **OpenStreetMap** : elles ne demandent rien,
affichent les commerces à partir du zoom 17, et le plan sombre est obtenu en assombrissant
ces mêmes tuiles. C'est suffisant pour jouer, mais la politique d'usage d'OSM vise les
petits volumes — pour une partie filmée avec beaucoup de spectateurs, prenez une clé.

**CARTO** (gratuit, plans Voyager et dark matter, rendu plus soigné) :

```bash
CARTO_KEY=votre_cle npm start
```

**MapTiler** (gratuit, rendu vectoriel : POI plus nets, numéros de rue, transports —
le plus proche d'Apple Maps) :

```bash
MAPTILER_KEY=votre_cle npm start
```

MapTiler prend le dessus s'il est défini, sinon CARTO, sinon OpenStreetMap. Si une clé est
refusée ou expirée, l'app le détecte, affiche un message et repasse toute seule sur
OpenStreetMap plutôt que de laisser une carte vide.

> Mettez ces clés dans les variables d'environnement de l'hébergeur, **jamais dans le
> dépôt** : une clé publiée est une clé que n'importe qui peut épuiser.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP (fourni par Render) |
| `APP_NAME` | `TRAQUE` | Titre sur l'écran de connexion |
| `ACCESS_CODES` | — | Codes fixes : `code:rôle:nom,…` |
| `CARTO_KEY` | — | Active les fonds CARTO (clé gratuite, obligatoire depuis 2024) |
| `MAPTILER_KEY` | — | Active les fonds vectoriels MapTiler (prioritaire sur CARTO) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | générées | Clés des notifications push |
| `DATA_DIR` | `./data` | Emplacement de `state.json` |
| `PUSH_SUBJECT` | `mailto:admin@example.com` | Contact envoyé avec le push |

## Structure

```
server/index.js    HTTP + WebSocket, API REST, authentification par code
server/store.js    État, persistance dans data/state.json, fichiers config/
server/game.js     Règles de visibilité, demandes, jokers, effets, journal
server/push.js     Notifications push (VAPID)
public/index.html  Connexion (code à 5 chiffres)
public/app.html    Carte — s'adapte au rôle joueur / maître du jeu / spectateur
public/js/map.js   Fonds de carte MapLibre, marqueurs, points figés, cercle de précision
public/js/app.js   État en direct, panneaux, actions, alertes
config/            codes.json / jokers.json / game.json (optionnels)
render.yaml        Blueprint de déploiement Render
```

Les positions passent par un WebSocket et sont filtrées **côté serveur** : le navigateur
des espionnés ne reçoit jamais les coordonnées des espions tant qu'aucun accès n'est
ouvert. Elles ne vivent qu'en mémoire — un redémarrage vide la carte mais conserve les
codes, les jokers et le chrono.

## Bon à savoir

- La précision GPS est celle que rapporte le téléphone ; chaque marqueur affiche son
  rayon ±, et un joueur silencieux depuis 5 minutes passe en « signal perdu ».
- Gardez l'app au premier plan pendant la partie : les téléphones coupent le GPS des
  onglets en arrière-plan. L'app demande un verrou d'écran quand le navigateur le permet.
- Il n'y a pas d'autre mot de passe que le code, et les positions ne sont pas chiffrées
  au repos. C'est un jeu entre amis, pas un outil de sécurité.
- Le suivi des défis et du quota de photos n'est pas dans l'app : le maître du jeu les
  valide de vive voix, comme sur les feuilles de règles.
