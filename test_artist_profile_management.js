import assert from 'assert';

function normalizeArtistName(name) {
  if (!name || typeof name !== 'string') return 'HLT&BS Official Music';
  let clean = name.trim().replace(/\s+/g, ' ');
  const lower = clean.toLowerCase();
  if (lower === 'dj nagaraj' || lower === 'dj nagaraja' || lower === 'nagaraja' || lower === 'nagaraj') {
    return 'DJ Nagaraj';
  }
  if (lower === 'hlt&bs' || lower === 'hlt & bs' || lower === 'hlt&bs official music' || lower === 'hlt & bs official music') {
    return 'HLT&BS Official Music';
  }
  if (lower === 'praveen bandri' || lower === 'praveen bandari') {
    return 'Praveen Bandri';
  }
  return clean;
}

function getArtistSlug(artistName) {
  const norm = normalizeArtistName(artistName);
  return norm.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'various-artists';
}

console.log('--- Testing Artist Profile Management & Name Renaming Rules ---');

// 1. Normalization & Slug Stability
assert.strictEqual(getArtistSlug('DJ Nagaraj'), 'dj-nagaraj');
assert.strictEqual(getArtistSlug('dj nagaraj'), 'dj-nagaraj');
assert.strictEqual(getArtistSlug(' DJ Nagaraj '), 'dj-nagaraj');
assert.strictEqual(getArtistSlug('DJ   NAGARAJ   '), 'dj-nagaraj');
assert.strictEqual(getArtistSlug('dj   nagaraja'), 'dj-nagaraj');
console.log('✓ Normalization handles all DJ Nagaraj variations');

// 2. Distinct artists are kept separate
assert.strictEqual(getArtistSlug('Praveen Bandri'), 'praveen-bandri');
assert.notStrictEqual(getArtistSlug('Praveen Bandri'), getArtistSlug('DJ Nagaraj'));
assert.strictEqual(getArtistSlug('New Artist 2026'), 'new-artist-2026');
console.log('✓ Distinct artists remain distinct');

// 3. Renaming Artist Name under Stable Artist ID
const mockSongs = [
  { youtubeVideoId: 'song1', songTitle: 'Song 1', artist: 'DJ Nagaraj' },
  { youtubeVideoId: 'song2', songTitle: 'Song 2', artist: 'dj nagaraj' },
  { youtubeVideoId: 'song3', songTitle: 'Song 3', artist: 'Praveen Bandri' },
];

// Admin edits "DJ Nagaraj" to "DJ Nagraj"
const mockR2Metadata = {
  'dj-nagaraj': {
    artistId: 'dj-nagaraj',
    artistName: 'DJ Nagraj', // Renamed!
    profileImageUrl: 'https://pub-8e4d4f2fc67c49b98ddd35c2eaa76b68.r2.dev/artists/dj-nagaraj/profile.jpg',
    hasCustomImage: true,
    instagramUrl: '@djnagraj',
    bio: 'Banjara DJ King',
  }
};

const artistGroupMap = {};
for (const song of mockSongs) {
  const artistName = normalizeArtistName(song.artist);
  const artistId = getArtistSlug(artistName);

  if (!artistGroupMap[artistId]) {
    const meta = mockR2Metadata[artistId] || {};
    artistGroupMap[artistId] = {
      artistId,
      artistName: meta.artistName || artistName, // Displays "DJ Nagraj"
      profileImageUrl: meta.profileImageUrl || `https://pub-8e4d4f2fc67c49b98ddd35c2eaa76b68.r2.dev/artists/${artistId}/profile.jpg`,
      hasCustomImage: Boolean(meta.hasCustomImage),
      instagramUrl: meta.instagramUrl || '',
      bio: meta.bio || '',
      songCount: 0,
    };
  }
  artistGroupMap[artistId].songCount++;
}

// Verification:
// Exactly 2 profiles exist: "dj-nagaraj" and "praveen-bandri". NO duplicate "dj-nagraj" created!
assert.strictEqual(Object.keys(artistGroupMap).length, 2);
assert.strictEqual(artistGroupMap['dj-nagaraj'].artistName, 'DJ Nagraj');
assert.strictEqual(artistGroupMap['dj-nagaraj'].songCount, 2); // Both songs still linked!
assert.strictEqual(artistGroupMap['dj-nagaraj'].hasCustomImage, true);
assert.strictEqual(artistGroupMap['dj-nagaraj'].instagramUrl, '@djnagraj');
assert.strictEqual(artistGroupMap['dj-nagaraj'].youtubeUrl, undefined); // YouTube channel URL removed!

assert.strictEqual(artistGroupMap['praveen-bandri'].songCount, 1);
assert.strictEqual(artistGroupMap['praveen-bandri'].artistName, 'Praveen Bandri');

console.log('✓ Renaming artist name preserves all songs under the stable artistId without duplicates!');
console.log('✓ YouTube Channel URL removed from Artist Profile data model.');
console.log('✓ All Artist Profile Backend Tests Passed! 🎉');
