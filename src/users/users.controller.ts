import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../config/prisma';

export const createSeller = async (req: Request, res: Response): Promise<void> => {
  const { email, first_name, last_name, cbu_alias } = req.body;

  try {
    const rawPassword = crypto.randomBytes(8).toString('hex');
    const password_hash = await bcrypt.hash(rawPassword, 10);
    
    const ref_code = `${first_name.toUpperCase().substring(0,4)}${last_name.toUpperCase().substring(0,1)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const newSeller = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          password_hash,
          role: 'SELLER'
        }
      });

      const profile = await tx.sellerProfile.create({
        data: {
          user_id: user.id,
          ref_code,
          first_name,
          last_name,
          cbu_alias
        }
      });

      return { user, profile };
    });
    
    res.status(201).json({
      message: 'Vendedor creado exitosamente',
      seller_id: newSeller.profile.id,
      ref_code: newSeller.profile.ref_code,
      temporary_password: rawPassword
    });

  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'El email ya está registrado' });
      return;
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};