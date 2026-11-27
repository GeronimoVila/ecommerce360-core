import { Request, Response } from 'express';
import { prismaGlobal } from '../config/prisma';
import { RedisService } from '../redis/redis.service';
import { PricingEngine } from '../products/pricing.engine';

export const syncCart = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const { items, paymentMethod, installments = 1 } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'El carrito está vacío o tiene un formato inválido.' });
        }

        const productIds = items.map(i => i.productId);

        const dbProducts = await prismaGlobal.product.findMany({
            where: { id: { in: productIds } },
            select: {
                id: true,
                name: true,
                base_price: true,
                physical_stock: true,
                is_combo: true,
                is_active: true,
                category_id: true,
                category: { select: { id: true, path: true } },
                images: {
                    orderBy: [
                        { is_primary: 'desc' },
                        { position: 'asc' }
                    ],
                    take: 1,
                    select: { url: true }
                }
            }
        });

        const activeRules = await RedisService.getActivePaymentRules();
        const pricedProducts = PricingEngine.applyDynamicPricing(dbProducts, activeRules);

        const comboIds = dbProducts.filter(p => p.is_combo).map(p => p.id);
        const comboStocks = comboIds.length > 0
            ? await RedisService.getMultipleComboStocks(comboIds)
            : {};

        let subtotal = 0;
        let baseSubtotal = 0;
        let hasErrors = false;
        const effectiveInstallments = Number(installments) || 1;

        const hydratedItems = items.map(reqItem => {
            const dbProduct = pricedProducts.find(p => p.id === reqItem.productId);

            if (!dbProduct) {
                hasErrors = true;
                return { ...reqItem, error: 'Producto no encontrado en el catálogo.' };
            }

            const primaryImageUrl = dbProduct.images[0]?.url || null;
            const effectiveStock = dbProduct.is_combo
                ? (comboStocks[dbProduct.id] ?? 0)
                : dbProduct.physical_stock;

            if (!dbProduct.is_active) {
                hasErrors = true;
                return {
                    ...reqItem,
                    error: 'El producto ya no está disponible.',
                    name: dbProduct.name,
                    imageUrl: primaryImageUrl
                };
            }

            const basePrice = Number(dbProduct.base_price);
            const effectivePricing = PricingEngine.calculateEffectiveUnitPrice(
                dbProduct,
                activeRules,
                paymentMethod,
                effectiveInstallments
            );
            const unitPrice = effectivePricing.unitPrice;

            if (effectiveStock < reqItem.quantity) {
                hasErrors = true;
                return {
                    ...reqItem,
                    error: effectiveStock === 0 ? 'Sin stock disponible.' : 'Stock insuficiente.',
                    availableStock: effectiveStock,
                    name: dbProduct.name,
                    basePrice,
                    unitPrice,
                    dynamicPricing: dbProduct.dynamic_pricing,
                    imageUrl: primaryImageUrl
                };
            }

            const itemTotal = Math.round(unitPrice * reqItem.quantity * 100) / 100;
            baseSubtotal += basePrice * reqItem.quantity;
            subtotal += itemTotal;

            return {
                productId: dbProduct.id,
                name: dbProduct.name,
                basePrice,
                unitPrice,
                discountPercentage: effectivePricing.discountPercentage,
                interestPercentage: effectivePricing.interestPercentage,
                quantity: reqItem.quantity,
                itemTotal,
                availableStock: effectiveStock,
                dynamicPricing: dbProduct.dynamic_pricing,
                imageUrl: primaryImageUrl
            };
        });

        return res.status(200).json({
            success: !hasErrors,
            baseSubtotal: Math.round(baseSubtotal * 100) / 100,
            subtotal: Math.round(subtotal * 100) / 100,
            items: hydratedItems
        });

    } catch (error) {
        console.error('[CartController.syncCart] Error:', error);
        return res.status(500).json({ error: 'Fallo interno sincronizando el carrito.' });
    }
};

export const validateCoupon = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const { code, cartSubtotal } = req.body;

        if (!code || cartSubtotal === undefined) {
            return res.status(400).json({ error: 'Se requiere el código del cupón y el subtotal del carrito.' });
        }

        const coupon = await prismaGlobal.coupon.findUnique({
            where: { code: code.toUpperCase() }
        });

        if (!coupon) return res.status(404).json({ error: 'Cupón no encontrado.' });
        if (!coupon.is_active) return res.status(400).json({ error: 'Cupón inválido.' });

        const now = new Date();
        if (coupon.starts_at && coupon.starts_at > now) return res.status(400).json({ error: 'Cupón inválido.' });
        if (coupon.expires_at && coupon.expires_at < now) return res.status(400).json({ error: 'Cupón inválido.' });

        if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
            return res.status(400).json({ error: 'Cupón inválido.' });
        }

        const subtotalNum = Number(cartSubtotal);
        const minPurchase = Number(coupon.min_purchase_amount || 0);

        if (minPurchase > 0 && subtotalNum < minPurchase) {
            return res.status(400).json({ error: `La compra mínima requerida es de $${minPurchase}.` });
        }

        let projectedDiscount = 0;
        if (coupon.discount_type === 'PERCENTAGE') {
            projectedDiscount = subtotalNum * (Number(coupon.discount_value) / 100);
        } else {
            projectedDiscount = Number(coupon.discount_value);
        }

        if (projectedDiscount > subtotalNum) {
            projectedDiscount = subtotalNum;
        }

        return res.status(200).json({
            success: true,
            coupon: {
                id: coupon.id,
                code: coupon.code,
                type: coupon.discount_type,
                value: Number(coupon.discount_value),
                projectedDiscount
            }
        });

    } catch (error) {
        console.error('[CartController.validateCoupon] Error:', error);
        return res.status(500).json({ error: 'Fallo interno validando el cupón.' });
    }
};