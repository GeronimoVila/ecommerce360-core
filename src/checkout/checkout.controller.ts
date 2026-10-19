import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const createCheckoutIntent = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const { items, paymentMethod, customerId } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'El carrito no puede estar vacío.' });
        }

        const sellerIdCookie = req.cookies.seller_attribution || null;
        let validSellerId: string | null = null;

        if (sellerIdCookie) {
            const activeSeller = await prisma.sellerProfile.findFirst({
                where: {
                    OR: [
                        { id: sellerIdCookie },
                        { user_id: sellerIdCookie }
                    ],
                    user: {
                        is_active: true,
                        role: 'SELLER'
                    }
                },
                select: { id: true }
            });

            if (activeSeller) {
                validSellerId = activeSeller.id;
            } else {
                console.warn(`[Atribución Rechazada] ID de vendedor en cookie (${sellerIdCookie}) inválido o inactivo.`);
            }
        }

        const productIds = items.map((i: { productId: string }) => i.productId);
        const dbProducts = await prisma.product.findMany({
            where: { 
                id: { in: productIds },
                is_active: true 
            }
        });

        if (dbProducts.length !== items.length) {
            return res.status(400).json({ error: 'Uno o más productos del carrito no existen o están inactivos.' });
        }

        let totalAmount = 0;
        const orderItemsToCreate = items.map((frontendItem: any) => {
            const dbProduct = dbProducts.find(p => p.id === frontendItem.productId);
            
            const unitPrice = Number(dbProduct!.base_price); 
            const quantity = Number(frontendItem.quantity);
            
            totalAmount += (unitPrice * quantity);

            return {
                product_id: dbProduct!.id,
                quantity: quantity,
                unit_price: unitPrice,
                pure_base_price: unitPrice
            };
        });

        const draftOrder = await prisma.$transaction(async (tx) => {
            return await tx.order.create({
                data: {
                    customer_id: customerId || null,
                    seller_id: validSellerId,
                    status: 'PENDING',
                    total_amount: totalAmount,
                    payment_method: paymentMethod,
                    items: {
                        create: orderItemsToCreate
                    }
                },
                include: {
                    items: true
                }
            });
        });

        return res.status(201).json({
            success: true,
            message: "Intención de compra registrada exitosamente.",
            attribution: {
                status: validSellerId ? 'ASSISTED' : 'ORGANIC',
                sellerId: validSellerId
            },
            order: {
                id: draftOrder.id,
                total_amount: draftOrder.total_amount,
                status: draftOrder.status,
                itemsCount: draftOrder.items.length
            }
        });

    } catch (error) {
        console.error('[CheckoutController.createIntent] Error Crítico:', error);
        return res.status(500).json({ error: 'Fallo interno en el motor transaccional.' });
    }
};