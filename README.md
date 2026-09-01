# OptiKey — le lecteur

**Récupérez un fichier depuis une image, avec l'appareil photo de votre téléphone. Sans connexion, sans compte, sans serveur.**

👉 **[Ouvrir le lecteur](https://betaisda.github.io/optikey-lecteur/)**

---

## Ce que c'est

OptiKey encode un fichier — texte, document, n'importe quoi — dans une image imprimable ou affichable. Cette page la relit.

Une **A4 porte 380 000 octets**. Une image affichée sur un écran, quelques dizaines de milliers.

## L'installer, une fois

Ouvrez le lien ci-dessus, puis **« Ajouter à l'écran d'accueil »** :

- **Android** — menu du navigateur → *Installer l'application* ou *Ajouter à l'écran d'accueil*
- **iPhone** — bouton Partager → *Sur l'écran d'accueil*

Une icône apparaît. **À partir de là, plus rien ne passe par Internet** : ni la page, ni le décodeur, ni vos fichiers. Coupez le Wi-Fi et les données, l'application fonctionne exactement pareil.

C'est une page web ordinaire de 260 ko. Il n'y a ni magasin d'applications, ni compte, ni mise à jour forcée.

## S'en servir

1. Scannez le QR Code qui accompagne l'image — il indique au lecteur comment elle est construite.
2. **Ouvrir la caméra**, cadrez le bloc de données seul, et ne bougez plus : la lecture se déclenche d'elle-même.
3. Le fichier vous est remis. Vous décidez de l'enregistrer.

L'option **« Enregistrer la photo »** garde la prise de vue dans votre appareil, en PNG sans perte — y compris quand la lecture échoue, pour pouvoir réessayer.

Vous pouvez aussi partir d'une **photo déjà prise**, avec « Choisir une photo déjà prise ».

## Vos fichiers ne partent nulle part

C'est le point de tout le projet, alors autant être précis :

- **Les octets ne quittent jamais l'appareil.** Le décodage se fait sur place, dans votre navigateur.
- **La géométrie non plus.** Elle voyage dans le *fragment* de l'adresse — la partie après le `#` — que les navigateurs n'envoient jamais au serveur.
- **Une fois installé, le lecteur ne demande plus rien au réseau.** Vérifiable : coupez tout, il marche.

Le lecteur **n'ouvre ni n'exécute jamais** ce qu'il récupère. Il vous remet des octets bruts ; c'est vous qui décidez de les ouvrir, et avec quoi.

## Ce dont il a besoin

Un navigateur récent. La caméra en direct exige une adresse en **HTTPS** — celle ci-dessus en est une. Ouvrir le fichier depuis votre disque fonctionne aussi, mais sans la caméra : les navigateurs la réservent aux contextes sécurisés.

## Ce dépôt

Il contient **uniquement le lecteur** : la page, quatre modules JavaScript, le décodeur WebAssembly et trois icônes. Onze fichiers, 260 ko, aucune dépendance — pas une seule bibliothèque tierce, ni ici ni dans le décodeur.

Le format, l'encodeur et la recherche vivent ailleurs et ne sont pas publiés.

---

*OptiKey — Quentin. Tous droits réservés.*
