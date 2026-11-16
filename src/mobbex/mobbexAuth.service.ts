import crypto from 'crypto';
import prisma from '../config/prisma';

const ALGO = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') !== 32) {
    throw new Error('ENCRYPTION_SECRET debe estar definido en .env y tener exactamente 32 bytes.');
  }
  return Buffer.from(secret, 'utf8');
}

export function encryptToken(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(payload: string): string {
  const [ivHex, tagHex, encHex] = payload.split(':');
  const decipher = crypto.createDecipheriv(ALGO, getEncryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

export async function resolveMobbexCredentials(tenantId = 'DEFAULT_STORE') {
  const config = await prisma.paymentGatewayConfig.findUnique({
    where: {
      tenantId_provider: { tenantId, provider: 'MOBBEX' },
    },
  });

  if (!config || config.status !== 'CONNECTED' || !config.accessTokenEncrypted) {
    const demoApiKey = process.env.MOBBEX_DEMO_API_KEY || process.env.MOBBEX_API_KEY;
    const demoAccessToken = process.env.MOBBEX_DEMO_ACCESS_TOKEN || process.env.MOBBEX_ACCESS_TOKEN;

    if (!demoApiKey || !demoAccessToken) {
      throw new Error(
        'Faltan credenciales Demo de Mobbex en .env (MOBBEX_DEMO_API_KEY / MOBBEX_API_KEY)'
      );
    }

    return {
      apiKey: demoApiKey,
      accessToken: demoAccessToken,
      isTest: true,
      isDemoFallback: true,
    };
  }

  return {
    apiKey: process.env.MOBBEX_APP_API_KEY!,
    accessToken: decryptToken(config.accessTokenEncrypted),
    isTest: config.isTestMode,
    isDemoFallback: false,
  };
}