import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../config/prisma';
import { RedisService } from '../redis/redis.service';

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

export const updateUser = async (req: Request, res: Response): Promise<void> => {
  const targetId = req.params.id as string;
  const { email, first_name, last_name, phone, cbu_alias } = req.body;

  try {
    const targetUser = await prisma.user.findUnique({ 
      where: { id: targetId },
      // CORRECCIÓN: Usamos snake_case tal como está en tu schema.prisma
      include: { customer_profile: true, seller_profile: true } 
    });

    if (!targetUser) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (targetUser.role === 'ADMIN') {
      res.status(403).json({ error: 'No tienes jerarquía para modificar a otro administrador.' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      if (email) {
        await tx.user.update({ where: { id: targetId }, data: { email } });
      }

      // CORRECCIÓN: Acceso y actualización usando snake_case
      if (targetUser.role === 'SELLER' && targetUser.seller_profile) {
        await tx.sellerProfile.update({
          where: { id: targetUser.seller_profile.id },
          data: { first_name, last_name, cbu_alias }
        });
      } else if (targetUser.role === 'CUSTOMER' && targetUser.customer_profile) {
        await tx.customerProfile.update({
          where: { id: targetUser.customer_profile.id },
          data: { first_name, last_name, phone }
        });
      }
    });

    res.status(200).json({ message: 'Usuario actualizado exitosamente' });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'El email ya está en uso por otra cuenta' });
      return;
    }
    res.status(500).json({ error: 'Error interno al actualizar usuario' });
  }
};

export const deactivateUser = async (req: Request, res: Response): Promise<void> => {
  // CORRECCIÓN 4: Casting explícito a string
  const targetId = req.params.id as string;

  try {
    const targetUser = await prisma.user.findUnique({ where: { id: targetId } });

    if (!targetUser) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (targetUser.role === 'ADMIN') {
      res.status(403).json({ error: 'Operación denegada: Un administrador no puede dar de baja a otro administrador.' });
      return;
    }

    await prisma.user.update({
      where: { id: targetId },
      data: { is_active: false }
    });

    // CORRECCIÓN 5: targetId ya es de tipo 'string' puro, RedisService no fallará
    await RedisService.banUserId(targetId, 900);

    res.status(200).json({ message: `Cuenta de ${targetUser.role} suspendida correctamente.` });
  } catch (error) {
    res.status(500).json({ error: 'Error al dar de baja el usuario' });
  }
};