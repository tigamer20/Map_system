# Personnalisation

Déposez un fichier ici **avant le premier lancement** (ou supprimez `data/state.json`
puis relancez) pour remplacer les valeurs par défaut. Copiez le `.example`
correspondant et retirez le suffixe `.example`.

| Fichier | Rôle |
|---|---|
| `codes.json` | Choisir vos propres codes à 5 chiffres au lieu des codes aléatoires |
| `jokers.json` | Réécrire les 2 jokers de chaque équipe |
| `game.json` | Qui traque qui, durée de la partie, nom affiché |

Si un fichier est absent ou invalide, l'app reprend ses valeurs par défaut et
l'explique dans les logs du serveur.

> Sur un hébergeur dont le disque est effacé à chaque redémarrage (Render en plan
> gratuit), passez plutôt par la variable d'environnement `ACCESS_CODES` : les codes
> restent stables et ne sont pas publiés dans le dépôt.

## game.json

- `hunters` : `"spied"` (par défaut, conforme aux règles imprimées — les espionnés
  traquent les espions) ou `"spy"` pour inverser les rôles.
- `durationMin` : durée de la partie en minutes (300 = 5 h).
- `appName` : nom affiché sur l'écran de connexion.

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
