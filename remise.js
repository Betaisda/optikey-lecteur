// Remise du fichier a la personne, sous conditions.
//
// LE PRINCIPE, ET IL N'EST PAS NEGOCIABLE
// ---------------------------------------
// Une feuille de papier vient de dicter des octets et un nom de fichier a un
// navigateur. Le §12 du cahier des charges ferme toutes les portes que cela
// ouvre : ne jamais executer le contenu, ne jamais l'interpreter comme du
// code, verifier le type reel, ne pas ecrire n'importe ou, ne rien lancer
// automatiquement, demander confirmation avant toute ouverture.
//
// Concretement, ici :
//   - les octets ne sont JAMAIS evalues, injectes dans le DOM, ni ouverts ;
//   - le Blob porte toujours `application/octet-stream`, jamais le type
//     devine. Servir `text/html` a un navigateur, c'est lui demander de
//     l'executer ; c'est exactement ce qu'on refuse ;
//   - le nom declare par la page est affiche comme une SUGGESTION, deja
//     assaini cote Rust, et la personne peut le changer ;
//   - le type reel est renifle dans les octets et compare a l'extension
//     annoncee. Un desaccord est signale fort.

/// Plafond de taille. Le §12 demande une limite ; la voici, explicite.
export const TAILLE_MAX = 16 * 1024 * 1024;

/// Signatures de fichiers, lues dans les octets et non dans le nom.
/// `decale` permet les formats dont la marque n'est pas au tout debut.
const SIGNATURES = [
  { octets: [0x89, 0x50, 0x4e, 0x47], type: 'PNG', ext: ['png'] },
  { octets: [0xff, 0xd8, 0xff], type: 'JPEG', ext: ['jpg', 'jpeg'] },
  { octets: [0x47, 0x49, 0x46, 0x38], type: 'GIF', ext: ['gif'] },
  { octets: [0x25, 0x50, 0x44, 0x46], type: 'PDF', ext: ['pdf'] },
  { octets: [0x50, 0x4b, 0x03, 0x04], type: 'ZIP (ou docx, xlsx, odt…)', ext: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'epub', 'jar', 'apk'] },
  { octets: [0x1f, 0x8b], type: 'gzip', ext: ['gz', 'tgz'] },
  { octets: [0x37, 0x7a, 0xbc, 0xaf], type: '7-Zip', ext: ['7z'] },
  { octets: [0x52, 0x61, 0x72, 0x21], type: 'RAR', ext: ['rar'] },
  { octets: [0x4f, 0x67, 0x67, 0x53], type: 'Ogg', ext: ['ogg', 'oga', 'ogv', 'opus'] },
  { octets: [0x66, 0x74, 0x79, 0x70], decale: 4, type: 'MP4 / MOV', ext: ['mp4', 'm4a', 'mov', 'm4v'] },
  { octets: [0x52, 0x49, 0x46, 0x46], type: 'RIFF (wav, avi…)', ext: ['wav', 'avi', 'webp'] },
  { octets: [0x49, 0x44, 0x33], type: 'MP3', ext: ['mp3'] },
  { octets: [0x00, 0x01, 0x00, 0x00], type: 'police TrueType', ext: ['ttf'] },
];

/// Signatures d'EXECUTABLES. Elles ne sont pas la pour reconnaitre un format
/// utile mais pour pouvoir le dire tres fort. Rien n'est jamais lance ici —
/// le protocole est de donnees, point — mais quelqu'un a qui l'on remet un
/// fichier a le droit de savoir qu'il vient de recevoir un programme.
const EXECUTABLES = [
  { octets: [0x4d, 0x5a], type: 'executable Windows (PE)' },
  { octets: [0x7f, 0x45, 0x4c, 0x46], type: 'executable Linux (ELF)' },
  { octets: [0xcf, 0xfa, 0xed, 0xfe], type: 'executable macOS (Mach-O)' },
  { octets: [0xca, 0xfe, 0xba, 0xbe], type: 'binaire Java ou Mach-O universel' },
  { octets: [0x23, 0x21], type: 'script a interpreteur (#!)' },
];

function commencePar(octets, sig, decale = 0) {
  if (octets.length < decale + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (octets[decale + i] !== sig[i]) return false;
  return true;
}

function ressembleADuTexte(octets) {
  const n = Math.min(octets.length, 4096);
  if (n === 0) return false;
  let imprimables = 0;
  for (let i = 0; i < n; i++) {
    const c = octets[i];
    if (c === 0) return false; // un octet nul exclut le texte
    if (c >= 0x20 || c === 9 || c === 10 || c === 13) imprimables++;
  }
  return imprimables / n > 0.95;
}

/// Reconnait le type REEL a partir des octets. Ne consulte jamais le nom.
export function renifler(octets) {
  for (const e of EXECUTABLES) {
    if (commencePar(octets, e.octets)) {
      return { type: e.type, executable: true, ext: [] };
    }
  }
  for (const s of SIGNATURES) {
    if (commencePar(octets, s.octets, s.decale ?? 0)) {
      return { type: s.type, executable: false, ext: s.ext };
    }
  }
  if (ressembleADuTexte(octets)) {
    return { type: 'texte', executable: false, ext: ['txt', 'md', 'csv', 'json', 'xml', 'html', 'svg', 'js', 'rs', 'py'] };
  }
  return { type: 'inconnu (donnees binaires)', executable: false, ext: [] };
}

/// Compare le type reniflé au nom declare par la page. Rend un avertissement,
/// ou `null` si rien ne cloche.
///
/// Le cas qui justifie ce controle : une page qui annonce « facture.pdf » et
/// livre un executable. Le nom est ce que quelqu'un a ECRIT ; les octets sont
/// ce qu'ils SONT.
export function verifierAccord(nomDeclare, renifle) {
  if (renifle.executable) {
    return {
      gravite: 'danger',
      texte: `Ces octets forment un ${renifle.type}. Ce decodeur ne lance jamais rien, `
           + `et vous ne devriez pas l'ouvrir sans savoir d'ou vient cette feuille.`,
    };
  }
  if (!nomDeclare) return null;
  const point = nomDeclare.lastIndexOf('.');
  if (point <= 0 || point === nomDeclare.length - 1) return null;
  const ext = nomDeclare.slice(point + 1).toLowerCase();
  if (renifle.ext.length === 0) return null;
  if (renifle.ext.includes(ext)) return null;
  return {
    gravite: 'attention',
    texte: `Le nom annonce « .${ext} » mais les octets sont du ${renifle.type}. `
         + `Le nom vient de la feuille, le type vient du contenu ; c'est le contenu qui dit vrai.`,
  };
}

/// Prepare le telechargement. Rend une URL de blob et le nom retenu.
///
/// Le type MIME est TOUJOURS `application/octet-stream`, quel que soit le type
/// reniflé. Annoncer `text/html` reviendrait a demander au navigateur
/// d'executer ce que la feuille contient ; le reniflage sert a INFORMER, pas
/// a decider comment servir.
export function preparer(octets, nom) {
  const blob = new Blob([octets], { type: 'application/octet-stream' });
  return { url: URL.createObjectURL(blob), nom: nom || 'fichier-pdc.bin' };
}

/// Assainissement cote navigateur, en plus de celui deja fait cote Rust : le
/// nom peut aussi avoir ete tape a la main dans le champ.
///
/// Ecrit en POINTS DE CODE et non en classes de caracteres. Une regle contre
/// les caracteres invisibles ne peut pas etre faite de caracteres invisibles :
/// personne ne saurait la relire, et c'est exactement dans ce genre de ligne
/// qu'une erreur passe inapercue. La structure suit celle de
/// `Manifest::safe_filename`, cote Rust, pour que les deux se comparent.
const INTERDITS = new Set(['/', '\\', ':', '<', '>', '"', '|', '?', '*']);

/// Marques bidirectionnelles : le tour de passe-passe qui fait lire
/// « facture.pdf » a un fichier nomme « fdp.exe ».
const BIDI = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,   // LRE RLE PDF LRO RLO
  0x2066, 0x2067, 0x2068, 0x2069,           // LRI RLI FSI PDI
  0x200e, 0x200f, 0x061c,                   // LRM RLM ALM
]);

export function assainirNom(nom) {
  let s = '';
  for (const c of String(nom || '')) {
    const p = c.codePointAt(0);
    const dangereux = p < 0x20 || p === 0x7f || INTERDITS.has(c) || BIDI.has(p);
    s += dangereux ? '_' : c;
  }
  // Un nom qui ne serait que des points remonterait l'arborescence.
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 120) s = s.slice(0, 120);
  return s || 'fichier-pdc.bin';
}
