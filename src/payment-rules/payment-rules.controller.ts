import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { Prisma } from '@prisma/client';
import { RedisService } from '../redis/redis.service';
import { triggerB2CRevalidation } from '../utils/revalidate.util';

export const createPaymentRule = async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      payment_method, 
      installments, 
      coefficient, 
      is_global, 
      category_id, 
      product_id 
    } = req.body;

    const coeffNum = parseFloat(coefficient);
    if (isNaN(coeffNum) || coeffNum < 0.1 || coeffNum > 3.0) {
      res.status(400).json({ error: 'El coeficiente debe ser un decimal entre 0.1000 y 3.0000' });
      return;
    }

    const targets = [is_global === true, !!category_id, !!product_id];
    const activeTargets = targets.filter(Boolean).length;

    if (activeTargets !== 1) {
      res.status(400).json({ 
        error: 'Incoherencia jerárquica: La regla debe ser global, O asignarse a una categoría, O asignarse a un producto. Solo una opción a la vez.' 
      });
      return;
    }

    const newRule = await prisma.paymentRule.create({
      data: {
        payment_method,
        installments: parseInt(installments, 10) || 1,
        coefficient: new Prisma.Decimal(coeffNum.toFixed(4)),
        is_global: is_global || false,
        category_id: category_id || null,
        product_id: product_id || null,
        is_active: true
      }
    });

    await RedisService.invalidatePaymentRules();
    triggerB2CRevalidation('products');

    res.status(201).json({
      message: 'Regla financiera creada exitosamente.',
      data: newRule
    });

  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ 
        error: 'Conflicto: Ya existe una regla idéntica para este método de pago, cantidad de cuotas y alcance (Producto/Categoría/Global).' 
      });
      return;
    }
    console.error('[PaymentRules] Error al crear:', error);
    res.status(500).json({ error: 'Error interno del servidor al crear la regla.' });
  }
};

export const getPaymentRules = async (req: Request, res: Response): Promise<void> => {
  try {
    const rules = await prisma.paymentRule.findMany({
      orderBy: { created_at: 'desc' },
      include: {
        category: { select: { name: true } },
        product: { select: { sku: true, name: true } }
      }
    });

    res.status(200).json({ data: rules });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener las reglas de pago.' });
  }
};

export const updatePaymentRule = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { coefficient, is_active } = req.body;

    const dataToUpdate: any = {};
    
    if (coefficient !== undefined) {
      const coeffNum = parseFloat(coefficient);
      if (coeffNum < 0.1 || coeffNum > 3.0) {
        res.status(400).json({ error: 'Coeficiente fuera de rango (0.1 a 3.0)' });
        return;
      }
      dataToUpdate.coefficient = new Prisma.Decimal(coeffNum.toFixed(4));
    }

    if (is_active !== undefined) {
      dataToUpdate.is_active = is_active;
    }

    const updatedRule = await prisma.paymentRule.update({
      where: { id },
      data: dataToUpdate
    });

    await RedisService.invalidatePaymentRules();
    triggerB2CRevalidation('products');

    res.status(200).json({
      message: 'Regla actualizada exitosamente.',
      data: updatedRule
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'La regla no existe.' });
      return;
    }
    res.status(500).json({ error: 'Error al actualizar la regla.' });
  }
};

export const softDeletePaymentRule = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const deletedRule = await prisma.paymentRule.update({
      where: { id },
      data: { is_active: false }
    });

    await RedisService.invalidatePaymentRules();
    triggerB2CRevalidation('products');

    res.status(200).json({
      message: 'Regla desactivada correctamente. Se mantendrá en el historial pero el motor la ignorará.',
      data: deletedRule
    });
  } catch (error: any) {
    if (error.code === 'P2025') res.status(404).json({ error: 'La regla no existe.' });
    else res.status(500).json({ error: 'Error al desactivar la regla.' });
  }
};