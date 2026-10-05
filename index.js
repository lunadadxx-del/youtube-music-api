import crypto from 'crypto';
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

// Secure in-memory session store with TTL (24 hours)
const activeAdminSessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Periodic cleanup of expired sessions every 30 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of activeAdminSessions.entries()) {
    if (!session || now > session.expiresAt) {
      activeAdminSessions.delete(token);
    }
  }
}, 30 * 60 * 1000);
if (cleanupInterval.unref) cleanupInterval.unref();

const requireAdminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const session = activeAdminSessions.get(token);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
  }

  if (Date.now() > session.expiresAt) {
    activeAdminSessions.delete(token);
    return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
  }

  req.adminUser = session.username;
  next();
};

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
const bannersMetadataR2Key = 'config/banners.json';
const adminSongsMetadataR2Key = 'config/admin_songs.json';
const localArtistsFilePath = path.join(__dirname, 'data', 'artists.json');
const localBannersFilePath = path.join(__dirname, 'data', 'banners.json');
const localAdminSongsFilePath = path.join(__dirname, 'data', 'admin_songs.json');
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
    'banjara holi old lyrics dj songs', 'super chori', 'banjara song', 'banjara dj song',
    'super', 'dj songs', 'banjara', 'girls dance', 'dj dance video', 'caming soon',
    'shoot video', 'runningsuccessfully', 'sasu bodi', 'comedy', 'kalinasha song', 'new'
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
  clean = clean.replace(/\s+(?:lyrics|mix|remix|dj\s*mix|full\s*song|song|audio|video|official|music|edm\s*mix|official\s*video|pre\s*wedding\s*shoot|comedy\s*dj\s*song|dance|video\s*song|caming\s*soon|coming\s*soon)$/i, '');

  return clean.trim();
}

/**
 * Canonical artists directory mapping all spelling/title variations to permanent canonical identities
 */
const CANONICAL_ARTISTS_CATALOG = [
  {
    name: 'DJ Nagaraj',
    slug: 'dj-nagaraj',
    aliases: [
      'dj nagaraj', 'dj nagaraja', 'nagaraja', 'nagaraj', 'nagaraj dj', 'nagaraja dj',
      'singer nagaraj', 'singer nagaraja', 'singer dj nagaraj', 'dj nagaraj mix',
      'dj nagaraj official', 'dj nagaraj songs', 'singing nagaraj dj', 'singing nagaraja dj'
    ]
  },
  {
    name: 'Praveen Bandri',
    slug: 'praveen-bandri',
    aliases: [
      'praveen bandri', 'praveen bandari', 'singer praveen bandri', 'praveen bandri music',
      'praveen', 'singing praveen bandri'
    ]
  },
  {
    name: 'Bhima BS',
    slug: 'bhima-bs',
    aliases: [
      'bhima bs', 'bhima b s', 'bheem bs', 'bheema bs', 'singer bhima bs',
      'lyrics bhima bs', 'bhima_bs', 'bhima bs studio', 'bhima'
    ]
  },
  {
    name: 'Sunil BS',
    slug: 'sunil-bs',
    aliases: [
      'sunil bs', 'sunil b s', 'sunil_bs', 'sunil', 'singer sunil bs',
      'singing sunil bs', 'singin sunil bs', 'singing by sunil'
    ]
  },
  {
    name: 'Gururaj Krg',
    slug: 'gururaj-krg',
    aliases: [
      'gururaj krg', 'gururaj', 'guru krg', 'gururaja krg', 'singer gururaja krg',
      'guru raj krg', 'singing guru raj krg', 'singing gururaj krg', 'guru raj',
      'gururaj k', 'gururaj k a', 'singer gururaj'
    ]
  },
  {
    name: 'Harish HLT',
    slug: 'harish-hlt',
    aliases: [
      'harish hlt', 'harish', 'h harish', 'dj harish hlt', 'dj harish', 'harish_hlt'
    ]
  },
  {
    name: 'Lakshman Vakdoth',
    slug: 'lakshman-vakdoth',
    aliases: [
      'lakshman vakdoth', 'laxman vakdoth', 'lokeshman vakdoth', 'lakshman', 'laxman',
      'singar lakshman vakdoth', 'laxman vakdoth'
    ]
  },
  {
    name: 'LD Annapa',
    slug: 'ld-annapa',
    aliases: [
      'ld annapa', 'ld annappa', 'annapa', 'annappa', 'singer ld annapa'
    ]
  },
  {
    name: 'Duniya LG',
    slug: 'duniya-lg',
    aliases: [
      'duniya lg', 'duniya', 'duniya_lg'
    ]
  },
  {
    name: 'M Kubera Naik',
    slug: 'm-kubera-naik',
    aliases: [
      'm kubera naik', 'm kuber naik', 'kubera naik', 'kuber naik', 'kubera'
    ]
  },
  {
    name: 'Raja RL',
    slug: 'raja-rl',
    aliases: [
      'raja rl', 'raja ai', 'raja', 'raja rl caming soon', 'raja_rl'
    ]
  },
  {
    name: 'Sanjana Lambani',
    slug: 'sanjana-lambani',
    aliases: [
      'sanjana lambani', 'sanjana lamani', 'sanjana'
    ]
  },
  {
    name: 'Jeeva PS',
    slug: 'jeeva-ps',
    aliases: [
      'jeeva ps', 'teeva ps', 'jeeva'
    ]
  },
  {
    name: 'MJPS',
    slug: 'mjps',
    aliases: [
      'mjps'
    ]
  },
  {
    name: 'Sumitra',
    slug: 'sumitra',
    aliases: [
      'sumitra', 'sumithra', 'singer sumitra', 'singer sumithra'
    ]
  },
  {
    name: 'Aishu',
    slug: 'aishu',
    aliases: [
      'aishu', 'singer aishu'
    ]
  },
  {
    name: 'S.M Somesh Naik',
    slug: 's-m-somesh-naik',
    aliases: [
      's.m somesh naik', 'somesh naik', 'sm somesh naik', 's.m somesh', 's.m_somesh', 'somesh'
    ]
  },
  {
    name: 'N Lokesh Naik',
    slug: 'n-lokesh-naik',
    aliases: [
      'n lokesh naik', 'lokesh naik', 'n lokesh'
    ]
  },
  {
    name: 'Janu Lambani',
    slug: 'janu-lambani',
    aliases: [
      'janu lambani'
    ]
  },
  {
    name: 'B N Prashantha',
    slug: 'b-n-prashantha',
    aliases: [
      'b n prashantha', 'bn prashantha', 'prashantha'
    ]
  },
  {
    name: 'Renu Rathod',
    slug: 'renu-rathod',
    aliases: [
      'renu rathod'
    ]
  },
  {
    name: 'Hundar Krishna',
    slug: 'hundar-krishna',
    aliases: [
      'hundar krishna'
    ]
  },
  {
    name: 'CHS Banjar',
    slug: 'chs-banjar',
    aliases: [
      'chs banjar', 'chs banjara'
    ]
  },
  {
    name: 'Chetu CH',
    slug: 'chetu-ch',
    aliases: [
      'chetu ch'
    ]
  },
  {
    name: 'Tukaram PS',
    slug: 'tukaram-ps',
    aliases: [
      'tukaram ps'
    ]
  },
  {
    name: 'Kalpana Pawar',
    slug: 'kalpana-pawar',
    aliases: [
      'kalpana pawar', 'kalpana'
    ]
  },
  {
    name: 'Vishwanath',
    slug: 'vishwanath',
    aliases: [
      'vishwanath'
    ]
  },
  {
    name: 'Ashwini',
    slug: 'ashwini',
    aliases: [
      'ashwini'
    ]
  },
  {
    name: 'Ravi Kiran',
    slug: 'ravi-kiran',
    aliases: [
      'ravi kiran'
    ]
  },
  {
    name: 'Appu',
    slug: 'appu',
    aliases: [
      'appu'
    ]
  },
  {
    name: 'Krishna Kakkur',
    slug: 'krishna-kakkur',
    aliases: [
      'krishna kakkur'
    ]
  },
  {
    name: 'Kirti Lamani',
    slug: 'kirti-lamani',
    aliases: [
      'kirti lamani'
    ]
  },
  {
    name: 'Abhi LS',
    slug: 'abhi-ls',
    aliases: [
      'abhi ls'
    ]
  },
  {
    name: 'Shivakumar',
    slug: 'shivakumar',
    aliases: [
      'shivakumar'
    ]
  },
  {
    name: 'Mahesh Lamani',
    slug: 'mahesh-lamani',
    aliases: [
      'mahesh lamani', 'mahesh lambani'
    ]
  },
  {
    name: 'MP Mahesh',
    slug: 'mp-mahesh',
    aliases: [
      'mp mahesh'
    ]
  },
  {
    name: 'MC Maruti',
    slug: 'mc-maruti',
    aliases: [
      'mc maruti'
    ]
  },
  {
    name: 'Vinod Nayak',
    slug: 'vinod-nayak',
    aliases: [
      'vinod nayak'
    ]
  },
  {
    name: 'Prakash Pujar',
    slug: 'prakash-pujar',
    aliases: [
      'prakash pujar'
    ]
  },
  {
    name: 'Devu R Lamani',
    slug: 'devu-r-lamani',
    aliases: [
      'devu r lamani'
    ]
  },
  {
    name: 'Pandu Naik',
    slug: 'pandu-naik',
    aliases: [
      'pandu naik', 'pandu ps'
    ]
  },
  {
    name: 'Santosh Naik',
    slug: 'santosh-naik',
    aliases: [
      'santosh naik', 'santosh naik lt hb'
    ]
  },
  {
    name: 'DJ Duda Naik',
    slug: 'dj-duda-naik',
    aliases: [
      'dj duda naik', 'duda naik'
    ]
  },
  {
    name: 'Rahul Naik',
    slug: 'rahul-naik',
    aliases: [
      'rahul naik', 'rahul naik d'
    ]
  },
  {
    name: 'C Prajawal',
    slug: 'c-prajawal',
    aliases: [
      'c prajawal', 'prajawal'
    ]
  },
  {
    name: 'VP Venktesh',
    slug: 'vp-venktesh',
    aliases: [
      'vp venktesh', 'venktesh'
    ]
  },
  {
    name: 'RK Sevaraj Rathod',
    slug: 'rk-sevaraj-rathod',
    aliases: [
      'rk sevaraj rathod', 'sevaraj rathod'
    ]
  },
  {
    name: 'Somesh Chanakya',
    slug: 'somesh-chanakya',
    aliases: [
      'somesh chanakya', 'chanakya'
    ]
  },
  {
    name: 'Arun Boss MJ',
    slug: 'arun-boss-mj',
    aliases: [
      'arun boss mj', 'arun boss'
    ]
  }
];

function findCanonicalArtist(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const lower = rawName.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const artist of CANONICAL_ARTISTS_CATALOG) {
    if (artist.name.toLowerCase() === lower || artist.slug === lower) {
      return artist;
    }
    for (const alias of artist.aliases) {
      if (alias === lower) {
        return artist;
      }
    }
  }
  return null;
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

  const matched = findCanonicalArtist(clean);
  if (matched) {
    return matched.name;
  }

  // Auto Title-Case formatting for any other artist
  return clean.split(' ').map(w => {
    if (!w) return '';
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

/**
 * Helper: Splits compound/multi-artist strings into individual artist names.
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
      // Check if this part contains multiple known canonical artists
      const foundInside = [];
      for (const artist of CANONICAL_ARTISTS_CATALOG) {
        for (const alias of artist.aliases) {
          const regex = new RegExp(`(^|[^A-Za-z0-9])${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i');
          if (regex.test(cleaned)) {
            if (!foundInside.includes(artist.name)) {
              foundInside.push(artist.name);
            }
            break;
          }
        }
      }

      if (foundInside.length > 0) {
        for (const a of foundInside) {
          if (!result.includes(a)) {
            result.push(a);
          }
        }
      } else {
        const norm = normalizeArtistName(cleaned);
        if (norm && norm !== 'HLT&BS Official Music' && !result.includes(norm)) {
          result.push(norm);
        }
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
  if (!artistName || typeof artistName !== 'string') return 'various-artists';
  const clean = cleanArtistToken(artistName);
  const matched = findCanonicalArtist(clean || artistName);
  if (matched) {
    return matched.slug;
  }
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

  // 2. Scan title for known canonical artists
  if (title && typeof title === 'string') {
    const upper = title.toUpperCase();

    for (const artist of CANONICAL_ARTISTS_CATALOG) {
      for (const alias of artist.aliases) {
        const regex = new RegExp(`(^|[^A-Za-z0-9])${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i');
        if (regex.test(upper)) {
          artists.add(artist.name);
          break;
        }
      }
    }

    // 3. Scan for candidate artist names matching credit markers
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
let artistsMetadataWriteLock = Promise.resolve();
async function saveArtistsMetadataToR2(artistsMap) {
  artistsMetadataWriteLock = artistsMetadataWriteLock.then(async () => {
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
      
      const verifyCmd = new GetObjectCommand({ Bucket: bucketName, Key: artistsMetadataR2Key });
      const verifyRes = await s3Client.send(verifyCmd);
      const bodyText = await verifyRes.Body.transformToString('utf-8');
      JSON.parse(bodyText);
    } catch (err) {
      console.error('[R2_ARTISTS_SAVE_ERROR] Failed persisting or verifying artists to R2:', err);
    }

    try {
      const dataDir = path.dirname(localArtistsFilePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const tmpPath = localArtistsFilePath + '.tmp';
      fs.writeFileSync(tmpPath, jsonString, 'utf-8');
      fs.renameSync(tmpPath, localArtistsFilePath);
    } catch (_) {}
  }).catch(() => {});
  return artistsMetadataWriteLock;
}

/**
 * Helper: Asynchronously reads config/banners.json from Cloudflare R2 bucket with local fallback.
 * R2 is the PRIMARY persistent source.
 * Local fallback is strictly for read fallback if R2 is temporarily unreachable.
 */
async function fetchBannersFromR2() {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: bannersMetadataR2Key,
    });
    const response = await s3Client.send(command);
    const bodyText = await response.Body.transformToString('utf-8');
    const parsed = JSON.parse(bodyText);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch (err) {
    if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) {
      console.warn('[R2_BANNERS_READ_WARN] Could not fetch banners from R2:', err.message || err);
    }
    if (fs.existsSync(localBannersFilePath)) {
      try {
        const localData = JSON.parse(fs.readFileSync(localBannersFilePath, 'utf-8'));
        if (Array.isArray(localData)) return localData;
      } catch (_) {}
    }
    return [];
  }
}

/**
 * Helper: Asynchronously uploads/overwrites config/banners.json in Cloudflare R2 bucket.
 * Uses mutex lock to serialize writes.
 */
let bannersMetadataWriteLock = Promise.resolve();
async function saveBannersToR2(bannersList) {
  bannersMetadataWriteLock = bannersMetadataWriteLock.then(async () => {
    const jsonString = JSON.stringify(bannersList, null, 2);
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: bannersMetadataR2Key,
        Body: Buffer.from(jsonString, 'utf-8'),
        ContentType: 'application/json',
      });
      await s3Client.send(command);
      console.log(`[R2_BANNERS_SAVED] Persisted config/banners.json to Cloudflare R2 bucket "${bucketName}"`);

      const verifyCmd = new GetObjectCommand({ Bucket: bucketName, Key: bannersMetadataR2Key });
      const verifyRes = await s3Client.send(verifyCmd);
      const bodyText = await verifyRes.Body.transformToString('utf-8');
      JSON.parse(bodyText);
    } catch (err) {
      console.error('[R2_BANNERS_SAVE_ERROR] Failed persisting or verifying banners to R2:', err);
    }

    try {
      const dataDir = path.dirname(localBannersFilePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const tmpPath = localBannersFilePath + '.tmp';
      fs.writeFileSync(tmpPath, jsonString, 'utf-8');
      fs.renameSync(tmpPath, localBannersFilePath);
    } catch (_) {}
  }).catch(() => {});
  return bannersMetadataWriteLock;
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
    const tmpPath = localSongsDbPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tmpPath, localSongsDbPath);
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
    if (obj.Key.startsWith('config/') || obj.Key.startsWith('artists/') || obj.Key.startsWith('banners/') || obj.Key.startsWith('admin_music/') || obj.Key.startsWith('admin_thumbnails/')) continue;

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
 * Health Check Endpoint for external uptime monitors (UptimeRobot) & Render keep-alive
 * Responds immediately with HTTP 200 without DB/R2/YouTube overhead.
 */
app.get(['/health', '/api/health'], (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'youtube-music-backend',
    serverTime: new Date().toISOString(),
  });
});

/**
 * POST /admin/login
 * Secure authentication against server environment variables (ADMIN_USERNAME & ADMIN_PASSWORD)
 */
const loginRateLimiter = new Map();

app.post('/admin/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const limitWindow = 15 * 60 * 1000;

  let limiter = loginRateLimiter.get(ip);
  if (!limiter) {
    limiter = { count: 0, firstAttempt: now };
    loginRateLimiter.set(ip, limiter);
  }

  if (now - limiter.firstAttempt > limitWindow) {
    limiter.count = 0;
    limiter.firstAttempt = now;
  }

  if (limiter.count >= 5) {
    return res.status(429).json({ success: false, error: 'Too Many Requests' });
  }

  const { username, password } = req.body;

  // Resolve effective credentials, guaranteeing that deprecated credentials are never accepted
  let adminUser = process.env.ADMIN_USERNAME || 'hltbs_official_music@2006';
  let adminPass = process.env.ADMIN_PASSWORD || '@BSDP20022006';

  // Explicit safety safeguard: Invalidate legacy credentials if still present in production environment
  if (adminUser.toLowerCase() === 'admin') {
    adminUser = 'hltbs_official_music@2006';
  }
  if (adminPass === 'bheema@bs7686') {
    adminPass = '@BSDP20022006';
  }

  const trimmedUser = (username || '').trim();
  const trimmedPass = (password || '').trim();

  // Strict check: Only exact match with new credentials passes
  if (trimmedUser.toLowerCase() === adminUser.toLowerCase() && trimmedPass === adminPass) {
    limiter.count = 0;
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminSessions.set(token, {
      username: trimmedUser,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    console.log(`[ADMIN_AUTH] Successful login for user: ${trimmedUser}`);
    return res.json({ success: true, username: trimmedUser, token });
  }

  limiter.count++;
  console.warn(`[ADMIN_AUTH] Failed login attempt for user: ${trimmedUser}`);
  return res.status(401).json({ success: false, error: 'Invalid username or password. Please try again.' });
});

/**
 * POST /admin/logout
 * Securely invalidates active admin session token.
 */
app.post('/admin/logout', requireAdminAuth, (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (token) {
      activeAdminSessions.delete(token);
    }
  }
  return res.json({ success: true, message: 'Logged out successfully' });
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
        if (artistId === 'hlt' || artistId === 'bs' || artistId === 'hlt-bs' || artistId === 'hlt-bs-official-music') continue;

        if (!artistGroupMap[artistId]) {
          const metadata = findArtistMetadata(artistsMetadata, artistId);
          const hasCustomImage = Boolean(metadata.hasCustomImage === true && metadata.profileImageUrl && !metadata.profileImageUrl.includes('default'));
          const profileImageUrl = hasCustomImage ? (metadata.profileImageUrl || `${publicDomain}/artists/${artistId}/profile.jpg`) : '';

          artistGroupMap[artistId] = {
            artistId,
            artistName: metadata.artistName || artistName,
            profileImageUrl,
            hasCustomImage,
            contactNumber: metadata.contactNumber || '',
            instagramUrl: metadata.instagramUrl || '',
            youtubeUrl: metadata.youtubeUrl || '',
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
      if (slug === 'hlt' || slug === 'bs' || slug === 'hlt-bs' || slug === 'hlt-bs-official-music') continue;
      const canonicalSlug = getArtistSlug(slug);
      const hasCustomImage = Boolean(meta.hasCustomImage === true && meta.profileImageUrl && !meta.profileImageUrl.includes('default'));
      const profileImageUrl = hasCustomImage ? (meta.profileImageUrl || `${publicDomain}/artists/${canonicalSlug}/profile.jpg`) : '';

      if (artistGroupMap[canonicalSlug]) {
        artistGroupMap[canonicalSlug].artistName = meta.artistName || artistGroupMap[canonicalSlug].artistName;
        artistGroupMap[canonicalSlug].hasCustomImage = hasCustomImage;
        artistGroupMap[canonicalSlug].profileImageUrl = profileImageUrl;
        artistGroupMap[canonicalSlug].contactNumber = meta.contactNumber || artistGroupMap[canonicalSlug].contactNumber || '';
        artistGroupMap[canonicalSlug].instagramUrl = meta.instagramUrl || artistGroupMap[canonicalSlug].instagramUrl;
        artistGroupMap[canonicalSlug].youtubeUrl = meta.youtubeUrl || artistGroupMap[canonicalSlug].youtubeUrl || '';
        artistGroupMap[canonicalSlug].bio = meta.bio || artistGroupMap[canonicalSlug].bio;
        artistGroupMap[canonicalSlug].updatedAt = meta.updatedAt || artistGroupMap[canonicalSlug].updatedAt;
      } else {
        artistGroupMap[canonicalSlug] = {
          artistId: canonicalSlug,
          artistName: meta.artistName || normalizeArtistName(canonicalSlug.replaceAll('-', ' ')),
          profileImageUrl,
          hasCustomImage,
          contactNumber: meta.contactNumber || '',
          instagramUrl: meta.instagramUrl || '',
          youtubeUrl: meta.youtubeUrl || '',
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
        contactNumber: metadata.contactNumber || '',
        instagramUrl: metadata.instagramUrl || '',
        youtubeUrl: metadata.youtubeUrl || '',
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
], requireAdminAuth, async (req, res) => {
  try {
    const { artistId } = req.params;
    const { artistName, contactNumber, instagramUrl, youtubeUrl, bio } = req.body;

    const safeSlug = getArtistSlug(artistId);
    const currentMetadata = await fetchArtistsMetadataFromR2();
    const existing = currentMetadata[safeSlug] || {};

    const updatedProfile = {
      artistId: safeSlug,
      artistName: (artistName && artistName.trim()) || existing.artistName || normalizeArtistName(safeSlug.replaceAll('-', ' ')),
      profileImageUrl: existing.hasCustomImage ? (existing.profileImageUrl || `${publicDomain}/artists/${safeSlug}/profile.jpg`) : '',
      hasCustomImage: existing.hasCustomImage || false,
      contactNumber: contactNumber !== undefined ? String(contactNumber).trim() : (existing.contactNumber || ''),
      instagramUrl: instagramUrl !== undefined ? String(instagramUrl).trim() : (existing.instagramUrl || ''),
      youtubeUrl: youtubeUrl !== undefined ? String(youtubeUrl).trim() : (existing.youtubeUrl || ''),
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
], requireAdminAuth, (req, res, next) => {
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
app.post('/admin/artist/profile', requireAdminAuth, async (req, res) => {
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
      if (obj.Key.startsWith('config/') || obj.Key.startsWith('artists/') || obj.Key.startsWith('banners/') || obj.Key.startsWith('admin_music/') || obj.Key.startsWith('admin_thumbnails/')) continue;
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
app.get('/admin/r2/files', requireAdminAuth, async (req, res) => {
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
app.post('/admin/upload-song', requireAdminAuth, upload.single('audioFile'), async (req, res) => {
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
app.delete('/admin/songs/:id', requireAdminAuth, async (req, res) => {
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

// ==========================================
// PROMOTIONAL BANNER ENDPOINTS
// ==========================================

/**
 * GET /api/banners
 * Public endpoint: returns all active promotional banners.
 * Sorted newest first.
 */
app.get('/api/banners', async (req, res) => {
  try {
    const banners = await fetchBannersFromR2();
    const activeBanners = banners
      .filter(b => b.isActive !== false)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json({ success: true, banners: activeBanners });
  } catch (err) {
    console.error('[API_BANNERS_ERROR] Error fetching banners:', err);
    return res.json({ success: true, banners: [] });
  }
});

/**
 * GET /admin/banners
 * Admin endpoint: returns all promotional banners (active and inactive).
 */
app.get('/admin/banners', requireAdminAuth, async (req, res) => {
  try {
    const banners = await fetchBannersFromR2();
    banners.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json({ success: true, banners });
  } catch (err) {
    console.error('[ADMIN_BANNERS_ERROR] Error fetching admin banners:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch banners' });
  }
});

/**
 * POST /admin/banners
 * Admin endpoint: creates a new promotional banner.
 * Uploads banner image to banners/ prefix in Cloudflare R2.
 * Metadata stored persistently in config/banners.json.
 */
app.post('/admin/banners', requireAdminAuth, upload.single('bannerImage'), async (req, res) => {
  try {
    const title = (req.body?.title || '').trim();
    const description = (req.body?.description || '').trim();
    const actionType = req.body?.actionType || 'none';
    const songId = (req.body?.songId || '').trim() || null;
    const actionUrl = (req.body?.actionUrl || '').trim() || null;
    const isActive = req.body?.isActive === undefined || req.body?.isActive === 'true' || req.body?.isActive === true;

    if (!title) {
      return res.status(400).json({ success: false, error: 'Banner title is required.' });
    }

    let imageUrl = (req.body?.imageUrl || '').trim();
    let r2Key = null;

    if (req.file) {
      const bannerUid = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const lowerName = req.file.originalname.toLowerCase();
      let ext = '.jpg';
      if (lowerName.endsWith('.png')) ext = '.png';
      if (lowerName.endsWith('.webp')) ext = '.webp';
      if (lowerName.endsWith('.jpeg')) ext = '.jpeg';

      r2Key = `banners/banner_${bannerUid}${ext}`;
      let contentType = req.file.mimetype || 'image/jpeg';

      const putCmd = new PutObjectCommand({
        Bucket: bucketName,
        Key: r2Key,
        Body: req.file.buffer,
        ContentType: contentType,
      });
      await s3Client.send(putCmd);
      imageUrl = `${publicDomain}/${encodeURIComponent(r2Key).replaceAll('%2F', '/')}`;
      console.log(`[R2_BANNER_UPLOAD] Banner image uploaded to ${r2Key}`);
    }

    if (!imageUrl) {
      return res.status(400).json({ success: false, error: 'Banner image is required.' });
    }

    const bannerId = `banner_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const newBanner = {
      id: bannerId,
      title,
      description,
      imageUrl,
      r2Key,
      actionType,
      songId,
      actionUrl,
      isActive,
      createdAt: new Date().toISOString(),
    };

    const banners = await fetchBannersFromR2();
    banners.unshift(newBanner);
    await saveBannersToR2(banners);

    return res.json({ success: true, banner: newBanner });
  } catch (err) {
    console.error('[ADMIN_CREATE_BANNER_ERROR] Error creating banner:', err);
    return res.status(500).json({ success: false, error: `Failed to create banner: ${err.message || err}` });
  }
});

/**
 * PATCH /admin/banners/:id/status
 * Admin endpoint: toggles or sets active state of a banner.
 */
app.patch('/admin/banners/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const banners = await fetchBannersFromR2();
    const bannerIndex = banners.findIndex(b => b.id === id);
    if (bannerIndex === -1) {
      return res.status(404).json({ success: false, error: 'Banner not found' });
    }

    const current = banners[bannerIndex];
    const updatedIsActive = req.body?.isActive !== undefined
      ? (req.body.isActive === true || req.body.isActive === 'true')
      : !current.isActive;

    banners[bannerIndex] = { ...current, isActive: updatedIsActive };
    await saveBannersToR2(banners);

    return res.json({ success: true, banner: banners[bannerIndex] });
  } catch (err) {
    console.error('[ADMIN_BANNER_STATUS_ERROR] Error updating banner status:', err);
    return res.status(500).json({ success: false, error: 'Failed to update banner status' });
  }
});

/**
 * DELETE /admin/banners/:id
 * Strictly scoped: ONLY deletes image files starting with 'banners/'.
 * NEVER touches 'music/*', audio files, or artist images.
 */
app.delete('/admin/banners/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const banners = await fetchBannersFromR2();
    const banner = banners.find(b => b.id === id);
    if (!banner) {
      return res.status(404).json({ success: false, error: 'Banner not found' });
    }

    // STRICT ISOLATION GUARD: ONLY delete if key starts with 'banners/'
    if (banner.r2Key && typeof banner.r2Key === 'string' && banner.r2Key.startsWith('banners/')) {
      try {
        const delCmd = new DeleteObjectCommand({
          Bucket: bucketName,
          Key: banner.r2Key,
        });
        await s3Client.send(delCmd);
        console.log(`[R2_BANNER_DELETED] Deleted banner image ${banner.r2Key} from bucket ${bucketName}`);
      } catch (delErr) {
        console.warn('[R2_BANNER_DELETE_WARN] Could not delete banner image from R2:', delErr.message);
      }
    }

    const remaining = banners.filter(b => b.id !== id);
    await saveBannersToR2(remaining);

    return res.json({ success: true, message: 'Banner deleted successfully' });
  } catch (err) {
    console.error('[ADMIN_BANNER_DELETE_ERROR] Error deleting banner:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete banner' });
  }
});

// ==========================================
// STANDALONE ADMIN SONGS HELPERS & ENDPOINTS
// ==========================================

/**
 * Helper: Asynchronously reads config/admin_songs.json from Cloudflare R2 bucket with local fallback.
 * R2 is the PRIMARY persistent source for standalone admin songs.
 */
async function fetchAdminSongsFromR2() {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: adminSongsMetadataR2Key,
    });
    const response = await s3Client.send(command);
    const bodyText = await response.Body.transformToString('utf-8');
    const parsed = JSON.parse(bodyText);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch (err) {
    if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) {
      console.warn('[R2_ADMIN_SONGS_READ_WARN] Could not fetch admin songs from R2:', err.message || err);
    }
    if (fs.existsSync(localAdminSongsFilePath)) {
      try {
        const localData = JSON.parse(fs.readFileSync(localAdminSongsFilePath, 'utf-8'));
        if (Array.isArray(localData)) return localData;
      } catch (_) {}
    }
    return [];
  }
}

/**
 * Helper: Asynchronously uploads/overwrites config/admin_songs.json in Cloudflare R2 bucket.
 * Uses mutex lock to serialize writes.
 */
let adminSongsMetadataWriteLock = Promise.resolve();
async function saveAdminSongsToR2(songsList) {
  adminSongsMetadataWriteLock = adminSongsMetadataWriteLock.then(async () => {
    const jsonString = JSON.stringify(songsList, null, 2);
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: adminSongsMetadataR2Key,
        Body: Buffer.from(jsonString, 'utf-8'),
        ContentType: 'application/json',
      });
      await s3Client.send(command);
      console.log(`[R2_ADMIN_SONGS_SAVED] Persisted config/admin_songs.json to Cloudflare R2 bucket "${bucketName}"`);

      const verifyCmd = new GetObjectCommand({ Bucket: bucketName, Key: adminSongsMetadataR2Key });
      const verifyRes = await s3Client.send(verifyCmd);
      const bodyText = await verifyRes.Body.transformToString('utf-8');
      JSON.parse(bodyText);
    } catch (err) {
      console.error('[R2_ADMIN_SONGS_SAVE_ERROR] Failed persisting or verifying admin songs to R2:', err);
    }

    try {
      const dataDir = path.dirname(localAdminSongsFilePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(localAdminSongsFilePath, jsonString, 'utf-8');
    } catch (fileErr) {
      console.warn('[LOCAL_ADMIN_SONGS_WARN] Could not write local cache of admin songs:', fileErr.message);
    }
  });
  return adminSongsMetadataWriteLock;
}

/**
 * Helper: Parses image dimensions from buffer (PNG, JPEG, WEBP) without external dependencies.
 */
function getImageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  // PNG: signature 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  }
  // JPEG: starts with FF D8
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }
      const length = buffer.readUInt16BE(offset + 2);
      offset += 2 + length;
    }
  }
  // WEBP: RIFF....WEBP
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunkHeader = buffer.toString('ascii', 12, 16);
    if (chunkHeader === 'VP8 ') {
      const width = (buffer.readUInt16LE(26) & 0x3FFF);
      const height = (buffer.readUInt16LE(28) & 0x3FFF);
      return { width, height };
    }
    if (chunkHeader === 'VP8L') {
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      const width = 1 + (((b1 & 0x3F) << 8) | b0);
      const height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
      return { width, height };
    }
    if (chunkHeader === 'VP8X') {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height };
    }
  }
  return null;
}

/**
 * GET /api/standalone-songs
 * Public endpoint: returns all standalone admin songs.
 * Sorted newest first.
 */
app.get('/api/standalone-songs', async (req, res) => {
  try {
    const songs = await fetchAdminSongsFromR2();
    songs.sort((a, b) => new Date(b.publishedAt || b.createdAt || 0) - new Date(a.publishedAt || a.createdAt || 0));
    return res.json({ success: true, count: songs.length, songs });
  } catch (err) {
    console.error('[API_STANDALONE_SONGS_ERROR] Error fetching standalone songs:', err);
    return res.json({ success: true, count: 0, songs: [] });
  }
});

/**
 * GET /admin/standalone-songs
 * Admin endpoint: returns all standalone admin songs.
 */
app.get('/admin/standalone-songs', requireAdminAuth, async (req, res) => {
  try {
    const songs = await fetchAdminSongsFromR2();
    songs.sort((a, b) => new Date(b.publishedAt || b.createdAt || 0) - new Date(a.publishedAt || a.createdAt || 0));
    return res.json({ success: true, count: songs.length, songs });
  } catch (err) {
    console.error('[ADMIN_STANDALONE_SONGS_ERROR] Error fetching admin standalone songs:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch standalone songs' });
  }
});

/**
 * POST /admin/standalone-songs
 * Admin endpoint: uploads a standalone audio file & square thumbnail to Cloudflare R2.
 * Metadata stored in config/admin_songs.json.
 */
app.post('/admin/standalone-songs', requireAdminAuth, upload.fields([
  { name: 'audioFile', maxCount: 1 },
  { name: 'thumbnailFile', maxCount: 1 },
]), async (req, res) => {
  let uploadedAudioKey = null;
  let uploadedThumbKey = null;

  try {
    const title = (req.body?.title || '').trim();
    if (!title) {
      return res.status(400).json({ success: false, error: 'Song title is required and cannot be empty.' });
    }

    const audioFile = req.files?.audioFile?.[0];
    if (!audioFile) {
      return res.status(400).json({ success: false, error: 'Audio file is required.' });
    }

    const thumbFile = req.files?.thumbnailFile?.[0];
    if (!thumbFile) {
      return res.status(400).json({ success: false, error: 'Thumbnail image is required.' });
    }

    // Validate audio format & size
    const audioNameLower = audioFile.originalname.toLowerCase();
    let audioExt = '.mp3';
    let audioContentType = 'audio/mpeg';
    if (audioNameLower.endsWith('.m4a')) {
      audioExt = '.m4a';
      audioContentType = 'audio/mp4';
    } else if (audioNameLower.endsWith('.wav')) {
      audioExt = '.wav';
      audioContentType = 'audio/wav';
    } else if (!audioNameLower.endsWith('.mp3')) {
      return res.status(400).json({ success: false, error: 'Unsupported audio format. Supported formats: MP3, M4A, WAV.' });
    }

    if (audioFile.size < 10000) {
      return res.status(400).json({ success: false, error: 'Audio file appears to be empty or corrupted (< 10 KB).' });
    }

    // Validate thumbnail format & square dimensions
    const thumbNameLower = thumbFile.originalname.toLowerCase();
    let thumbExt = '.jpg';
    let thumbContentType = 'image/jpeg';
    if (thumbNameLower.endsWith('.png')) {
      thumbExt = '.png';
      thumbContentType = 'image/png';
    } else if (thumbNameLower.endsWith('.webp')) {
      thumbExt = '.webp';
      thumbContentType = 'image/webp';
    } else if (thumbNameLower.endsWith('.jpeg')) {
      thumbExt = '.jpeg';
      thumbContentType = 'image/jpeg';
    } else if (!thumbNameLower.endsWith('.jpg')) {
      return res.status(400).json({ success: false, error: 'Unsupported thumbnail format. Supported: JPG, JPEG, PNG, WEBP.' });
    }

    // Square 1:1 aspect ratio validation
    const dims = getImageDimensions(thumbFile.buffer);
    if (dims) {
      if (dims.width !== dims.height) {
        return res.status(400).json({
          success: false,
          error: `Thumbnail must be square (1:1 aspect ratio). Uploaded image is ${dims.width}x${dims.height} px. 512x512 is recommended.`,
        });
      }
    }

    // Generate safe unique song ID
    const songUid = `admin_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const audioKey = `admin_music/${songUid}${audioExt}`;
    const thumbKey = `admin_thumbnails/${songUid}${thumbExt}`;

    // Upload audio to R2
    const putAudioCmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: audioKey,
      Body: audioFile.buffer,
      ContentType: audioContentType,
      Metadata: {
        songTitle: title,
        source: 'admin',
        uploadedBy: 'admin-standalone',
      },
    });
    await s3Client.send(putAudioCmd);
    uploadedAudioKey = audioKey;
    const audioUrl = `${publicDomain}/${encodeURIComponent(audioKey).replaceAll('%2F', '/')}`;

    // Upload thumbnail to R2
    const putThumbCmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: thumbKey,
      Body: thumbFile.buffer,
      ContentType: thumbContentType,
    });
    await s3Client.send(putThumbCmd);
    uploadedThumbKey = thumbKey;
    const thumbUrl = `${publicDomain}/${encodeURIComponent(thumbKey).replaceAll('%2F', '/')}`;

    const newSong = {
      id: songUid,
      title,
      description: (req.body?.description || '').trim(),
      thumbnailUrl: thumbUrl,
      audioUrl,
      r2AudioKey: audioKey,
      r2ThumbnailKey: thumbKey,
      channelId: 'admin-standalone',
      channelTitle: 'HLT&BS Official Music',
      artist: 'HLT&BS Official Music',
      source: 'admin',
      isAudioUploaded: true,
      publishedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      formattedDuration: (req.body?.duration || '3:30').trim(),
      fileSize: audioFile.size,
    };

    const currentSongs = await fetchAdminSongsFromR2();
    currentSongs.unshift(newSong);
    await saveAdminSongsToR2(currentSongs);

    console.log(`[R2_STANDALONE_SONG_SUCCESS] Standalone song created: "${title}" (ID: ${songUid})`);
    return res.json({ success: true, song: newSong });
  } catch (err) {
    console.error('[ADMIN_STANDALONE_UPLOAD_ERROR] Error creating standalone song:', err);

    // Rollback any partially uploaded objects on error
    if (uploadedAudioKey) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: uploadedAudioKey }));
      } catch (_) {}
    }
    if (uploadedThumbKey) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: uploadedThumbKey }));
      } catch (_) {}
    }

    return res.status(500).json({ success: false, error: `Failed to create standalone song: ${err.message || err}` });
  }
});

/**
 * DELETE /admin/standalone-songs/:id
 * Strictly scoped: ONLY deletes objects starting with 'admin_music/' and 'admin_thumbnails/'.
 * NEVER touches 'music/*', YouTube files, artist files, or banners.
 */
app.delete('/admin/standalone-songs/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, error: 'Song ID is required' });
    }

    const songs = await fetchAdminSongsFromR2();
    const song = songs.find(s => s.id === id);
    if (!song) {
      return res.status(404).json({ success: false, error: 'Standalone song not found' });
    }

    // STRICT ISOLATION GUARD: ONLY delete if keys start with 'admin_music/' and 'admin_thumbnails/'
    if (song.r2AudioKey && typeof song.r2AudioKey === 'string' && song.r2AudioKey.startsWith('admin_music/')) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: song.r2AudioKey }));
        console.log(`[R2_ADMIN_SONG_DELETED] Deleted audio ${song.r2AudioKey} from bucket ${bucketName}`);
      } catch (delErr) {
        console.warn('[R2_ADMIN_SONG_DELETE_WARN] Could not delete audio from R2:', delErr.message);
      }
    }

    if (song.r2ThumbnailKey && typeof song.r2ThumbnailKey === 'string' && song.r2ThumbnailKey.startsWith('admin_thumbnails/')) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: song.r2ThumbnailKey }));
        console.log(`[R2_ADMIN_THUMB_DELETED] Deleted thumbnail ${song.r2ThumbnailKey} from bucket ${bucketName}`);
      } catch (delErr) {
        console.warn('[R2_ADMIN_THUMB_DELETE_WARN] Could not delete thumbnail from R2:', delErr.message);
      }
    }

    const remaining = songs.filter(s => s.id !== id);
    await saveAdminSongsToR2(remaining);

    return res.json({ success: true, message: 'Standalone song deleted successfully' });
  } catch (err) {
    console.error('[ADMIN_STANDALONE_DELETE_ERROR] Error deleting standalone song:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete standalone song' });
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
