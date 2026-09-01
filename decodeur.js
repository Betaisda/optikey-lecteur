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

import { Pdc, versNiveauxDeGris } from './pdc.js';
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
    texte($('etat-decodeur'), 'décodeur prêt · 100 Ko');
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

function amorcer(fragment) {
  try {
    page = lireFragment(fragment);
    retenirFeuille(fragment);
  } catch (e) {
    if (!(e instanceof ErreurAmorcage)) throw e;
    texte($('erreur-amorcage'), fragment && fragment.length > 1 ? e.message : '');
    montrer('vue-amorcage');
    return;
  }
  presenterPage();
}

function presenterPage() {
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
  montrer('vue-pret');
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
  const plafond = (r.width || 0) / cellulesLargeur(page);
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

function lancerGuidage(video) {
  let dernierTemps = 0;
  const tour = () => {
    if (!flux) return;
    const lv = video.videoWidth, lh = video.videoHeight;
    if (lv && lh) {
      const t0 = performance.now();
      const k = echelleAnalyse(lv, lh);
      const w = Math.round(lv * k), h = Math.round(lh * k);
      let m = null;
      try {
        m = pdc.inspecter(versGris(video, w, h), w, h, page);
      } catch { m = null; }
      dernierTemps = performance.now() - t0;
      if (m) m.pxParCellule /= k;   // remise a l'echelle de la piste complete
      afficherMesure(m, dernierTemps);
    }
    // La cadence s'adapte au cout reel : on ne cherche pas a saturer le
    // processeur d'un telephone qu'on tient a bout de bras.
    boucle = setTimeout(tour, Math.max(60, dernierTemps * 0.6));
  };
  tour();
}

function afficherMesure(m, ms) {
  const viseur = $('viseur');
  texte($('val-cadence'), ms ? `${(1000 / Math.max(ms, 1)).toFixed(1)}/s` : '—');

  if (!m) {
    derniereMesure = null;
    bonnesDeSuite = 0;
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
    viseur.dataset.etat = 'ajuster';
    texte($('verdict'), 'Cadrez tout le bloc, ses cadres noirs compris');
    texte($('val-finesse'), '—');
    $('barre-finesse').style.width = '0%';
    $('jauge-finesse').removeAttribute('data-suffisant');
    return;
  }

  derniereMesure = m;
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
    viseur.dataset.etat = 'pret';
    texte($('verdict'), 'Ne bougez plus');
    bonnesDeSuite++;
    // Deux passes de suite : une mesure isolee peut etre un coup de chance
    // entre deux tremblements.
    if (bonnesDeSuite >= 2) lire();
  } else {
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

async function lire() {
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
  const gris = versGris(video, largeur, hauteur);
  // La photo est enregistree AVANT le decodage, pas apres.
  //
  // Une lecture qui echoue ne doit pas emporter l'image avec elle : c'est
  // justement quand ca rate qu'on veut pouvoir reessayer, ou l'envoyer a
  // quelqu'un. L'ordre compte donc, et il n'est pas neutre.
  // LA PRISE DE VUE EST TOUJOURS GARDEE EN MEMOIRE, MEME SANS L'OPTION.
  //
  // L'option decide de l'ENREGISTREMENT immediat ; la garder sous la main coute
  // quelques megaoctets et permet de la proposer apres coup si la lecture
  // echoue. C'est justement dans ce cas qu'on la veut.
  dernierePrise = await versPng(video, largeur, hauteur);
  if ($('opt-garder')?.checked && dernierePrise) {
    telecharger(dernierePrise);
  }
  arreterCamera();
  await decoder(gris, largeur, hauteur);
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
    texte($('detail-travail'),
      `${width} × ${height} px, soit ${(width / cellulesLargeur(page)).toFixed(2)} px par cellule `
      + 'si le bloc remplit l\'image.');
    const gris = versGris(bitmap, width, height);
    bitmap.close?.();
    await decoder(gris, width, height);
  } catch (e) {
    echouer('Image illisible', String(e.message || e));
  }
}

async function decoder(gris, largeur, hauteur) {
  montrer('vue-travail');
  texte($('titre-travail'), 'Décodage…');
  texte($('detail-travail'), `${largeur} × ${hauteur} px`);
  // Laisse le navigateur peindre s'il le peut, sans jamais l'attendre.
  await respirer();

  let mesure = null;
  try {
    mesure = pdc.inspecter(gris, largeur, hauteur, page);
  } catch { /* le diagnostic est un bonus, pas une condition */ }

  let sortie;
  try {
    sortie = pdc.decoder(gris, largeur, hauteur, page);
  } catch (e) {
    diagnostiquer(e, mesure);
    return;
  }
  presenterResultat(sortie, mesure);
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
  montrer('vue-echec');
}

// --- amorcage depuis l'application elle-meme -------------------------------
//
// OUVERTE DEPUIS SON ICONE, L'APPLICATION N'AVAIT AUCUNE ISSUE.
//
// Elle affichait « il manque l amorcage » et demandait de scanner un QR — sans
// offrir le moindre moyen de le faire. Le parcours prevu etait : scanner avec
// l appareil photo du systeme, qui ouvre l application avec la geometrie dans
// l adresse. Cela marche sur Android, ou une application installee capte les
// adresses de son domaine. Sur iOS, l appareil photo ouvre Safari et non
// l application : le parcours n existait donc pas du tout.
//
// Deux issues sont ajoutees ici, et une troisieme reste a construire.

const MEMOIRE_DERNIERE = 'optikey-derniere-feuille';

/// Range la geometrie qui vient d etre lue, pour la reproposer plus tard.
function retenirFeuille(fragment) {
  try {
    localStorage.setItem(MEMOIRE_DERNIERE, fragment.replace(/^#/, ''));
  } catch { /* stockage refuse : on s en passe, ce n est qu un raccourci */ }
}

function proposerDerniereFeuille() {
  let frag = null;
  try { frag = localStorage.getItem(MEMOIRE_DERNIERE); } catch { /* ignore */ }
  if (!frag) return;
  let d;
  try { d = lireFragment(frag); } catch { return; }
  const e = $('encart-derniere');
  if (!e) return;
  texte($('detail-derniere'),
    `${d.tuilesX} × ${d.tuilesY} tuiles, ${d.niveaux} niveaux, `
    + `${d.symboles.toLocaleString('fr')} symboles.`);
  e.hidden = false;
  $('btn-derniere').onclick = () => amorcer(frag);
}

/// Le scan du QR, avec NOTRE decodeur.
///
/// La premiere version utilisait `BarcodeDetector`, l API du navigateur. Elle
/// n existe que sur les moteurs Chromium : aucun iPhone n en dispose, et le
/// bouton devait donc etre cache sur la moitie des appareils. C etait aussi la
/// seule chose, dans tout le projet, que nous ne controlions pas.
///
/// `pdc.lireQr` est le decodeur du cœur, en WebAssembly : le meme code partout.
let fluxQr = null;
let boucleQr = null;

async function ouvrirScanQr() {
  try {
    fluxQr = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
    });
  } catch (e) {
    texte($('erreur-amorcage'), `Caméra indisponible : ${e.message}`);
    return;
  }
  const v = $('apercu-qr');
  v.srcObject = fluxQr;
  await v.play().catch(() => {});
  $('scan-qr').hidden = false;
  boucleQr = setInterval(() => {
    if (!fluxQr || !v.videoWidth) return;
    // On lit sur une image reduite : un QR s y trouve tres bien, et le
    // balayage coute alors quelques millisecondes par image.
    const l = Math.min(640, v.videoWidth);
    const h = Math.round((v.videoHeight * l) / v.videoWidth);
    const octets = pdc.lireQr(versNiveauxDeGris(v, l, h), l, h);
    if (!octets) return;
    appliquerQr(new TextDecoder().decode(octets));
  }, 200);
}

function fermerScanQr() {
  if (boucleQr) clearInterval(boucleQr);
  boucleQr = null;
  if (fluxQr) fluxQr.getTracks().forEach((t) => t.stop());
  fluxQr = null;
  const v = $('apercu-qr');
  if (v) v.srcObject = null;
  const z = $('scan-qr');
  if (z) z.hidden = true;
}

/// N EXTRAIT QUE LE FRAGMENT, ET JAMAIS L ADRESSE.
///
/// Un QR est une entree quelconque : n importe qui peut en imprimer un. Suivre
/// l adresse qu il contient reviendrait a laisser un bout de papier decider ou
/// va le navigateur. On ne garde donc que ce qui suit le diese, et `lireFragment`
/// le valide champ par champ avant qu il ne serve a quoi que ce soit.
function appliquerQr(valeur) {
  const i = String(valeur || '').indexOf('#');
  if (i < 0) return false;
  const frag = valeur.slice(i + 1);
  try {
    lireFragment(frag);
  } catch {
    texte($('verdict-qr'), 'QR reconnu, mais ce n’est pas un OptiKey');
    return false;
  }
  fermerScanQr();
  amorcer(frag);
  return true;
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

$('btn-amorcer').onclick = () => {
  const brut = $('champ-url').value.trim();
  const diese = brut.indexOf('#');
  amorcer(diese >= 0 ? brut.slice(diese) : brut);
};
$('champ-url').onkeydown = (e) => { if (e.key === 'Enter') $('btn-amorcer').click(); };

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

$('btn-scanner').onclick = ouvrirScanQr;
$('btn-scan-arreter').onclick = fermerScanQr;
proposerDerniereFeuille();
// Le scan marche partout : c est notre decodeur, pas celui du navigateur.
$('actions-scan').hidden = false;
texte($('detail-scan-manuel'),
  "Ou avec l’appareil photo du téléphone, qui ouvrira cette page "
  + "avec la géométrie dans l’adresse.");

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

$('btn-recommencer').onclick = () => { bonnesDeSuite = 0; montrer('vue-pret'); };
$('btn-reessayer').onclick = () => { bonnesDeSuite = 0; montrer(page ? 'vue-pret' : 'vue-amorcage'); };

window.addEventListener('hashchange', () => amorcer(location.hash));
window.addEventListener('pagehide', arreterCamera);

demarrer();
