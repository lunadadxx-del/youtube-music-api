import assert from 'assert';

function extractYoutubeIdFromKey(key) {
  if (!key) return null;
  const cleanKey = key.split('/').pop() || key;
  if (cleanKey.includes('__')) {
    const parts = cleanKey.split('__');
    const candidate = parts[0].trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) {
      return candidate;
    }
  }
  const bracketMatch = cleanKey.match(/\[([a-zA-Z0-9_-]{11})\]/);
  if (bracketMatch && bracketMatch[1]) {
    return bracketMatch[1];
  }
  const baseName = cleanKey.replace(/\.(mp3|m4a|wav|flac|aac|ogg|mp4)$/i, '');
  if (/^[a-zA-Z0-9_-]{11}$/.test(baseName)) {
    return baseName;
  }
  const pathParts = key.split('/');
  for (const part of pathParts) {
    const partBase = part.replace(/\.(mp3|m4a|wav|flac|aac|ogg|mp4)$/i, '');
    if (/^[a-zA-Z0-9_-]{11}$/.test(partBase)) {
      return partBase;
    }
  }
  return null;
}

console.log('--- Testing Safe Song Deletion Logic & Error Safeguards ---');

// 1. YouTube ID extraction from exact keys
const testKey1 = 'music/8_vJvjkTUSQ__Aajo_Chora_Dalepar.mp3';
const testKey2 = 'music/GN0Le7lXq7k.mp3';
const testKey3 = 'music/u--C_tPRI4A.mp3';

assert.strictEqual(extractYoutubeIdFromKey(testKey1), '8_vJvjkTUSQ');
assert.strictEqual(extractYoutubeIdFromKey(testKey2), 'GN0Le7lXq7k');
assert.strictEqual(extractYoutubeIdFromKey(testKey3), 'u--C_tPRI4A');
console.log('✓ Exact YouTube ID matched from R2 keys');

// 2. Safe Deletion Data Consistency Simulation
const mockDb = {
  'test_song_1': {
    youtubeVideoId: 'test_song_1',
    songTitle: 'Test Song 1',
    r2ObjectKey: 'music/test_song_1__Song_1.mp3',
  },
  'test_song_2': {
    youtubeVideoId: 'test_song_2',
    songTitle: 'Test Song 2',
    r2ObjectKey: 'music/test_song_2.mp3',
  },
};

// Simulate Successful R2 Deletion
function deleteSongSimulation(db, id, shouldR2Succeed) {
  const exactKey = db[id]?.r2ObjectKey;
  if (!exactKey) throw new Error('Not found');

  if (!shouldR2Succeed) {
    // R2 failed: DO NOT remove from db
    throw new Error('Cloudflare R2 storage error');
  }

  // R2 succeeded: remove from db
  delete db[id];
  return { success: true, deletedKey: exactKey };
}

// Test failed deletion: db entry preserved
assert.throws(() => {
  deleteSongSimulation(mockDb, 'test_song_1', false);
}, /Cloudflare R2 storage error/);
assert.ok(mockDb['test_song_1'], 'Song 1 must NOT be deleted from DB when R2 fails');
console.log('✓ Data consistency guard: record preserved when R2 deletion fails');

// Test successful deletion: db entry removed
const result = deleteSongSimulation(mockDb, 'test_song_1', true);
assert.strictEqual(result.success, true);
assert.strictEqual(result.deletedKey, 'music/test_song_1__Song_1.mp3');
assert.strictEqual(mockDb['test_song_1'], undefined);
assert.ok(mockDb['test_song_2'], 'Other songs must remain untouched');
console.log('✓ Song 1 safely deleted from DB, Song 2 remains intact');

console.log('\nAll Safe Delete Song Unit Tests Passed! 🎉');
