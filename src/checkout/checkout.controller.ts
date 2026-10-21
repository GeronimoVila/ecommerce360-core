import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { createMpPreference } from './mercadopago.service';

const prisma = new PrismaClient();

const mpClient = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || '', 
    options: { timeout: 5000 } 
});

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
                    items: { include: { product: true } }
                }
            });
        });

        let checkoutUrl = '';
        let gatewayTxnId = '';

        if (paymentMethod === 'MP') {
            const mpItems = draftOrder.items.map(i => ({
                id: i.product_id || 'N/A',
                title: i.product?.name || 'Producto',
                quantity: i.quantity,
                unit_price: Number(i.pure_base_price) 
            }));

            const mpResponse = await createMpPreference(draftOrder.id, mpItems);
            
            checkoutUrl = mpResponse.sandboxInitPoint || mpResponse.initPoint || '';
            gatewayTxnId = mpResponse.preferenceId || '';

            await prisma.order.update({
                where: { id: draftOrder.id },
                data: { gateway_txn_id: gatewayTxnId }
            });
        } else if (paymentMethod === 'MOBBEX') {
            throw new Error("Mobbex no implementado aún");
        }

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
            },
            checkoutUrl: checkoutUrl 
        });

    } catch (error) {
        console.error('[CheckoutController.createIntent] Error Crítico:', error);
        return res.status(500).json({ error: 'Fallo interno en el motor transaccional.' });
    }
};

export const receiveMpWebhook = async (req: Request, res: Response): Promise<Response | void> => {
    const paymentId = req.query['data.id'] || req.body?.data?.id;
    const type = req.query.type || req.body?.type;

    if (type !== 'payment' || !paymentId) {
        return res.status(200).send('Evento ignorado');
    }

    try {
        const paymentInfo = await new Payment(mpClient).get({ id: Number(paymentId) });

        if (paymentInfo.status === 'approved') {
            const orderId = paymentInfo.external_reference;

            if (!orderId) {
                console.warn(`[Webhook MP] Pago ${paymentId} sin external_reference (Order ID missing).`);
                return res.status(200).send('OK');
            }

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true }
            });

            if (!order) {
                console.error(`[Webhook MP] Orden ${orderId} no encontrada en PostgreSQL.`);
                return res.status(200).send('Orden no encontrada');
            }

            if (order.status === 'PAID') {
                console.log(`[Webhook MP] Orden ${orderId} ya procesada previamente (Idempotencia activa).`);
                return res.status(200).send('Orden ya procesada');
            }

            await prisma.$transaction(async (tx) => {
                await tx.order.update({
                    where: { id: orderId },
                    data: { status: 'PAID' }
                });

                for (const item of order.items) {
                    if (!item.product_id) {
                        console.warn(`[Inventario] El item de la orden ${orderId} no tiene product_id asociado. Se omite actualización de stock.`);
                        continue;
                    }

                    await tx.product.update({
                        where: { id: item.product_id },
                        data: {
                            physical_stock: { decrement: item.quantity }
                        }
                    });
                }

                if (order.seller_id) {
                    console.log(`[Atribución Registrada] Orden ${orderId} asociada al Vendedor ${order.seller_id}.`);
                }
            });

            console.log(`✅ [FINANZAS & INVENTARIO] Orden ${orderId} confirmada como PAID. Stock actualizado.`);
        }

        return res.status(200).send('Webhook procesado exitosamente');

    } catch (error) {
        console.error('[Webhook MP] Error crítico procesando la notificación:', error);
        return res.status(500).send('Internal Server Error');
    }
};