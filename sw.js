/// Service worker : ce qui rend OptiKey installable et utilisable hors ligne.
///
/// POURQUOI UN SERVICE WORKER, ALORS QU'UN FICHIER HTML SUFFISAIT DEJA
/// -------------------------------------------------------------------
/// `tools/bundler.py` produit deja un lecteur en un seul fichier, qui marche
/// depuis une cle USB sans le moindre reseau. Mais un fichier ouvert en
/// `file://` n'est PAS un contexte securise, et les navigateurs y refusent la
/// camera. On ne peut donc y arriver que par la voie « choisir une photo » :
/// deux gestes, et pas de visee en direct.
///
/// Une application installee, elle, s'execute dans un contexte securise. La
/// camera y fonctionne, et ce fichier fait le reste : il met tout en cache a
/// l'installation, et ne redemande plus jamais rien au reseau.
///
/// Le prix est UNE seule recuperation en HTTPS, au moment de l'installation.
/// C'est l'equivalent d'acheter le lecteur de cartes : on acquiert l'outil une
/// fois, et ensuite plus rien ne transite — ni les donnees, ni la geometrie.

/// Le nom du cache PORTE SA VERSION, et il faut la changer a chaque livraison.
///
/// Sans cela, un appareil garderait indefiniment l'ancienne version : la regle
/// « cache d'abord » ci-dessous est justement faite pour ne plus interroger le
/// reseau. C'est le compromis exact de l'installation hors ligne — on echange
/// la fraicheur automatique contre l'independance.
const CACHE = 'optikey-v15';

/// Tout ce dont l'application a besoin pour fonctionner sans reseau.
///
/// La feuille de style distante d'IBM Plex n'y figure pas, deliberement : une
/// application « hors ligne » qui va chercher une police sur Internet n'est pas
/// hors ligne. Les piles de repli du CSS prennent le relais, et c'est le meme
/// choix que celui du fichier unique.
const RESSOURCES = [
  './',
  './index.html',
  './pdc.js',
  './amorcage.js',
  './remise.js',
  './decodeur.js',
  './pdc_wasm.wasm',
  './manifest.webmanifest',
  './icone-192.png',
  './icone-512.png',
  './icone-512-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `addAll` echoue en bloc si une seule ressource manque, et c'est ce
      // qu'on veut : une installation a moitie faite donnerait une application
      // qui semble installee et tombe en panne hors reseau.
      await cache.addAll(RESSOURCES);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const nom of await caches.keys()) {
        if (nom !== CACHE) await caches.delete(nom);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // On ne s'occupe QUE de nos propres ressources, et seulement en lecture.
  //
  // Laisser passer le reste sans y toucher est plus sur que de tenter de le
  // gerer : le service worker s'interpose sur TOUTES les requetes de la page,
  // et une erreur ici casserait des choses qui n'ont rien a voir avec nous.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    (async () => {
      const enCache = await caches.match(e.request, { ignoreSearch: true });
      if (enCache) return enCache;
      try {
        const reponse = await fetch(e.request);
        // On ne met en cache que ce qui a vraiment abouti : stocker une erreur
        // 404 la rendrait permanente, jusqu'au prochain changement de version.
        if (reponse.ok && reponse.type === 'basic') {
          const cache = await caches.open(CACHE);
          cache.put(e.request, reponse.clone());
        }
        return reponse;
      } catch (err) {
        // Hors ligne et absent du cache : on repond la page d'accueil pour une
        // navigation, faute de quoi le navigateur affiche son propre message
        // d'erreur — celui qui parle de connexion, alors que l'application n'en
        // a jamais eu besoin.
        if (e.request.mode === 'navigate') {
          const repli = await caches.match('./index.html');
          if (repli) return repli;
        }
        throw err;
      }
    })(),
  );
});
