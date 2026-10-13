import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/prisma';
import { RedisService } from '../redis/redis.service';

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.is_active) {
    res.status(401).json({ error: 'Credenciales inválidas o cuenta inactiva' });
    return;
  }

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) {
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  const jti = uuidv4();
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, jti },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' }
  );

  res.cookie('access_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 15 * 60 * 1000
  });

  res.json({ message: 'Login exitoso', role: user.role });
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  const payload = req.user;
  
  if (payload && payload.jti && payload.exp) {
    await RedisService.banToken(payload.jti, payload.exp);
  }

  res.clearCookie('access_token');
  res.json({ message: 'Logout exitoso' });
};

export const registerCustomer = async (req: Request, res: Response): Promise<void> => {
  const { email, password, first_name, last_name, phone } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, 10);

    const newCustomer = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          password_hash,
          role: 'CUSTOMER'
        }
      });

      const profile = await tx.customerProfile.create({
        data: {
          user_id: user.id,
          first_name,
          last_name,
          phone
        }
      });

      return { user, profile };
    });

    res.status(201).json({
      message: 'Cliente registrado exitosamente',
      customer_id: newCustomer.profile.id,
      email: newCustomer.user.email
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'El email ya se encuentra registrado' });
      return;
    }
    res.status(500).json({ error: 'Error interno al registrar cliente' });
  }
};