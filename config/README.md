# Personnalisation

Déposez un fichier ici pour remplacer les valeurs par défaut : copiez le `.example`
correspondant et retirez le suffixe `.example`. **Un fichier modifié est relu à chaque
redémarrage** — l'app compare son contenu à ce qu'elle avait enregistré et l'applique
s'il a changé. Inutile de supprimer `data/state.json`.

Ces fichiers doivent être **versionnés** (commités) pour arriver sur l'hébergeur :
rien dans `config/` n'est ignoré par git.

| Fichier | Rôle |
|---|---|
| `codes.json` | Choisir vos propres codes à 5 chiffres au lieu des codes aléatoires |
| `jokers.json` | Réécrire les 2 jokers de chaque équipe |
| `game.json` | Qui traque qui, durée de la partie, nom affiché |
| `defis.json` | La liste des défis et lesquels demandent une photo |

Si un fichier est absent ou invalide, l'app reprend ses valeurs par défaut et
l'explique dans les logs du serveur.

### Qui gagne, du fichier ou de la variable d'environnement ?

1. `config/codes.json` s'il existe — c'est un choix explicite, il passe devant tout ;
2. sinon la variable `ACCESS_CODES` ;
3. sinon un tirage aléatoire, stable d'un redémarrage à l'autre.

Le serveur annonce la source retenue au démarrage :

```
  Codes d'accès (source : config/codes.json) :
  22316  player  spy    Raf
```

Si les deux sont présents, il le dit aussi. Gardez `ACCESS_CODES` uniquement si vous
tenez à ce que vos codes ne soient pas lisibles dans un dépôt public.

## game.json

- `hunters` : `"spied"` (par défaut, conforme aux règles imprimées — les espionnés
  traquent les espions) ou `"spy"` pour inverser les rôles.
- `permanentReveal` : équipe qui voit ses adversaires **en continu**, sans demande ni
  validation. Par défaut la proie (`"spy"`, les espions voient les espionnés arriver).
  Mettez `"none"` pour que les deux équipes doivent tout demander.
- `durationMin` : durée de la partie en minutes (300 = 5 h).
- `appName` : nom affiché sur l'écran de connexion.

## defis.json

Un tableau d'objets, dans l'ordre d'affichage :

```json
[
  { "title": "Photo devant une fontaine", "photo": true },
  { "title": "Faire un high-five à un inconnu", "photo": false }
]
```

- `title` : le texte affiché au joueur (obligatoire).
- `description` : précision facultative, en plus petit sous le titre.
- `photo` : `true` oblige à envoyer une photo, `"optional"` l'accepte sans l'exiger,
  `false` n'en demande aucune. La photo est redimensionnée par le téléphone puis stockée
  dans `data/uploads/`, visible par l'équipe concernée et le maître du jeu seulement.
  Le joueur choisit sa source : appareil photo, galerie ou fichiers.
- `photoLabel` : remplace le titre de l'encadré (« Capture d'écran du chrono » plutôt
  que « Photo obligatoire »).
- `approval` : `true` envoie le défi au maître du jeu au lieu de le valider tout de
  suite. Il apparaît dans son onglet Validations avec la photo s'il y en a une ; tant
  qu'il n'a pas tranché, le défi reste « en attente » et ne compte pas. Un refus le
  remet à faire.
- `team` : `"spied"` par défaut. Mettez `"spy"` pour donner la liste aux espions.
- `id` : facultatif, calculé sinon (`defi_1`, `defi_2`…).
- `answer` : réponse à fournir en plus, pour valider le défi.
  - `"ranking"` : un menu déroulant par position, rempli avec les noms de l'équipe
    (« 1 — le plus cave » … « le plus intelligent »). Les doublons et les classements
    incomplets sont refusés, et le maître du jeu voit le résultat.
  - `"text"` : une réponse libre.

Le fichier livré (`defis.json`) contient les défis réels de la partie ; `defis.json.example`
garde une liste générique si vous voulez repartir de zéro.

Le joker « Défi annulé » des espions pioche dans les défis **validés** de l'autre
équipe : celui qui est choisi repasse en non fait et sa photo est effacée.

## Effets de joker

| `effect` | Ce que ça fait | utilise `durationSec` |
|---|---|---|
| `freeze` | L'équipe adverse doit rester sur place, compte à rebours sur son écran | oui |
| `reveal_opponents` | L'équipe qui joue le joker voit l'autre équipe en direct | oui |
| `block_reveal` | L'équipe adverse ne peut obtenir aucune position | oui |
| `snapshot_pin` | Pose un point figé sur la position actuelle de chaque adversaire | non |
| `notify` | Aucun effet mécanique, seulement une notification (ex. « défi annulé ») | non |

Options communes :

- `requiresUnlock` : `true` = le joker doit d'abord être débloqué en réalisant le défi
  décrit dans `unlockRequirement`, que le maître du jeu valide dans l'app.
- `prompt` : question posée au joueur au moment de jouer le joker (le texte saisi part
  dans la notification de l'équipe adverse). Sans `prompt`, le joker part directement.
- `alsoBlock` : avec `freeze`, coupe aussi tout accès à la position pendant la durée
  (c'est la règle « sans possibilité de poursuite »).
