import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../config/prisma';

export const getMyProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user.sub;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { customer_profile: true, seller_profile: true }
    });

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    const { password_hash, ...safeUser } = user;
    res.status(200).json(safeUser);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener el perfil' });
  }
};

export const updateMyProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user.sub;
    const role = req.user.role;
    const { cbu_alias } = req.body;

    if (role === 'SELLER') {
      const updatedProfile = await prisma.sellerProfile.update({
        where: { user_id: userId },
        data: { cbu_alias }
      });
      res.status(200).json({ message: 'CBU/Alias actualizado correctamente', data: updatedProfile });
      return;
    }
    
    res.status(403).json({ error: 'Solo los vendedores pueden modificar su CBU comercial.' });
  } catch (error) {
    console.error('[ProfileController] Error actualizando CBU:', error);
    res.status(500).json({ error: 'Error al actualizar el perfil' });
  }
};

export const changeMyPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user.sub;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password || new_password.length < 8) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    const isValid = await bcrypt.compare(current_password, user.password_hash);
    if (!isValid) {
      res.status(401).json({ error: 'La contraseña actual es incorrecta. Operación denegada.' });
      return;
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password_hash: newHash }
    });

    res.status(200).json({ message: 'Contraseña actualizada con éxito. Tu cuenta ahora es segura.' });
  } catch (error) {
    console.error('[ProfileController] Error cambiando contraseña:', error);
    res.status(500).json({ error: 'Error interno al cambiar la contraseña' });
  }
};