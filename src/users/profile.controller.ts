import { Request, Response } from 'express';
import prisma from '../config/prisma';

export const getMyProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user.sub;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        customer_profile: true,
        seller_profile: true
      }
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