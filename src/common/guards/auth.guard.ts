import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { RedisService } from '../../redis/redis.service';
import { getPrismaContext } from '../../config/prisma';

export const requireAuth = (allowedRoles: string[] = []) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      let token = req.cookies?.access_token;

      if (!token && req.headers.authorization?.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      }
      
      if (!token) {
        res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });
        return;
      }

      const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;

      const isTokenBanned = await RedisService.isTokenBanned(payload.jti);
      if (isTokenBanned) {
        res.status(401).json({ error: 'Sesión revocada. Vuelva a iniciar sesión.' });
        return;
      }

      const isUserBanned = await RedisService.isUserBanned(payload.sub);
      if (isUserBanned) {
        res.status(403).json({ error: 'Tu cuenta ha sido suspendida.' });
        return;
      }

      if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role)) {
        res.status(403).json({ error: 'Permisos insuficientes para esta acción.' });
        return;
      }

      req.user = payload; 
      req.prisma = getPrismaContext(req.user); 
      next();
    } catch (error) {
      res.status(401).json({ error: 'Token inválido o expirado.' });
    }
  };
};