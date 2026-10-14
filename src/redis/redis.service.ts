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
  },

  async setComboStock(comboId: string, stock: number): Promise<void> {
    await redisClient.setex(`combo:stock:${comboId}`, 86400, stock.toString());
  },

  async getComboStock(comboId: string): Promise<number | null> {
    const stock = await redisClient.get(`combo:stock:${comboId}`);
    return stock !== null ? parseInt(stock, 10) : null;
  },

  async registerComboDependencies(comboId: string, partIds: string[]): Promise<void> {
    const pipeline = redisClient.pipeline();
    for (const partId of partIds) {
      pipeline.sadd(`part:combos:${partId}`, comboId);
    }
    await pipeline.exec();
  },

  async getCombosByPart(partId: string): Promise<string[]> {
    return await redisClient.smembers(`part:combos:${partId}`);
  },

  async getMultipleComboStocks(comboIds: string[]): Promise<Record<string, number>> {
    if (comboIds.length === 0) return {};
    
    const keys = comboIds.map(id => `combo:stock:${id}`);
    const values = await redisClient.mget(keys);
    
    const result: Record<string, number> = {};
    comboIds.forEach((id, index) => {
      const val = values[index];
      result[id] = val !== null ? parseInt(val, 10) : 0;
    });
    
    return result;
  }
};