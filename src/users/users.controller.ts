import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prismaGlobal } from '../config/prisma'; 
import { RedisService } from '../redis/redis.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const createSeller = async (req: Request, res: Response): Promise<void> => {
  const { email, first_name, last_name, cbu_alias } = req.body;

  try {
    const rawPassword = crypto.randomBytes(8).toString('hex');
    const password_hash = await bcrypt.hash(rawPassword, 10);
    
    const ref_code = `${first_name.toUpperCase().substring(0,4)}${last_name.toUpperCase().substring(0,1)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const newSeller = await req.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, password_hash, role: 'SELLER' }
      });

      const profile = await tx.sellerProfile.create({
        data: { user_id: user.id, ref_code, first_name, last_name, cbu_alias }
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
  const { email, first_name, last_name, phone, cbu_alias, is_active } = req.body;

  try {
    const targetUser = await req.prisma.user.findUnique({ 
      where: { id: targetId },
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

    await req.prisma.$transaction(async (tx) => {
      const userUpdateData: any = {};
      if (email !== undefined) userUpdateData.email = email;
      if (is_active !== undefined) userUpdateData.is_active = is_active;

      if (Object.keys(userUpdateData).length > 0) {
        await tx.user.update({ 
          where: { id: targetId }, 
          data: userUpdateData 
        });
      }

      if (targetUser.role === 'SELLER' && targetUser.seller_profile) {
        const sellerUpdateData: any = {};
        if (first_name !== undefined) sellerUpdateData.first_name = first_name;
        if (last_name !== undefined) sellerUpdateData.last_name = last_name;
        if (cbu_alias !== undefined) sellerUpdateData.cbu_alias = cbu_alias;

        if (Object.keys(sellerUpdateData).length > 0) {
          await tx.sellerProfile.update({
            where: { id: targetUser.seller_profile.id },
            data: sellerUpdateData
          });
        }
      } else if (targetUser.role === 'CUSTOMER' && targetUser.customer_profile) {
        const customerUpdateData: any = {};
        if (first_name !== undefined) customerUpdateData.first_name = first_name;
        if (last_name !== undefined) customerUpdateData.last_name = last_name;
        if (phone !== undefined) customerUpdateData.phone = phone;

        if (Object.keys(customerUpdateData).length > 0) {
          await tx.customerProfile.update({
            where: { id: targetUser.customer_profile.id },
            data: customerUpdateData
          });
        }
      }
    });

    if (is_active === true) {
      await RedisService.unbanUserId(targetId);
    }

    res.status(200).json({ message: 'Usuario actualizado exitosamente' });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'El email ya está en uso por otra cuenta' });
      return;
    }
    console.error('[UsersController.updateUser] Error:', error);
    res.status(500).json({ error: 'Error interno al actualizar usuario' });
  }
};

export const deactivateUser = async (req: Request, res: Response): Promise<void> => {
  const targetId = req.params.id as string;

  try {
    const targetUser = await req.prisma.user.findUnique({ where: { id: targetId } });

    if (!targetUser) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (targetUser.role === 'ADMIN') {
      res.status(403).json({ error: 'Operación denegada: Un administrador no puede dar de baja a otro administrador.' });
      return;
    }

    await req.prisma.user.update({
      where: { id: targetId },
      data: { is_active: false }
    });

    await RedisService.banUserId(targetId, 900);

    res.status(200).json({ message: `Cuenta de ${targetUser.role} suspendida correctamente.` });
  } catch (error) {
    res.status(500).json({ error: 'Error al dar de baja el usuario' });
  }
};

export const validateSellerId = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const id = req.params.id as string;

    if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Formato de Referral ID inválido.' });
    }

    const cachedData = await RedisService.getSellerValidation(id);
    
    if (cachedData) {
      return res.status(200).json(cachedData);
    }

    const seller = await prismaGlobal.user.findFirst({
      where: {
        id: id,
        role: 'SELLER',
      },
      select: {
        id: true,
      }
    });

    if (!seller) {
      return res.status(404).json({ error: 'Vendedor no encontrado o inactivo.' });
    }

    const responsePayload = {
      valid: true,
      sellerId: seller.id,
      expiresIn: 86400 
    };

    await RedisService.setSellerValidation(id, responsePayload, 3600);

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('[UsersController.validateSellerId] Error interno:', error);
    return res.status(500).json({ error: 'Error procesando la validación de atribución.' });
  }
};

export const getSellers = async (req: Request, res: Response): Promise<void> => {
  try {
    const sellers = await req.prisma.user.findMany({
      where: { role: 'SELLER' },
      select: {
        id: true,
        email: true,
        is_active: true,
        created_at: true,
        seller_profile: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            ref_code: true,
            cbu_alias: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    res.status(200).json({ data: sellers });
  } catch (error) {
    console.error('[UsersController] Error al obtener sellers:', error);
    res.status(500).json({ error: 'Error al obtener la lista de vendedores.' });
  }
};