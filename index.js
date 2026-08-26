import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB max limit
});

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME || 'artist-music';
const publicDomain = process.env.R2_PUBLIC_DOMAIN || 'https://pub-8e4d4f2fc67c49b98ddd35c2eaa76b68.r2.dev';

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('[SERVER_ERROR] Missing Cloudflare R2 environment variables in server/.env');
}

// Initialize AWS S3 Client targeting Cloudflare R2 Endpoint
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKeyId || '',
    secretAccessKey: secretAccessKey || ''
  }
});

const profileR2Key = 'config/artist-profile.json';
const artistsMetadataR2Key = 'config/artists.json';
const localArtistsFilePath = path.join(__dirname, 'data', 'artists.json');
const localSongsDbPath = path.join(__dirname, 'data', 'songs_db.json');

const defaultArtistProfile = {
  contactNumber: '8747875269',
  instagramUrl: 'https://www.instagram.com/bhima_bs_',
  youtubeUrl: 'https://www.youtube.com/@HLT_BS_Music/videos',
};

/**
 * Helper: Validates that a string is a genuine artist name and not a phone number, contact, or junk tag.
 */
function isValidArtistName(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 35) return false;

  // Discard phone numbers or strings with 3+ digits (e.g. "contact 733804116", "9845012345")
  if (/\d{3,}/.test(clean)) return false;

  const lower = clean.toLowerCase();

  // Blacklisted keywords (contacts, editing, metadata tags, generic words)
  const blacklistedKeywords = [
    'contact', 'phone', 'call', 'mobile', 'whatsapp', 'ph no', 'ph.', 'mob.',
    'subscribe', 'editing', 'editor', 'poster', 'banner', 'thumbnail',
    'status', 'whatsapp status', 'promo', 'teaser', 'trailer', 'video',
    'audio', 'full song', 'official video', 'lyrics video', 'jumbenachujumbe',
    'record', 'recording', 'studio', 'presents', 'production', 'channel',
    'instagram', 'youtube', 'facebook', 'media', 'company', 'entertainment',
    'sound', 'music company', 'all rights', 'copyright', 'banjara dance', 'dance',
    'folksong', 'folk song', 'full song tag', 'coming soon', 'bay thara chori kay super',
    'new coming soon song', 'banjara new feeling song', 'banjara comedy dj song',
    'banjara pre wedding shoot', 'banjara love feeling song', 'holi song',
    'banjara holi old lyrics dj songs', 'super chori', 'banjara song', 'banjara dj song'
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

/**
 * Helper: Cleans credit prefixes like "lyrics", "singing", "singer", "singers", "music by", "by", etc.
 */
function cleanArtistToken(token) {
  if (!token || typeof token !== 'string') return '';
  let clean = token.trim().replace(/\s+/g, ' ');

  // Strip contact / phone patterns like "contact 733804116", "ph 98450...", "mob 12345...", "+91 98765..." or long digits
  clean = clean.replace(/(?:contact|phone|call|mob|mobile|whatsapp|ph\.?|mob\.?)\s*(?::|-)?\s*\+?\d[\d\s-]{4,}/gi, '');
  clean = clean.replace(/\b\d{5,}\b/g, '');

  // Remove leading credit prefixes
  clean = clean.replace(/^(?:lyrics(?:\s+by)?|singing(?:\s+by)?|singer[s]?(?:\s+by)?|singin[s]?(?:\s+by)?|singar[s]?(?:\s+by)?|vocal[s]?(?:\s+by)?|composed\s+by|written\s+by|music(?:\s+by)?|produced\s+by|directed\s+by|starring|featuring|feat\.?|ft\.?|by|dialogue[s]?(?:\s+by)?)\s+/i, '');

  // Remove trailing credit suffixes
  clean = clean.replace(/\s+(?:lyrics|mix|remix|dj\s*mix|full\s*song|song|audio|video|official|music|edm\s*mix|official\s*video|pre\s*wedding\s*shoot|comedy\s*dj\s*song|dance|video\s*song)$/i, '');

  return clean.trim();
}

/**
 * Helper: Normalizes artist name carefully for canonical deduplication and grouping.
 */
function normalizeArtistName(name) {
  if (!name || typeof name !== 'string') return 'HLT&BS Official Music';
  const lowerRaw = name.trim().replace(/\s+/g, ' ').toLowerCase();

  // HLT&BS Channel variations
  if (lowerRaw === 'hlt&bs' || lowerRaw === 'hlt & bs' || lowerRaw === 'hlt&bs official music' ||
      lowerRaw === 'hlt & bs official music' || lowerRaw === 'hlt and bs' || lowerRaw === 'hlt official music' ||
      lowerRaw === 'hlt' || lowerRaw === 'bs' || lowerRaw === 'hlt bs' || lowerRaw === 'hlt&bs music') {
    return 'HLT&BS Official Music';
  }

  let clean = cleanArtistToken(name);
  if (!clean || !isValidArtistName(clean)) return 'HLT&BS Official Music';

  const lower = clean.toLowerCase();

  // DJ Nagaraj variations
  if (lower === 'dj nagaraj' || lower === 'dj nagaraja' || lower === 'nagaraja' || lower === 'nagaraj' ||
      lower === 'dj nagaraj mix' || lower === 'dj nagaraj official' || lower === 'singer nagaraj' ||
      lower === 'singer nagaraja' || lower === 'singer dj nagaraj' || lower === 'dj nagaraj songs' ||
      lower === 'nagaraja dj' || lower === 'nagaraj dj' || lower === 'singing nagaraj dj' || lower === 'singing nagaraja dj') {
    return 'DJ Nagaraj';
  }

  // Praveen Bandri variations
  if (lower === 'praveen bandri' || lower === 'praveen bandari' || lower === 'singer praveen bandri' ||
      lower === 'praveen bandri music' || lower === 'praveen' || lower === 'singing praveen bandri') {
    return 'Praveen Bandri';
  }

  // Bhima BS variations
  if (lower === 'bhima bs' || lower === 'bhima b s' || lower === 'bheem bs' || lower === 'bheema bs' ||
      lower === 'singer bhima bs' || lower === 'lyrics bhima bs' || lower === 'bhima_bs') {
    return 'Bhima BS';
  }

  // Sumitra variations
  if (lower === 'sumitra' || lower === 'sumithra' || lower === 'singer sumitra' || lower === 'singer sumithra') {
    return 'Sumitra';
  }

  // Gururaj Krg variations
  if (lower === 'gururaj krg' || lower === 'gururaj' || lower === 'guru krg' || lower === 'gururaja krg' ||
      lower === 'singer gururaja krg' || lower === 'guru raj krg' || lower === 'singing guru raj krg' ||
      lower === 'singing gururaj krg' || lower === 'guru raj') {
    return 'Gururaj Krg';
  }

  // Aishu variations
  if (lower === 'aishu' || lower === 'singer aishu') {
    return 'Aishu';
  }

  // Sunil BS variations
  if (lower === 'sunil bs' || lower === 'singin sunil bs' || lower === 'singing sunil bs' || lower === 'sunil b s' || lower === 'sunil_bs') {
    return 'Sunil BS';
  }

  // Lakshman Vakdoth variations
  if (lower === 'lakshman vakdoth' || lower === 'laxman vakdoth' || lower === 'lakshman') {
    return 'Lakshman Vakdoth';
  }

  // Harish HLT variations
  if (lower === 'harish hlt' || lower === 'harish') {
    return 'Harish HLT';
  }

  // S.M Somesh Naik variations
  if (lower === 's.m somesh naik' || lower === 'somesh naik' || lower === 'sm somesh naik' || lower === 's.m somesh' || lower === 's.m_somesh') {
    return 'S.M Somesh Naik';
  }

  // N Lokesh Naik variations
  if (lower === 'n lokesh naik' || lower === 'lokesh naik' || lower === 'n lokesh') {
    return 'N Lokesh Naik';
  }

  // MJPS variations
  if (lower === 'mjps') {
    return 'MJPS';
  }

  // Janu Lambani variations
  if (lower === 'janu lambani') {
    return 'Janu Lambani';
  }

  // B N Prashantha variations
  if (lower === 'b n prashantha' || lower === 'bn prashantha' || lower === 'prashantha') {
    return 'B N Prashantha';
  }

  // Renu Rathod variations
  if (lower === 'renu rathod') {
    return 'Renu Rathod';
  }

  // Hundar Krishna variations
  if (lower === 'hundar krishna') {
    return 'Hundar Krishna';
  }

  // CHS Banjar variations
  if (lower === 'chs banjar') {
    return 'CHS Banjar';
  }

  // Chetu CH variations
  if (lower === 'chetu ch') {
    return 'Chetu CH';
  }

  // Tukaram PS variations
  if (lower === 'tukaram ps') {
    return 'Tukaram PS';
  }

  // Kalpana Pawar variations
  if (lower === 'kalpana pawar' || lower === 'kalpana') {
    return 'Kalpana Pawar';
  }

  // Vishwanath variations
  if (lower === 'vishwanath') {
    return 'Vishwanath';
  }

  // Ashwini variations
  if (lower === 'ashwini') {
    return 'Ashwini';
  }

  // Auto Title-Case formatting for any other artist
  return clean.split(' ').map(w => {
    if (!w) return '';
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

/**
 * Helper: Splits compound/multi-artist strings (e.g., "Bhima BS & Sumitra", "Aishu and Nagaraj") into individual artist names.
 */
function splitArtists(rawString) {
  if (!rawString || typeof rawString !== 'string') return [];
  // Protect HLT&BS from being split into HLT and BS
  const protectedStr = rawString.replace(/HLT\s*&\s*BS/gi, 'HLT_AND_BS');
  const parts = protectedStr.split(/\s*(?:&|(?:\band\b)|(?:\bAND\b)|,|\+|\/|\||(?:\bfeat\.?\b)|(?:\bft\.?\b)|(?:\bwith\b))\s*/i);
  const result = [];
  for (let part of parts) {
    part = part.replaceAll('HLT_AND_BS', 'HLT&BS');
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

/**
 * Helper: Creates a deterministic, URL-safe artist slug identifier.
 * e.g. "DJ Nagaraj", "dj nagaraj", "DJ NAGARAJ" -> "dj-nagaraj"
 */
function getArtistSlug(artistName) {
  const norm = normalizeArtistName(artistName);
  return norm.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'various-artists';
}

/**
 * Helper: Finds artist metadata from R2 metadata map by matching canonical slug or aliases
 */
function findArtistMetadata(artistsMetadata, slug) {
  if (!artistsMetadata || typeof artistsMetadata !== 'object') return {};
  if (artistsMetadata[slug]) return artistsMetadata[slug];
  for (const [key, meta] of Object.entries(artistsMetadata)) {
    if (getArtistSlug(key) === slug || (meta && meta.artistName && getArtistSlug(meta.artistName) === slug)) {
      return meta;
    }
  }
  return {};
}

/**
 * Helper: Extracts an array of ALL unique artists involved in a song.
 */
function extractArtistsFromSong(title, explicitArtist, channelTitle) {
  const artists = new Set();

  // 1. If explicitArtist is provided
  if (explicitArtist && typeof explicitArtist === 'string' && explicitArtist.trim()) {
    const explicitSplits = splitArtists(explicitArtist);
    for (const a of explicitSplits) {
      if (a !== 'HLT&BS Official Music') {
        artists.add(a);
      }
    }
  }

  // 2. Extract from song title
  if (title && typeof title === 'string') {
    const upper = title.toUpperCase();

    if (upper.includes('NAGARAJ') || upper.includes('NAGARAJA')) artists.add('DJ Nagaraj');
    if (upper.includes('PRAVEEN BANDRI') || upper.includes('PRAVEEN BANDARI')) artists.add('Praveen Bandri');
    if (upper.includes('BHIMA BS') || upper.includes('BHIMA B S') || upper.includes('BHEEMA BS') || upper.includes('BHIMA_BS')) artists.add('Bhima BS');
    if (upper.includes('SUMITRA') || upper.includes('SUMITHRA')) artists.add('Sumitra');
    if (upper.includes('GURURAJ KRG') || upper.includes('GURURAJA KRG') || upper.includes('GURU RAJ KRG') || upper.includes('GURURAJ')) artists.add('Gururaj Krg');
    if (upper.includes('AISHU')) artists.add('Aishu');
    if (upper.includes('SUNIL BS') || upper.includes('SUNIL B S') || upper.includes('SUNIL_BS')) artists.add('Sunil BS');
    if (upper.includes('LAKSHMAN VAKDOTH') || upper.includes('LAXMAN VAKDOTH')) artists.add('Lakshman Vakdoth');
    if (upper.includes('HARISH HLT')) artists.add('Harish HLT');
    if (upper.includes('SOMESH NAIK') || upper.includes('S.M SOMESH') || upper.includes('S.M_SOMESH')) artists.add('S.M Somesh Naik');
    if (upper.includes('LOKESH NAIK') || upper.includes('N LOKESH')) artists.add('N Lokesh Naik');
    if (upper.includes('MJPS')) artists.add('MJPS');
    if (upper.includes('JANU LAMBANI')) artists.add('Janu Lambani');
    if (upper.includes('PRASHANTHA') || upper.includes('B N PRASHANTHA')) artists.add('B N Prashantha');
    if (upper.includes('RENU RATHOD')) artists.add('Renu Rathod');
    if (upper.includes('HUNDAR KRISHNA')) artists.add('Hundar Krishna');
    if (upper.includes('CHS BANJAR')) artists.add('CHS Banjar');
    if (upper.includes('CHETU CH')) artists.add('Chetu CH');
    if (upper.includes('TUKARAM PS')) artists.add('Tukaram PS');
    if (upper.includes('KALPANA PAWAR') || upper.includes('KALPANA')) artists.add('Kalpana Pawar');
    if (upper.includes('VISHWANATH')) artists.add('Vishwanath');
    if (upper.includes('ASHWINI')) artists.add('Ashwini');

    const matches = title.matchAll(/(?:SINGER[S]?|SINGING|SINGIN|SINGAR|FEAT\.?|FT\.?|VOCALS?|LYRICS?|MUSIC|BY)\s+([A-Za-z0-9\s&,+\/]+?)(?:\s+(?:DJ|MIX|FULL|OFFICIAL|#|\|\||-|MUSIC|LYRICS|SINGING|SINGER)|$)/gi);
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

/**
 * Helper: Extracts single primary artist from song for backward compatibility.
 */
function extractArtistFromSong(title, explicitArtist, channelTitle) {
  const list = extractArtistsFromSong(title, explicitArtist, channelTitle);
  return list.length > 0 ? list.join(' & ') : 'HLT&BS Official Music';
}

/**
 * Helper: Asynchronously reads config/artist-profile.json from Cloudflare R2 bucket.
 */
async function fetchArtistProfileFromR2() {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: profileR2Key,
    });
    const response = await s3Client.send(command);
    const bodyText = await response.Body.transformToString('utf-8');
    const parsed = JSON.parse(bodyText);
    return { ...defaultArtistProfile, ...parsed };
  } catch (err) {
    if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) {
      console.warn('[R2_PROFILE_READ_WARN] Could not fetch profile from R2:', err.message || err);
    }
    return defaultArtistProfile;
  }
}

/**
 * Helper: Asynchronously uploads/overwrites config/artist-profile.json in Cloudflare R2 bucket.
 */
async function saveArtistProfileToR2(profileData) {
  const jsonString = JSON.stringify(profileData, null, 2);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: profileR2Key,
    Body: Buffer.from(jsonString, 'utf-8'),
    ContentType: 'application/json',
  });
  await s3Client.send(command);
  console.log(`[R2_PROFILE_SAVED] Persisted config/artist-profile.json to Cloudflare R2 bucket "${bucketName}"`);
}

/**
 * Helper: Asynchronously reads config/artists.json from Cloudflare R2 bucket with local fallback.
 */
async function fetchArtistsMetadataFromR2() {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: artistsMetadataR2Key,
    });
    const response = await s3Client.send(command);
    const bodyText = await response.Body.transformToString('utf-8');
    const parsed = JSON.parse(bodyText);
    return parsed;
  } catch (err) {
    if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) {
      console.warn('[R2_ARTISTS_READ_WARN] Could not fetch artists from R2:', err.message || err);
    }
    if (fs.existsSync(localArtistsFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(localArtistsFilePath, 'utf-8'));
      } catch (_) {}
    }
    return {};
  }
}

/**
 * Helper: Asynchronously uploads/overwrites config/artists.json in Cloudflare R2 bucket.
 */
async function saveArtistsMetadataToR2(artistsMap) {
  const jsonString = JSON.stringify(artistsMap, null, 2);
  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: artistsMetadataR2Key,
      Body: Buffer.from(jsonString, 'utf-8'),
      ContentType: 'application/json',
    });
    await s3Client.send(command);
    console.log(`[R2_ARTISTS_SAVED] Persisted config/artists.json to Cloudflare R2 bucket "${bucketName}"`);
  } catch (err) {
    console.error('[R2_ARTISTS_SAVE_ERROR] Failed persisting artists to R2:', err);
  }

  // Backup to local file
  try {
    const dataDir = path.dirname(localArtistsFilePath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(localArtistsFilePath, jsonString, 'utf-8');
  } catch (_) {}
}

/**
 * Helper: Reads local songs database
 */
function getLocalSongsDb() {
  if (fs.existsSync(localSongsDbPath)) {
    try {
      return JSON.parse(fs.readFileSync(localSongsDbPath, 'utf-8'));
    } catch (_) {}
  }
  return {};
}

/**
 * Helper: Saves local songs database
 */
function saveLocalSongsDb(db) {
  try {
    const dataDir = path.dirname(localSongsDbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(localSongsDbPath, JSON.stringify(db, null, 2), 'utf-8');
  } catch (_) {}
}

/**
 * Helper: Aggregates all known songs from local DB and live R2 objects
 */
async function getAllKnownSongs() {
  const localDb = getLocalSongsDb();
  const r2Objects = await fetchAllR2Objects();
  const songsMap = { ...localDb };

  for (const obj of r2Objects) {
    if (!obj.Key) continue;
    if (obj.Key.startsWith('config/') || obj.Key.startsWith('artists/')) continue;

    const youtubeVideoId = extractYoutubeIdFromKey(obj.Key);
    if (!youtubeVideoId) continue;

    const audioUrl = `${publicDomain}/${encodeURIComponent(obj.Key).replaceAll('%2F', '/')}`;
    if (!songsMap[youtubeVideoId]) {
      const cleanName = obj.Key.split('/').pop().replace(/\.(mp3|m4a|wav)$/i, '');
      const rawTitle = cleanName.includes('__') ? cleanName.split('__')[1].replaceAll('_', ' ') : cleanName;
      const detectedArtist = extractArtistFromSong(rawTitle, null, 'HLT&BS Official Music');

      songsMap[youtubeVideoId] = {
        youtubeVideoId,
        songTitle: rawTitle,
        artist: detectedArtist,
        duration: '0:00',
        r2Key: obj.Key,
        publicUrl: audioUrl,
        r2ObjectKey: obj.Key,
        r2AudioUrl: audioUrl,
        fileSize: obj.Size,
        lastModified: obj.LastModified,
        uploadStatus: 'UPLOADED',
      };
    } else {
      songsMap[youtubeVideoId].r2Key = obj.Key;
      songsMap[youtubeVideoId].r2ObjectKey = obj.Key;
      songsMap[youtubeVideoId].publicUrl = audioUrl;
      songsMap[youtubeVideoId].r2AudioUrl = audioUrl;
      songsMap[youtubeVideoId].uploadStatus = 'UPLOADED';
      if (!songsMap[youtubeVideoId].artist) {
        songsMap[youtubeVideoId].artist = extractArtistFromSong(songsMap[youtubeVideoId].songTitle, null, 'HLT&BS Official Music');
      }
    }
  }

  return songsMap;
}

/**
 * Helper: Lists all objects directly from Cloudflare R2 bucket.
 * Handles pagination for > 1000 items.
 */
async function fetchAllR2Objects() {
  const objects = [];
  let isTruncated = true;
  let continuationToken = undefined;

  while (isTruncated) {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: continuationToken,
    });
    const response = await s3Client.send(command);
    if (response.Contents) {
      objects.push(...response.Contents);
    }
    isTruncated = response.IsTruncated || false;
    continuationToken = response.NextContinuationToken;
  }

  // STEP 1 Safe Logging: Log R2 bucket name, object count, and key list
  console.log(`R2 bucket: ${bucketName}`);
  console.log(`Number of objects found: ${objects.length}`);
  console.log(`Object keys: ${objects.map(o => o.Key).join(', ')}`);

  return objects;
}

/**
 * Helper: Sanitizes a song title for a safe R2 filename key.
 * - Removes invalid filesystem/URL characters
 * - Replaces spaces with _
 * - Limits length (max 50 chars)
 * - Removes leading/trailing underscores
 */
function sanitizeTitle(title) {
  if (!title) return '';
  let clean = title.replace(/[^a-zA-Z0-9_\-\s]/g, '');
  clean = clean.trim().replace(/\s+/g, '_');
  clean = clean.replace(/^_+|_+$/g, '');
  if (clean.length > 50) {
    clean = clean.substring(0, 50).replace(/_+$/g, '');
  }
  return clean;
}

/**
 * Helper: Extracts YouTube Video ID from R2 object Key using multiple matching strategies.
 * Handles both:
 * - Old format: music/8_vJvjkTUSQ.mp3, 8_vJvjkTUSQ.mp3, music/[8_vJvjkTUSQ].mp3
 * - New format: music/8_vJvjkTUSQ__Bheema_Official_Song.mp3
 * Strictly returns an 11-char YouTube ID matching /^[a-zA-Z0-9_-]{11}$/ or null if not found.
 */
function extractYoutubeIdFromKey(key) {
  if (!key) return null;

  const cleanKey = key.split('/').pop() || key;

  // 1. Double underscore separator e.g. 8_vJvjkTUSQ__Bheema_Official_Song.mp3
  if (cleanKey.includes('__')) {
    const parts = cleanKey.split('__');
    const candidate = parts[0].trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) {
      return candidate;
    }
  }

  // 2. Explicit bracket pattern e.g. [Rxsdi6JIj-8]
  const bracketMatch = cleanKey.match(/\[([a-zA-Z0-9_-]{11})\]/);
  if (bracketMatch && bracketMatch[1]) {
    return bracketMatch[1];
  }

  // 3. Exact 11-char YouTube ID filename (with audio/video extension stripped)
  const baseName = cleanKey.replace(/\.(mp3|m4a|wav|flac|aac|ogg|mp4)$/i, '');
  if (/^[a-zA-Z0-9_-]{11}$/.test(baseName)) {
    return baseName;
  }

  // 4. Prefix pattern e.g. music/8_vJvjkTUSQ.mp3
  const pathParts = key.split('/');
  for (const part of pathParts) {
    const partBase = part.replace(/\.(mp3|m4a|wav|flac|aac|ogg|mp4)$/i, '');
    if (/^[a-zA-Z0-9_-]{11}$/.test(partBase)) {
      return partBase;
    }
  }

  return null;
}

/**
 * Health Check Endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bucket: bucketName, serverTime: new Date().toISOString() });
});

/**
 * POST /admin/login
 * Secure authentication against server environment variables (ADMIN_USERNAME & ADMIN_PASSWORD)
 */
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'bheema@bs7686';

  const trimmedUser = (username || '').trim();
  const trimmedPass = (password || '').trim();

  if (trimmedUser.toLowerCase() === adminUser.toLowerCase() && trimmedPass === adminPass) {
    const token = Buffer.from(`${trimmedUser}:${Date.now()}`).toString('base64');
    console.log(`[ADMIN_AUTH] Successful login for user: ${trimmedUser}`);
    return res.json({ success: true, username: trimmedUser, token });
  }

  console.warn(`[ADMIN_AUTH] Failed login attempt for user: ${trimmedUser}`);
  return res.status(401).json({ success: false, error: 'Invalid username or password. Please try again.' });
});

/**
 * GET /api/artist/profile
 * Reads config/artist-profile.json directly from Cloudflare R2.
 */
app.get('/api/artist/profile', async (req, res) => {
  try {
    const profile = await fetchArtistProfileFromR2();
    res.json({ success: true, source: 'Cloudflare_R2', profile });
  } catch (err) {
    console.error('[R2_PROFILE_GET_ERROR]', err);
    res.json({ success: true, source: 'Default_Fallback', profile: defaultArtistProfile });
  }
});

/**
 * GET /api/artists and GET /admin/artists
 * Returns all detected artists with persistent profile images and metadata from Cloudflare R2 and song counts.
 */
app.get(['/api/artists', '/admin/artists'], async (req, res) => {
  try {
    const songsMap = await getAllKnownSongs();
    const artistsMetadata = await fetchArtistsMetadataFromR2();

    const artistGroupMap = {};

    for (const song of Object.values(songsMap)) {
      if (!song.youtubeVideoId) continue;
      const artistNames = extractArtistsFromSong(song.songTitle, song.artist, 'HLT&BS Official Music');

      for (const artistName of artistNames) {
        const artistId = getArtistSlug(artistName);
        if (artistId === 'hlt' || artistId === 'bs' || artistId === 'hlt-bs') continue;

        if (!artistGroupMap[artistId]) {
          const metadata = findArtistMetadata(artistsMetadata, artistId);
          const hasCustomImage = Boolean(metadata.hasCustomImage === true && metadata.profileImageUrl && !metadata.profileImageUrl.includes('default'));
          const profileImageUrl = hasCustomImage ? (metadata.profileImageUrl || `${publicDomain}/artists/${artistId}/profile.jpg`) : '';

          artistGroupMap[artistId] = {
            artistId,
            artistName: metadata.artistName || artistName,
            profileImageUrl,
            hasCustomImage,
            instagramUrl: metadata.instagramUrl || '',
            bio: metadata.bio || '',
            songCount: 0,
            updatedAt: metadata.updatedAt || null,
          };
        }

        artistGroupMap[artistId].songCount++;
      }
    }

    // Also include and merge artists directly from artistsMetadata (config/artists.json in R2)
    for (const [slug, meta] of Object.entries(artistsMetadata || {})) {
      if (slug === 'hlt' || slug === 'bs' || slug === 'hlt-bs') continue;
      const canonicalSlug = getArtistSlug(slug);
      const hasCustomImage = Boolean(meta.hasCustomImage === true && meta.profileImageUrl && !meta.profileImageUrl.includes('default'));
      const profileImageUrl = hasCustomImage ? (meta.profileImageUrl || `${publicDomain}/artists/${canonicalSlug}/profile.jpg`) : '';

      if (artistGroupMap[canonicalSlug]) {
        artistGroupMap[canonicalSlug].artistName = meta.artistName || artistGroupMap[canonicalSlug].artistName;
        artistGroupMap[canonicalSlug].hasCustomImage = hasCustomImage;
        artistGroupMap[canonicalSlug].profileImageUrl = profileImageUrl;
        artistGroupMap[canonicalSlug].instagramUrl = meta.instagramUrl || artistGroupMap[canonicalSlug].instagramUrl;
        artistGroupMap[canonicalSlug].bio = meta.bio || artistGroupMap[canonicalSlug].bio;
        artistGroupMap[canonicalSlug].updatedAt = meta.updatedAt || artistGroupMap[canonicalSlug].updatedAt;
      } else {
        artistGroupMap[canonicalSlug] = {
          artistId: canonicalSlug,
          artistName: meta.artistName || normalizeArtistName(canonicalSlug.replaceAll('-', ' ')),
          profileImageUrl,
          hasCustomImage,
          instagramUrl: meta.instagramUrl || '',
          bio: meta.bio || '',
          songCount: 0,
          updatedAt: meta.updatedAt || null,
        };
      }
    }

    // Convert map to list and sort by song count descending, then alphabetical
    const artistsList = Object.values(artistGroupMap).sort((a, b) => {
      const countDiff = b.songCount - a.songCount;
      if (countDiff !== 0) return countDiff;
      return a.artistName.localeCompare(b.artistName);
    });

    return res.json({
      success: true,
      count: artistsList.length,
      artists: artistsList,
    });
  } catch (err) {
    console.error('[API_GET_ARTISTS_ERROR]', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to fetch artists' });
  }
});

/**
 * GET /api/artists/:artistId and GET /admin/artists/:artistId
 * Returns artist profile details and ONLY songs belonging to that artist.
 */
app.get(['/api/artists/:artistId', '/admin/artists/:artistId'], async (req, res) => {
  try {
    const { artistId } = req.params;
    const targetSlug = getArtistSlug(artistId);

    const songsMap = await getAllKnownSongs();
    const artistsMetadata = await fetchArtistsMetadataFromR2();
    const metadata = findArtistMetadata(artistsMetadata, targetSlug);

    const matchingSongs = [];
    let resolvedArtistName = metadata.artistName || '';

    for (const song of Object.values(songsMap)) {
      if (!song.youtubeVideoId) continue;
      const artistNames = extractArtistsFromSong(song.songTitle, song.artist, 'HLT&BS Official Music');
      const songArtistSlugs = artistNames.map(getArtistSlug);

      if (songArtistSlugs.includes(targetSlug)) {
        const specificName = artistNames.find(name => getArtistSlug(name) === targetSlug) || artistNames[0];
        if (!resolvedArtistName) resolvedArtistName = specificName;
        matchingSongs.push({
          id: song.youtubeVideoId,
          title: song.songTitle,
          artist: artistNames.join(' & '),
          artistId: targetSlug,
          duration: song.duration || '0:00',
          formattedDuration: song.duration || '0:00',
          thumbnailUrl: `https://i.ytimg.com/vi/${song.youtubeVideoId}/hqdefault.jpg`,
          audioUrl: song.publicUrl || song.r2AudioUrl || null,
          isAudioUploaded: !!(song.publicUrl || song.r2AudioUrl),
        });
      }
    }

    if (!resolvedArtistName) {
      resolvedArtistName = normalizeArtistName(artistId.replaceAll('-', ' '));
    }

    const hasCustomImage = Boolean(metadata.hasCustomImage === true && metadata.profileImageUrl && !metadata.profileImageUrl.includes('default'));
    const profileImageUrl = hasCustomImage ? (metadata.profileImageUrl || `${publicDomain}/artists/${targetSlug}/profile.jpg`) : '';

    return res.json({
      success: true,
      artist: {
        artistId: targetSlug,
        artistName: resolvedArtistName,
        profileImageUrl,
        hasCustomImage,
        instagramUrl: metadata.instagramUrl || '',
        bio: metadata.bio || '',
        songCount: matchingSongs.length,
        songs: matchingSongs,
        updatedAt: metadata.updatedAt || null,
      },
    });
  } catch (err) {
    console.error('[API_GET_ARTIST_DETAIL_ERROR]', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to fetch artist details' });
  }
});

/**
 * POST /admin/artists/:artistId/profile and POST /api/artists/:artistId/profile
 * Updates artist profile metadata (artistName, instagramUrl, bio) and persists to Cloudflare R2.
 */
app.post([
  '/admin/artists/:artistId/profile',
  '/api/artists/:artistId/profile',
  '/admin/artists/:artistId',
  '/api/artists/:artistId',
], async (req, res) => {
  try {
    const { artistId } = req.params;
    const { artistName, instagramUrl, bio } = req.body;

    const safeSlug = getArtistSlug(artistId);
    const currentMetadata = await fetchArtistsMetadataFromR2();
    const existing = currentMetadata[safeSlug] || {};

    const updatedProfile = {
      artistId: safeSlug,
      artistName: (artistName && artistName.trim()) || existing.artistName || normalizeArtistName(safeSlug.replaceAll('-', ' ')),
      profileImageUrl: existing.profileImageUrl || `${publicDomain}/artists/${safeSlug}/profile.jpg`,
      hasCustomImage: existing.hasCustomImage || false,
      instagramUrl: instagramUrl !== undefined ? String(instagramUrl).trim() : (existing.instagramUrl || ''),
      bio: bio !== undefined ? String(bio).trim() : (existing.bio || ''),
      updatedAt: new Date().toISOString(),
    };

    currentMetadata[safeSlug] = updatedProfile;
    await saveArtistsMetadataToR2(currentMetadata);

    console.log(`[R2_ARTIST_PROFILE_SAVED] Profile for artist "${safeSlug}" saved to R2 config/artists.json`);

    return res.json({
      success: true,
      message: 'Artist profile updated and persisted to Cloudflare R2',
      artist: updatedProfile,
    });
  } catch (err) {
    console.error('[R2_ARTIST_PROFILE_POST_ERROR]', err);
    return res.status(500).json({
      success: false,
      error: `Failed to update artist profile in Cloudflare R2: ${err.message || err.toString()}`,
    });
  }
});

/**
 * POST /admin/artists/:artistId/profile-image and POST /api/artists/:artistId/profile-image
 * Uploads/changes artist profile image directly to Cloudflare R2 and persists config/artists.json in R2.
 */
app.post([
  '/admin/artists/:artistId/profile-image',
  '/api/artists/:artistId/profile-image',
  '/admin/artists/:artistId/image',
  '/api/artists/:artistId/image',
], (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: `Multer file parsing error: ${err.message}` });
    req.file = req.files?.[0] || req.file;
    next();
  });
}, async (req, res) => {
  try {
    const { artistId } = req.params;
    const { artistName } = req.body;
    const file = req.file;

    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'No image file uploaded or file buffer is empty.' });
    }

    const safeSlug = getArtistSlug(artistId);
    const r2Key = `artists/${safeSlug}/profile.jpg`;
    let contentType = file.mimetype || 'image/jpeg';
    if (!contentType || contentType === 'application/octet-stream' || !contentType.startsWith('image/')) {
      if (file.buffer && file.buffer.length >= 4) {
        if (file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff) {
          contentType = 'image/jpeg';
        } else if (file.buffer[0] === 0x89 && file.buffer[1] === 0x50 && file.buffer[2] === 0x4e && file.buffer[3] === 0x47) {
          contentType = 'image/png';
        } else {
          contentType = 'image/jpeg';
        }
      } else {
        contentType = 'image/jpeg';
      }
    }

    console.log(`[R2_ARTIST_IMAGE_START] Uploading artist profile image to R2: key="${r2Key}", size=${file.size || file.buffer.length} bytes, type="${contentType}"`);

    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: r2Key,
      Body: file.buffer,
      ContentType: contentType,
      Metadata: {
        artistId: safeSlug,
        uploadedBy: 'admin-panel',
      },
    });

    await s3Client.send(putCommand);

    const imageUrl = `${publicDomain}/${r2Key}`;

    // Read current artists metadata from R2, update, and write back to R2
    const currentMetadata = await fetchArtistsMetadataFromR2();
    const existing = currentMetadata[safeSlug] || {};

    currentMetadata[safeSlug] = {
      ...existing,
      artistId: safeSlug,
      artistName: (artistName && artistName.trim()) || existing.artistName || normalizeArtistName(safeSlug.replaceAll('-', ' ')),
      profileImageUrl: imageUrl,
      hasCustomImage: true,
      updatedAt: new Date().toISOString(),
    };

    await saveArtistsMetadataToR2(currentMetadata);

    console.log(`[R2_ARTIST_IMAGE_SUCCESS] Artist ${safeSlug} profile image persisted to R2: ${imageUrl}`);

    return res.json({
      success: true,
      message: 'Artist profile image uploaded and persisted to Cloudflare R2',
      artistId: safeSlug,
      profileImageUrl: imageUrl,
      artist: currentMetadata[safeSlug],
    });
  } catch (err) {
    console.error('[R2_ARTIST_IMAGE_ERROR] Upload failed:', err);
    return res.status(500).json({
      success: false,
      error: `Cloudflare R2 image upload failed: ${err.message || err.toString()}`,
    });
  }
});

/**
 * POST /admin/artist/profile
 * Converts profile to JSON and uploads/overwrites config/artist-profile.json in Cloudflare R2.
 */
app.post('/admin/artist/profile', async (req, res) => {
  try {
    const current = await fetchArtistProfileFromR2();
    const { contactNumber, instagramUrl, youtubeUrl } = req.body;

    const updated = {
      contactNumber: contactNumber !== undefined ? String(contactNumber).trim() : current.contactNumber,
      instagramUrl: instagramUrl !== undefined ? String(instagramUrl).trim() : current.instagramUrl,
      youtubeUrl: youtubeUrl !== undefined ? String(youtubeUrl).trim() : current.youtubeUrl,
    };

    await saveArtistProfileToR2(updated);

    return res.json({
      success: true,
      message: 'Artist profile saved and persisted to Cloudflare R2',
      profile: updated,
    });
  } catch (err) {
    console.error('[R2_PROFILE_POST_ERROR] Failed saving profile to Cloudflare R2:', err);
    return res.status(500).json({
      success: false,
      error: `Failed to save artist profile to Cloudflare R2: ${err.message || err.toString()}`,
    });
  }
});

/**
 * GET /admin/songs/status
 * Dynamically scans Cloudflare R2 live bucket contents to return actual upload statuses.
 * Cloudflare R2 is the SINGLE SOURCE OF TRUTH.
 */
app.get('/admin/songs/status', async (req, res) => {
  try {
    const r2Objects = await fetchAllR2Objects();
    const songsMap = {};

    for (const obj of r2Objects) {
      if (!obj.Key) continue;
      const youtubeVideoId = extractYoutubeIdFromKey(obj.Key);
      if (!youtubeVideoId) continue;

      const audioUrl = `${publicDomain}/${encodeURIComponent(obj.Key).replaceAll('%2F', '/')}`;

      const songData = {
        uploaded: true,
        r2Key: obj.Key,
        publicUrl: audioUrl,
        youtubeVideoId,
        r2ObjectKey: obj.Key,
        r2AudioUrl: audioUrl,
        fileSize: obj.Size,
        lastModified: obj.LastModified,
        uploadStatus: 'UPLOADED',
      };

      // Map primary key (extracted YouTube ID)
      songsMap[youtubeVideoId] = songData;

      // Also map raw obj.Key if different to support fallback matches
      if (obj.Key !== youtubeVideoId) {
        songsMap[obj.Key] = songData;
      }
    }

    console.log(`[R2_STATUS_CHECK] Live R2 scan: ${r2Objects.length} total objects, ${Object.keys(songsMap).length} mapped keys`);

    return res.json({
      success: true,
      source: 'Cloudflare_R2_Live',
      count: r2Objects.length,
      songs: songsMap,
    });
  } catch (err) {
    console.error('[R2_STATUS_ERROR] Cloudflare R2 live scan failed:', err);
    return res.status(500).json({
      success: false,
      error: `Cloudflare R2 scan failed: ${err.message || err.toString()}`,
      count: 0,
      songs: {},
    });
  }
});

/**
 * GET /admin/r2/files
 * Lists real object keys directly from Cloudflare R2 bucket
 */
app.get('/admin/r2/files', async (req, res) => {
  try {
    const r2Objects = await fetchAllR2Objects();
    const files = r2Objects.map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
      url: `${publicDomain}/${encodeURIComponent(obj.Key).replaceAll('%2F', '/')}`,
    }));
    res.json({ success: true, count: files.length, files });
  } catch (err) {
    console.error('[R2_ERROR] ListObjectsV2 failed:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed listing R2 objects' });
  }
});

/**
 * POST /admin/upload-song
 * REAL Cloudflare R2 Multipart File Upload with DUPLICATE UPLOAD PROTECTION
 * Uses NEW naming convention: music/<youtubeVideoId>__<safeSongTitle>.<ext> for new uploads
 */
app.post('/admin/upload-song', upload.single('audioFile'), async (req, res) => {
  try {
    const file = req.file;
    const { youtubeVideoId, songTitle, artist, duration } = req.body;

    if (!youtubeVideoId) {
      return res.status(400).json({ success: false, error: 'Missing youtubeVideoId parameter.' });
    }

    // 1. DUPLICATE CHECK: Verify if Cloudflare R2 already contains an object for this YouTube Video ID
    const r2Objects = await fetchAllR2Objects();
    const existingObject = r2Objects.find(obj => {
      if (!obj.Key) return false;
      const ytId = extractYoutubeIdFromKey(obj.Key);
      return ytId === youtubeVideoId;
    });

    if (existingObject) {
      const existingAudioUrl = `${publicDomain}/${encodeURIComponent(existingObject.Key).replaceAll('%2F', '/')}`;
      console.log(`[R2_DUPLICATE_PREVENTED] Song ${youtubeVideoId} already exists in R2 at key="${existingObject.Key}"`);

      return res.json({
        success: true,
        status: 'already_uploaded',
        uploaded: true,
        message: 'Song already exists in Cloudflare R2 bucket.',
        r2Key: existingObject.Key,
        publicUrl: existingAudioUrl,
        r2ObjectKey: existingObject.Key,
        r2AudioUrl: existingAudioUrl,
        youtubeVideoId,
        song: {
          youtubeVideoId,
          songTitle: songTitle || 'Untitled Song',
          artist: artist || 'HLT&BS Official Music',
          duration: duration || '0:00',
          r2Key: existingObject.Key,
          publicUrl: existingAudioUrl,
          r2ObjectKey: existingObject.Key,
          r2AudioUrl: existingAudioUrl,
          uploaded: true,
          uploadStatus: 'UPLOADED',
        },
      });
    }

    if (!file) {
      return res.status(400).json({ success: false, error: 'No audio file uploaded in multipart request.' });
    }

    const lowerName = file.originalname.toLowerCase();
    let ext = '.mp3';
    if (lowerName.endsWith('.m4a')) ext = '.m4a';
    if (lowerName.endsWith('.wav')) ext = '.wav';

    // R2 Object Key format for NEW uploads:
    // music/<youtubeVideoId>__<safeSongTitle>.<ext>
    const rawTitle = songTitle || req.body?.songTitle || req.body?.title || req.body?.song_title || '';
    const safeTitle = sanitizeTitle(rawTitle);
    const objectKey = safeTitle
      ? `music/${youtubeVideoId}__${safeTitle}${ext}`
      : `music/${youtubeVideoId}${ext}`;

    // Determine Content-Type header
    let contentType = 'audio/mpeg';
    if (ext === '.m4a') contentType = 'audio/mp4';
    if (ext === '.wav') contentType = 'audio/wav';

    console.log(`[R2_UPLOAD_START] Uploading file to R2: key="${objectKey}", size=${file.size} bytes`);

    // PutObjectCommand to Cloudflare R2
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: file.buffer,
      ContentType: contentType,
      Metadata: {
        youtubeId: youtubeVideoId,
        songTitle: songTitle || '',
        uploadedBy: 'admin-panel',
      },
    });

    const r2Response = await s3Client.send(putCommand);
    console.log(`[R2_UPLOAD_SUCCESS] Cloudflare R2 confirmed upload for key="${objectKey}", ETag=${r2Response.ETag}`);

    // Public audio URL
    const audioUrl = `${publicDomain}/${encodeURIComponent(objectKey).replaceAll('%2F', '/')}`;

    const songEntry = {
      youtubeVideoId,
      songTitle: songTitle || 'Untitled Song',
      artist: artist ? normalizeArtistName(artist) : extractArtistFromSong(songTitle, null, 'HLT&BS Official Music'),
      duration: duration || '0:00',
      r2Key: objectKey,
      publicUrl: audioUrl,
      r2ObjectKey: objectKey,
      r2AudioUrl: audioUrl,
      uploadedAt: new Date().toISOString(),
      fileSize: file.size,
      uploaded: true,
      uploadStatus: 'UPLOADED',
      etag: r2Response.ETag,
    };

    // Save to local songs db
    const localDb = getLocalSongsDb();
    localDb[youtubeVideoId] = songEntry;
    saveLocalSongsDb(localDb);

    return res.json({
      success: true,
      status: 'uploaded',
      uploaded: true,
      message: 'Uploaded successfully to Cloudflare R2',
      r2Key: objectKey,
      publicUrl: audioUrl,
      r2ObjectKey: objectKey,
      r2AudioUrl: audioUrl,
      fileSize: file.size,
      youtubeVideoId,
      song: songEntry,
    });
  } catch (err) {
    console.error('[R2_UPLOAD_ERROR] Cloudflare R2 Upload Failed:', err);
    return res.status(500).json({
      success: false,
      error: `Cloudflare R2 Upload Failed: ${err.message || err.toString()}`,
    });
  }
});

/**
 * DELETE /admin/songs/:id
 * Safely deletes an audio file from Cloudflare R2 and removes its metadata from the song catalog database.
 * Strict Error Safety: If R2 deletion fails, the local catalog record is NOT removed.
 */
app.delete('/admin/songs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing song ID parameter.' });
    }

    const localDb = getLocalSongsDb();
    let exactR2Key = localDb[id]?.r2ObjectKey || localDb[id]?.r2Key || null;

    // If not directly found in local db, scan live R2 objects
    if (!exactR2Key) {
      const r2Objects = await fetchAllR2Objects();
      const matchingObject = r2Objects.find(obj => {
        if (!obj.Key) return false;
        const ytId = extractYoutubeIdFromKey(obj.Key);
        return ytId === id || obj.Key === id;
      });
      if (matchingObject) {
        exactR2Key = matchingObject.Key;
      }
    }

    if (!exactR2Key) {
      console.warn(`[R2_DELETE_NOT_FOUND] Song ${id} not found in Cloudflare R2 bucket or local DB`);
      return res.status(404).json({
        success: false,
        error: `Song with ID "${id}" was not found in storage or catalog database.`,
      });
    }

    console.log(`[R2_DELETE_START] Deleting R2 object key: "${exactR2Key}" for song ID "${id}" from bucket "${bucketName}"`);

    // 1. Delete object directly from Cloudflare R2
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: exactR2Key,
    });

    await s3Client.send(deleteCommand);
    console.log(`[R2_DELETE_SUCCESS] Confirmed deletion of "${exactR2Key}" from Cloudflare R2 bucket`);

    // 2. Only remove from catalog AFTER Cloudflare R2 deletion successfully completes
    delete localDb[id];
    delete localDb[exactR2Key];
    saveLocalSongsDb(localDb);

    return res.json({
      success: true,
      message: 'Song deleted successfully from Cloudflare R2 and catalog.',
      youtubeVideoId: id,
      deletedKey: exactR2Key,
    });
  } catch (err) {
    console.error('[R2_DELETE_ERROR] Failed deleting song from Cloudflare R2:', err);
    return res.status(500).json({
      success: false,
      error: 'Unable to delete the file from storage. Song was not removed.',
      details: err.message || err.toString(),
    });
  }
});

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`Backend listening on ${HOST}:${PORT}`);
  console.log(`Windows Host: http://localhost:${PORT}`);
  console.log(`Android Emulator: http://10.0.2.2:${PORT}`);
  console.log(`Cloudflare R2 Bucket: ${bucketName}`);
  console.log(`=======================================================`);
});
