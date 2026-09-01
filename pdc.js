// Liaison JavaScript de la facade WebAssembly du cœur PDC.
//
// Aucune dependance, aucune etape de construction : le module .wasm exporte
// neuf fonctions manipulant des octets, et ce fichier les enveloppe.
//
//   import { Pdc } from './pdc.js';
//   const pdc = await Pdc.charger('./pdc_wasm.wasm');
//   const page = pdc.encoder(octets, { profil: 'laser', echelle: 6 });
//   //   -> { pixels, largeur, hauteur, descripteur }
//   const fichier = pdc.decoder(pixels, largeur, hauteur, page.descripteur);
//
// Le descripteur porte la geometrie de la page. Il ne se devine pas depuis les
// pixels : c'est ce que le QR Code d'amorcage transportera, aux cotes de
// l'URL du decodeur (paragraphe 7.2 de l'etude).

const PROFILS = { ecran: 0, laser: 1, rugueux: 2 };

/// Decode une suite de quadrilateres : par forme, huit entiers de seize bits
/// petit-boutiens — x et y des quatre coins, en pixels de l'image analysee.
///
/// Un seul decodeur pour les deux fonctions qui en rendent, sinon la premiere
/// divergence d'un octet donnerait un cadre plausible mais faux.
function quadrilateres(octets, combien) {
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const out = [];
  for (let t = 0; t < combien && (t + 1) * 16 <= octets.byteLength; t++) {
    const q = [];
    for (let k = 0; k < 4; k++) {
      q.push([vue.getUint16(t * 16 + k * 4, true), vue.getUint16(t * 16 + k * 4 + 2, true)]);
    }
    out.push(q);
  }
  return out;
}
/// La table inverse : du numero de l'ABI vers le nom. Elle sert quand la
/// geometrie vient de la PAGE et non d'un QR.
///
/// Nom different de celui d'`amorcage.js`, qui fait la meme chose pour le QR :
/// le lecteur autonome concatene les modules, et deux constantes homonymes au
/// premier niveau s'y ecraseraient. L'outil d'assemblage refuse d'ailleurs de
/// livrer tant que la collision existe — c'est ainsi qu'elle a ete vue.
const PROFIL_PAR_NUMERO = ['ecran', 'laser', 'rugueux'];

const ERREURS = {
  '-1': "pointeur nul ou dimensions invalides",
  '-2': "profil de redondance inconnu",
  '-3': "geometrie de page invalide",
  '-4': "encodage impossible",
  '-5': "grille introuvable dans l'image",
  '-6': "donnees irrecuperables",
};

export class Pdc {
  constructor(exports) {
    this.x = exports;
  }

  // `await X ? A : B` s'analyse en `(await X) ? A : B` : la version
  // precedente attendait la FONCTION, pas son resultat, et ne retombait
  // jamais sur la voie lente autrement que par accident. Le repli est
  // necessaire pour de bon : `instantiateStreaming` exige le type MIME
  // application/wasm, qu'un serveur statique n'envoie pas toujours.
  /// Instancie depuis des octets deja en memoire.
  ///
  /// C'est ce qui permet a tout le decodeur de tenir dans UN SEUL fichier, sans
  /// reseau : le module wasm y est embarque en base64 et n'est jamais telecharge.
  static async depuisOctets(octets) {
    const { instance } = await WebAssembly.instantiate(
      octets instanceof Uint8Array ? octets.buffer : octets,
      {},
    );
    return new Pdc(instance.exports);
  }

  static async charger(url) {
    const src = await fetch(url);
    if (!src.ok) throw new Error(`chargement du decodeur : HTTP ${src.status}`);
    if (WebAssembly.instantiateStreaming) {
      try {
        const { instance } = await WebAssembly.instantiateStreaming(src.clone(), {});
        return new Pdc(instance.exports);
      } catch { /* type MIME refuse : on passe par le tampon */ }
    }
    const { instance } = await WebAssembly.instantiate(await src.arrayBuffer(), {});
    return new Pdc(instance.exports);
  }

  /** Vue sur la memoire du module. A relire apres chaque appel : une
   *  allocation peut faire croitre la memoire et invalider l'ancienne vue. */
  get memoire() {
    return new Uint8Array(this.x.memory.buffer);
  }

  #lire(res) {
    const statut = this.x.pdc_result_status(res);
    if (statut !== 0) {
      const message = ERREURS[String(statut)] ?? `erreur ${statut}`;
      this.x.pdc_result_free(res);
      throw new Error(message);
    }
    const ptr = this.x.pdc_result_ptr(res);
    const len = this.x.pdc_result_len(res);
    const octets = this.memoire.slice(ptr, ptr + len);
    const info = [];
    for (let i = 0; i < 8; i++) info.push(this.x.pdc_result_info(res, i));
    const nptr = this.x.pdc_result_name_ptr(res);
    const nlen = this.x.pdc_result_name_len(res);
    const nom = nlen ? new TextDecoder().decode(this.memoire.slice(nptr, nptr + nlen)) : null;
    this.x.pdc_result_free(res);
    return { octets, info, nom };
  }

  /** Fichier -> image en niveaux de gris, un octet par pixel. */
  encoder(donnees, { profil = 'laser', echelle = 6, maille = 32, repere = 4,
                     niveaux = 2 } = {}) {
    const p = PROFILS[profil];
    if (p === undefined) throw new Error(`profil inconnu : ${profil}`);

    const ptr = this.x.pdc_alloc(donnees.length);
    try {
      this.memoire.set(donnees, ptr);
      const res = this.x.pdc_encode(ptr, donnees.length, p, echelle, maille, repere,
                                    niveaux);
      const { octets, info } = this.#lire(res);
      return {
        pixels: octets,
        largeur: info[0],
        hauteur: info[1],
        descripteur: {
          profil,
          tuilesX: info[2],
          tuilesY: info[3],
          cellulesParTuile: info[4],
          cadre: info[5],
          silence: info[6],
          symboles: info[7],
          echelle,
          maille,
          repere,
          niveaux,
        },
      };
    } finally {
      this.x.pdc_dealloc(ptr, donnees.length);
    }
  }

  /** Examine une image sans la decoder : repond a « cette image est-elle
   *  exploitable ? », pas a « que contient-elle ? ».
   *
   *  Assez rapide pour tourner sur l'apercu de la camera, ce qu'un decodage
   *  complet ne serait pas. Rend `null` quand aucune grille n'est visible —
   *  l'etat normal tant que la feuille n'est pas dans le champ. */
  inspecter(pixels, largeur, hauteur, d) {
    const ptr = this.x.pdc_alloc(pixels.length);
    try {
      this.memoire.set(pixels, ptr);
      const res = this.x.pdc_inspect(
        ptr, largeur, hauteur,
        d.tuilesX, d.tuilesY, d.cellulesParTuile, d.cadre, d.silence,
        d.maille ?? 0, d.repere ?? 0, d.niveaux ?? 2, d.entete ? 1 : 0,
      );
      if (this.x.pdc_result_status(res) !== 0) {
        this.x.pdc_result_free(res);
        return null;
      }
      const { octets, info } = this.#lire(res);
      const coins = quadrilateres(octets, info[6]);
      return {
        tuiles: info[0],
        tuilesAttendues: info[1],
        pxParCellule: info[2] / 100,
        contraste: info[3],
        cellulesSures: info[4] / 1000,
        erreurReprojection: info[5] / 1000,
        coins,
      };
    } finally {
      this.x.pdc_dealloc(ptr, pixels.length);
    }
  }

  /** Lit un QR Code dans une image en niveaux de gris.
   *
   *  Rend les octets, ou `null` si aucun QR exploitable n'est trouve — l'etat
   *  normal tant que le code n'est pas dans le champ, donc pas une erreur.
   *
   *  C'est NOTRE decodeur, pas celui du navigateur : `BarcodeDetector` n'existe
   *  que sur les moteurs Chromium, et le lecteur ne pouvait donc s'amorcer seul
   *  que sur la moitie des appareils. */
  lireQr(pixels, largeur, hauteur) {
    const ptr = this.x.pdc_alloc(pixels.length);
    try {
      this.memoire.set(pixels, ptr);
      const res = this.x.pdc_lire_qr(ptr, largeur, hauteur);
      if (this.x.pdc_result_status(res) !== 0) {
        this.x.pdc_result_free(res);
        return null;
      }
      const { octets } = this.#lire(res);
      return octets;
    } finally {
      this.x.pdc_dealloc(ptr, pixels.length);
    }
  }

  /** Image EN COULEUR -> fichier. Trois octets par pixel, entrelaces.
   *
   *  Fonction a part plutot que drapeau : l'entree n'a pas la meme forme, et un
   *  drapeau obligerait chaque appelant a savoir ce que la memoire contient
   *  sans que rien ne le dise. La premiere confusion produirait une page lue de
   *  travers plutot qu'une erreur. */
  decoderCouleur(rvb, largeur, hauteur, d) {
    const p = PROFILS[d.profil];
    if (p === undefined) throw new Error(`profil inconnu : ${d.profil}`);
    const ptr = this.x.pdc_alloc(rvb.length);
    try {
      this.memoire.set(rvb, ptr);
      const res = this.x.pdc_decode_couleur(
        ptr, largeur, hauteur, p,
        d.tuilesX, d.tuilesY, d.cellulesParTuile, d.cadre, d.silence, d.symboles,
        d.maille ?? 0, d.repere ?? 0, d.niveaux ?? 2, d.entete ? 1 : 0,
      );
      const { octets, info, nom } = this.#lire(res);
      return {
        donnees: octets,
        nomDeclare: nom,
        effacements: info[0],
        blocsLus: info[1],
        blocsReconstruits: info[2],
        blocsTotal: info[3],
        symbolesCorriges: info[4],
        pireBloc: info[5],
        budgetParBloc: info[6],
      };
    } finally {
      this.x.pdc_dealloc(ptr, rvb.length);
    }
  }

  /** Demodule une vue SANS la decoder, pour pouvoir en cumuler plusieurs.
   *
   *  Une cellule est mal lue quand la grille de pixels tombe mal sur elle.
   *  Changer de distance change lesquelles : deux vues qui echouent chacune
   *  peuvent se completer. Mesure au banc : dans toute une bande de
   *  difficulte, une vue seule echoue six fois sur six pendant que deux vues
   *  suffisent.
   *
   *  Rend un tableau de `2 * symboles` octets — les valeurs, puis un drapeau
   *  de certitude par case — a passer tel quel a `fusionnerEtDecoder`. */
  demoduler(pixels, largeur, hauteur, d, canaux = 1) {
    const ptr = this.x.pdc_alloc(pixels.length);
    try {
      this.memoire.set(pixels, ptr);
      const res = this.x.pdc_demoduler(
        ptr, largeur, hauteur,
        d.tuilesX, d.tuilesY, d.cellulesParTuile, d.cadre, d.silence,
        d.maille ?? 0, d.repere ?? 0, d.niveaux ?? 2, d.entete ? 1 : 0,
        canaux, d.symboles,
      );
      if (this.x.pdc_result_status(res) !== 0) {
        this.x.pdc_result_free(res);
        return null;
      }
      const { octets, info } = this.#lire(res);
      return { vue: octets, symboles: info[0], douteux: info[1] };
    } finally {
      this.x.pdc_dealloc(ptr, pixels.length);
    }
  }

  /** Cumule plusieurs vues de la MEME page et decode le resultat.
   *
   *  `vues` est un tableau de ce que rend `demoduler`. Le vote est fait dans
   *  le cœur — une seule regle, testee la-bas. */
  fusionnerEtDecoder(vues, symboles, profil) {
    const p = PROFILS[profil];
    if (p === undefined) throw new Error(`profil inconnu : ${profil}`);
    const taille = vues.length * symboles * 2;
    const ptr = this.x.pdc_alloc(taille);
    try {
      for (let i = 0; i < vues.length; i++) {
        this.memoire.set(vues[i], ptr + i * symboles * 2);
      }
      const res = this.x.pdc_fusionner_decoder(ptr, vues.length, symboles, p);
      const { octets, info, nom } = this.#lire(res);
      return {
        donnees: octets,
        nomDeclare: nom,
        effacements: info[0],
        blocsLus: info[1],
        blocsReconstruits: info[2],
        blocsTotal: info[3],
        symbolesCorriges: info[4],
        pireBloc: info[5],
        budgetParBloc: info[6],
        vues: info[7],
      };
    } finally {
      this.x.pdc_dealloc(ptr, taille);
    }
  }

  /** Les grandes taches claires carrees de l'image, sans aucune geometrie.
   *
   *  Sert au viseur pendant la recherche : montrer ce qu'on voit avant de
   *  savoir ce que c'est. Rend un tableau de quadrilateres, chacun quatre
   *  paires de coordonnees en pixels de l'image donnee. */
  ouvertures(pixels, largeur, hauteur) {
    const ptr = this.x.pdc_alloc(pixels.length);
    try {
      this.memoire.set(pixels, ptr);
      const res = this.x.pdc_ouvertures(ptr, largeur, hauteur);
      if (this.x.pdc_result_status(res) !== 0) {
        this.x.pdc_result_free(res);
        return [];
      }
      const { octets, info } = this.#lire(res);
      return quadrilateres(octets, info[0]);
    } finally {
      this.x.pdc_dealloc(ptr, pixels.length);
    }
  }

  /** RETROUVE LA GEOMETRIE D'UNE PAGE, sans la decoder.
   *
   *  Rend un descripteur de la meme forme que `lireFragment`, si bien que tout
   *  le reste de l'application — guidage, diagnostic, decodage — continue de
   *  fonctionner sans rien savoir de son origine.
   *
   *  Rend `null` quand aucune page ne se decrit : l'etat normal tant que la
   *  feuille n'est pas dans le champ, donc pas une erreur. */
  amorcerImage(pixels, largeur, hauteur, canaux = 1) {
    const ptr = this.x.pdc_alloc(pixels.length);
    try {
      this.memoire.set(pixels, ptr);
      const res = this.x.pdc_amorcer(ptr, largeur, hauteur, canaux);
      if (this.x.pdc_result_status(res) !== 0) {
        this.x.pdc_result_free(res);
        return null;
      }
      const { octets, info } = this.#lire(res);
      const niveaux = info[3];
      return {
        profil: PROFIL_PAR_NUMERO[info[4]],
        tuilesX: info[0],
        tuilesY: info[1],
        cellulesParTuile: info[2],
        niveaux,
        bitsParCellule: Math.log2(niveaux),
        symboles: info[5],
        couleur: info[6] !== 0,
        cadre: octets[0],
        silence: octets[1],
        maille: octets[2],
        repere: octets[3],
        // La page porte son en-tete : c'est ainsi qu'on vient de la lire.
        entete: true,
        // Elle ne s'est pas annoncee par un QR : rien a comparer.
        empreinteCourte: null,
        // D'ou vient cette geometrie. L'interface le dit a l'utilisateur.
        origine: 'entete',
      };
    } finally {
      this.x.pdc_dealloc(ptr, pixels.length);
    }
  }

  /** LIT UNE PAGE SANS RIEN SAVOIR D'ELLE.
   *
   *  Ni geometrie, ni profil, ni nombre de symboles : la page les porte dans
   *  son en-tete. C'est ce qui permet au QR d'amorcage de n'etre plus qu'une
   *  adresse — la meme pour toutes les pages — au lieu d'une chaine de
   *  quatorze champs a regenerer pour chaque fichier.
   *
   *  `canaux` vaut 1 pour du gris, 3 pour du rouge-vert-bleu entrelace. Une
   *  page en couleur photographiee en gris echoue franchement plutot que de
   *  rendre des octets faux : c'est l'en-tete qui dit laquelle des deux elle
   *  est, et le desaccord est une erreur.
   *
   *  Rend `null` si la page ne s'est pas decrite — cas normal quand l'image ne
   *  contient pas d'OptiKey, ou qu'une tuile manque. */
  decoderAuto(pixels, largeur, hauteur, canaux = 1) {
    const ptr = this.x.pdc_alloc(pixels.length);
    try {
      this.memoire.set(pixels, ptr);
      const res = this.x.pdc_decode_auto(ptr, largeur, hauteur, canaux);
      if (this.x.pdc_result_status(res) !== 0) {
        const code = this.x.pdc_result_status(res);
        this.x.pdc_result_free(res);
        // -8 : aucun en-tete. Les autres codes disent que la page s'est bien
        // decrite mais n'a pas pu etre lue — une information a garder.
        if (code === -8) return null;
        throw new Error(`decodage automatique : code ${code}`);
      }
      const { octets, info, nom } = this.#lire(res);
      return {
        donnees: octets,
        nomDeclare: nom,
        effacements: info[0],
        blocsLus: info[1],
        blocsReconstruits: info[2],
        blocsTotal: info[3],
        symbolesCorriges: info[4],
        pireBloc: info[5],
        budgetParBloc: info[6],
        niveaux: info[7],
      };
    } finally {
      this.x.pdc_dealloc(ptr, pixels.length);
    }
  }

  /** Image en niveaux de gris -> fichier. */
  decoder(pixels, largeur, hauteur, d) {
    const p = PROFILS[d.profil];
    if (p === undefined) throw new Error(`profil inconnu : ${d.profil}`);

    const ptr = this.x.pdc_alloc(pixels.length);
    try {
      this.memoire.set(pixels, ptr);
      const res = this.x.pdc_decode(
        ptr, largeur, hauteur, p,
        d.tuilesX, d.tuilesY, d.cellulesParTuile, d.cadre, d.silence, d.symboles,
        d.maille ?? 0, d.repere ?? 0, d.niveaux ?? 2, d.entete ? 1 : 0,
      );
      const { octets, info, nom } = this.#lire(res);
      return {
        donnees: octets,
        // Nom DECLARE par la page, deja assaini cote Rust. C'est une
        // suggestion a montrer, jamais un chemin a suivre.
        nomDeclare: nom,
        effacements: info[0],
        blocsLus: info[1],
        blocsReconstruits: info[2],
        blocsTotal: info[3],
        symbolesCorriges: info[4],
        // Le budget du Reed-Solomon est PAR BLOC : c'est le bloc le plus
        // touche qui decide, jamais la moyenne.
        pireBloc: info[5],
        budgetParBloc: info[6],
      };
    } finally {
      this.x.pdc_dealloc(ptr, pixels.length);
    }
  }
}

/** Convertit une frame de camera ou un canvas en niveaux de gris.
 *
 *  La luminance suffit : le protocole est monochrome, la campagne E4 ayant
 *  montre que la couleur perd sur ce support. */
export function versNiveauxDeGris(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return out;
}

/** Trois octets par pixel, entrelaces : ce qu'attend le decodeur couleur.
 *
 *  Un canvas rend du RVBA ; on laisse tomber la transparence, qui n'existe pas
 *  sur une photographie. */
export function versRvb(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    out[j] = data[i];
    out[j + 1] = data[i + 1];
    out[j + 2] = data[i + 2];
  }
  return out;
}

/** Rend une image en niveaux de gris dans un canvas. */
export function versCanvas(pixels, largeur, hauteur, canvas) {
  canvas.width = largeur;
  canvas.height = hauteur;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(largeur, hauteur);
  for (let i = 0, j = 0; j < pixels.length; i += 4, j++) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = pixels[j];
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Sans cela, le navigateur lisse les cellules a l'affichage comme a
  // l'impression, ce qui detruit precisement ce qu'on cherche a preserver.
  canvas.style.imageRendering = 'pixelated';
}
