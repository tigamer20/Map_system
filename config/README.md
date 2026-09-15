# Personnalisation

Déposez un fichier ici **avant le premier lancement** (ou supprimez `data/state.json`
puis relancez) pour remplacer les valeurs par défaut. Copiez le `.example`
correspondant et retirez le suffixe `.example`.

| Fichier | Rôle |
|---|---|
| `codes.json` | Choisir vos propres codes à 5 chiffres au lieu des codes aléatoires |
| `jokers.json` | Réécrire les 2 jokers de chaque équipe |
| `game.json` | Qui traque qui, durée de la partie, nom affiché |
| `defis.json` | La liste des défis et lesquels demandent une photo |

Si un fichier est absent ou invalide, l'app reprend ses valeurs par défaut et
l'explique dans les logs du serveur.

> Sur un hébergeur dont le disque est effacé à chaque redémarrage (Render en plan
> gratuit), passez plutôt par la variable d'environnement `ACCESS_CODES` : les codes
> restent stables et ne sont pas publiés dans le dépôt.

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
- `photo` : `true` oblige à envoyer une photo pour valider le défi. La photo est
  redimensionnée par le téléphone puis stockée dans `data/uploads/`, visible par
  l'équipe concernée et le maître du jeu seulement.
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
