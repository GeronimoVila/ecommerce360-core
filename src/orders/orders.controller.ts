import { Request, Response } from 'express';
import { prismaGlobal } from '../config/prisma';

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