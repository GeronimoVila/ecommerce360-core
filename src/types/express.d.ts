import { Request } from 'express';
import { getPrismaContext } from '../config/prisma';

declare global {
  namespace Express {
    interface Request {
      user?: {
        sub: string;
        email: string;
        role: string;
        jti: string;
        exp: number;
        iat: number;
      }; 
      prisma: ReturnType<typeof getPrismaContext>;
    }
  }
}