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
  }
};