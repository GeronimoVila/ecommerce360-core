import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { Prisma } from '@prisma/client';
import { RedisService } from '../redis/redis.service';
import { PricingEngine } from './pricing.engine';

export const createProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      sku, 
      name, 
      purchase_cost, 
      vat_rate, 
      profit_margin, 
      physical_stock, 
      commission_rate 
    } = req.body;

    const cost = parseFloat(purchase_cost);
    const vat = parseFloat(vat_rate) / 100;
    const margin = parseFloat(profit_margin) / 100;

    const costWithVat = cost * (1 + vat);
    const calculatedBasePrice = costWithVat * (1 + margin);

    const newProduct = await prisma.product.create({
      data: {
        sku: sku.toUpperCase(),
        name,
        purchase_cost: new Prisma.Decimal(cost),
        vat_rate: new Prisma.Decimal(vat_rate),
        profit_margin: new Prisma.Decimal(profit_margin),
        base_price: new Prisma.Decimal(calculatedBasePrice.toFixed(2)),
        physical_stock: parseInt(physical_stock, 10),
        commission_rate: new Prisma.Decimal(commission_rate)
      }
    });

    res.status(201).json({
      message: 'Producto creado exitosamente',
      product: newProduct
    });

  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'El SKU ingresado ya existe en el catálogo.' });
      return;
    }
    res.status(500).json({ error: 'Error interno al crear el producto' });
  }
};

export const updateProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string; 
    const updateData = req.body;

    const existingProduct = await prisma.product.findUnique({ where: { id } });
    if (!existingProduct) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    const dataToUpdate: any = { ...updateData };

    if (updateData.purchase_cost || updateData.vat_rate || updateData.profit_margin) {
      const cost = parseFloat(updateData.purchase_cost ?? existingProduct.purchase_cost.toString());
      const vat = parseFloat(updateData.vat_rate ?? existingProduct.vat_rate.toString()) / 100;
      const margin = parseFloat(updateData.profit_margin ?? existingProduct.profit_margin.toString()) / 100;

      const calculatedBasePrice = cost * (1 + vat) * (1 + margin);
      dataToUpdate.base_price = new Prisma.Decimal(calculatedBasePrice.toFixed(2));
    }

    if (updateData.purchase_cost) dataToUpdate.purchase_cost = new Prisma.Decimal(updateData.purchase_cost);
    if (updateData.vat_rate) dataToUpdate.vat_rate = new Prisma.Decimal(updateData.vat_rate);
    if (updateData.profit_margin) dataToUpdate.profit_margin = new Prisma.Decimal(updateData.profit_margin);
    if (updateData.commission_rate) dataToUpdate.commission_rate = new Prisma.Decimal(updateData.commission_rate);
    if (updateData.physical_stock !== undefined) dataToUpdate.physical_stock = parseInt(updateData.physical_stock, 10);

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: dataToUpdate
    });

    res.status(200).json({
      message: 'Producto actualizado exitosamente',
      product: updatedProduct
    });

  } catch (error: any) {
    if (error.code === 'P2002') res.status(409).json({ error: 'El SKU ya está en uso.' });
    else res.status(500).json({ error: 'Error interno al actualizar el producto' });
  }
};

export const deactivateProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const deactivatedProduct = await prisma.product.update({
      where: { id },
      data: { is_active: false }
    });

    res.status(200).json({
      message: 'Producto dado de baja lógicamente. Ya no será visible en el Storefront.',
      product: deactivatedProduct
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }
    res.status(500).json({ error: 'Error al desactivar el producto' });
  }
};

export const getProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const products = await prisma.product.findMany({
      where: { is_active: true },
      skip,
      take: limit,
      select: {
        id: true,
        sku: true,
        name: true,
        base_price: true,
        physical_stock: true,
        is_combo: true,
        category_id: true
      }
    });

    const comboIds = products.filter(p => p.is_combo).map(p => p.id);

    const comboStocks = await RedisService.getMultipleComboStocks(comboIds);

    const hydratedProducts = products.map(product => {
      if (product.is_combo) {
        return {
          ...product,
          physical_stock: comboStocks[product.id] ?? 0
        };
      }
      return product;
    });

    const activeRules = await RedisService.getActivePaymentRules();

    const finalProducts = PricingEngine.applyDynamicPricing(hydratedProducts, activeRules);

    const total = await prisma.product.count({ where: { is_active: true } });

    res.status(200).json({
      data: finalProducts,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('[ProductsController] Error en getProducts:', error);
    res.status(500).json({ error: 'Error al obtener el catálogo' });
  }
};

export const getProductById = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(id)) {
      res.status(400).json({ error: 'Formato de ID inválido' });
      return;
    }

    const product = await prisma.product.findFirst({
      where: { id, is_active: true },
      select: {
        id: true,
        sku: true,
        name: true,
        base_price: true,
        physical_stock: true,
        is_combo: true,
        category_id: true
      }
    });

    if (!product) {
      res.status(404).json({ error: 'Producto no encontrado o inactivo' });
      return;
    }

    if (product.is_combo) {
      const virtualStock = await RedisService.getComboStock(product.id);
      product.physical_stock = virtualStock ?? 0;
    }

    const activeRules = await RedisService.getActivePaymentRules();

    const [finalProduct] = PricingEngine.applyDynamicPricing([product], activeRules);

    res.status(200).json(finalProduct);
  } catch (error) {
    console.error('[ProductsController] Error en getProductById:', error);
    res.status(500).json({ error: 'Error al obtener el producto' });
  }
};

export const reactivateProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const reactivatedProduct = await prisma.product.update({
      where: { id },
      data: { is_active: true }
    });

    res.status(200).json({
      message: 'Producto reactivado exitosamente. Vuelve a ser visible en el Storefront.',
      product: reactivatedProduct
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }
    res.status(500).json({ error: 'Error al reactivar el producto' });
  }
};

export const createCombo = async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      sku, 
      name, 
      base_price, 
      commission_rate, 
      parts 
    } = req.body;

    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      res.status(400).json({ error: 'Un combo debe contener al menos un componente.' });
      return;
    }

    const partSkus = parts.map((p: { sku: string; quantity: number }) => p.sku);

    const dbParts = await prisma.product.findMany({
      where: { 
        sku: { in: partSkus },
        is_active: true
      }
    });

    if (dbParts.length !== parts.length) {
      res.status(404).json({ error: 'Uno o más componentes del combo no existen o están inactivos.' });
      return;
    }

    const hasSubCombo = dbParts.some(part => part.is_combo);
    if (hasSubCombo) {
      res.status(400).json({ error: 'Regla de negocio violada: No se permite incluir un combo dentro de otro combo.' });
      return;
    }

    let minVirtualStock = Infinity;
    const comboItemsToInsert: { product_id: string; quantity: number }[] = [];
    const partIdsToRegister: string[] = [];

    for (const item of parts) {
      const dbPart = dbParts.find(p => p.sku === item.sku)!;
      const requiredQty = parseInt(item.quantity, 10);

      if (isNaN(requiredQty) || requiredQty <= 0) {
        res.status(400).json({ error: `La cantidad para el componente ${item.sku} debe ser un entero positivo.` });
        return;
      }

      const availableCombosFromPart = Math.floor(dbPart.physical_stock / requiredQty);
      if (availableCombosFromPart < minVirtualStock) {
        minVirtualStock = availableCombosFromPart;
      }

      comboItemsToInsert.push({
        product_id: dbPart.id,
        quantity: requiredQty
      });

      partIdsToRegister.push(dbPart.id);
    }

    const calculatedInitialStock = minVirtualStock === Infinity ? 0 : minVirtualStock;

    const newCombo = await prisma.$transaction(async (tx) => {
      return await tx.product.create({
        data: {
          sku: sku.toUpperCase(),
          name,
          base_price: new Prisma.Decimal(base_price),
          purchase_cost: new Prisma.Decimal(0),
          vat_rate: new Prisma.Decimal(0),
          profit_margin: new Prisma.Decimal(0),
          physical_stock: 0,
          is_combo: true,
          commission_rate: new Prisma.Decimal(commission_rate),
          combo_parts: {
            create: comboItemsToInsert
          }
        },
        include: {
          combo_parts: {
            include: {
              product: {
                select: { sku: true, name: true, physical_stock: true }
              }
            }
          }
        }
      });
    });

    await RedisService.setComboStock(newCombo.id, calculatedInitialStock);
    await RedisService.registerComboDependencies(newCombo.id, partIdsToRegister);

    res.status(201).json({
      message: 'Combo creado exitosamente y sincronizado con Redis',
      combo: {
        id: newCombo.id,
        sku: newCombo.sku,
        name: newCombo.name,
        base_price: newCombo.base_price,
        virtual_stock: calculatedInitialStock,
        parts: newCombo.combo_parts.map(cp => ({
          sku: cp.product.sku,
          name: cp.product.name,
          quantity_required: cp.quantity,
          current_physical_stock: cp.product.physical_stock
        }))
      }
    });

  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'El SKU ingresado para el combo ya existe en el catálogo.' });
      return;
    }
    res.status(500).json({ error: 'Error interno al crear el combo' });
  }
};