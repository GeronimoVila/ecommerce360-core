import { Request, Response } from 'express';
import prisma from '../config/prisma';

export const getSuppliers = async (req: Request, res: Response): Promise<void> => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: 'asc' }
    });
    res.status(200).json(suppliers);
  } catch (error) {
    console.error('[SupplierController] Error obteniendo proveedores:', error);
    res.status(500).json({ error: 'Error interno al obtener proveedores' });
  }
};

export const createSupplier = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, tax_id, email, phone } = req.body;

    if (!name) {
      res.status(400).json({ error: 'El nombre / razón social es obligatorio' });
      return;
    }

    const newSupplier = await prisma.supplier.create({
      data: { name, tax_id, email, phone }
    });

    res.status(201).json(newSupplier);
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe un proveedor con ese nombre' });
      return;
    }
    console.error('[SupplierController] Error creando proveedor:', error);
    res.status(500).json({ error: 'Error interno al crear el proveedor' });
  }
};