import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { RedisService } from '../redis/redis.service';
import { triggerB2CRevalidation } from '../utils/revalidate.util';

interface RestockItem {
  sku: string;
  quantity: number;
}

export const processRestock = async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider_name, reference_document, items } = req.body as { 
      provider_name?: string; 
      reference_document?: string; 
      items: RestockItem[];
    };

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'El remito debe contener al menos un producto (items).' });
      return;
    }

    const invalidItems = items.filter(
      item => typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0
    );

    if (invalidItems.length > 0) {
      res.status(400).json({
        error: 'Transacción abortada. Todas las cantidades (quantity) deben ser números enteros estrictamente mayores a cero (> 0).',
        invalid_items: invalidItems
      });
      return;
    }

    const skus = items.map(item => item.sku.toUpperCase());
    const existingProducts = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { id: true, sku: true, is_combo: true }
    });

    if (existingProducts.length !== skus.length) {
      const existingSkus = existingProducts.map(p => p.sku);
      const missingSkus = skus.filter(s => !existingSkus.includes(s));
      res.status(404).json({ 
        error: 'Transacción abortada. Algunos SKUs no existen en el catálogo.',
        missing_skus: missingSkus
      });
      return;
    }

    const comboAttempt = existingProducts.find(p => p.is_combo);
    if (comboAttempt) {
      res.status(400).json({ 
        error: `El SKU ${comboAttempt.sku} es un Combo. El stock de los combos es virtual y depende de sus piezas individuales.` 
      });
      return;
    }

    const { updatedParts, purchaseRecord } = await prisma.$transaction(async (tx) => {
      
      let supplierId = null;
      if (provider_name) {
        const supplier = await tx.supplier.findUnique({
          where: { name: provider_name }
        });
        if (supplier) supplierId = supplier.id;
      }

      const purchase = await tx.supplierPurchase.create({
        data: {
          provider_name: provider_name || null,
          supplier_id: supplierId,
          reference_document: reference_document || null,
        }
      });

      const results = [];
      
      for (const item of items) {
        const dbProduct = existingProducts.find(p => p.sku === item.sku.toUpperCase())!;

        const updatedProduct = await tx.product.update({
          where: { id: dbProduct.id },
          data: { physical_stock: { increment: item.quantity } },
          select: { id: true, sku: true, physical_stock: true }
        });

        const stockAfter = updatedProduct.physical_stock;
        const stockBefore = stockAfter - item.quantity;

        await tx.supplierPurchaseItem.create({
          data: {
            purchase_id: purchase.id,
            product_id: dbProduct.id,
            quantity_added: item.quantity,
            stock_before: stockBefore,
            stock_after: stockAfter
          }
        });

        results.push(updatedProduct);
      }
      
      return { updatedParts: results, purchaseRecord: purchase };
    });

    const affectedComboIds = new Set<string>();
    
    for (const part of updatedParts) {
      const combos = await RedisService.getCombosByPart(part.id);
      combos.forEach(comboId => affectedComboIds.add(comboId));
    }

    for (const comboId of affectedComboIds) {
      const comboRecipe = await prisma.product.findUnique({
        where: { id: comboId },
        select: {
          combo_parts: {
            select: {
              quantity: true,
              product: { select: { physical_stock: true } }
            }
          }
        }
      });

      if (comboRecipe) {
        let minVirtualStock = Infinity;
        for (const part of comboRecipe.combo_parts) {
          const possibleCombos = Math.floor(part.product.physical_stock / part.quantity);
          if (possibleCombos < minVirtualStock) minVirtualStock = possibleCombos;
        }

        await RedisService.setComboStock(comboId, minVirtualStock);
      }
    }

    triggerB2CRevalidation('products');

    res.status(200).json({
      message: 'Restock procesado correctamente. Inventarios y combos actualizados.',
      provider: provider_name || 'No especificado',
      document: reference_document || 'N/A',
      updated_items: updatedParts,
      combos_recalculated: affectedComboIds.size
    });

  } catch (error) {
    console.error('[InventoryController] Error en restock:', error);
    res.status(500).json({ error: 'Error interno al procesar el ingreso de mercadería.' });
  }
};

export const getSupplierPurchases = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const purchases = await prisma.supplierPurchase.findMany({
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
      include: {
        items: {
          include: {
            product: {
              select: { sku: true, name: true }
            }
          }
        }
      }
    });

    const total = await prisma.supplierPurchase.count();

    const formattedPurchases = purchases.map(purchase => ({
      id: purchase.id,
      provider: purchase.provider_name || 'Desconocido',
      document: purchase.reference_document || 'S/D',
      date: purchase.created_at,
      total_items_types: purchase.items.length,
      details: purchase.items.map(item => ({
        sku: item.product.sku,
        name: item.product.name,
        quantity_added: item.quantity_added,
        stock_transition: `${item.stock_before} -> ${item.stock_after}`
      }))
    }));

    res.status(200).json({
      data: formattedPurchases,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('[InventoryController] Error al obtener el historial de compras:', error);
    res.status(500).json({ error: 'Error al obtener el historial de compras a proveedores.' });
  }
};

export const updateSupplierPurchaseMetadata = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { provider_name, reference_document, items, quantity } = req.body;

    if (items !== undefined || quantity !== undefined) {
      res.status(403).json({ 
        error: 'Violación de Inmutabilidad. No se pueden modificar las cantidades o los productos de un remito ya procesado. Para corregir el stock, realice un Ajuste de Inventario.' 
      });
      return;
    }

    const updatedPurchase = await prisma.supplierPurchase.update({
      where: { id },
      data: {
        ...(provider_name !== undefined && { provider_name }),
        ...(reference_document !== undefined && { reference_document })
      }
    });

    res.status(200).json({
      message: 'Metadatos del remito actualizados correctamente. El historial de stock permanece inmutable.',
      data: updatedPurchase
    });

  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'El remito de proveedor no existe.' });
      return;
    }
    console.error('[InventoryController] Error al actualizar remito:', error);
    res.status(500).json({ error: 'Error interno al actualizar los metadatos de la compra.' });
  }
};