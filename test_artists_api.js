import assert from 'assert';

function isValidArtistName(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 35) return false;

  // Discard phone numbers or candidates containing 3+ digits (e.g. "contact 733804116", "9845012345")
  if (/\d{3,}/.test(clean)) return false;

  const lower = clean.toLowerCase();

  // Blacklisted keywords
  const blacklistedKeywords = [
    'contact', 'phone', 'call', 'mobile', 'whatsapp', 'ph no', 'ph.', 'mob.',
    'subscribe', 'editing', 'editor', 'poster', 'banner', 'thumbnail',
    'status', 'whatsapp status', 'promo', 'teaser', 'trailer', 'video',
    'audio', 'full song', 'official video', 'lyrics video', 'jumbenachujumbe',
    'record', 'recording', 'studio', 'presents', 'production', 'channel',
    'instagram', 'youtube', 'facebook', 'media', 'company', 'entertainment',
    'sound', 'music company', 'all rights', 'copyright'
  ];

  for (const keyword of blacklistedKeywords) {
    if (lower === keyword || lower.startsWith(keyword + ' ') || lower.endsWith(' ' + keyword)) {
      return false;
    }
  }

  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(clean)) return false;

  return true;
}

function cleanArtistToken(token) {
  if (!token || typeof token !== 'string') return '';
  let clean = token.trim().replace(/\s+/g, ' ');

  // Strip contact / phone patterns like "contact 733804116", "ph 98450...", "mob 12345...", "+91 98765..." or long digits
  clean = clean.replace(/(?:contact|phone|call|mob|mobile|whatsapp|ph\.?|mob\.?)\s*(?::|-)?\s*\+?\d[\d\s-]{4,}/gi, '');
  clean = clean.replace(/\b\d{5,}\b/g, '');

  // Remove leading credit prefixes
  clean = clean.replace(/^(?:lyrics(?:\s+by)?|singer[s]?(?:\s+by)?|vocal[s]?(?:\s+by)?|composed\s+by|written\s+by|music(?:\s+by)?|produced\s+by|directed\s+by|starring|featuring|feat\.?|ft\.?|by|dialogue[s]?(?:\s+by)?)\s+/i, '');

  // Remove trailing credit suffixes
  clean = clean.replace(/\s+(?:lyrics|mix|remix|dj\s*mix|full\s*song|song|audio|video|official|music)$/i, '');

  return clean.trim();
}

function normalizeArtistName(name) {
  if (!name || typeof name !== 'string') return 'HLT&BS Official Music';
  const lowerRaw = name.trim().replace(/\s+/g, ' ').toLowerCase();

  // HLT&BS Channel variations
  if (lowerRaw === 'hlt&bs' || lowerRaw === 'hlt & bs' || lowerRaw === 'hlt&bs official music' ||
      lowerRaw === 'hlt & bs official music' || lowerRaw === 'hlt and bs' || lowerRaw === 'hlt official music') {
    return 'HLT&BS Official Music';
  }

  let clean = cleanArtistToken(name);
  if (!clean || !isValidArtistName(clean)) return 'HLT&BS Official Music';

  const lower = clean.toLowerCase();

  // DJ Nagaraj variations
  if (lower === 'dj nagaraj' || lower === 'dj nagaraja' || lower === 'nagaraja' || lower === 'nagaraj' ||
      lower === 'dj nagaraj mix' || lower === 'dj nagaraj official' || lower === 'singer nagaraj' ||
      lower === 'singer nagaraja' || lower === 'singer dj nagaraj' || lower === 'dj nagaraj songs') {
    return 'DJ Nagaraj';
  }

  // Praveen Bandri variations
  if (lower === 'praveen bandri' || lower === 'praveen bandari' || lower === 'singer praveen bandri' ||
      lower === 'praveen bandri music' || lower === 'praveen') {
    return 'Praveen Bandri';
  }

  // Bhima BS variations
  if (lower === 'bhima bs' || lower === 'bhima b s' || lower === 'bheem bs' || lower === 'bheema bs' ||
      lower === 'singer bhima bs' || lower === 'lyrics bhima bs') {
    return 'Bhima BS';
  }

  // Sumitra variations
  if (lower === 'sumitra' || lower === 'sumithra' || lower === 'singer sumitra' || lower === 'singer sumithra') {
    return 'Sumitra';
  }

  // Gururaj Krg variations
  if (lower === 'gururaj krg' || lower === 'gururaj' || lower === 'guru krg' || lower === 'gururaja krg') {
    return 'Gururaj Krg';
  }

  // Aishu variations
  if (lower === 'aishu' || lower === 'singer aishu') {
    return 'Aishu';
  }

  // Auto Title-Case formatting for any other artist
  return clean.split(' ').map(w => {
    if (!w) return '';
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function splitArtists(rawString) {
  if (!rawString || typeof rawString !== 'string') return [];
  const parts = rawString.split(/\s*(?:&|(?:\band\b)|(?:\bAND\b)|,|\+|\/|\||(?:\bfeat\.?\b)|(?:\bft\.?\b)|(?:\bwith\b))\s*/i);
  const result = [];
  for (const part of parts) {
    const cleaned = cleanArtistToken(part);
    if (isValidArtistName(cleaned)) {
      const norm = normalizeArtistName(cleaned);
      if (norm && norm !== 'HLT&BS Official Music' && !result.includes(norm)) {
        result.push(norm);
      }
    }
  }
  return result;
}

function getArtistSlug(artistName) {
  const norm = normalizeArtistName(artistName);
  return norm.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'various-artists';
}

function extractArtistsFromSong(title, explicitArtist, channelTitle) {
  const artists = new Set();

  if (explicitArtist && typeof explicitArtist === 'string' && explicitArtist.trim()) {
    const explicitSplits = splitArtists(explicitArtist);
    for (const a of explicitSplits) {
      if (a !== 'HLT&BS Official Music') {
        artists.add(a);
      }
    }
  }

  if (title && typeof title === 'string') {
    const upperTitle = title.toUpperCase();

    if (upperTitle.includes('NAGARAJ') || upperTitle.includes('NAGARAJA')) {
      artists.add('DJ Nagaraj');
    }
    if (upperTitle.includes('PRAVEEN BANDRI') || upperTitle.includes('PRAVEEN BANDARI')) {
      artists.add('Praveen Bandri');
    }
    if (upperTitle.includes('BHIMA BS') || upperTitle.includes('BHIMA B S') || upperTitle.includes('BHEEMA BS')) {
      artists.add('Bhima BS');
    }
    if (upperTitle.includes('SUMITRA') || upperTitle.includes('SUMITHRA')) {
      artists.add('Sumitra');
    }
    if (upperTitle.includes('GURURAJ KRG') || upperTitle.includes('GURURAJ')) {
      artists.add('Gururaj Krg');
    }
    if (upperTitle.includes('AISHU')) {
      artists.add('Aishu');
    }

    const matches = title.matchAll(/(?:SINGER[S]?|FEAT\.?|FT\.?|VOCALS?|LYRICS?|MUSIC|BY)\s+([A-Za-z0-9\s&,+\/]+?)(?:\s+(?:DJ|MIX|FULL|OFFICIAL|#|\|\||-)|$)/gi);
    for (const match of matches) {
      if (match[1]) {
        const candidate = match[1].trim();
        const splits = splitArtists(candidate);
        for (const a of splits) {
          if (a !== 'HLT&BS Official Music') {
            artists.add(a);
          }
        }
      }
    }
  }

  if (artists.size === 0) {
    if (explicitArtist && typeof explicitArtist === 'string' && isValidArtistName(explicitArtist)) {
      artists.add(normalizeArtistName(explicitArtist));
    } else {
      artists.add(normalizeArtistName(channelTitle || 'HLT&BS Official Music'));
    }
  }

  return Array.from(artists);
}

console.log('--- Testing Artist Normalization, Phone/Contact Filtering, & Multi-Artist Splitting ---');

// 1. Phone number / Contact filtering
assert.strictEqual(isValidArtistName('contact 733804116'), false);
assert.strictEqual(isValidArtistName('733804116'), false);
assert.strictEqual(isValidArtistName('contact 9845012345'), false);
assert.strictEqual(isValidArtistName('whatsapp 9876543210'), false);
assert.strictEqual(isValidArtistName('editing by rathod'), false);
assert.strictEqual(isValidArtistName('poster design'), false);
console.log('✓ Invalid artists (phone numbers, contact tags, editing credits) rejected');

// 2. Clean Credit Prefixes: "Lyrics bhima bs" -> "Bhima BS"
assert.strictEqual(normalizeArtistName('Lyrics bhima bs'), 'Bhima BS');
assert.strictEqual(normalizeArtistName('lyrics bhima bs'), 'Bhima BS');
assert.strictEqual(normalizeArtistName('Singer Bhima BS'), 'Bhima BS');
assert.strictEqual(normalizeArtistName('gururaj krg'), 'Gururaj Krg');
console.log('✓ Credit prefixes stripped: "Lyrics bhima bs" -> "Bhima BS" and "gururaj krg" -> "Gururaj Krg"');

// 3. Multi-Artist Splitting: "Bhima BS & Sumitra" or "Bhima BS and Sumitra"
const split1 = splitArtists('Bhima BS and Sumitra');
assert.deepStrictEqual(split1, ['Bhima BS', 'Sumitra']);

const split2 = splitArtists('Bhima BS & Sumitra');
assert.deepStrictEqual(split2, ['Bhima BS', 'Sumitra']);

const splitWithContact = splitArtists('Bhima BS & Sumitra Contact 733804116');
assert.deepStrictEqual(splitWithContact, ['Bhima BS', 'Sumitra']);
console.log('✓ Multi-artist compound names properly split into individual artist records');

// 4. Song with multiple artists creates individual profiles and links the song to both
const testSongs = [
  {
    title: 'BANJARA DUET SINGER BHIMA BS AND SUMITRA CONTACT 7338041169 DJ MIX',
    artist: null,
  },
  {
    title: 'GURURAJ KRG LYRICS BHIMA BS FULL AUDIO SONG',
    artist: null,
  },
  {
    title: 'CHAINA WALI CHORIN MAYI LUCHU MAMA SINGER NAGARAJA DJ MIX',
    artist: null,
  }
];

const artistGroupMap = {};
for (const s of testSongs) {
  const extracted = extractArtistsFromSong(s.title, s.artist, 'HLT&BS Official Music');
  for (const name of extracted) {
    const slug = getArtistSlug(name);
    if (!artistGroupMap[slug]) {
      artistGroupMap[slug] = { artistId: slug, artistName: name, songCount: 0 };
    }
    artistGroupMap[slug].songCount++;
  }
}

// Check profiles created:
// "Bhima BS" (in song 1 and song 2 = 2 songs)
// "Sumitra" (in song 1 = 1 song)
// "Gururaj Krg" (in song 2 = 1 song)
// "DJ Nagaraj" (in song 3 = 1 song)
// "contact 733804116" must NOT exist!
assert.strictEqual(artistGroupMap['contact-733804116'], undefined);
assert.strictEqual(artistGroupMap['bhima-bs-and-sumitra'], undefined);
assert.strictEqual(artistGroupMap['bhima-bs-sumitra'], undefined);
assert.strictEqual(artistGroupMap['lyrics-bhima-bs'], undefined);

assert.strictEqual(artistGroupMap['bhima-bs'].artistName, 'Bhima BS');
assert.strictEqual(artistGroupMap['bhima-bs'].songCount, 2);

assert.strictEqual(artistGroupMap['sumitra'].artistName, 'Sumitra');
assert.strictEqual(artistGroupMap['sumitra'].songCount, 1);

assert.strictEqual(artistGroupMap['gururaj-krg'].artistName, 'Gururaj Krg');
assert.strictEqual(artistGroupMap['gururaj-krg'].songCount, 1);

assert.strictEqual(artistGroupMap['dj-nagaraj'].artistName, 'DJ Nagaraj');
assert.strictEqual(artistGroupMap['dj-nagaraj'].songCount, 1);

console.log('✓ Multi-artist songs show in both artist profiles and phone numbers are excluded');
console.log('\nAll Artist Catalog unit tests passed successfully! 🎉');
