import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createMpPreference } from './mercadopago.service';

const prisma = new PrismaClient();

const BUDGET_EXPIRATION_HOURS = 48;

export const createBudget = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const userId = (req as any).user?.sub; 

        if (!userId) {
            return res.status(401).json({ error: 'Token inválido o malformado: No se encontró el claim sub.' });
        }

        const { items, customerId, paymentMethod } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'El presupuesto debe contener al menos un producto.' });
        }

        const sellerProfile = await prisma.sellerProfile.findUnique({
            where: { user_id: userId }
        });

        if (!sellerProfile) {
            return res.status(403).json({ error: 'Perfil de vendedor no encontrado o inactivo.' });
        }

        const productIds = items.map((i: { productId: string }) => i.productId);
        const dbProducts = await prisma.product.findMany({
            where: { id: { in: productIds }, is_active: true }
        });

        if (dbProducts.length !== items.length) {
            return res.status(400).json({ error: 'Discrepancia en catálogo: Productos inactivos o inexistentes.' });
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

        const budgetOrder = await prisma.order.create({
            data: {
                seller_id: sellerProfile.id,
                customer_id: customerId || null,
                status: 'BUDGET',
                total_amount: totalAmount,
                payment_method: paymentMethod || 'MP',
                items: { create: orderItemsToCreate }
            }
        });

        return res.status(201).json({
            success: true,
            message: 'Presupuesto creado con éxito.',
            budget: {
                id: budgetOrder.id,
                total_amount: budgetOrder.total_amount,
                expires_at: new Date(Date.now() + BUDGET_EXPIRATION_HOURS * 3600 * 1000)
            }
        });

    } catch (error) {
        console.error('[BudgetController.createBudget] Error:', error);
        return res.status(500).json({ error: 'Fallo al generar el presupuesto.' });
    }
};

export const payBudget = async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    try {
        const id = req.params.id as string;

        const order = await prisma.order.findUnique({
            where: { id: id },
            include: { items: { include: { product: true } } }
        });

        if (!order || order.status !== 'BUDGET') {
            return res.status(404).json({ error: 'Presupuesto no encontrado o ya procesado.' });
        }

        const hoursSinceCreation = Math.abs(Date.now() - new Date(order.created_at).getTime()) / 36e5;
        if (hoursSinceCreation > BUDGET_EXPIRATION_HOURS) {
            return res.status(410).json({ error: 'El presupuesto ha expirado (48h). Solicite uno nuevo.' });
        }

        for (const item of order.items) {
            if (item.product && item.product.physical_stock < item.quantity) {
                return res.status(409).json({ 
                    error: 'Quiebre de stock.', 
                    details: `Stock insuficiente para el producto: ${item.product.name}` 
                });
            }
        }

        let checkoutUrl = '';
        let gatewayTxnId = '';

        if (order.payment_method === 'MP') {
            const mpItems = order.items.map((i: any) => ({
                id: i.product_id || 'N/A',
                title: i.product?.name || 'Producto Presupuestado',
                quantity: i.quantity,
                unit_price: Number(i.unit_price)
            }));

            const mpResponse = await createMpPreference(order.id, mpItems);
            checkoutUrl = mpResponse.sandboxInitPoint || mpResponse.initPoint || '';
            gatewayTxnId = mpResponse.preferenceId || '';

            await prisma.order.update({
                where: { id: order.id },
                data: { 
                    status: 'PENDING',
                    gateway_txn_id: gatewayTxnId
                }
            });
        }

        return res.status(200).json({
            success: true,
            checkoutUrl
        });

    } catch (error) {
        console.error('[BudgetController.payBudget] Error:', error);
        return res.status(500).json({ error: 'Fallo al procesar el pago del presupuesto.' });
    }
};