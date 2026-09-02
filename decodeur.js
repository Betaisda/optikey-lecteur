// La page camera : viser, mesurer, decoder, remettre.
//
// CE QUE CETTE PAGE FAIT DE PARTICULIER
// -------------------------------------
// Elle ne se contente pas d'essayer de decoder et d'annoncer un echec. Elle
// MESURE, en direct, la seule grandeur qui decide de tout : le nombre de
// pixels par cellule que l'image porte reellement.
//
// Le document 03 l'a etabli a 3,94 px/cellule, et le document 09 l'a retrouve
// par un chemin entierement different. La mesure faite depuis cette page-ci
// precise le tableau : au-dessus de ce seuil la lecture est SYSTEMATIQUE, en
// dessous elle devient une loterie dont la mise depend de la phase
// d'echantillonnage — voir le commentaire de `SEUIL`.
//
// C'est aussi la seule grandeur que la personne qui cadre peut corriger : elle
// se rapproche, ou elle n'y arrive pas. D'ou le parti pris de l'afficher grand
// et en continu, plutot que de la garder pour le message d'erreur.

import { Pdc, versNiveauxDeGris, versRvb } from './pdc.js';
import { lireFragment, ErreurAmorcage } from './amorcage.js';
import { renifler, verifierAccord, preparer, assainirNom, TAILLE_MAX } from './remise.js';

/// Finesse visee par le guidage, en pixels par cellule.
///
/// LE SEUIL A BAISSE PARCE QUE LA GEOMETRIE A CHANGE.
/// --------------------------------------------------
/// La valeur precedente, 3,9, datait de la geometrie par tuile : une seule
/// homographie devait y representer une page qui n'est pas plane, et une part
/// du seuil venait de cette erreur de MODELE, pas de l'echantillonnage.
///
/// Le maillage de synchronisation l'a supprimee. Nouvelle mesure, sur une page
/// de 120 ko photographiee avec perspective, gondolage, flou et bruit :
///
/// ```text
///   2,75 px/cellule : echec total
///   3,00 px/cellule : partiel — 526 blocs sur 768
///   3,10 px/cellule : lu, 12,5 % d'effacements   <- la limite
///   3,50 px/cellule : lu,  2,1 %                 <- confortable
///   4,00 px/cellule : lu,  0,0 %
/// ```
///
/// Le guidage vise 3,5 : la limite est a 3,1, mais y viser reviendrait a
/// depenser les deux tiers du budget de correction avant meme d'avoir
/// rencontre une tache ou un pli.
///
/// Comme avant, le seuil sert a GUIDER et a declencher la capture
/// automatique, jamais a refuser d'essayer : une image en dessous est tentee
/// quand meme.
const SEUIL = 3.5;
/// Finesse visee selon le nombre de niveaux de gris de la page.
///
/// QUATRE NIVEAUX NE COUTENT PRESQUE RIEN EN FINESSE.
/// ---------------------------------------------------
/// On s'attendait au contraire — lire la VALEUR d'une cellule parait plus
/// exigeant que d'en lire le signe — et la premiere mesure le confirmait :
/// 4,8 px par cellule contre 4,2. Le seuillage par recherche de paquets, qui
/// cherche ou sont reellement les teintes au lieu de les supposer regulierement
/// espacees, a ramene les deux presque au meme point.
///
/// Mesure sur dix prises de vue — gondolage 1 a 3 %, perspective 2 a 6 %, flou
/// 0,5 a 1,0 px — avec une reduction qui integre sur la surface du photosite,
/// comme le fait un capteur. Nombre de lectures reussies sur dix :
///
/// ```text
///   px/cellule    2,9   3,0   3,1   3,2   3,3   3,4   3,5
///    2 niveaux      7    10     8    10    10    10    10
///    4 niveaux      -     -     -     4     4     6    10
/// ```
///
/// Le guidage vise au-dessus de ces limites, pour la meme raison qu'a deux
/// niveaux : y viser exactement, c'est depenser tout le budget de correction
/// avant d'avoir rencontre la moindre tache.
function seuilVise(niveaux) {
  if (niveaux >= 8) return 7.0;
  if (niveaux >= 4) return 3.9;
  return SEUIL;
}
/// Marge de confort visee par le guidage : viser le seuil exact, c'est viser
/// l'echec une fois sur deux.
const CONFORT = 5.0;
/// En dessous, une « detection » n'en est pas une.
///
/// Observe : sur une feuille dont un bord sort du cadre, la detection annonce
/// tranquillement six tuiles sur six a **0,74 px par cellule**. Les
/// homographies se sont accrochees a des structures parasites. Une cellule
/// plus etroite qu'un pixel ne se demodule pas ; ce n'est pas une mesure
/// pessimiste, c'est une mesure fausse, et il vaut mieux dire « je ne vois pas
/// la feuille » que d'afficher un chiffre qui n'a pas de sens.
const PX_PLAUSIBLE_MIN = 1.5;
/// Durée pendant laquelle la netteté doit avoir cessé de progresser avant
/// qu'on tire. Six cents millisecondes couvrent trois à six passes de guidage,
/// et l'autofocus d'un téléphone converge en cinq cents à deux mille.
const REPOS_MS = 600;
/// Plafond : passé ce délai de bon cadrage, on tire même si la netteté bouge
/// encore. Attendre indéfiniment un point qui ne se fait pas serait pire que
/// tenter une lecture imparfaite — le décodeur a de la redondance pour ça.
const PATIENCE_MS = 2500;
/// Nombre de vues cumulées au-delà duquel on s'arrête pour expliquer.
///
/// SANS PLAFOND, L'ÉCHEC N'EST JAMAIS EXPLIQUÉ.
/// ---------------------------------------------
/// La caméra qui reprend indéfiniment paraît travailler, mais si la page est
/// hors de portée elle ne dira jamais pourquoi — et c'est justement le moment
/// où l'on a besoin du chiffre : combien de pixels par cellule, combien de
/// cellules sûres. Le banc montre que deux ou trois vues suffisent quand elles
/// peuvent suffire ; au-delà de quatre, une de plus n'apporte plus rien.
const VUES_MAX = 4;
/// Fraction du cadre qu'une tuile doit occuper pour qu'on la lise seule.
///
/// C'est tout le geste du mode case par case : remplir le cadre d'UNE case. A
/// cinquante pour cent du plus petit cote, une tuile de cent trente-quatre
/// cellules recoit deja plus de dix pixels par cellule sur un capteur ordinaire
/// — trois fois ce que donne la page entiere.
const PART_TUILE = 0.5;
/// Écart de distance exigé entre deux vues cumulées, en fraction.
///
/// SANS LUI, LE CUMUL NE CUMULAIT RIEN.
/// -------------------------------------
/// Le guidage se redéclenche dès que l'image redevient stable. Après un échec,
/// il reprenait donc une vue quasi identique à la précédente — même distance,
/// même moiré, mêmes cellules fausses — et quatre vues valaient exactement une.
/// Le banc le dit sans détour : empiler des copies n'apporte rien.
///
/// Le cumul ne paie que si la grille de pixels retombe AILLEURS sur les
/// cellules, ce qui demande de changer de distance. Huit pour cent suffisent :
/// à six pixels par cellule, cela déplace l'échantillonnage d'un demi-pixel.
const ECART_VUES = 0.08;
/// Au-dela, l'analyse du guidage travaille sur une image reduite. Le resultat
/// est remis a l'echelle : la finesse est proportionnelle a la resolution.
const PIXELS_ANALYSE_MAX = 2_500_000;

const $ = (id) => document.getElementById(id);
const vues = [...document.querySelectorAll('.vue')];

function montrer(id) {
  for (const v of vues) v.toggleAttribute('data-actif', v.id === id);
}

function texte(el, s) { el.textContent = s; }

/// Rend la main au navigateur pour qu'il puisse peindre, SANS jamais dependre
/// qu'il le fasse.
///
/// La version precedente attendait deux `requestAnimationFrame`. C'est le
/// procede habituel, et il pose ici un piege : **rAF ne se declenche pas quand
/// le document est masque**. Un telephone qui passe a une autre application, un
/// ecran qui s'eteint, un onglet mis en arriere-plan pendant le calcul, et la
/// page reste figee sur « Décodage… » pour toujours. Verifie : avec
/// `visibilityState === 'hidden'`, la promesse ne se resout jamais.
///
/// La course avec un delai garantit la progression. Le decodage ne doit
/// dependre d'aucun affichage.
function respirer(delai = 32) {
  return Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise((r) => setTimeout(r, delai)),
  ]);
}

function fiche(dl, paires) {
  dl.replaceChildren();
  for (const [cle, valeur] of paires) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    // textContent, jamais innerHTML : rien de ce qui vient d'une feuille ne
    // doit pouvoir devenir du balisage.
    dt.textContent = cle;
    dd.textContent = valeur;
    dl.append(dt, dd);
  }
}

// --- etat ------------------------------------------------------------------

let pdc = null;
let page = null;        // descripteur issu du QR
let flux = null;        // MediaStream
let boucle = null;      // identifiant de la boucle de guidage
let derniereMesure = null;
let bonnesDeSuite = 0;
/// Meilleure part de cellules sûres vue depuis que le cadrage est bon, et
/// l'instant où elle a été atteinte. C'est ainsi qu'on sait que l'objectif a
/// fini de faire son point : la netteté cesse de monter.
let meilleuresSures = 0;
let derniereAmelioration = 0;
let debutBonCadrage = 0;
/// Facteur de reduction et dimensions de la derniere image analysee. Le suivi
/// en a besoin pour replacer les coins sur l'apercu.
let vueCourante = { k: 1, largeur: 0, hauteur: 0 };
/// Vues demodulees de la page courante, en attente d'etre cumulees.
///
/// Nom distinct de `vues`, qui designe les ecrans : deux `vues` au premier
/// niveau se seraient ecrasees, et le lecteur autonome — qui concatene les
/// modules — l'aurait fait silencieusement.
///
/// Vidée dès qu'on change de page ou qu'on recommence : cumuler des vues de
/// deux feuilles differentes ne produirait pas une lecture partielle, mais du
/// bruit presente comme une lecture.
let vuesPage = [];
/// Mode « case par case » : on lit une tuile a la fois, de pres.
let modeTuile = false;
/// Rangs des tuiles deja lues. Une tuile relue ne coute rien — le vote la
/// confirme — mais l'afficher evite de tourner en rond.
let tuilesLues = new Set();
/// Finesse à laquelle la dernière vue cumulée a été prise. Sert à exiger un
/// vrai déplacement avant d'en accepter une autre.
let pxDerniereVue = 0;
/// Finesse visee pour la page courante. Recalculee des que le descripteur est
/// connu, car elle depend du nombre de niveaux de gris qu'il annonce.
let vise = SEUIL;
/// Derniere prise de vue, en PNG. Gardee pour pouvoir la proposer apres un
/// echec de lecture — voir `lire`.
let dernierePrise = null;
/// Evenement d'installation mis de cote par le navigateur, quand il l'offre.
let inviteInstallation = null;

/// Geometrie gravee dans ce fichier, s'il en porte une.
///
/// UN FICHIER QUI EST SON PROPRE LECTEUR.
/// ---------------------------------------
/// Le decodeur ne fait deja transiter aucune donnee : les octets ne quittent
/// pas l'appareil, et le fragment d'adresse n'est jamais envoye au serveur.
/// Restait une derniere dependance, plus discrete : la GEOMETRIE de la page
/// arrivait par ce fragment, donc par une adresse, donc par un serveur.
///
/// `tools/bundler.py --geometrie <fragment>` remplace cette constante par la
/// geometrie d'une page precise. Le fichier produit se double-clique depuis une
/// cle USB, un telephone, un avion, et lit CETTE page sans rien demander a
/// personne. C'est la clef USB optique, prise au mot.
///
/// Vide par defaut : la page servie normalement se comporte comme avant.
const GEOMETRIE_INCLUSE = '';
let urlBlob = null;

/// Cellules le long d'un axe, cadres et zones de silence comprises.
function cellules(d, tuiles) {
  return (d.cellulesParTuile + 2 * (d.cadre + d.silence)) * tuiles;
}
const cellulesLargeur = (d) => cellules(d, d.tuilesX);

// --- chargement ------------------------------------------------------------

async function demarrer() {
  try {
    pdc = await Pdc.charger('./pdc_wasm.wasm');
    texte($('etat-decodeur'), 'décodeur prêt');
  } catch (e) {
    texte($('etat-decodeur'), 'décodeur indisponible');
    echouer('Le décodeur n\'a pas pu être chargé', String(e.message || e));
    return;
  }
  // Le fragment de l'adresse d'abord, la geometrie incluse ensuite. L'ordre
  // compte : un fichier grave pour une page doit quand meme pouvoir en lire
  // une autre si on lui en donne l'adresse.
  amorcer(location.hash || GEOMETRIE_INCLUSE);
}

/// Entre en mode « la feuille se decrira elle-meme ».
///
/// C'EST L'AMORCAGE SANS RIEN.
/// ---------------------------
/// Jusqu'ici cette application refusait de commencer sans geometrie, et l'ecran
/// d'accueil affirmait que celle-ci « ne se devine pas depuis les pixels ».
/// C'etait vrai : elle voyageait dans le QR. Depuis que chaque page porte son
/// en-tete, elle se lit dans l'image, et le QR n'est plus qu'une adresse.
///
/// `page` reste donc nul, et le guidage cherche l'en-tete au lieu de mesurer
/// une grille qu'il ne connait pas encore. Des qu'il le trouve, tout le reste
/// de l'application reprend son cours habituel.
function amorcerSansQr() {
  page = null;
  vuesPage = [];
  pxDerniereVue = 0;
  modeTuile = false;
  tuilesLues = new Set();
  vise = seuilVise(2);
  fiche($('fiche-page'), []);
  texte($('texte-exigence'),
    'Cadrez le bloc de données, pas la feuille entière — ses quatre coins dans '
    + 'le champ, à plat, sans reflet.');
  montrer('vue-pret');
}

/// Amorce depuis un fragment d'adresse, s'il en porte un d'utilisable.
///
/// UNE FEUILLE ANCIENNE PASSE ENCORE PAR ICI.
/// -------------------------------------------
/// Celles d'avant l'en-tete portent leur geometrie dans le fragment de
/// l'adresse. On l'ouvre avec l'appareil photo du telephone, qui lance cette
/// application avec le fragment : c'est le seul chemin qui reste, et il suffit.
/// Le scanner de QR embarque, lui, a ete supprime — il faisait doublon avec
/// l'appareil photo et menait au meme endroit.
///
/// Sans fragment exploitable, on ne montre pas d'erreur : la page saura se
/// decrire elle-meme, et c'est desormais le cas normal.
function amorcer(fragment) {
  try {
    page = lireFragment(fragment);
  } catch (e) {
    if (!(e instanceof ErreurAmorcage)) throw e;
    montrer('vue-amorcage');
    return;
  }
  presenterPage();
}

function presenterPage() {
  decrirePage();
  montrer('vue-pret');
}

/// Remplit la fiche et la finesse visee, SANS changer d'ecran.
///
/// Separe de `presenterPage` le jour ou le guidage a pu decouvrir la geometrie
/// en cours de visee : il faut alors mettre la fiche a jour tout en restant
/// dans le viseur, et non renvoyer l'utilisateur a l'ecran precedent.
function decrirePage() {
  const large = cellulesLargeur(page);
  vise = seuilVise(page.niveaux ?? 2);
  fiche($('fiche-page'), [
    ['Tuiles', `${page.tuilesX} × ${page.tuilesY}`],
    ...(page.niveaux > 2 ? [['Niveaux de gris', String(page.niveaux)]] : []),
    ['Grille', `${large} × ${cellules(page, page.tuilesY)} cellules`],
    ['Redondance', page.profil],
    ['Symboles', page.symboles.toLocaleString('fr')],
    ...(page.empreinteCourte ? [['Empreinte', page.empreinteCourte]] : []),
  ]);
  texte($('texte-exigence'),
    `Le bloc fait ${large} cellules de large. À partir de `
    + `${Math.ceil(large * vise).toLocaleString('fr')} pixels consacrés au bloc — soit `
    + `${vise} px par cellule — la lecture réussit à tous les coups. En dessous elle `
    + `devient une affaire de chance : c'est mesuré, et c'est pour ça que cette page `
    + `affiche la finesse en continu plutôt que de vous laisser deviner.`);
}

// --- camera ----------------------------------------------------------------

async function ouvrirCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    echouer('Pas d\'accès caméra',
      'Ce navigateur n\'expose pas de caméra à la page. Prenez une photo avec '
      + 'l\'application appareil photo, puis donnez-la ici.');
    return;
  }
  try {
    // On demande beaucoup, on prend ce qu'on obtient, et on le DIT : la
    // definition reelle de la piste decide si la lecture est possible.
    flux = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    });
  } catch (e) {
    const refus = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    echouer(refus ? 'Caméra refusée' : 'Caméra indisponible',
      refus
        ? 'L\'accès à la caméra n\'a pas été autorisé. Vous pouvez l\'autoriser dans '
          + 'les réglages du navigateur, ou simplement prendre une photo avec '
          + 'l\'application appareil photo et la donner ici.'
        : `${e.name} — ${e.message}. L'autre voie reste ouverte : une photo déjà prise.`);
    return;
  }

  const video = $('apercu');
  video.srcObject = flux;
  await video.play().catch(() => {});

  const piste = flux.getVideoTracks()[0];
  const r = piste.getSettings();
  // SANS GÉOMÉTRIE, PAS DE PLAFOND À ANNONCER.
  //
  // Ce plafond dit combien de pixels par cellule le flux vidéo peut donner au
  // mieux, bloc plein cadre. Il suppose donc de savoir combien la page a de
  // cellules — ce qu'on ne saura qu'après avoir lu son en-tête.
  const plafond = page ? (r.width || 0) / cellulesLargeur(page) : Infinity;
  texte($('etat-decodeur'), `${r.width}×${r.height}`);

  if (plafond < vise) {
    // Cas honnete et frequent : meme feuille pleine cadre, le flux video n'a
    // pas assez de pixels. Autant le dire tout de suite.
    avertirViseur(
      `Ce flux vidéo plafonne à ${plafond.toFixed(1)} px/cellule, bloc plein cadre — `
      + `il en faudrait ${vise}. Une photo prise avec l'appareil photo ira plus loin.`);
  }

  montrer('vue-visee');
  $('marque-seuil').style.left = `${(vise / (CONFORT * 2)) * 100}%`;
  $('btn-lire').disabled = false;
  lancerGuidage(video);
}

function arreterCamera() {
  if (boucle) { clearTimeout(boucle); boucle = null; }
  if (flux) { for (const p of flux.getTracks()) p.stop(); flux = null; }
  $('apercu').srcObject = null;
  // Le suivi doit s'effacer avec l'aperçu : un cadre qui reste dessiné sur un
  // écran noir affirmerait qu'on voit encore quelque chose.
  oublierMiseAuPoint();
  dessinerSuivi([], 1, 0, 0, false);
}

function avertirViseur(message) {
  const v = $('verdict');
  v.textContent = message;
  $('viseur').dataset.etat = 'perdu';
}

// --- guidage ---------------------------------------------------------------

/// Extrait une image en niveaux de gris depuis une source dessinable.
///
/// La conversion se fait PAR BANDES. Une photo de 50 Mpx donnerait un
/// `ImageData` de 200 Mo d'un seul tenant, ce qu'un telephone refuse ou paie
/// tres cher ; par bandes de deux millions de pixels, le pic reste modeste et
/// le resultat est identique.
/// Luminance d'une image RVB deja extraite, sans repasser par le canvas.
function luminanceDe(rvb, largeur, hauteur) {
  const out = new Uint8Array(largeur * hauteur);
  for (let i = 0, j = 0; j < out.length; i += 3, j++) {
    out[j] = (rvb[i] * 2 + rvb[i + 1] * 5 + rvb[i + 2]) >> 3;
  }
  return out;
}

/// Trois octets par pixel, par bandes, comme `versGris`.
///
/// Le decoupage en bandes n'est pas une elegance : une photo de quarante
/// megapixels demanderait cent soixante megaoctets d'un coup en RVBA, et le
/// navigateur d'un telephone refuse bien avant.
function versRvbBandes(source, largeur, hauteur) {
  const toile = $('toile');
  const ctx = toile.getContext('2d', { willReadFrequently: true });
  toile.width = largeur;
  toile.height = hauteur;
  ctx.drawImage(source, 0, 0, largeur, hauteur);
  const rvb = new Uint8Array(largeur * hauteur * 3);
  const bande = Math.max(1, Math.floor(2_000_000 / largeur));
  for (let y = 0; y < hauteur; y += bande) {
    const h = Math.min(bande, hauteur - y);
    rvb.set(versRvb(ctx.getImageData(0, y, largeur, h)), y * largeur * 3);
  }
  return rvb;
}

function versGris(source, largeur, hauteur) {
  const toile = $('toile');
  const ctx = toile.getContext('2d', { willReadFrequently: true });
  toile.width = largeur;
  toile.height = hauteur;
  ctx.drawImage(source, 0, 0, largeur, hauteur);

  const gris = new Uint8Array(largeur * hauteur);
  const bande = Math.max(1, Math.floor(2_000_000 / largeur));
  for (let y = 0; y < hauteur; y += bande) {
    const h = Math.min(bande, hauteur - y);
    const morceau = versNiveauxDeGris(ctx.getImageData(0, y, largeur, h));
    gris.set(morceau, y * largeur);
  }
  return gris;
}

/// Dimensions d'analyse : au-dela de `PIXELS_ANALYSE_MAX`, on reduit. La
/// finesse mesuree est ensuite remise a l'echelle, ce qui est exact puisque
/// elle est proportionnelle a la resolution.
function echelleAnalyse(largeur, hauteur) {
  const pixels = largeur * hauteur;
  if (pixels <= PIXELS_ANALYSE_MAX) return 1;
  return Math.sqrt(PIXELS_ANALYSE_MAX / pixels);
}

/// Où se trouve la tuile de rang `t`, en toutes lettres.
///
/// On ne demande jamais « approchez-vous de la case 3 » : personne ne sait où
/// est la troisième. On nomme la position, et l'ordre n'a aucune importance
/// puisque chaque tuile dit elle-même laquelle elle est.
function ouEstLaTuile(t, tx, ty) {
  if (tx === 1 && ty === 1) return 'la case';
  const col = t % tx;
  const lig = Math.floor(t / tx);
  const h = tx === 1 ? '' : col === 0 ? 'à gauche' : col === tx - 1 ? 'à droite' : 'au milieu';
  const v = ty === 1 ? '' : lig === 0 ? 'en haut' : lig === ty - 1 ? 'en bas' : 'au centre';
  return [v, h].filter(Boolean).join(' ') || 'la case';
}

/// Les tuiles qu'il reste à photographier, nommées par leur position.
function tuilesManquantes() {
  if (!page) return [];
  const total = page.tuilesX * page.tuilesY;
  const reste = [];
  for (let t = 0; t < total; t++) {
    if (!tuilesLues.has(t)) reste.push(ouEstLaTuile(t, page.tuilesX, page.tuilesY));
  }
  return reste;
}

function lancerGuidage(video) {
  let dernierTemps = 0;
  const tour = () => {
    if (!flux) return;
    const lv = video.videoWidth, lh = video.videoHeight;
    if (lv && lh) {
      const t0 = performance.now();
      const k = echelleAnalyse(lv, lh);
      const w = Math.round(lv * k), h = Math.round(lh * k);

      // MODE CASE PAR CASE : on ne cherche plus la page, mais UNE tuile.
      //
      // La page entière dans le champ, c'est le capteur qui décide : ses pixels
      // se partagent entre les tuiles. Neuf tuiles donnent trois fois moins de
      // pixels par cellule qu'une seule — mesuré sur téléphone : 4,94 px par
      // cellule là où il en faut six.
      //
      // En s'approchant case par case, chaque gros plan retrouve la finesse
      // d'une page d'une seule tuile. On attend simplement qu'une tuile
      // remplisse le cadre, et l'en-tête dit laquelle c'est.
      if (modeTuile) {
        const gris = versGris(video, w, h);
        let taches = [];
        try { taches = pdc.ouvertures(gris, w, h); } catch { taches = []; }
        const grande = taches
          .map((q) => Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]))
          .reduce((a, b) => Math.max(a, b), 0);
        const part = grande / Math.min(w, h);
        dessinerSuivi(taches, k, lv, lh, part >= PART_TUILE);
        dernierTemps = performance.now() - t0;
        const reste = tuilesManquantes();
        if (part >= PART_TUILE) {
          $('viseur').dataset.etat = 'pret';
          texte($('verdict'), 'Ne bougez plus');
          bonnesDeSuite++;
          if (bonnesDeSuite >= 2) lireUneTuile();
        } else {
          bonnesDeSuite = 0;
          $('viseur').dataset.etat = taches.length ? 'ajuster' : 'perdu';
          texte($('verdict'), taches.length
            ? `Approchez : une seule case doit remplir le cadre — reste ${reste.length} `
              + `(${reste.slice(0, 3).join(', ')}${reste.length > 3 ? '…' : ''})`
            : `Cadrez une case — il en reste ${reste.length}`);
        }
        boucle = setTimeout(tour, Math.max(80, dernierTemps));
        return;
      }

      if (!page) {
        // CHERCHER L'EN-TETE SE FAIT A PLEINE DEFINITION, ET C'EST OBLIGATOIRE.
        //
        // Le guidage, lui, peut reduire l'image : il ne mesure qu'une grille,
        // et la finesse se remet a l'echelle. Lire l'en-tete demande au
        // contraire de distinguer des cellules une a une — sur une image
        // reduite de moitie, il n'y a plus assez de pixels par cellule et
        // l'amorcage echouerait a chaque tour sans que rien ne le dise.
        const gris = versGris(video, lv, lh);
        // ON REGARDE AVANT DE CHERCHER, ET C'EST DIX FOIS MOINS CHER.
        //
        // Trouver l'en-tete demande une detection complete par cote de tuile
        // essaye — deux a trois dixiemes de seconde sur un telephone. Reperer
        // les taches claires carrees, lui, coute quinze millisecondes. Quand il
        // n'y en a aucune, il n'y a rien a chercher : la boucle reste vive au
        // lieu de saccader sur une scene vide.
        let taches = [];
        try { taches = pdc.ouvertures(gris, lv, lh); } catch { taches = []; }
        let d = null;
        if (taches.length) {
          try {
            d = pdc.amorcerImage(gris, lv, lh, 1);
          } catch { d = null; }
        }
        dernierTemps = performance.now() - t0;
        if (d) {
          // La geometrie est trouvee : la fiche se remplit, on reste dans le
          // viseur, et le tour suivant repart sur le guidage habituel.
          page = d;
          decrirePage();
          texte($('verdict'), 'Feuille reconnue');
        } else {
          // MONTRER CE QU'ON VOIT, MEME QUAND ON NE SAIT PAS ENCORE QUOI.
          //
          // « Cherche une feuille… » sur un ecran noir ne dit pas si le lecteur
          // regarde la bonne chose. Les taches carrees qu'il a reperees, elles,
          // le disent : si elles entourent les tuiles, il ne manque que la
          // nettete ; si elles entourent autre chose, c'est le cadrage.
          dessinerSuivi(taches, 1, lv, lh, false);
          $('viseur').dataset.etat = taches.length ? 'ajuster' : 'perdu';
          texte($('verdict'), taches.length
            ? `${taches.length} tuile${taches.length > 1 ? 's' : ''} en vue — approchez, `
              + 'que les cellules se distinguent'
            : 'Cherche une feuille…');
        }
        // Chercher coute plus cher que mesurer : on espace davantage.
        boucle = setTimeout(tour, Math.max(200, dernierTemps));
        return;
      }
      let m = null;
      try {
        m = pdc.inspecter(versGris(video, w, h), w, h, page);
      } catch { m = null; }
      dernierTemps = performance.now() - t0;
      if (m) m.pxParCellule /= k;   // remise a l'echelle de la piste complete
      // Le suivi est dessine dans les coordonnees de l'image ANALYSEE : il faut
      // lui donner le facteur de reduction et la taille reelle de la video.
      vueCourante = { k, largeur: lv, hauteur: lh };
      afficherMesure(m, dernierTemps);
    }
    // La cadence s'adapte au cout reel : on ne cherche pas a saturer le
    // processeur d'un telephone qu'on tient a bout de bras.
    boucle = setTimeout(tour, Math.max(60, dernierTemps * 0.6));
  };
  tour();
}

/// Dessine les tuiles reconnues par-dessus l'aperçu.
///
/// TROIS REPÈRES SUCCESSIFS, ET C'EST LE PIÈGE.
/// ---------------------------------------------
/// Les coins arrivent en pixels de l'IMAGE ANALYSÉE, qui est réduite quand la
/// vidéo est grande. La vidéo, elle, est affichée en `object-fit: contain` :
/// elle ne remplit donc pas le viseur, elle y est centrée avec des bandes.
/// Dessiner sans traverser ces deux changements donnerait un cadre plausible
/// mais décalé — l'erreur la plus difficile à voir, parce qu'elle ressemble à
/// une détection imprécise plutôt qu'à un bug d'affichage.
function dessinerSuivi(coins, k, largeurVideo, hauteurVideo, pret) {
  const toile = $('suivi');
  const ctx = toile.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const l = toile.clientWidth, h = toile.clientHeight;
  if (!l || !h) return;
  if (toile.width !== Math.round(l * dpr) || toile.height !== Math.round(h * dpr)) {
    toile.width = Math.round(l * dpr);
    toile.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, l, h);
  if (!coins || !coins.length || !largeurVideo || !hauteurVideo) return;

  // Rectangle réellement occupé par la vidéo dans le viseur (contain).
  const e = Math.min(l / largeurVideo, h / hauteurVideo);
  const dx = (l - largeurVideo * e) / 2;
  const dy = (h - hauteurVideo * e) / 2;
  // `k` a réduit l'image avant l'analyse : on annule cette réduction d'abord.
  const p = (c) => [dx + (c[0] / k) * e, dy + (c[1] / k) * e];

  const teinte = pret
    ? getComputedStyle(document.documentElement).getPropertyValue('--pret').trim()
    : getComputedStyle(document.documentElement).getPropertyValue('--ajuster').trim();
  ctx.lineWidth = 2;
  ctx.strokeStyle = teinte || '#5f5';
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (const q of coins) {
    ctx.beginPath();
    const [x0, y0] = p(q[0]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < 4; i++) {
      const [x, y] = p(q[i]);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

/// Oublie où en était la mise au point. À appeler dès que le cadrage se perd :
/// la netteté d'une image qu'on ne voit plus ne dit plus rien de celle qu'on
/// verra ensuite.
function oublierMiseAuPoint() {
  meilleuresSures = 0;
  derniereAmelioration = 0;
  debutBonCadrage = 0;
}

function afficherMesure(m, ms) {
  const viseur = $('viseur');
  texte($('val-cadence'), ms ? `${(1000 / Math.max(ms, 1)).toFixed(1)}/s` : '—');

  if (!m) {
    derniereMesure = null;
    bonnesDeSuite = 0;
    oublierMiseAuPoint();
    dessinerSuivi([], 1, 0, 0, false);
    viseur.dataset.etat = 'perdu';
    texte($('verdict'), 'Cherche le bloc…');
    texte($('val-finesse'), '—');
    texte($('val-tuiles'), '—');
    texte($('val-contraste'), '—');
    texte($('val-sures'), '—');
    $('barre-finesse').style.width = '0%';
    $('jauge-finesse').removeAttribute('data-suffisant');
    return;
  }

  if (m.pxParCellule < PX_PLAUSIBLE_MIN) {
    // Detection accrochee a autre chose que la feuille — en pratique, un bord
    // qui sort du cadre.
    derniereMesure = null;
    bonnesDeSuite = 0;
    oublierMiseAuPoint();
    dessinerSuivi(m.coins, vueCourante.k, vueCourante.largeur, vueCourante.hauteur, false);
    viseur.dataset.etat = 'ajuster';
    texte($('verdict'), 'Cadrez tout le bloc, ses cadres noirs compris');
    texte($('val-finesse'), '—');
    $('barre-finesse').style.width = '0%';
    $('jauge-finesse').removeAttribute('data-suffisant');
    return;
  }

  derniereMesure = m;
  dessinerSuivi(m.coins, vueCourante.k, vueCourante.largeur, vueCourante.hauteur,
    m.pxParCellule >= vise && m.tuiles === m.tuilesAttendues);
  texte($('val-finesse'), m.pxParCellule.toFixed(2));
  texte($('val-tuiles'), `${m.tuiles}/${m.tuilesAttendues}`);
  texte($('val-contraste'), String(m.contraste));
  texte($('val-sures'), `${(m.cellulesSures * 100).toFixed(0)} %`);

  const part = Math.min(1, m.pxParCellule / (CONFORT * 2));
  $('barre-finesse').style.width = `${part * 100}%`;
  const assez = m.pxParCellule >= vise;
  $('jauge-finesse').toggleAttribute('data-suffisant', assez);

  const completes = m.tuiles === m.tuilesAttendues;
  if (assez && completes) {
    // ON ATTEND QUE LA MISE AU POINT AIT FINI, ET C'EST UNE CORRECTION.
    // ------------------------------------------------------------------
    // Le declenchement ne regardait que la FINESSE et le nombre de tuiles —
    // deux grandeurs purement geometriques. Or une image floue a exactement la
    // meme finesse qu'une image nette : le nombre de pixels par cellule ne
    // depend que de la distance. Le lecteur tirait donc au bout de deux passes,
    // soit environ trois dixiemes de seconde, pendant que l'objectif cherchait
    // encore son point — lequel demande d'une demie a deux secondes.
    //
    // La nettete, elle, se lit dans la PART DE CELLULES SURES : une cellule
    // floue tombe pres de la frontiere de decision et cesse d'etre certaine.
    // C'est la seule mesure de nettete dont on dispose, et on l'ignorait.
    //
    // On n'ajoute AUCUN seuil absolu : on ne saurait pas ou le mettre, et un
    // seuil trop haut empecherait des lectures qui reussissaient. On attend
    // seulement que ce chiffre CESSE DE MONTER. Cela ne peut donc que retarder
    // un tir, jamais l'interdire — et un plafond garantit qu'il part quand meme.
    const t = performance.now();
    if (m.cellulesSures > meilleuresSures + 0.004) {
      meilleuresSures = m.cellulesSures;
      derniereAmelioration = t;
    } else if (m.cellulesSures < meilleuresSures - 0.02) {
      // Nette rechute : on a bouge, ou le point s'est perdu. On repart de la.
      meilleuresSures = m.cellulesSures;
      derniereAmelioration = t;
    }
    if (!debutBonCadrage) debutBonCadrage = t;

    // UNE VUE DE PLUS N'EN EST UNE QUE SI ELLE EST DIFFERENTE.
    //
    // Après un échec, le guidage se redéclenchait dès que l'image redevenait
    // stable — c'est-à-dire aussitôt, si la personne n'a pas bougé. Les quatre
    // vues cumulées étaient alors quatre copies de la même, et le cumul ne
    // cumulait rien : le banc mesure explicitement qu'empiler des copies
    // n'apporte aucune information.
    //
    // On exige donc un vrai déplacement avant d'en accepter une autre. C'est
    // exactement ce que demande l'enregistrement d'une empreinte digitale, et
    // pour la même raison.
    if (pxDerniereVue > 0
        && Math.abs(m.pxParCellule - pxDerniereVue) / pxDerniereVue < ECART_VUES) {
      viseur.dataset.etat = 'ajuster';
      bonnesDeSuite = 0;
      texte($('verdict'),
        `Vue ${vuesPage.length} sur ${VUES_MAX} — approchez ou reculez un peu, `
        + 'sinon la vue suivante serait la même');
      return;
    }

    const repos = t - derniereAmelioration;
    const attente = t - debutBonCadrage;
    if (repos < REPOS_MS && attente < PATIENCE_MS) {
      viseur.dataset.etat = 'ajuster';
      bonnesDeSuite = 0;
      texte($('verdict'),
        `Mise au point… ${(m.cellulesSures * 100).toFixed(0)} % de cellules sûres`);
      return;
    }
    viseur.dataset.etat = 'pret';
    texte($('verdict'), 'Ne bougez plus');
    bonnesDeSuite++;
    // Deux passes de suite : une mesure isolee peut etre un coup de chance
    // entre deux tremblements.
    if (bonnesDeSuite >= 2) lire();
  } else {
    oublierMiseAuPoint();
    bonnesDeSuite = 0;
    viseur.dataset.etat = 'ajuster';
    if (completes) {
      texte($('verdict'), `Rapprochez-vous : ${m.pxParCellule.toFixed(1)} px/cellule, visez ${vise}`);
    } else if (assez) {
      // La finesse est bonne et il manque quand meme des tuiles : ce n'est
      // probablement plus un probleme de cadrage mais une tuile abimee. La
      // lecture reste possible — une tuile absente devient de l'effacement,
      // et la redondance en absorbe une sur six. On le propose au lieu de
      // demander indefiniment de recadrer.
      texte($('verdict'), `${m.tuiles} tuiles sur ${m.tuilesAttendues} lisibles — `
        + `recadrez, ou touchez « Lire maintenant »`);
    } else {
      texte($('verdict'), `${m.tuiles} tuile${m.tuiles > 1 ? 's' : ''} sur `
        + `${m.tuilesAttendues} — cadrez tout le bloc`);
    }
  }
}

// --- lecture ---------------------------------------------------------------

/// Empeche une seconde lecture de demarrer pendant la premiere.
///
/// Meme avec la camera coupee au bon moment, une pression sur « Lire
/// maintenant » pendant un decodage relancerait tout. Un verrou vaut mieux
/// qu'un ordre d'instructions dont il faut se souvenir.
let lectureEnCours = false;

/// Version de l'application, affichee en permanence dans l'en-tete.
///
/// Elle doit rester EGALE au nom de cache du service worker : sans quoi on
/// afficherait une version tout en servant les fichiers d'une autre.
/// `tools/deploiement.py` refuse de livrer si les deux divergent.
const VERSION = 'v15';

async function lire() {
  if (lectureEnCours) return;
  lectureEnCours = true;
  try {
    await lireVraiment();
  } finally {
    lectureEnCours = false;
  }
}

/// Photographie UNE case, l'ajoute aux vues, et tente le décodage.
///
/// La caméra ne s'arrête pas : tant qu'il manque des cases, on continue. C'est
/// l'enregistrement d'empreinte, appliqué à une page — sauf qu'ici l'ordre n'a
/// aucune importance, puisque chaque case dit laquelle elle est.
async function lireUneTuile() {
  if (lectureEnCours) return;
  lectureEnCours = true;
  try {
    const video = $('apercu');
    const largeur = video.videoWidth;
    const hauteur = video.videoHeight;
    if (!largeur || !hauteur) return;
    const brut = versGris(video, largeur, hauteur);
    texte($('verdict'), 'Lecture de la case…');
    await respirer();

    let lu = null;
    try {
      lu = pdc.demodulerTuile(brut, largeur, hauteur, 1);
    } catch { lu = null; }
    if (!lu) {
      bonnesDeSuite = 0;
      texte($('verdict'), 'Case non reconnue — approchez, ou changez d’angle');
      return;
    }
    // La géométrie vient de la case elle-même : la première lue renseigne la
    // page, les suivantes la confirment.
    if (!page) { page = lu.page; decrirePage(); }
    const deja = tuilesLues.has(lu.tuile);
    tuilesLues.add(lu.tuile);
    vuesPage.push(lu.vue);

    let sortie = null;
    try {
      sortie = pdc.fusionnerEtDecoder(vuesPage, lu.symboles, page.profil);
    } catch { sortie = null; }
    if (sortie) {
      arreterCamera();
      presenterResultat(sortie, null);
      return;
    }
    const reste = tuilesManquantes();
    bonnesDeSuite = 0;
    oublierMiseAuPoint();
    texte($('verdict'), reste.length
      ? `${deja ? 'Case déjà lue' : 'Case lue'} — il en reste ${reste.length} : `
        + reste.slice(0, 3).join(', ') + (reste.length > 3 ? '…' : '')
      : 'Toutes les cases lues, mais il manque encore des données — reprenez-en une');
  } finally {
    lectureEnCours = false;
  }
}

/// Entre dans le mode case par case.
function passerEnModeTuile() {
  modeTuile = true;
  tuilesLues = new Set();
  vuesPage = [];
  bonnesDeSuite = 0;
  oublierMiseAuPoint();
  montrer('vue-visee');
  if (!flux) { ouvrirCamera(); return; }
  if (!boucle) lancerGuidage($('apercu'));
}

async function lireVraiment() {
  const video = $('apercu');
  // Les dimensions sont relevees AVANT toute autre chose, et gardees.
  //
  // Ecrire `decoder(gris, video.videoWidth, video.videoHeight)` apres un appel
  // a `arreterCamera()` semble anodin : les arguments sont pourtant evalues
  // APRES l'arret, or arreter la camera remet `srcObject` a null et
  // `videoWidth` a zero. Le decodeur recevait une image de 0 x 0 et repondait
  // « feuille introuvable » — juste apres que le guidage ait affiche
  // « Ne bougez plus » sur une image parfaitement nette a 4,6 px/cellule.
  const largeur = video.videoWidth;
  const hauteur = video.videoHeight;
  if (!largeur || !hauteur) return;
  // La lecture travaille TOUJOURS a pleine definition : le guidage peut se
  // permettre d'approximer, le decodage non.
  // ON EXTRAIT CE QUE LA PAGE DEMANDE, PAS PLUS.
  //
  // Une page couleur a besoin des trois canaux ; une page monochrome n'a que
  // faire d'un tableau trois fois plus gros, qui coute trois fois la memoire
  // sur un telephone tenu a bout de bras.
  const brut = (!page || page.couleur)
    ? versRvbBandes(video, largeur, hauteur)
    : versGris(video, largeur, hauteur);
  // UNE TOILE DE COPIE, PRISE MAINTENANT, LUE PLUS TARD.
  //
  // La photo est gardee pour pouvoir etre proposee apres coup — c'est justement
  // quand la lecture echoue qu'on la veut, pour reessayer ou l'envoyer. Mais sa
  // conversion en PNG est ASYNCHRONE, et la faire ici, avant d'arreter la
  // camera, laissait le guidage tourner pendant l'attente : il redeclenchait
  // `lire`, plusieurs fois, et l'ecran alternait cinq ou six fois entre
  // « Décodage… » et « Fichier récupéré ».
  //
  // On copie donc l'image tout de suite — c'est instantane — et l'on ne
  // convertit qu'apres avoir coupe la camera.
  const toile = document.createElement('canvas');
  toile.width = largeur;
  toile.height = hauteur;
  toile.getContext('2d').drawImage(video, 0, 0, largeur, hauteur);

  // PLUSIEURS VUES, ET LA CAMERA NE S'ARRETE PLUS AU PREMIER ESSAI.
  // ---------------------------------------------------------------
  // Une cellule est mal lue quand la grille de pixels tombe mal sur elle.
  // Changer de distance change LESQUELLES : deux vues qui échouent chacune
  // peuvent se compléter. Mesuré au banc `plusieurs_vues` — dans toute une
  // bande de difficulté, une vue seule échoue six fois sur six pendant que
  // deux vues suffisent, et trois vont plus loin encore.
  //
  // On ne coupe donc la caméra qu'en cas de succès. Tant qu'il en manque, on
  // demande un léger déplacement et l'on recommence, comme le fait
  // l'enregistrement d'une empreinte digitale.
  const suite = await decoder(brut, largeur, hauteur, { garderCamera: true });
  if (suite === 'reussi') {
    arreterCamera();
    dernierePrise = await versPng(toile, largeur, hauteur);
    if ($('opt-garder')?.checked && dernierePrise) telecharger(dernierePrise);
    return;
  }
  // Échec : on garde la photo (c'est justement quand ça rate qu'on la veut),
  // et l'on rend la main au guidage pour une vue de plus.
  dernierePrise = await versPng(toile, largeur, hauteur);
  if ($('opt-garder')?.checked && dernierePrise) telecharger(dernierePrise);
  if (suite === 'encore' && flux) {
    montrer('vue-visee');
    oublierMiseAuPoint();
    bonnesDeSuite = 0;
    if (!boucle) lancerGuidage(video);
  } else {
    arreterCamera();
  }
}

/// Enregistre la prise de vue dans l'appareil, en PNG.
///
/// POURQUOI PNG ET NON JPEG, MALGRE LE POIDS
/// ------------------------------------------
/// Un JPEG serait cinq a dix fois plus petit, et c'est tentant pour une photo.
/// Mais celle-ci n'est pas une photo ordinaire : elle porte un fichier, et
/// l'utilisateur peut vouloir la relire plus tard, ou l'envoyer a quelqu'un
/// qui la relira. Les artefacts d'un JPEG s'ajoutent exactement la ou notre
/// decodeur mesure — sur les bords de cellule — et une image enregistree qui
/// ne se relit plus serait le pire des deux mondes : on croit avoir garde le
/// fichier, et on ne l'a plus.
///
/// Le PNG est sans perte : l'image enregistree se decode exactement comme
/// celle qui vient d'etre lue.
async function enregistrerPhoto(video, largeur, hauteur) {
  const blob = await versPng(video, largeur, hauteur);
  if (blob) telecharger(blob);
}

/// Transforme une source dessinable en PNG, ou rend `null` sans rien casser.
async function versPng(source, largeur, hauteur) {
  try {
    const toile = document.createElement('canvas');
    toile.width = largeur;
    toile.height = hauteur;
    toile.getContext('2d').drawImage(source, 0, 0, largeur, hauteur);
    const blob = await new Promise((r) => toile.toBlob(r, 'image/png'));
    if (!blob) throw new Error('image vide');
    return blob;
  } catch (e) {
    // Une photo non enregistree ne doit JAMAIS empecher la lecture : c'est un
    // service rendu en plus, pas une etape de la chaine.
    console.warn('OptiKey : photo non preparee —', e.message);
    return null;
  }
}

function telecharger(blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `optikey-${t}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // On libere plus tard : revoquer tout de suite annulerait le
    // telechargement sur certains navigateurs, qui lisent l'URL apres le clic.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    console.warn('OptiKey : photo non enregistree —', e.message);
  }
}

async function lireFichier(fichier) {
  montrer('vue-travail');
  texte($('titre-travail'), 'Lecture de l\'image…');
  texte($('detail-travail'), fichier.name);
  try {
    const bitmap = await createImageBitmap(fichier);
    const { width, height } = bitmap;
    // Sans géométrie, on ne peut pas encore convertir les pixels en cellules :
    // c'est justement ce que l'en-tête va nous apprendre.
    texte($('detail-travail'), page
      ? `${width} × ${height} px, soit ${(width / cellulesLargeur(page)).toFixed(2)} px par cellule `
        + 'si le bloc remplit l\'image.'
      : `${width} × ${height} px — la page va se décrire elle-même.`);
    // SANS GEOMETRIE, ON PREND LES TROIS CANAUX.
    //
    // On ignore encore si la page est en couleur — c'est justement l'en-tete
    // qui le dira. Prendre le gris fermerait la porte aux pages couleur ; les
    // trois canaux se ramenent a la luminance en une ligne, l'inverse est
    // impossible.
    const brut = (!page || page.couleur)
      ? versRvbBandes(bitmap, width, height)
      : versGris(bitmap, width, height);
    bitmap.close?.();
    await decoder(brut, width, height);
  } catch (e) {
    echouer('Image illisible', String(e.message || e));
  }
}

/// Lit une image. Rend `'reussi'`, `'encore'` (une vue de plus aiderait) ou
/// `'perdu'` (rien à espérer d'une vue de plus, l'écran d'échec est affiché).
async function decoder(source, largeur, hauteur, { garderCamera = false } = {}) {
  montrer('vue-travail');
  texte($('titre-travail'), 'Décodage…');
  const troisCanaux = !page || page.couleur;
  texte($('detail-travail'),
    `${largeur} × ${hauteur} px${troisCanaux ? ' · trois canaux' : ''}`);
  // Laisse le navigateur peindre s'il le peut, sans jamais l'attendre.
  await respirer();

  // AUCUNE GEOMETRIE : ON LA LIT D'ABORD, PUIS ON REPREND LE CHEMIN NORMAL.
  //
  // UNE SEULE VOIE DE DECODAGE, ET C'EST UNE CORRECTION.
  // ----------------------------------------------------
  // Il y avait ici un appel unique `decoderAuto` qui decrivait ET decodait. Il
  // marchait, mais il sautait le diagnostic : quand la page se decrivait et que
  // les donnees ne passaient pas — le cas exact des pages fines photographiees
  // sur un ecran — l'utilisateur recevait « code -6 » au lieu du nombre de
  // pixels par cellule et de ce qu'il faut faire.
  //
  // Or la geometrie est connue des que l'en-tete est lu. Il n'y a donc aucune
  // raison de se priver du diagnostic : on lit l'en-tete, on renseigne `page`,
  // et tout ce qui suit est le chemin deja eprouve.
  // `source` porte trois canaux tant qu'on ignore si la page est en couleur.
  // Une fois qu'on le sait, on garde ce qu'il faut, et rien de plus.
  let pixels = source;
  if (!page) {
    const luminance = luminanceDe(source, largeur, hauteur);
    let d = null;
    try {
      d = pdc.amorcerImage(luminance, largeur, hauteur, 1);
    } catch { d = null; }
    if (!d) {
      echouer("Aucune feuille reconnue dans l'image",
        "La page n'a pas pu se décrire. Il faut que les quatre coins de chaque "
        + 'tuile soient dans le champ, à plat, sans reflet — et assez de pixels '
        + 'pour distinguer les cellules une à une. Si la feuille est plus ancienne '
        + 'que cette version, ouvrez son QR Code avec l’appareil photo du téléphone.');
      return 'perdu';
    }
    page = d;
    // LA PAGE EST MONOCHROME : ON JETTE LES DEUX AUTRES CANAUX MAINTENANT.
    //
    // Sans cette ligne, `pdc.decoder` recevrait un tableau trois fois trop long
    // et lirait un pixel sur trois — soit une image de travers, sans qu'aucune
    // etape ne s'en apercoive avant l'echec du Reed-Solomon.
    if (!page.couleur) pixels = luminance;
    decrirePage();
    montrer('vue-travail');
    texte($('titre-travail'), 'Décodage…');
    texte($('detail-travail'),
      `${page.tuilesX} × ${page.tuilesY} tuiles, ${page.niveaux} niveaux — `
      + 'lus dans la page elle-même.');
    await respirer();
  }

  // LE DIAGNOSTIC TRAVAILLE TOUJOURS SUR LA LUMINANCE.
  //
  // `inspecter` ne repond qu'a « cette image est-elle exploitable », question
  // qui est geometrique et ne concerne pas les canaux. La detection d'une page
  // couleur se fait d'ailleurs sur la luminance elle aussi.
  const gris = page.couleur ? luminanceDe(pixels, largeur, hauteur) : pixels;
  let mesure = null;
  try {
    mesure = pdc.inspecter(gris, largeur, hauteur, page);
  } catch { /* le diagnostic est un bonus, pas une condition */ }

  // UNE SEULE VOIE, ET ELLE PASSE TOUJOURS PAR LE CUMUL.
  //
  // Avec une seule vue, le cumul rend exactement ce que rendait `pdc.decoder` :
  // les mêmes symboles, les mêmes effacements. Il n'y a donc pas deux chemins
  // à maintenir — juste celui-ci, qui sait en plus additionner les vues.
  const lu = pdc.demoduler(pixels, largeur, hauteur, page, page.couleur ? 3 : 1);
  if (!lu) {
    diagnostiquer(new Error('la grille n’a pas été retrouvée'), mesure);
    return 'perdu';
  }
  vuesPage.push(lu.vue);
  if (mesure) pxDerniereVue = mesure.pxParCellule;

  let sortie = null;
  try {
    sortie = pdc.fusionnerEtDecoder(vuesPage, page.symboles, page.profil);
  } catch { sortie = null; }
  if (sortie) {
    presenterResultat(sortie, mesure);
    return 'reussi';
  }

  // ÉCHEC. Une vue de plus vaut-elle la peine ?
  //
  // Oui tant que la caméra est là et que la page a bien été trouvée : c'est
  // précisément le régime où le cumul paie. Non pour une photo isolée, où il
  // n'y aura pas de vue suivante.
  if (garderCamera && flux && vuesPage.length < VUES_MAX) {
    montrer('vue-visee');
    texte($('verdict'),
      `${vuesPage.length} vue${vuesPage.length > 1 ? 's' : ''} sur ${VUES_MAX}`
      + ' — changez un peu de distance, je réessaie');
    return 'encore';
  }
  const k = vuesPage.length;
  diagnostiquer(
    new Error(`${k} vue${k > 1 ? 's' : ''} cumulée${k > 1 ? 's' : ''}, `
      + `${sortie === null ? 'toujours' : ''} insuffisante${k > 1 ? 's' : ''}`), mesure);
  return 'perdu';
}

/// Distingue « pas assez de pixels » de « image abimee ». Ce sont deux
/// problemes, et ils n'appellent pas le meme geste.
function diagnostiquer(e, mesure) {
  if (!mesure) {
    echouer('Bloc introuvable dans l\'image',
      'Aucune grille n\'a été reconnue. Cadrez le bloc de données — pas la feuille '
      + 'entière — bien à plat, ses quatre cadres noirs entièrement dans le champ, et '
      + 'sans reflet dessus.');
    return;
  }
  if (mesure.pxParCellule < vise) {
    echouer(`Trop peu de pixels : ${mesure.pxParCellule.toFixed(2)} px par cellule`,
      `En dessous de ${vise}, la lecture n'est plus garantie : elle dépend de la façon `
      + 'dont les pixels tombent sur les cellules. Rapprochez-vous, ou prenez la photo '
      + 'avec l\'application appareil photo, qui donne souvent plus de définition que '
      + 'l\'aperçu vidéo. L\'image est peut-être parfaitement nette : ce n\'est pas la '
      + 'netteté qui manque ici, ce sont les pixels.');
    return;
  }
  // ASSEZ DE PIXELS, ET POURTANT ILLISIBLE : DEUX MONDES DIFFERENTS.
  //
  // Le message ne parlait que de papier — abime, plie, reflet. Photographier un
  // ECRAN echoue pour de tout autres raisons, et ce sont les plus frequentes
  // pendant la mise au point :
  //
  //   - la mise a l'echelle de Windows (125 % le plus souvent) et le zoom du
  //     navigateur etirent l'image d'un facteur NON ENTIER : une cellule de
  //     deux pixels devient deux pixels et demi, et les cellules ne recoivent
  //     plus le meme nombre de pixels chacune ;
  //   - le moire entre la grille de l'ecran et celle du capteur ;
  //   - un ecran qui lisse l'image au lieu de l'afficher point pour point.
  //
  // Aucun de ces trois n'est visible a l'œil : l'image parait nette, et la
  // finesse mesuree est bonne. D'ou un message qui envoyait chercher un pli
  // inexistant.
  const sures = (mesure.cellulesSures * 100).toFixed(0);
  // L'ÉCART ENTRE TEINTES, ET POURQUOI IL EST ICI.
  //
  // Sur une page à quatre teintes, les deux gris du milieu peuvent s'être
  // rejoints alors que le contraste reste excellent et la finesse largement
  // suffisante. Aucun chiffre affiché ne bougeait, et le message envoyait
  // chercher un pli inexistant. Celui-ci discrimine : au-dessous d'une
  // vingtaine, la décision n'a plus de marge, et c'est la chaîne optique —
  // courbe de tonalité du téléphone, accentuation, moiré — pas le cadrage.
  const ecart = mesure.ecartTeintes ?? 0;
  const teintes = page && page.niveaux > 2
    ? [`Écart entre teintes voisines : ${ecart.toFixed(0)} niveaux de gris sur 255 `
       + `(${page.niveaux} teintes à séparer). En dessous d'une vingtaine, la `
       + `décision n'a plus de marge — et c'est l'écran ou l'appareil qui les a `
       + `rapprochées, pas votre cadrage.`]
    : [];
  // Apostrophes typographiques et guillemets doubles : aucune sequence
  // d'echappement dans un texte qui en contient a chaque ligne.
  const paragraphes = [
    `La finesse suffisait (${mesure.pxParCellule.toFixed(2)} px par cellule, `
      + `${sures} % de cellules sûres) : le problème n’est pas la définition.`,
    "SI VOUS PHOTOGRAPHIEZ UN ÉCRAN — c’est la cause la plus fréquente pendant "
      + "la mise au point. Mettez le zoom du navigateur à 100 % (Ctrl+0) et "
      + "affichez l’image en taille réelle. Si votre système agrandit tout "
      + "(125 % sous Windows), demandez une image dessinée plus gros : étirée "
      + "d’un facteur non entier, une cellule ne reçoit plus le même nombre de "
      + "pixels partout — et cela ne se voit pas à l’œil.",
    "SI VOUS PHOTOGRAPHIEZ DU PAPIER — le bloc est probablement plié, abîmé, "
      + "ou masqué par un reflet.",
    ...teintes,
    `— ${e.message}`,
  ];
  echouer("Données irrécupérables", paragraphes.join("\n\n"));
}

/// Met en mots deux chiffres qui ne mesurent pas la meme chose.
///
/// `doutes` : symboles que la demodulation n'a pas voulu certifier.
/// `corriges` : symboles que le Reed-Solomon a effectivement changes.
///
/// Le cas interessant est `corriges === 0` avec `doutes > 0` : la prudence
/// n'aura servi a rien, ce qui est une bonne nouvelle et doit se lire comme
/// telle.
function decrireReparations(corriges, doutes) {
  const c = corriges || 0;
  const d = doutes || 0;
  const n = (v) => v.toLocaleString('fr');
  if (c === 0 && d === 0) return 'aucune — la lecture était parfaite';
  if (c === 0) return `${n(d)} symboles jugés douteux, aucun n'était faux`;
  if (d === 0) return `${n(c)} symboles remis en place`;
  return `${n(c)} symboles remis en place · ${n(d)} avaient été signalés douteux`;
}

function presenterResultat(sortie, mesure) {
  const octets = sortie.donnees;
  if (octets.length > TAILLE_MAX) {
    echouer('Fichier trop volumineux',
      `${octets.length.toLocaleString('fr')} octets, au-delà de la limite de `
      + `${(TAILLE_MAX / 1024 / 1024)} Mo que ce décodeur s'impose.`);
    return;
  }

  const type = renifler(octets);
  const nomPropose = assainirNom(sortie.nomDeclare || 'fichier-pdc.bin');

  fiche($('fiche-resultat'), [
    ['Taille', `${octets.length.toLocaleString('fr')} octets`],
    ['Type réel', type.type],
    ['Nom déclaré', sortie.nomDeclare || '— aucun —'],
    ['Empreinte', 'SHA-256 vérifiée'],
    ['Blocs', `${sortie.blocsLus} lus, ${sortie.blocsReconstruits} reconstruits sur ${sortie.blocsTotal}`],
    // DEUX GRANDEURS DIFFERENTES, ET L'ORDRE COMPTAIT.
    //
    // « effacements » compte les symboles que le demodulateur a juges DOUTEUX.
    // « corrigés » compte ceux que le Reed-Solomon a reellement remis en place
    // — et il vaut zero quand les symboles douteux etaient en fait tous justes,
    // car le decodeur s'arrete des que les syndromes sont nuls.
    //
    // La formulation precedente les enchainait par « dont » et donnait
    // « 0 symboles reconstruits, dont 12 101 signalés illisibles » : une
    // contradiction apparente, la ou l'information etait au contraire
    // rassurante — beaucoup de prudence, aucune erreur reelle.
    ['Réparations', decrireReparations(sortie.symbolesCorriges, sortie.effacements)],
    // La marge qui compte est celle du bloc le plus touche : le Reed-Solomon
    // travaille bloc par bloc, et c'est le plus mal loti qui decide.
    ...(sortie.pireBloc
      ? [['Marge', `le bloc le plus touché a utilisé ${sortie.pireBloc} des `
          + `${sortie.budgetParBloc} réparations permises`
          + (sortie.pireBloc > sortie.budgetParBloc * 0.75 ? ' — la marge était mince' : '')]]
      : []),
    ...(mesure ? [['Finesse', `${mesure.pxParCellule.toFixed(2)} px/cellule`]] : []),
    ...(mesure && mesure.tuiles < mesure.tuilesAttendues
      ? [['Tuiles', `${mesure.tuiles} lisibles sur ${mesure.tuilesAttendues}`]]
      : []),
  ]);

  const zone = $('avertissements');
  zone.replaceChildren();

  // Une feuille abimee qui se lit quand meme : le dire vaut mieux que de le
  // taire. La personne saura que cet exemplaire se degrade, et qu'il vaut
  // peut-etre mieux en reimprimer un pendant qu'il est encore lisible.
  if (mesure && mesure.tuiles < mesure.tuilesAttendues) {
    const d = document.createElement('div');
    d.className = 'encart';
    d.dataset.gravite = 'bien';
    const t = document.createElement('span');
    t.className = 'titre';
    t.textContent = 'Feuille abîmée, fichier intact';
    const c = document.createElement('span');
    const abs = mesure.tuilesAttendues - mesure.tuiles;
    c.textContent = `${abs} bloc${abs > 1 ? 's' : ''} sur ${mesure.tuilesAttendues} `
      + `illisible${abs > 1 ? 's' : ''} — la redondance a comblé le trou et l'empreinte `
      + `SHA-256 est vérifiée. Si cet exemplaire compte, refaites-en un pendant qu'il se lit encore.`;
    d.append(t, c);
    zone.append(d);
  }

  const souci = verifierAccord(sortie.nomDeclare, type);
  if (souci) {
    const d = document.createElement('div');
    d.className = 'encart';
    d.dataset.gravite = souci.gravite;
    const t = document.createElement('span');
    t.className = 'titre';
    t.textContent = souci.gravite === 'danger' ? 'Ce fichier est un programme'
                                               : 'Le nom et le contenu ne concordent pas';
    const c = document.createElement('span');
    c.textContent = souci.texte;
    d.append(t, c);
    zone.append(d);
  }

  $('champ-nom').value = nomPropose;
  majLien();
  montrer('vue-resultat');

  function majLien() {
    if (urlBlob) URL.revokeObjectURL(urlBlob);
    const { url, nom } = preparer(octets, assainirNom($('champ-nom').value));
    urlBlob = url;
    const a = $('lien-telecharger');
    a.href = url;
    a.download = nom;
  }
  $('champ-nom').oninput = majLien;
}

function echouer(titre, detail) {
  arreterCamera();
  texte($('titre-echec'), titre);
  texte($('detail-echec'), detail);
  // La photo n'est proposee que s'il y en a une : un fichier choisi dans la
  // galerie est deja sur l'appareil, l'enregistrer une seconde fois n'aurait
  // aucun sens.
  const b = $('btn-garder-echec');
  if (b) b.hidden = !dernierePrise;
  // La lecture case par case n'a de sens que sur une page qui en a plusieurs,
  // et seulement une fois qu'on sait combien.
  const c = $('btn-tuiles');
  if (c) c.hidden = !(page && page.tuilesX * page.tuilesY > 1);
  montrer('vue-echec');
}

// --- installation ----------------------------------------------------------
//
// DEUX PLATEFORMES, DEUX MECANIQUES, ET UNE SEULE QUI PREVIENT.
//
// Android annonce l'installation possible par un evenement, que l'on met de
// cote pour le declencher sur un vrai bouton. iOS n'annonce rien du tout : le
// geste existe — Partager, puis « Sur l'ecran d'accueil » — mais rien dans la
// page ne permet de le provoquer ni meme de savoir s'il est disponible. On s'y
// resout a l'ecrire, ce qui est la seule chose honnete a faire.

/// Vrai si la page tourne deja comme une application installee.
function dejaInstallee() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function estApple() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    // Un iPad recent se declare « Macintosh » : le tactile le trahit.
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function reglerBandeauInstallation() {
  const bandeau = $('bandeau-installer');
  if (!bandeau) return;
  if (dejaInstallee() || sessionStorage.getItem('optikey-installer-plus-tard')) {
    bandeau.hidden = true;
    return;
  }
  if (inviteInstallation) {
    texte($('installer-titre'), "Installer OptiKey sur cet appareil");
    texte($('installer-detail'),
      "Une icône sur l’écran d’accueil, et plus aucun besoin de réseau.");
    $('btn-installer').hidden = false;
    bandeau.hidden = false;
    return;
  }
  if (estApple()) {
    // Aucun bouton : rien ne permet de declencher le geste depuis la page.
    texte($('installer-titre'), "Ajouter OptiKey à l’écran d’accueil");
    texte($('installer-detail'),
      "Bouton Partager, puis « Sur l’écran d’accueil ». Ensuite l’application "
      + "fonctionne sans aucun réseau.");
    $('btn-installer').hidden = true;
    bandeau.hidden = false;
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  // Sans cela, le navigateur affiche sa propre invite, au moment qui lui
  // convient. On la garde pour la declencher sur un bouton explicite.
  e.preventDefault();
  inviteInstallation = e;
  reglerBandeauInstallation();
});

window.addEventListener('appinstalled', () => {
  inviteInstallation = null;
  const b = $('bandeau-installer');
  if (b) b.hidden = true;
});

// --- branchements ----------------------------------------------------------


$('btn-camera').onclick = ouvrirCamera;
$('btn-photo').onclick = () => $('entree-fichier').click();
$('entree-fichier').onchange = (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) lireFichier(f);
};

$('btn-lire').onclick = () => { if (boucle) clearTimeout(boucle); boucle = null; lire(); };
$('btn-arreter').onclick = () => { arreterCamera(); montrer('vue-pret'); };
// INSTALLATION HORS LIGNE, QUAND LE CONTEXTE LE PERMET.
//
// `serviceWorker` n'existe que dans un contexte securise : HTTPS, ou
// `localhost`. Servie en clair sur une adresse du reseau local, la page
// fonctionne exactement comme avant — elle n'est simplement pas installable, et
// la camera en direct n'y est pas disponible non plus. Les deux limitations ont
// la meme cause, et ce n'est pas un defaut de notre code.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      // Un echec d'installation ne doit RIEN casser : on le note et on continue.
      console.warn("OptiKey : installation hors ligne indisponible —", e.message);
    });
  });
}

texte($('version-appli'), VERSION);
$('btn-scanner-document').onclick = amorcerSansQr;
$('btn-tuiles').onclick = passerEnModeTuile;

$('btn-installer').onclick = async () => {
  if (!inviteInstallation) return;
  inviteInstallation.prompt();
  await inviteInstallation.userChoice;
  // L'invite ne se rejoue pas : le navigateur n'en emet qu'une par visite.
  inviteInstallation = null;
  $('bandeau-installer').hidden = true;
};
$('btn-installer-plus-tard').onclick = () => {
  // Le refus vaut pour cette visite seulement, pas pour toujours : une
  // preference definitive se regretterait le jour ou l'on veut installer.
  sessionStorage.setItem('optikey-installer-plus-tard', '1');
  $('bandeau-installer').hidden = true;
};
$('btn-garder-echec').onclick = () => {
  if (dernierePrise) telecharger(dernierePrise);
};
reglerBandeauInstallation();

$('btn-recommencer').onclick = () => { bonnesDeSuite = 0; vuesPage = []; pxDerniereVue = 0; modeTuile = false; tuilesLues = new Set(); montrer('vue-pret'); };
$('btn-reessayer').onclick = () => { bonnesDeSuite = 0; vuesPage = []; pxDerniereVue = 0; modeTuile = false; tuilesLues = new Set(); montrer('vue-pret'); };

window.addEventListener('hashchange', () => amorcer(location.hash));
window.addEventListener('pagehide', arreterCamera);

demarrer();
