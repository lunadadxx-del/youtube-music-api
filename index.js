import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Helper: Extracts YouTube Video ID from R2 object Key using multiple matching strategies.
 */
function extractYoutubeIdFromKey(key) {
  if (!key) return null;

  const cleanKey = key.split('/').pop() || key;

  // 1. Explicit bracket pattern e.g. [Rxsdi6JIj-8]
  const bracketMatch = cleanKey.match(/\[([a-zA-Z0-9_-]{11})\]/);
  if (bracketMatch && bracketMatch[1]) {
    return bracketMatch[1];
  }

  // 2. Exact 11-char YouTube ID filename (with or without audio/video extension)
  const baseName = cleanKey.replace(/\.(mp3|m4a|wav|flac|aac|ogg|mp4)$/i, '');
  if (/^[a-zA-Z0-9_-]{11}$/.test(baseName)) {
    return baseName;
  }

  // 3. Prefix pattern e.g. music/8_vJvjkTUSQ.mp3 or songs/8_vJvjkTUSQ.mp3
  const pathParts = key.split('/');
  for (const part of pathParts) {
    const partBase = part.replace(/\.(mp3|m4a|wav|flac|aac|ogg|mp4)$/i, '');
    if (/^[a-zA-Z0-9_-]{11}$/.test(partBase)) {
      return partBase;
    }
  }

  return baseName;
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

      // Map primary key (extracted YouTube ID or clean baseName)
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
      return ytId === youtubeVideoId || obj.Key.includes(youtubeVideoId);
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

    // R2 Object Key: music/<youtubeVideoId>.<ext>
    const objectKey = `music/${youtubeVideoId}${ext}`;

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
      artist: artist || 'HLT&BS Official Music',
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
