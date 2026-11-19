import { Request, Response } from 'express';
import { OrderStatus } from '@prisma/client';
import { prismaGlobal } from '../config/prisma';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VALID_ORDER_STATUSES: OrderStatus[] = ['PENDING', 'BUDGET', 'PAID', 'SHIPPED', 'DELIVERED'];

export const getMySales = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user?.sub; 

        if (!userId) {
            console.warn('[OrdersController.getMySales] Intento de acceso sin token o sin claim "sub".');
            res.status(401).json({ error: 'No autorizado. Vendedor no identificado.' });
            return;
        }

        const sellerProfile = await prismaGlobal.sellerProfile.findFirst({
            where: {
                OR: [
                    { id: userId },
                    { user_id: userId }
                ]
            },
            select: { id: true, user_id: true }
        });

        if (!sellerProfile) {
            console.warn(`[OrdersController.getMySales] El usuario ${userId} no tiene un perfil de vendedor (SellerProfile) vinculado.`);
            res.status(200).json({
                success: true,
                data: [],
                meta: { total: 0, page: 1, limit: 20, totalPages: 0 }
            });
            return;
        }

        const sellerProfileId = sellerProfile.id;

        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const skip = (page - 1) * limit;

        const [sales, totalCount] = await Promise.all([
            prismaGlobal.order.findMany({
                where: { 
                    seller_id: sellerProfileId,
                    status: { not: 'PENDING' } 
                },
                select: {
                    id: true,
                    total_amount: true,
                    status: true,
                    created_at: true,
                    customer_id: true,
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit,
            }),
            prismaGlobal.order.count({
                where: { seller_id: sellerProfileId }
            })
        ]);

        res.status(200).json({
            success: true,
            data: sales,
            meta: {
                total: totalCount,
                page,
                limit,
                totalPages: Math.ceil(totalCount / limit)
            }
        });
    } catch (error: any) {
        console.error('[OrdersController.getMySales] Error crítico:', error.message);
        res.status(500).json({ error: 'Fallo interno al consultar las ventas.' });
    }
};

export const getMyOrders = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user?.sub;
        if (!userId) {
            res.status(401).json({ error: 'No autorizado.' });
            return;
        }

        const customerProfile = await prismaGlobal.customerProfile.findUnique({
            where: { user_id: userId },
            select: { id: true }
        });

        if (!customerProfile) {
            res.status(200).json({
                success: true,
                data: [],
                meta: { total: 0, page: 1, limit: 10, totalPages: 0 }
            });
            return;
        }

        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
        const skip = (page - 1) * limit;

        const statusQuery = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
        const statusFilter = VALID_ORDER_STATUSES.includes(statusQuery as OrderStatus)
            ? (statusQuery as OrderStatus)
            : undefined;

        const whereClause = {
            customer_id: customerProfile.id,
            ...(statusFilter ? { status: statusFilter } : { status: { not: 'BUDGET' as OrderStatus } })
        };

        const [orders, totalCount] = await Promise.all([
            prismaGlobal.order.findMany({
                where: whereClause,
                select: {
                    id: true,
                    status: true,
                    total_amount: true,
                    discount_amount: true,
                    coupon_code: true,
                    payment_method: true,
                    shipping_cp: true,
                    shipping_address: true,
                    created_at: true,
                    updated_at: true,
                    seller: {
                        select: {
                            first_name: true,
                            last_name: true,
                            ref_code: true
                        }
                    },
                    items: {
                        select: {
                            id: true,
                            quantity: true,
                            unit_price: true,
                            product: {
                                select: {
                                    id: true,
                                    sku: true,
                                    name: true,
                                    is_combo: true,
                                    images: {
                                        where: { is_primary: true },
                                        take: 1,
                                        select: { url: true, alt_text: true }
                                    }
                                }
                            }
                        }
                    }
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit
            }),
            prismaGlobal.order.count({ where: whereClause })
        ]);

        const formattedOrders = orders.map((order) => ({
            id: order.id,
            order_number: order.id.slice(0, 8).toUpperCase(),
            status: order.status,
            total_amount: Number(order.total_amount),
            discount_amount: Number(order.discount_amount),
            coupon_code: order.coupon_code,
            payment_method: order.payment_method,
            shipping_cp: order.shipping_cp,
            shipping_address: order.shipping_address,
            created_at: order.created_at,
            updated_at: order.updated_at,
            advisor: order.seller
                ? {
                    name: `${order.seller.first_name} ${order.seller.last_name}`.trim(),
                    ref_code: order.seller.ref_code
                }
                : null,
            items: order.items.map((item) => ({
                id: item.id,
                product_id: item.product?.id || null,
                sku: item.product?.sku || 'N/A',
                name: item.product?.name || 'Producto discontinuado',
                is_combo: item.product?.is_combo || false,
                image_url: item.product?.images?.[0]?.url || null,
                quantity: item.quantity,
                unit_price: Number(item.unit_price),
                subtotal: Number(item.unit_price) * item.quantity
            }))
        }));

        res.status(200).json({
            success: true,
            data: formattedOrders,
            meta: {
                total: totalCount,
                page,
                limit,
                totalPages: Math.ceil(totalCount / limit)
            }
        });
    } catch (error: any) {
        console.error('[OrdersController.getMyOrders] Error crítico:', error.message);
        res.status(500).json({ error: 'Fallo interno al obtener el historial de compras.' });
    }
};

export const getMyOrderDetail = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user?.sub;
        const orderId = req.params.id as string;

        if (!userId) {
            res.status(401).json({ error: 'No autorizado.' });
            return;
        }

        if (!UUID_REGEX.test(orderId)) {
            res.status(400).json({ error: 'Identificador de pedido inválido.' });
            return;
        }

        const customerProfile = await prismaGlobal.customerProfile.findUnique({
            where: { user_id: userId },
            select: { id: true }
        });

        if (!customerProfile) {
            res.status(404).json({ error: 'Pedido no encontrado.' });
            return;
        }

        const order = await prismaGlobal.order.findFirst({
            where: {
                id: orderId,
                customer_id: customerProfile.id
            },
            include: {
                seller: {
                    select: {
                        first_name: true,
                        last_name: true,
                        ref_code: true
                    }
                },
                items: {
                    include: {
                        product: {
                            select: {
                                id: true,
                                sku: true,
                                name: true,
                                is_combo: true,
                                images: {
                                    where: { is_primary: true },
                                    take: 1,
                                    select: { url: true, alt_text: true }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!order) {
            res.status(404).json({ error: 'Pedido no encontrado.' });
            return;
        }

        res.status(200).json({
            success: true,
            data: {
                id: order.id,
                order_number: order.id.slice(0, 8).toUpperCase(),
                status: order.status,
                total_amount: Number(order.total_amount),
                discount_amount: Number(order.discount_amount),
                coupon_code: order.coupon_code,
                payment_method: order.payment_method,
                shipping_cp: order.shipping_cp,
                shipping_address: order.shipping_address,
                created_at: order.created_at,
                updated_at: order.updated_at,
                advisor: order.seller
                    ? {
                        name: `${order.seller.first_name} ${order.seller.last_name}`.trim(),
                        ref_code: order.seller.ref_code
                    }
                    : null,
                items: order.items.map((item) => ({
                    id: item.id,
                    product_id: item.product?.id || null,
                    sku: item.product?.sku || 'N/A',
                    name: item.product?.name || 'Producto discontinuado',
                    is_combo: item.product?.is_combo || false,
                    image_url: item.product?.images?.[0]?.url || null,
                    quantity: item.quantity,
                    unit_price: Number(item.unit_price),
                    subtotal: Number(item.unit_price) * item.quantity
                }))
            }
        });
    } catch (error: any) {
        console.error('[OrdersController.getMyOrderDetail] Error:', error.message);
        res.status(500).json({ error: 'Error interno al consultar el detalle del pedido.' });
    }
};

export const getOrderPublicStatus = async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;

        if (!UUID_REGEX.test(id)) {
            res.status(400).json({ error: 'Identificador de orden inválido.' });
            return;
        }

        const order = await prismaGlobal.order.findUnique({
            where: { id },
            select: {
                id: true,
                status: true,
                payment_method: true,
                total_amount: true,
                created_at: true,
                _count: {
                    select: { items: true }
                }
            }
        });

        if (!order) {
            res.status(404).json({ error: 'Orden no encontrada.' });
            return;
        }

        res.status(200).json({
            id: order.id,
            status: order.status,
            payment_method: order.payment_method,
            total_amount: Number(order.total_amount),
            items_count: order._count.items,
            created_at: order.created_at
        });
    } catch (error: any) {
        console.error('[OrdersController.getOrderPublicStatus] Error:', error.message);
        res.status(500).json({ error: 'Error interno al verificar el estado de la orden.' });
    }
};