import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prismaGlobal } from '../config/prisma';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const getCoupons = async (req: Request, res: Response): Promise<void> => {
  try {
    const db = req.prisma || prismaGlobal;
    const coupons = await db.coupon.findMany({
      orderBy: { created_at: 'desc' },
    });
    res.status(200).json({ data: coupons });
  } catch (error) {
    console.error('[CouponsController] Error en getCoupons:', error);
    res.status(500).json({ error: 'Error al obtener el listado de cupones.' });
  }
};

export const createCoupon = async (req: Request, res: Response): Promise<void> => {
  try {
    const db = req.prisma || prismaGlobal;
    const {
      code,
      description,
      discount_type,
      discount_value,
      min_purchase_amount,
      max_uses,
      starts_at,
      expires_at,
      is_active,
    } = req.body;

    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!normalizedCode) {
      res.status(400).json({ error: 'El código del cupón es obligatorio.', field: 'code' });
      return;
    }

    if (discount_type !== 'PERCENTAGE' && discount_type !== 'FIXED_AMOUNT') {
      res.status(400).json({ error: 'Tipo de descuento inválido. Debe ser PERCENTAGE o FIXED_AMOUNT.' });
      return;
    }

    const numericValue = Number(discount_value);
    if (isNaN(numericValue) || numericValue <= 0) {
      res.status(400).json({ error: 'El valor del descuento debe ser mayor a 0.' });
      return;
    }

    if (discount_type === 'PERCENTAGE' && numericValue > 100) {
      res.status(400).json({ error: 'Un descuento porcentual no puede superar el 100%.' });
      return;
    }

    const existing = await db.coupon.findUnique({ where: { code: normalizedCode } });
    if (existing) {
      res.status(409).json({
        error: `Ya existe un cupón con el código "${normalizedCode}".`,
        field: 'code',
      });
      return;
    }

    const parsedStartsAt = starts_at ? new Date(starts_at) : new Date();
    const parsedExpiresAt = expires_at ? new Date(expires_at) : null;

    if (parsedExpiresAt && parsedExpiresAt <= parsedStartsAt) {
      res.status(400).json({ error: 'La fecha de expiración debe ser posterior a la fecha de inicio.' });
      return;
    }

    const newCoupon = await db.coupon.create({
      data: {
        code: normalizedCode,
        description: description ? String(description).trim() : null,
        discount_type,
        discount_value: new Prisma.Decimal(numericValue),
        min_purchase_amount:
          min_purchase_amount !== undefined && min_purchase_amount !== null && min_purchase_amount !== ''
            ? new Prisma.Decimal(Number(min_purchase_amount))
            : null,
        max_uses:
          max_uses !== undefined && max_uses !== null && max_uses !== ''
            ? parseInt(String(max_uses), 10)
            : null,
        starts_at: parsedStartsAt,
        expires_at: parsedExpiresAt,
        is_active: is_active !== undefined ? Boolean(is_active) : true,
      },
    });

    res.status(201).json({
      message: 'Cupón creado exitosamente.',
      coupon: newCoupon,
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'El código del cupón ya existe.', field: 'code' });
      return;
    }
    console.error('[CouponsController] Error en createCoupon:', error);
    res.status(500).json({ error: 'Error interno al crear el cupón.' });
  }
};

export const updateCoupon = async (req: Request, res: Response): Promise<void> => {
  try {
    const db = req.prisma || prismaGlobal;
    const id = req.params.id as string;

    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'ID de cupón inválido.' });
      return;
    }

    const existingCoupon = await db.coupon.findUnique({ where: { id } });
    if (!existingCoupon) {
      res.status(404).json({ error: 'Cupón no encontrado.' });
      return;
    }

    const {
      code,
      description,
      discount_type,
      discount_value,
      min_purchase_amount,
      max_uses,
      starts_at,
      expires_at,
      is_active,
    } = req.body;

    const dataToUpdate: Prisma.CouponUpdateInput = {};

    if (code !== undefined) {
      const normalizedCode = String(code).trim().toUpperCase();
      if (!normalizedCode) {
        res.status(400).json({ error: 'El código del cupón no puede estar vacío.', field: 'code' });
        return;
      }
      const duplicate = await db.coupon.findFirst({
        where: { code: normalizedCode, id: { not: id } },
      });
      if (duplicate) {
        res.status(409).json({
          error: `Ya existe otro cupón con el código "${normalizedCode}".`,
          field: 'code',
        });
        return;
      }
      dataToUpdate.code = normalizedCode;
    }

    if (description !== undefined) {
      dataToUpdate.description = description ? String(description).trim() : null;
    }

    const effectiveType = discount_type ?? existingCoupon.discount_type;
    if (discount_type !== undefined) {
      if (discount_type !== 'PERCENTAGE' && discount_type !== 'FIXED_AMOUNT') {
        res.status(400).json({ error: 'Tipo de descuento inválido.' });
        return;
      }
      dataToUpdate.discount_type = discount_type;
    }

    if (discount_value !== undefined) {
      const numericValue = Number(discount_value);
      if (isNaN(numericValue) || numericValue <= 0) {
        res.status(400).json({ error: 'El valor del descuento debe ser mayor a 0.' });
        return;
      }
      if (effectiveType === 'PERCENTAGE' && numericValue > 100) {
        res.status(400).json({ error: 'Un descuento porcentual no puede superar el 100%.' });
        return;
      }
      dataToUpdate.discount_value = new Prisma.Decimal(numericValue);
    }

    if (min_purchase_amount !== undefined) {
      dataToUpdate.min_purchase_amount =
        min_purchase_amount === null || min_purchase_amount === ''
          ? null
          : new Prisma.Decimal(Number(min_purchase_amount));
    }

    if (max_uses !== undefined) {
      dataToUpdate.max_uses =
        max_uses === null || max_uses === '' ? null : parseInt(String(max_uses), 10);
    }

    if (starts_at !== undefined) {
      dataToUpdate.starts_at = starts_at ? new Date(starts_at) : null;
    }

    if (expires_at !== undefined) {
      dataToUpdate.expires_at = expires_at ? new Date(expires_at) : null;
    }

    if (is_active !== undefined) {
      dataToUpdate.is_active = Boolean(is_active);
    }

    const updatedCoupon = await db.coupon.update({
      where: { id },
      data: dataToUpdate,
    });

    res.status(200).json({
      message: 'Cupón actualizado exitosamente.',
      coupon: updatedCoupon,
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'El código del cupón ya existe.', field: 'code' });
      return;
    }
    console.error('[CouponsController] Error en updateCoupon:', error);
    res.status(500).json({ error: 'Error interno al actualizar el cupón.' });
  }
};

export const deleteCoupon = async (req: Request, res: Response): Promise<void> => {
  try {
    const db = req.prisma || prismaGlobal;
    const id = req.params.id as string;

    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'ID de cupón inválido.' });
      return;
    }

    const coupon = await db.coupon.findUnique({ where: { id } });
    if (!coupon) {
      res.status(404).json({ error: 'Cupón no encontrado.' });
      return;
    }

    if (coupon.used_count > 0) {
      const deactivated = await db.coupon.update({
        where: { id },
        data: { is_active: false },
      });
      res.status(200).json({
        message: 'El cupón tiene usos registrados; fue desactivado para preservar auditoría.',
        coupon: deactivated,
      });
      return;
    }

    await db.coupon.delete({ where: { id } });
    res.status(200).json({ message: 'Cupón eliminado exitosamente.' });
  } catch (error) {
    console.error('[CouponsController] Error en deleteCoupon:', error);
    res.status(500).json({ error: 'Error al eliminar el cupón.' });
  }
};