import Redis from 'ioredis';

const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export const RedisService = {
  async banToken(jti: string, expTimestamp: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = expTimestamp - now;
    
    if (ttl > 0) {
      await redisClient.setex(`banned_jwt:${jti}`, ttl, 'revoked');
    }
  },

  async isTokenBanned(jti: string): Promise<boolean> {
    const result = await redisClient.get(`banned_jwt:${jti}`);
    return result !== null;
  },

  async banUserId(userId: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds > 0) {
      await redisClient.setex(`banned_user:${userId}`, ttlSeconds, 'true');
    }
  },

  async isUserBanned(userId: string): Promise<boolean> {
    const result = await redisClient.get(`banned_user:${userId}`);
    return result !== null;
  }
};