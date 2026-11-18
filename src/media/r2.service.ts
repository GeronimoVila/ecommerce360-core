import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const accountId = process.env.R2_ACCOUNT_ID || '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const bucketName = process.env.R2_BUCKET_NAME || '';
const publicBaseUrl = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/$/, '');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

export const R2Service = {
  isConfigured(): boolean {
    return Boolean(accountId && accessKeyId && secretAccessKey && bucketName && publicBaseUrl);
  },

  async createPresignedUploadUrl(params: {
    storageKey: string;
    contentType: string;
    contentLength: number;
  }): Promise<{ uploadUrl: string; publicUrl: string }> {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: params.storageKey,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
      CacheControl: 'public, max-age=31536000, immutable',
    });

    const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 60 });
    const publicUrl = `${publicBaseUrl}/${params.storageKey}`;

    return { uploadUrl, publicUrl };
  },

  async deleteObject(storageKey: string): Promise<void> {
    if (!storageKey || !this.isConfigured()) return;

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: storageKey,
    });

    await r2Client.send(command);
  },
};