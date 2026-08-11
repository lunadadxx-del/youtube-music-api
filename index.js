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

const dbPath = path.join(__dirname, 'data', 'songs_db.json');

function loadDb() {
  try {
    if (!fs.existsSync(dbPath)) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, JSON.stringify({}), 'utf-8');
      return {};
    }
    const data = fs.readFileSync(dbPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[DB_ERROR] Failed reading songs_db.json:', err);
    return {};
  }
}

function saveDb(db) {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB_ERROR] Failed writing songs_db.json:', err);
  }
}

/**
 * Health Check Endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bucket: bucketName, serverTime: new Date().toISOString() });
});

/**
 * GET /admin/songs/status
 * Returns canonical R2 upload database mapping: youtubeVideoId -> song object
 */
app.get('/admin/songs/status', (req, res) => {
  const db = loadDb();
  res.json({ success: true, count: Object.keys(db).length, songs: db });
});

/**
 * GET /admin/r2/files
 * Lists object keys directly from Cloudflare R2 bucket
 */
app.get('/admin/r2/files', async (req, res) => {
  try {
    const command = new ListObjectsV2Command({ Bucket: bucketName });
    const response = await s3Client.send(command);
    const files = (response.Contents || []).map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified
    }));
    res.json({ success: true, count: files.length, files });
  } catch (err) {
    console.error('[R2_ERROR] ListObjectsV2 failed:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed listing R2 objects' });
  }
});

/**
 * POST /admin/upload-song
 * REAL Cloudflare R2 Multipart File Upload
 */
app.post('/admin/upload-song', upload.single('audioFile'), async (req, res) => {
  try {
    const file = req.file;
    const { youtubeVideoId, songTitle, artist, duration } = req.body;

    if (!file) {
      return res.status(400).json({ success: false, error: 'No audio file uploaded in multipart request.' });
    }
    if (!youtubeVideoId) {
      return res.status(400).json({ success: false, error: 'Missing youtubeVideoId parameter.' });
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
        uploadedBy: 'admin-panel'
      }
    });

    const r2Response = await s3Client.send(putCommand);
    console.log(`[R2_UPLOAD_SUCCESS] Cloudflare R2 confirmed upload for key="${objectKey}", ETag=${r2Response.ETag}`);

    // Public audio URL
    const audioUrl = `${publicDomain}/${encodeURIComponent(objectKey).replaceAll('%2F', '/')}`;

    // Update persistent database
    const db = loadDb();
    const songEntry = {
      youtubeVideoId,
      songTitle: songTitle || 'Untitled Song',
      artist: artist || 'HLT&BS Official Music',
      duration: duration || '0:00',
      r2ObjectKey: objectKey,
      r2AudioUrl: audioUrl,
      uploadedAt: new Date().toISOString(),
      fileSize: file.size,
      uploadStatus: 'UPLOADED',
      etag: r2Response.ETag
    };

    db[youtubeVideoId] = songEntry;
    saveDb(db);

    return res.json({
      success: true,
      message: 'Uploaded successfully to Cloudflare R2',
      r2ObjectKey: objectKey,
      r2AudioUrl: audioUrl,
      fileSize: file.size,
      youtubeVideoId,
      song: songEntry
    });
  } catch (err) {
    console.error('[R2_UPLOAD_ERROR] Cloudflare R2 Upload Failed:', err);
    return res.status(500).json({
      success: false,
      error: `Cloudflare R2 Upload Failed: ${err.message || err.toString()}`
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
