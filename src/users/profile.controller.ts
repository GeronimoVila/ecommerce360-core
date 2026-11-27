import { Request, Response } from 'express';
import bcrypt from 'bcrypt';

export const getMyProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.sub;
    const user = await req.prisma.user.findUnique({
      where: { id: userId },
      include: { customer_profile: true, seller_profile: true },
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
    const userId = req.user!.sub;
    const role = req.user!.role;
    const { email, first_name, last_name, phone, dni, cbu_alias } = req.body;

    const currentUser = await req.prisma.user.findUnique({
      where: { id: userId },
      include: { customer_profile: true, seller_profile: true },
    });

    if (!currentUser) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        res.status(400).json({ error: 'El correo electrónico ingresado no es válido.' });
        return;
      }

      if (normalizedEmail !== currentUser.email) {
        const existingEmail = await req.prisma.user.findUnique({
          where: { email: normalizedEmail },
        });
        if (existingEmail) {
          res.status(409).json({ error: 'Ese correo electrónico ya está en uso por otra cuenta.' });
          return;
        }

        await req.prisma.user.update({
          where: { id: userId },
          data: { email: normalizedEmail },
        });
      }
    }

    if (role === 'SELLER') {
      const sellerData: Record<string, string | null> = {};
      if (first_name !== undefined) sellerData.first_name = String(first_name).trim();
      if (last_name !== undefined) sellerData.last_name = String(last_name).trim();
      if (cbu_alias !== undefined) sellerData.cbu_alias = String(cbu_alias).trim() || null;

      if (Object.keys(sellerData).length > 0) {
        await req.prisma.sellerProfile.update({
          where: { user_id: userId },
          data: sellerData,
        });
      }
    } else if (role === 'CUSTOMER') {
      const cleanDni = dni !== undefined ? String(dni).replace(/\D/g, '') : undefined;

      if (cleanDni !== undefined && cleanDni.length > 0 && cleanDni.length < 7) {
        res.status(400).json({ error: 'El DNI debe tener al menos 7 dígitos.' });
        return;
      }

      if (cleanDni && cleanDni !== currentUser.customer_profile?.dni) {
        const existingDni = await req.prisma.customerProfile.findFirst({
          where: {
            dni: cleanDni,
            user_id: { not: userId },
          },
        });
        if (existingDni) {
          res.status(409).json({ error: 'Ya existe otro cliente registrado con ese DNI.' });
          return;
        }
      }

      const customerData: Record<string, string | null> = {};
      if (first_name !== undefined) customerData.first_name = String(first_name).trim() || null;
      if (last_name !== undefined) customerData.last_name = String(last_name).trim() || null;
      if (phone !== undefined) customerData.phone = String(phone).trim() || null;
      if (cleanDni !== undefined) customerData.dni = cleanDni || null;

      if (Object.keys(customerData).length > 0) {
        await req.prisma.customerProfile.upsert({
          where: { user_id: userId },
          update: customerData,
          create: {
            user_id: userId,
            first_name: customerData.first_name ?? null,
            last_name: customerData.last_name ?? null,
            phone: customerData.phone ?? null,
            dni: customerData.dni ?? null,
          },
        });
      }
    }

    const updatedUser = await req.prisma.user.findUnique({
      where: { id: userId },
      include: { customer_profile: true, seller_profile: true },
    });

    const { password_hash, ...safeUser } = updatedUser!;
    res.status(200).json({
      message: 'Perfil actualizado correctamente',
      user: safeUser,
    });
  } catch (error) {
    console.error('[ProfileController] Error actualizando perfil:', error);
    res.status(500).json({ error: 'Error al actualizar el perfil' });
  }
};

export const changeMyPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.sub;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password || new_password.length < 8) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
      return;
    }

    const user = await req.prisma.user.findUnique({ where: { id: userId } });
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
    await req.prisma.user.update({
      where: { id: userId },
      data: { password_hash: newHash },
    });

    res.status(200).json({ message: 'Contraseña actualizada con éxito. Tu cuenta ahora es segura.' });
  } catch (error) {
    console.error('[ProfileController] Error cambiando contraseña:', error);
    res.status(500).json({ error: 'Error interno al cambiar la contraseña' });
  }
};