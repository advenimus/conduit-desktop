// Password generation utilities - pure functions, no React dependencies

export type GeneratorMode = "default" | "passphrase" | "pronounceable";

export interface DefaultModeSettings {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  special: boolean;
  excludeSimilar: boolean;
  excludeAmbiguous: boolean;
}

export interface PassphraseModeSettings {
  wordCount: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export interface GeneratorSettings {
  mode: GeneratorMode;
  default: DefaultModeSettings;
  passphrase: PassphraseModeSettings;
  pronounceable: { length: number };
}

export interface StrengthResult {
  score: number; // 0-4
  label: string;
  color: string;
  percent: number;
}

const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const NUMBERS = "0123456789";
const SPECIAL = "!@#$%^&*()-_=+[]{}|;:,.<>?";
const SIMILAR = "il1oO0";
const AMBIGUOUS = "{}[]()/\\'\"`~,;:.<>";

function cryptoRandom(max: number): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

function fisherYatesShuffle(arr: string[]): string[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = cryptoRandom(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function filterChars(pool: string, excludeSimilar: boolean, excludeAmbiguous: boolean): string {
  let result = pool;
  if (excludeSimilar) {
    result = result.split("").filter((c) => !SIMILAR.includes(c)).join("");
  }
  if (excludeAmbiguous) {
    result = result.split("").filter((c) => !AMBIGUOUS.includes(c)).join("");
  }
  return result;
}

export function generateDefaultPassword(opts: DefaultModeSettings): string {
  let pool = "";
  const guaranteed: string[] = [];

  if (opts.uppercase) {
    const chars = filterChars(UPPERCASE, opts.excludeSimilar, opts.excludeAmbiguous);
    pool += chars;
    if (chars.length) guaranteed.push(chars[cryptoRandom(chars.length)]);
  }
  if (opts.lowercase) {
    const chars = filterChars(LOWERCASE, opts.excludeSimilar, opts.excludeAmbiguous);
    pool += chars;
    if (chars.length) guaranteed.push(chars[cryptoRandom(chars.length)]);
  }
  if (opts.numbers) {
    const chars = filterChars(NUMBERS, opts.excludeSimilar, opts.excludeAmbiguous);
    pool += chars;
    if (chars.length) guaranteed.push(chars[cryptoRandom(chars.length)]);
  }
  if (opts.special) {
    const chars = filterChars(SPECIAL, opts.excludeSimilar, opts.excludeAmbiguous);
    pool += chars;
    if (chars.length) guaranteed.push(chars[cryptoRandom(chars.length)]);
  }

  if (!pool) pool = LOWERCASE + NUMBERS;

  const length = Math.max(opts.length, guaranteed.length);
  const remaining = length - guaranteed.length;
  const chars = [...guaranteed];

  for (let i = 0; i < remaining; i++) {
    chars.push(pool[cryptoRandom(pool.length)]);
  }

  return fisherYatesShuffle(chars).join("");
}

// EFF short word list (1296 words for 5-dice rolls)
// Trimmed to a representative set for passphrase generation
const WORD_LIST = [
  "acid","acorn","acre","acts","afar","aging","agony","ahead","aide","aim",
  "ajar","alarm","alias","alibi","alien","align","alley","allot","allow","aloe",
  "alone","amaze","ample","amuse","angel","anger","angle","ankle","annex","anvil",
  "apart","apex","apple","april","apron","aqua","arena","argue","armor","army",
  "aroma","array","arrow","arson","art","ash","asset","atlas","atom","attic",
  "audio","audit","avert","avoid","awake","award","awe","axis","bacon","badge",
  "bagel","baker","balm","bamboo","banjo","barge","barn","bash","basin","batch",
  "beach","bead","beard","beast","begin","bell","below","bench","berry","bible",
  "bike","bind","birch","birth","black","blade","blame","blank","blast","blaze",
  "bleak","blend","bless","blimp","blind","bliss","block","blot","blown","blue",
  "bluff","blunt","blur","blush","board","boast","body","bogey","boil","bold",
  "bolt","bond","bonus","book","booth","boots","boss","botch","bound","boxer",
  "brace","brain","brand","brave","bravo","bread","break","breed","brick","bride",
  "brief","bring","brisk","broad","broil","broke","brook","broom","broth","brush",
  "buck","buddy","budge","buggy","build","bulge","bulk","bunny","burn","burst",
  "cabin","cable","camel","candy","canon","cape","cargo","carol","carry","carve",
  "catch","cause","cedar","chain","chair","chalk","champ","chaos","charm","chart",
  "chase","cheap","check","cheek","cheer","chess","chest","chew","chief","child",
  "chill","china","chip","choir","chop","chunk","churn","cider","cigar","city",
  "civil","claim","clamp","clap","clash","clasp","class","claw","clay","clean",
  "clear","clerk","click","cliff","climb","cling","clip","cloak","clock","clone",
  "close","cloth","cloud","clown","club","cluck","clue","clump","coach","coast",
  "cobra","cocoa","coil","comet","comic","comma","conch","coral","cork","couch",
  "court","cover","craft","crane","crash","crate","crawl","crazy","creek","creep",
  "crest","crisp","cross","crowd","crown","crude","crush","cubic","cupid","curl",
  "curry","curve","cycle","dab","daily","dairy","dance","dare","dark","dart",
  "dash","data","dawn","deal","dear","death","debug","decal","decay","decoy",
  "decor","decoy","delta","demo","denim","dense","depth","derby","desk","dial",
  "diary","digit","dill","dimly","diner","disco","dish","dock","dodge","doing",
  "donor","doom","door","dose","dove","draft","drain","drama","drank","drape",
  "draw","dream","dress","drift","drill","drink","drive","drone","drool","drop",
  "drove","drum","dry","dual","duck","dug","dump","dune","dusk","dust",
  "dwarf","dwell","eagle","early","earth","easel","east","eaten","eaves","ebony",
  "echo","edge","eels","eight","elder","elect","elfin","elite","elm","elves",
  "ember","emit","empty","ended","enemy","enjoy","enter","envoy","equal","equip",
  "erase","error","erupt","essay","evade","event","every","exact","exile","exist",
  "extra","fable","faced","fact","faded","fake","fall","fancy","fang","far",
  "fatal","fault","feast","feat","fence","ferry","fetch","fever","fiber","field",
  "fifth","fifty","fight","final","finch","fire","first","fist","five","fixed",
  "flag","flame","flash","flask","fleet","flesh","flick","fling","flint","flip",
  "flock","flood","floor","flora","flour","flown","fluid","fluke","flush","flute",
  "foam","focal","focus","foggy","foil","folk","font","force","forge","fork",
  "form","forth","forum","fossil","found","fox","foyer","frame","frank","fraud",
  "freak","freed","fresh","front","frost","froze","fruit","fuel","fully","fungi",
  "fury","fuse","fussy","gain","gala","game","gamma","gap","gash","gauge",
  "gave","gaze","gear","gecko","geek","gem","genre","ghost","giant","gift",
  "gills","given","gizmo","glad","glare","glass","gleam","glide","glimpse","globe",
  "gloom","glory","gloss","glove","glow","glue","gnome","goal","goat","going",
  "gold","golf","gone","gopher","gouge","gown","grab","grace","grade","grain",
  "grand","grant","grape","graph","grasp","grass","grave","gravy","gray","green",
  "greet","grief","grill","grin","grind","grip","groan","groom","gross","group",
  "grove","growl","grown","grub","guard","guess","guide","guild","guilt","guise",
  "gulch","gulf","gummy","guru","gust","habit","half","halt","happy","hardy",
  "harem","harm","harp","harsh","haste","hatch","haven","hazel","heart","heavy",
  "hedge","hefty","hello","hence","herbs","herd","hero","hilly","hinge","hippo",
  "hire","hobby","hoist","holds","holly","homer","honey","honor","hood","hook",
  "hope","horn","horse","hose","hotel","hound","house","hover","hub","human",
  "humor","hurry","husk","husky","hut","hydro","hyena","hymn","ice","icing",
  "icon","idea","igloo","image","imp","inch","index","inner","input","intro",
  "ionic","irate","iron","ivory","ivy","jab","jack","jade","jam","jazz",
  "jeans","jelly","jewel","jiffy","job","jog","join","joke","jolly","judge",
  "juice","jumbo","jump","junco","jury","just","karma","kayak","keen","keep",
  "kelp","kept","kick","kind","king","kiosk","kite","knack","knead","knee",
  "knelt","knob","knock","knot","known","koala","label","lace","lad","lake",
  "lamb","lamp","lance","land","lane","large","latch","later","lathe","lawn",
  "layer","lead","leaf","lean","learn","lease","ledge","legal","lemon","lend",
  "level","lever","light","lilac","limit","linen","liner","lingo","link","lion",
  "list","liver","llama","lobby","local","lodge","lofty","logic","logo","lone",
  "long","loose","lord","lore","lost","lotus","loud","love","lower","lucky",
  "lug","lunar","lunch","lure","lurk","lying","lyric","macro","magic","magma",
  "maid","major","maker","mango","manor","maple","march","mask","match","math",
  "mayor","maze","medal","media","melon","memo","mercy","merge","merit","mesh",
  "metal","meter","midst","mild","milk","mime","minor","minus","mirth","mist",
  "moat","mock","model","moist","molar","money","month","moose","moral","morse",
  "moss","motel","moth","motor","motto","mound","mouse","mouth","moved","movie",
  "much","mug","mulch","mule","mural","music","mute","myth","nail","name",
  "nanny","nap","navy","near","neat","neck","nerve","nest","never","next",
  "ninth","noble","nod","noise","none","north","notch","noted","novel","nudge",
  "nurse","nylon","oak","oasis","oat","ocean","odds","offer","often","olive",
  "omen","onset","opal","open","opted","orbit","order","organ","other","otter",
  "ought","ounce","outer","oval","oven","owner","oxide","pace","pack","pagan",
  "paint","pair","palm","panda","panel","panic","paper","park","party","pasta",
  "patch","path","patio","pause","peach","pearl","pedal","penny","perch","peril",
  "perky","pesto","petal","petty","photo","piano","pick","piece","pilot","pinch",
  "pine","pixel","pizza","place","plaid","plain","plan","plant","plate","plaza",
  "plead","pleat","plied","pluck","plug","plumb","plume","plump","plunk","plus",
  "plush","poem","point","poker","polar","polio","polka","polo","pond","pony",
  "pooch","pool","poppy","porch","pork","poser","pouch","pound","power","prank",
  "prawn","press","price","pride","prim","prime","print","prior","prism","prize",
  "probe","prone","proof","prose","proud","prude","prune","pub","puck","pudgy",
  "pull","pulp","pulse","pump","punk","pupil","puppy","purge","push","put",
  "putty","quack","qualm","quart","queen","query","quest","quick","quote","quota",
  "rabbi","race","radar","radio","raft","rage","raid","rail","rain","raise",
  "rally","ramp","ranch","range","rapid","rash","raven","reach","react","realm",
  "rebel","recap","reef","regal","reign","relax","relay","relic","remix","repay",
  "repel","reply","retro","rhino","ridge","rifle","right","rigid","rinse","riot",
  "ripen","risen","risk","ritzy","rival","river","roast","robe","robin","robot",
  "rocky","rodeo","rogue","roman","romp","roof","rope","rover","royal","ruby",
  "rugby","ruin","ruler","rumor","rural","rusty","sack","sadly","saint","salad",
  "salon","salsa","salt","sandy","satin","sauce","sauna","saved","scale","scam",
  "scarf","scary","scene","scent","score","scout","scowl","scrap","scrub","seize",
  "self","sense","serve","setup","seven","shade","shaft","shake","shall","shame",
  "shape","share","shark","sharp","shave","shawl","sheet","shelf","shell","shift",
  "shine","shirt","shock","shore","shout","shove","shown","shrub","shrug","shut",
  "siege","sight","sigma","silk","silly","since","siren","sixth","sixty","skate",
  "skeptic","skill","skirt","skull","slam","slang","slash","slate","sleep","sleet",
  "slept","slice","slide","slope","sloth","slug","slump","smart","smash","smell",
  "smile","smirk","smoke","snack","snake","snare","sneak","snore","snout","snowy",
  "soapy","soar","sober","solar","solid","solve","sonic","sorry","soul","south",
  "space","spare","spark","speak","spear","speed","spend","spew","spice","spike",
  "spine","spoke","spoon","sport","spray","squad","squid","stage","stain","stair",
  "stake","stale","stalk","stamp","stand","star","stark","start","state","stays",
  "steam","steel","steep","steer","stem","step","stern","stick","stiff","still",
  "sting","stock","stoic","stoke","stone","stood","stool","stoop","store","storm",
  "story","stout","stove","straw","stray","strip","stuck","study","stuff","stump",
  "style","sugar","suite","sultry","sum","sunny","super","surge","sushi","swam",
  "swamp","swan","sweep","sweet","swept","swift","swirl","swoop","sword","swore",
  "sworn","swung","syrup","table","tacky","taco","taint","taken","taker","tale",
  "talon","tango","tangy","tapir","taste","taunt","thank","theft","theme","thick",
  "thief","thing","think","third","thorn","those","three","threw","throw","thumb",
  "thump","tidal","tiger","tight","tilt","timer","timid","tipsy","tired","title",
  "toast","token","topic","torch","total","totem","touch","tough","towel","tower",
  "toxic","trace","track","trade","trail","train","trait","trash","tray","treat",
  "trend","trial","tribe","trick","tried","trio","troop","truck","truly","trump",
  "trunk","trust","truth","tulip","tumor","tuna","tuner","turbo","turf","twang",
  "tweak","tweed","tweet","twice","twirl","twist","udder","ultra","uncle","uncut",
  "under","unfit","union","unite","unity","unmet","until","upper","upset","urban",
  "usage","usher","using","usual","utter","vague","valid","valor","value","valve",
  "vapor","vault","venue","verge","verse","vigor","vine","vinyl","viola","viral",
  "virus","visit","visor","vital","vivid","vocal","vodka","voice","voter","vowel",
  "voyage","wade","wager","wagon","waist","walks","waltz","wand","watch","water",
  "wavy","wax","weak","wealth","weary","weave","wedge","weigh","weird","whale",
  "wheat","wheel","while","whirl","whole","widen","widow","width","wild","wilt",
  "wince","wind","wipe","wired","witch","vivid","vocal","wolf","woman","won",
  "world","worry","worse","worst","worth","wound","woven","wrath","wreck","write",
  "wrong","wrote","yacht","yard","year","yeast","yield","yoga","young","youth",
  "zebra","zero","zinc","zone","zoom",
];

export function generatePassphrase(opts: PassphraseModeSettings): string {
  const words: string[] = [];
  for (let i = 0; i < opts.wordCount; i++) {
    let word = WORD_LIST[cryptoRandom(WORD_LIST.length)];
    if (opts.capitalize) {
      word = word[0].toUpperCase() + word.slice(1);
    }
    words.push(word);
  }

  let result = words.join(opts.separator);

  if (opts.includeNumber) {
    const num = cryptoRandom(100);
    result += opts.separator + num;
  }

  return result;
}

const CONSONANTS = "bcdfghjklmnpqrstvwxyz";
const VOWELS = "aeiou";

export function generatePronounceable(length: number): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    if (i % 2 === 0) {
      chars.push(CONSONANTS[cryptoRandom(CONSONANTS.length)]);
    } else {
      chars.push(VOWELS[cryptoRandom(VOWELS.length)]);
    }
  }
  return chars.join("");
}

export function generatePassword(settings: GeneratorSettings): string {
  switch (settings.mode) {
    case "default":
      return generateDefaultPassword(settings.default);
    case "passphrase":
      return generatePassphrase(settings.passphrase);
    case "pronounceable":
      return generatePronounceable(settings.pronounceable.length);
  }
}

export function scorePassword(password: string): StrengthResult {
  if (!password) return { score: 0, label: "Very Weak", color: "red-500", percent: 10 };

  let score = 0;

  // Length scoring
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (password.length >= 24) score += 1;

  // Character variety
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  const variety = [hasUpper, hasLower, hasNumber, hasSpecial].filter(Boolean).length;
  score += variety - 1; // 0 for 1 type, up to 3 for all 4

  // Entropy estimate (bits per char * length)
  let poolSize = 0;
  if (hasUpper) poolSize += 26;
  if (hasLower) poolSize += 26;
  if (hasNumber) poolSize += 10;
  if (hasSpecial) poolSize += 32;
  if (poolSize === 0) poolSize = 26;
  const entropy = password.length * Math.log2(poolSize);
  if (entropy >= 60) score += 1;
  if (entropy >= 80) score += 1;
  if (entropy >= 100) score += 1;

  // Pattern penalties
  // Repeated characters
  if (/(.)\1{2,}/.test(password)) score -= 1;
  // Sequential numbers
  if (/012|123|234|345|456|567|678|789/.test(password)) score -= 1;
  // Sequential letters
  if (/abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz/i.test(password)) score -= 1;

  // Clamp to 0-4
  const clamped = Math.max(0, Math.min(4, Math.round(score / 2)));

  const mapping: Record<number, { label: string; color: string; percent: number }> = {
    0: { label: "Very Weak", color: "red-500", percent: 10 },
    1: { label: "Weak", color: "orange-500", percent: 30 },
    2: { label: "Fair", color: "yellow-500", percent: 55 },
    3: { label: "Strong", color: "green-500", percent: 80 },
    4: { label: "Very Strong", color: "emerald-500", percent: 100 },
  };

  return { score: clamped, ...mapping[clamped] };
}

export const defaultSettings: GeneratorSettings = {
  mode: "default",
  default: {
    length: 16,
    uppercase: true,
    lowercase: true,
    numbers: true,
    special: true,
    excludeSimilar: false,
    excludeAmbiguous: false,
  },
  passphrase: {
    wordCount: 4,
    separator: "-",
    capitalize: true,
    includeNumber: true,
  },
  pronounceable: {
    length: 12,
  },
};
