import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

dotenv.config();

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME || 'artist-music';

console.log('--- Cloudflare R2 Connection Verification Test ---');
console.log(`Account ID: ${accountId}`);
console.log(`Access Key: ${accessKeyId ? accessKeyId.substring(0, 6) + '...' : 'NONE'}`);
console.log(`Bucket Name: ${bucketName}`);

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKeyId || '',
    secretAccessKey: secretAccessKey || ''
  }
});

async function runTest() {
  try {
    const command = new ListObjectsV2Command({ Bucket: bucketName });
    const response = await s3Client.send(command);
    console.log('\n✅ SUCCESS: Connected to Cloudflare R2 Bucket!');
    console.log(`Total Objects in "${bucketName}": ${response.KeyCount || 0}`);
    if (response.Contents && response.Contents.length > 0) {
      console.log('\nSample Bucket Objects:');
      response.Contents.slice(0, 5).forEach((obj, idx) => {
        console.log(` ${idx + 1}. Key: "${obj.Key}" | Size: ${obj.Size} bytes`);
      });
    }
  } catch (err) {
    console.error('\n❌ ERROR: Cloudflare R2 Connection Failed:');
    console.error(err);
  }
}

runTest();
