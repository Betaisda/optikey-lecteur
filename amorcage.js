// Lecture du QR d'amorcage, et rien d'autre.
//
// CE FICHIER TRAITE UNE ENTREE HOSTILE.
// -------------------------------------
// Le fragment d'URL vient d'un QR Code qu'on a scanne. On ne sait pas qui l'a
// imprime. Il peut annoncer une page de dix mille tuiles, trois milliards de
// symboles, ou une geometrie qui fait exploser une allocation.
//
// Le §12 du cahier des charges l'exige noir sur blanc : verifier les tailles
// declarees, les indices, empecher les debordements et les allocations
// geantes. Chaque nombre est donc borne ici, avant que quoi que ce soit ne
// l'utilise, et une valeur hors domaine fait echouer l'amorcage — jamais un
// ajustement silencieux.

/// Bornes de chaque champ. Elles ne decrivent pas ce qui est *plausible* mais
/// ce qui est *supportable* : au-dela, on refuse au lieu d'essayer.
const BORNES = {
  v:  [2, 2],            // version du format d'amorcage — 1 : avant le maillage
  p:  [0, 2],            // profil de redondance
  tx: [1, 16],           // tuiles en x
  ty: [1, 16],           // tuiles en y
  td: [16, 512],         // cellules de donnees par tuile
  f:  [1, 8],            // epaisseur du cadre
  q:  [0, 8],            // zone de silence
  n:  [1, 4_000_000],    // symboles annonces
  m:  [0, 256],          // pas du maillage, 0 = page sans maillage
  r:  [0, 16],           // cote d'un repere
  g:  [2, 8],            // niveaux de gris par cellule : 2, 4 ou 8
  c:  [0, 1],            // page en trois canaux de couleur
};

/// Plafond dur sur la surface totale en cellules. Une geometrie peut respecter
/// chaque borne prise separement et rester absurde : 16 x 16 tuiles de 512
/// cellules font 67 millions de cellules. On coupe ici.
const CELLULES_MAX = 4_000_000;

/// Nom de profil par numero. Homonyme a eviter : `pdc.js` a sa propre table
/// PROFILS qui va dans l'autre sens, du nom vers le numero de l'ABI.
const NOMS_DE_PROFIL = ['ecran', 'laser', 'rugueux'];

export class ErreurAmorcage extends Error {}

function entier(params, cle, obligatoire = true) {
  const brut = params.get(cle);
  if (brut === null) {
    if (!obligatoire) return null;
    throw new ErreurAmorcage(`champ « ${cle} » absent du QR`);
  }
  // parseInt accepterait « 12abc » et « 0x10 ». Ici, des chiffres ou rien.
  if (!/^\d{1,10}$/.test(brut)) {
    throw new ErreurAmorcage(`champ « ${cle} » : « ${brut} » n'est pas un entier`);
  }
  const v = Number(brut);
  const [min, max] = BORNES[cle];
  if (v < min || v > max) {
    throw new ErreurAmorcage(`champ « ${cle} » = ${v}, hors des bornes [${min}, ${max}]`);
  }
  return v;
}

/// Analyse un fragment d'amorcage et rend un descripteur utilisable, ou leve.
///
/// Le fragment est ce qui suit le diese dans l'URL. Ce choix n'est pas
/// cosmetique : **un fragment n'est jamais transmis au serveur**. Meme la
/// geometrie de votre page ne quitte pas le telephone.
export function lireFragment(fragment) {
  const texte = String(fragment || '').replace(/^#/, '');
  if (!texte) throw new ErreurAmorcage('aucun fragment dans l\'URL');

  const params = new URLSearchParams(texte);
  entier(params, 'v'); // la version doit valoir 2, la borne s'en charge

  const d = {
    profil: NOMS_DE_PROFIL[entier(params, 'p')],
    tuilesX: entier(params, 'tx'),
    tuilesY: entier(params, 'ty'),
    cellulesParTuile: entier(params, 'td'),
    cadre: entier(params, 'f'),
    silence: entier(params, 'q'),
    symboles: entier(params, 'n'),
    // Absents : page sans maillage, ce qui reste une geometrie valide.
    maille: entier(params, 'm', false) ?? 0,
    repere: entier(params, 'r', false) ?? 0,
    // Absent : deux niveaux. Toutes les pages ecrites avant les niveaux de
    // gris se relisent ainsi, et elles restent valides.
    niveaux: entier(params, 'g', false) ?? 2,
    // Absent : page monochrome. Toutes les pages ecrites avant la couleur se
    // relisent ainsi, et elles restent valides.
    couleur: (entier(params, 'c', false) ?? 0) !== 0,
  };

  // Seules trois valeurs divisent huit sans reste ET tiennent dans un octet de
  // symbole. Une quatrieme obligerait un symbole a chevaucher un nombre non
  // entier de cellules : refuser est plus sur que d'inventer une convention.
  if (![2, 4, 8].includes(d.niveaux)) {
    throw new ErreurAmorcage(`niveaux de gris non supportes : ${d.niveaux}`);
  }
  d.bitsParCellule = Math.log2(d.niveaux);

  // Un maillage doit tenir dans la tuile et laisser de la donnee. Les memes
  // bornes que cote Rust, verifiees ici avant toute allocation.
  if (d.maille > 0 && (d.repere === 0 || d.repere >= d.maille
                       || d.repere + d.maille > d.cellulesParTuile)) {
    throw new ErreurAmorcage(
      `maillage impossible : pas ${d.maille}, repere ${d.repere}, tuile ${d.cellulesParTuile}`);
  }

  // Coherence d'ensemble, une fois les champs valides separement.
  const parTuile = d.cellulesParTuile + 2 * (d.cadre + d.silence);
  const cellules = parTuile * parTuile * d.tuilesX * d.tuilesY;
  if (cellules > CELLULES_MAX) {
    throw new ErreurAmorcage(
      `geometrie demesuree : ${cellules.toLocaleString('fr')} cellules annoncees`);
  }
  // Une page ne peut pas porter plus de symboles qu'elle n'a de BITS.
  //
  // Ce controle comparait des symboles a des cellules, ce qui etait exact tant
  // qu'une cellule valait un bit. A quatre niveaux elle en vaut deux : garder
  // l'ancienne forme rejetterait la moitie des pages valides.
  // EN COULEUR, LA PAGE PORTE TROIS FOIS PLUS DE BITS.
  //
  // Sans ce facteur, ce controle rejetterait les deux tiers des pages couleur
  // valides — il comparerait un flux reparti sur trois canaux a la capacite
  // d'un seul.
  const bits = cellules * d.bitsParCellule * (d.couleur ? 3 : 1);
  if (d.symboles * 8 > bits) {
    throw new ErreurAmorcage(
      `incoherent : ${d.symboles} symboles annonces pour ${bits} bits`);
  }

  // Empreinte courte : identifie la feuille, ne prouve rien. Le SHA-256
  // complet est verifie par le decodeur, apres coup.
  const h = params.get('h');
  if (h !== null && !/^[0-9a-f]{8}$/.test(h)) {
    throw new ErreurAmorcage('empreinte courte malformee');
  }
  d.empreinteCourte = h;
  d.cellulesTotal = cellules;
  return d;
}

/// Reconstruit un fragment a partir d'un descripteur. Sert aux essais et au
/// mode manuel ; c'est aussi la reciproque qui permet de tester la lecture.
export function ecrireFragment(d) {
  const p = NOMS_DE_PROFIL.indexOf(d.profil);
  const c = [`v=2`, `p=${p}`, `tx=${d.tuilesX}`, `ty=${d.tuilesY}`,
             `td=${d.cellulesParTuile}`, `f=${d.cadre}`, `q=${d.silence}`,
             `n=${d.symboles}`, `m=${d.maille ?? 0}`, `r=${d.repere ?? 0}`,
             `g=${d.niveaux ?? 2}`, `c=${d.couleur ? 1 : 0}`];
  if (d.empreinteCourte) c.push(`h=${d.empreinteCourte}`);
  return c.join('&');
}
