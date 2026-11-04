import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createMpPreference, getMpPaymentById } from './mercadopago.service';

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

        let validCustomerId: string | null = null;

        if (customerId && typeof customerId === 'string' && customerId.trim() !== '') {
            const cleanCustomerId = customerId.trim();

            const customerProfile = await prisma.customerProfile.findFirst({
                where: {
                    OR: [
                        { id: cleanCustomerId },
                        { user_id: cleanCustomerId }
                    ]
                }
            });

            if (!customerProfile) {
                return res.status(400).json({
                    error: 'Cliente no válido.',
                    details: `No se encontró un CustomerProfile con el ID enviado: ${cleanCustomerId}`
                });
            }

            validCustomerId = customerProfile.id;
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
                customer_id: validCustomerId,
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

export const getBudgetById = async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
    try {
        const id = req.params.id;

        const order = await prisma.order.findUnique({
            where: { id: id },
            include: { 
                items: { 
                    include: { product: { select: { name: true, sku: true } } } 
                } 
            }
        });

        if (!order || order.status !== 'BUDGET') {
            return res.status(404).json({ error: 'Presupuesto no encontrado, expirado o ya procesado.' });
        }

        const expiresAt = new Date(new Date(order.created_at).getTime() + BUDGET_EXPIRATION_HOURS * 3600 * 1000);

        return res.status(200).json({
            success: true,
            budget: {
                id: order.id,
                total_amount: order.total_amount,
                expires_at: expiresAt,
                items: order.items
            }
        });

    } catch (error) {
        console.error('[BudgetController.getBudgetById] Error:', error);
        return res.status(500).json({ error: 'Fallo al consultar el detalle del presupuesto.' });
    }
};

export const mercadopagoWebhookHandler = async (req: Request, res: Response): Promise<Response | void> => {
    const type = req.query.topic || req.body.type || req.body.action;
    const paymentId = req.query.id || req.body.data?.id;

    if (!paymentId || (type !== 'payment' && type !== 'payment.created')) {
        return res.status(200).send('Evento ignorado');
    }

    try {
        const paymentData = await getMpPaymentById(paymentId as string);

        if (paymentData.status === 'approved') {
            const orderId = paymentData.external_reference;

            if (!orderId) {
                return res.status(200).send('Pago aprobado pero sin external_reference. Ignorando.');
            }

            await prisma.$transaction(async (tx) => {
                const order = await tx.order.findUnique({
                    where: { id: orderId },
                    include: { items: { include: { product: true } } }
                });

                if (!order || order.status === 'PAID') return;

                await tx.order.update({
                    where: { id: orderId },
                    data: { status: 'PAID' }
                });

                let totalCommission = 0;

                for (const item of order.items) {
                    if (item.product_id) {
                        await tx.product.update({
                            where: { id: item.product_id },
                            data: { physical_stock: { decrement: item.quantity } }
                        });

                        if (item.product && item.product.commission_rate) {
                            const commissionValue = (Number(item.unit_price) * item.quantity) * (Number(item.product.commission_rate) / 100);
                            totalCommission += commissionValue;
                        }
                    }
                }

                if (order.seller_id && totalCommission > 0) {
                    if (order.seller_id !== order.customer_id) {
                        await tx.commissionLedger.create({
                            data: {
                                order_id: order.id,
                                seller_id: order.seller_id,
                                amount: totalCommission,
                                status: 'PENDING_CLEARANCE'
                            }
                        });
                    } else {
                        console.warn(`[FRAUD PREVENTED] Auto-compra detectada. Orden: ${order.id}. No se liquidó comisión.`);
                    }
                }
            });
        }

        return res.status(200).send('Webhook procesado con éxito');

    } catch (error) {
        console.error('[Webhook Controller] Error crítico procesando Webhook:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};