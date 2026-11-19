import { Request, Response } from 'express';
import { OrderStatus, Prisma } from '@prisma/client';
import { prismaGlobal } from '../config/prisma';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VALID_ORDER_STATUSES: OrderStatus[] = ['PENDING', 'BUDGET', 'PAID', 'SHIPPED', 'DELIVERED'];
const CONFIRMED_SALES_STATUSES: OrderStatus[] = ['PAID', 'SHIPPED', 'DELIVERED'];

const SELLER_ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
    PAID: ['SHIPPED', 'DELIVERED'],
    SHIPPED: ['DELIVERED']
};

const ADMIN_ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
    PAID: ['SHIPPED', 'DELIVERED'],
    SHIPPED: ['PAID', 'DELIVERED'],
    DELIVERED: ['SHIPPED']
};

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
                    status: { in: CONFIRMED_SALES_STATUSES }
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
                where: {
                    seller_id: sellerProfileId,
                    status: { in: CONFIRMED_SALES_STATUSES }
                }
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

export const getManageableOrders = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user?.sub;
        const userRole = req.user?.role;

        if (!userId || (userRole !== 'ADMIN' && userRole !== 'SELLER')) {
            res.status(403).json({ error: 'Permisos insuficientes para consultar ventas.' });
            return;
        }

        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const skip = (page - 1) * limit;

        const statusParam = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
        const attributionParam = typeof req.query.attribution === 'string' ? req.query.attribution.toUpperCase() : 'ALL';
        const sellerFilterParam = typeof req.query.seller_id === 'string' ? req.query.seller_id.trim() : '';
        const searchParam = typeof req.query.search === 'string' ? req.query.search.trim() : '';

        const whereClause: Prisma.OrderWhereInput = {};

        if (userRole === 'SELLER') {
            const sellerProfile = await prismaGlobal.sellerProfile.findUnique({
                where: { user_id: userId },
                select: { id: true }
            });

            if (!sellerProfile) {
                res.status(200).json({
                    success: true,
                    data: [],
                    meta: { total: 0, page, limit, totalPages: 0 }
                });
                return;
            }

            whereClause.seller_id = sellerProfile.id;
        } else if (userRole === 'ADMIN') {
            if (attributionParam === 'SELLER') {
                whereClause.seller_id = { not: null };
            } else if (attributionParam === 'DIRECT') {
                whereClause.seller_id = null;
            }

            if (sellerFilterParam && UUID_REGEX.test(sellerFilterParam)) {
                whereClause.seller_id = sellerFilterParam;
            }
        }

        if (VALID_ORDER_STATUSES.includes(statusParam as OrderStatus)) {
            if (userRole === 'SELLER' && !CONFIRMED_SALES_STATUSES.includes(statusParam as OrderStatus)) {
                whereClause.status = { in: CONFIRMED_SALES_STATUSES };
            } else {
                whereClause.status = statusParam as OrderStatus;
            }
        } else {
            whereClause.status = { in: CONFIRMED_SALES_STATUSES };
        }

        if (searchParam.length > 0) {
            whereClause.OR = [
                {
                    customer: {
                        OR: [
                            { first_name: { contains: searchParam, mode: 'insensitive' } },
                            { last_name: { contains: searchParam, mode: 'insensitive' } },
                            { user: { email: { contains: searchParam, mode: 'insensitive' } } }
                        ]
                    }
                },
                {
                    seller: {
                        OR: [
                            { first_name: { contains: searchParam, mode: 'insensitive' } },
                            { last_name: { contains: searchParam, mode: 'insensitive' } },
                            { ref_code: { contains: searchParam, mode: 'insensitive' } }
                        ]
                    }
                },
                {
                    items: {
                        some: {
                            product: {
                                OR: [
                                    { name: { contains: searchParam, mode: 'insensitive' } },
                                    { sku: { contains: searchParam, mode: 'insensitive' } }
                                ]
                            }
                        }
                    }
                }
            ];
        }

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
                    seller_id: true,
                    customer: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            phone: true,
                            user: {
                                select: { email: true }
                            }
                        }
                    },
                    seller: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            ref_code: true,
                            user: {
                                select: { email: true }
                            }
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
                                        select: { url: true }
                                    }
                                }
                            }
                        }
                    },
                    commissions: {
                        select: {
                            id: true,
                            amount: true,
                            status: true
                        }
                    }
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit
            }),
            prismaGlobal.order.count({ where: whereClause })
        ]);

        const transitionMap = userRole === 'ADMIN' ? ADMIN_ALLOWED_TRANSITIONS : SELLER_ALLOWED_TRANSITIONS;

        const formattedOrders = orders.map((order) => {
            const customerFullName = order.customer
                ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
                : '';

            return {
                id: order.id,
                order_number: order.id.slice(0, 8).toUpperCase(),
                status: order.status,
                allowed_next_statuses: transitionMap[order.status] || [],
                total_amount: Number(order.total_amount),
                discount_amount: Number(order.discount_amount),
                coupon_code: order.coupon_code,
                payment_method: order.payment_method,
                shipping_cp: order.shipping_cp,
                shipping_address: order.shipping_address,
                created_at: order.created_at,
                updated_at: order.updated_at,
                attribution_type: order.seller_id ? 'SELLER' : 'DIRECT',
                seller: order.seller
                    ? {
                        id: order.seller.id,
                        name: `${order.seller.first_name} ${order.seller.last_name}`.trim(),
                        ref_code: order.seller.ref_code,
                        email: order.seller.user?.email || null
                    }
                    : null,
                customer: order.customer
                    ? {
                        id: order.customer.id,
                        name: customerFullName || order.customer.user?.email || 'Cliente registrado',
                        email: order.customer.user?.email || null,
                        phone: order.customer.phone || null
                    }
                    : {
                        id: null,
                        name: 'Cliente Invitado',
                        email: null,
                        phone: null
                    },
                commission: order.commissions[0]
                    ? {
                        id: order.commissions[0].id,
                        amount: Number(order.commissions[0].amount),
                        status: order.commissions[0].status
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
            };
        });

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
        console.error('[OrdersController.getManageableOrders] Error crítico:', error.message);
        res.status(500).json({ error: 'Fallo interno al obtener el listado de ventas.' });
    }
};

export const updateOrderStatus = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user?.sub;
        const userRole = req.user?.role;
        const orderId = req.params.id as string;
        const nextStatusRaw = typeof req.body?.status === 'string' ? req.body.status.toUpperCase() : '';

        if (!userId || (userRole !== 'ADMIN' && userRole !== 'SELLER')) {
            res.status(403).json({ error: 'Permisos insuficientes para actualizar estados.' });
            return;
        }

        if (!UUID_REGEX.test(orderId)) {
            res.status(400).json({ error: 'Identificador de orden inválido.' });
            return;
        }

        if (!VALID_ORDER_STATUSES.includes(nextStatusRaw as OrderStatus)) {
            res.status(400).json({ error: 'Estado de orden no válido.' });
            return;
        }

        const nextStatus = nextStatusRaw as OrderStatus;

        const order = await prismaGlobal.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                status: true,
                seller_id: true
            }
        });

        if (!order) {
            res.status(404).json({ error: 'Orden no encontrada.' });
            return;
        }

        if (userRole === 'SELLER') {
            const sellerProfile = await prismaGlobal.sellerProfile.findUnique({
                where: { user_id: userId },
                select: { id: true }
            });

            if (!sellerProfile || order.seller_id !== sellerProfile.id) {
                res.status(403).json({ error: 'No tienes permiso para modificar órdenes que no pertenecen a tus ventas.' });
                return;
            }
        }

        if (order.status === nextStatus) {
            res.status(200).json({
                success: true,
                message: 'La orden ya se encuentra en el estado indicado.',
                data: { id: order.id, status: order.status }
            });
            return;
        }

        const transitionMap = userRole === 'ADMIN' ? ADMIN_ALLOWED_TRANSITIONS : SELLER_ALLOWED_TRANSITIONS;
        const allowedTargets = transitionMap[order.status] || [];

        if (!allowedTargets.includes(nextStatus)) {
            res.status(400).json({
                error: `Transición no permitida de "${order.status}" a "${nextStatus}" para el rol ${userRole}.`
            });
            return;
        }

        const updateResult = await prismaGlobal.order.updateMany({
            where: {
                id: orderId,
                status: order.status
            },
            data: {
                status: nextStatus
            }
        });

        if (updateResult.count === 0) {
            res.status(409).json({
                error: 'El estado de la orden cambió concurrentemente. Refresca el listado e intenta nuevamente.'
            });
            return;
        }

        res.status(200).json({
            success: true,
            message: `Estado actualizado a ${nextStatus}.`,
            data: {
                id: orderId,
                status: nextStatus,
                allowed_next_statuses: transitionMap[nextStatus] || []
            }
        });
    } catch (error: any) {
        console.error('[OrdersController.updateOrderStatus] Error crítico:', error.message);
        res.status(500).json({ error: 'Error interno al actualizar el estado de la orden.' });
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