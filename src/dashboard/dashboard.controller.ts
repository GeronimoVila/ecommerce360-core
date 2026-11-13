import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { OrderStatus, CommissionStatus } from '@prisma/client'; 
import { RedisService } from '../redis/redis.service'; 

export const getNetRevenue = async (req: Request, res: Response): Promise<Response> => {
  try {
    const cacheKey = 'admin:metrics:net-revenue-affiliate';
    
    const cachedData = await RedisService.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({ status: 'success', data: JSON.parse(cachedData) });
    }

    const now = new Date();
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const [currentMonthData, previousMonthData, affiliateData] = await Promise.all([
      prisma.order.aggregate({
        _sum: { total_amount: true },
        _count: { id: true },
        where: { status: OrderStatus.PAID, created_at: { gte: startOfCurrentMonth } }
      }),
      prisma.order.aggregate({
        _sum: { total_amount: true },
        where: { status: OrderStatus.PAID, created_at: { gte: startOfPreviousMonth, lte: endOfPreviousMonth } }
      }),
      prisma.order.aggregate({
        _sum: { total_amount: true },
        where: { 
          status: OrderStatus.PAID, 
          created_at: { gte: startOfCurrentMonth },
          seller_id: { not: null }
        }
      })
    ]);

    const currentGross = Number(currentMonthData._sum.total_amount || 0);
    const previousGross = Number(previousMonthData._sum.total_amount || 0);
    const affiliateGross = Number(affiliateData._sum.total_amount || 0);
    
    const netRevenue = currentGross;
    let percentageChange = 0;
    if (previousGross > 0) {
      percentageChange = ((currentGross - previousGross) / previousGross) * 100;
    }

    const affiliateRevenuePercentage = currentGross > 0 ? (affiliateGross / currentGross) * 100 : 0;

    const payload = {
      period: startOfCurrentMonth.toISOString().substring(0, 7),
      netRevenue,
      affiliateRevenuePercentage: Number(affiliateRevenuePercentage.toFixed(2)),
      comparisonVsLastMonthPercentage: Number(percentageChange.toFixed(2)),
      lastUpdated: new Date().toISOString()
    };

    await RedisService.set(cacheKey, JSON.stringify(payload), 900);
    return res.status(200).json({ status: 'success', data: payload });

  } catch (error) {
    console.error('[Dashboard] Error calculando Ingreso Neto y Afiliados:', error);
    return res.status(500).json({ error: 'Error interno calculando métricas.' });
  }
};

export const getSellersDebt = async (req: Request, res: Response): Promise<Response> => {
  try {
    const cacheKey = 'admin:metrics:sellers-debt';
    
    const cachedData = await RedisService.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({ status: 'success', data: JSON.parse(cachedData) });
    }

    const debtAggregation = await prisma.commissionLedger.aggregate({
      _sum: { amount: true },
      where: {
        status: CommissionStatus.AVAILABLE 
      }
    });

    const pendingCommissions = Number(debtAggregation._sum.amount || 0);

    const payload = {
      pendingCommissions,
      currency: 'ARS',
      lastUpdated: new Date().toISOString()
    };

    await RedisService.set(cacheKey, JSON.stringify(payload), 300);

    return res.status(200).json({ status: 'success', data: payload });

  } catch (error) {
    console.error('[Dashboard] Error calculando Deuda a Vendedores:', error);
    return res.status(500).json({ error: 'Error interno calculando deuda.' });
  }
};

export const getInventoryAlerts = async (req: Request, res: Response): Promise<Response> => {
  try {
    const cacheKey = 'admin:metrics:inventory-alerts';
    
    const cachedData = await RedisService.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({ status: 'success', data: JSON.parse(cachedData) });
    }

    const criticalStockCount = await prisma.product.count({
      where: {
        is_active: true,
        is_combo: false, 
        physical_stock: { lte: 3 }
      }
    });

    const payload = { 
      criticalStockCount,
      lastUpdated: new Date().toISOString()
    };

    await RedisService.set(cacheKey, JSON.stringify(payload), 300);

    return res.status(200).json({ status: 'success', data: payload });

  } catch (error) {
    console.error('[Dashboard] Error calculando alertas de stock:', error);
    return res.status(500).json({ error: 'Error interno de inventario.' });
  }
};

export const getPerformanceChart = async (req: Request, res: Response): Promise<Response> => {
  try {
    const range = (req.query.range as string) || '7d';
    const cacheKey = `admin:metrics:performance-chart-${range}`;
    
    const cachedData = await RedisService.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({ status: 'success', data: JSON.parse(cachedData) });
    }

    let iterations = 7;
    let daysPerIteration = 1;

    if (range === 'month') {
      iterations = 4;
      daysPerIteration = 7;
    } else if (range === 'quarter') {
      iterations = 12;
      daysPerIteration = 7;
    }

    const promises = [];
    let totalSales = 0;
    let totalCommissions = 0;

    for (let i = iterations - 1; i >= 0; i--) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - (i * daysPerIteration) - daysPerIteration + 1);
      startDate.setHours(0, 0, 0, 0);
      
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + daysPerIteration - 1);
      endDate.setHours(23, 59, 59, 999);

      const dayLabel = range === '7d' 
        ? ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][startDate.getDay()]
        : `${startDate.getDate()}/${startDate.getMonth()+1}`;

      promises.push(
        Promise.all([
          prisma.order.aggregate({
            _sum: { total_amount: true },
            where: { status: OrderStatus.PAID, created_at: { gte: startDate, lte: endDate } }
          }),
          prisma.commissionLedger.aggregate({
            _sum: { amount: true },
            where: { created_at: { gte: startDate, lte: endDate } }
          })
        ]).then(([salesAgg, commAgg]) => {
          const sales = Number(salesAgg._sum.total_amount || 0);
          const commissions = Number(commAgg._sum.amount || 0);
          
          totalSales += sales;
          totalCommissions += commissions;

          return { 
            day: dayLabel, 
            date: `${startDate.toISOString().split('T')[0]} a ${endDate.toISOString().split('T')[0]}`, 
            sales, 
            commissions 
          };
        })
      );
    }

    const resolvedSeries = await Promise.all(promises);

    const payload = {
      summary: {
        totalSales,
        totalCommissions,
        margin: totalSales > 0 ? Number(((totalCommissions / totalSales) * 100).toFixed(2)) : 0
      },
      series: resolvedSeries
    };

    await RedisService.set(cacheKey, JSON.stringify(payload), 900);

    return res.status(200).json({ status: 'success', data: payload });
  } catch (error) {
    console.error('[Dashboard] Error generando gráfico de rendimiento:', error);
    return res.status(500).json({ error: 'Error interno generando gráfico.' });
  }
};

export const getTopSellers = async (req: Request, res: Response): Promise<Response> => {
  try {
    const cacheKey = 'admin:metrics:top-sellers';
    const cachedData = await RedisService.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({ status: 'success', data: JSON.parse(cachedData) });
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));

    const topSellersAgg = await prisma.order.groupBy({
      by: ['seller_id'],
      _sum: { total_amount: true },
      where: {
        status: OrderStatus.PAID,
        seller_id: { not: null },
        created_at: { gte: thirtyDaysAgo }
      },
      orderBy: { _sum: { total_amount: 'desc' } },
      take: 5
    });

    if (topSellersAgg.length === 0) {
      return res.status(200).json({ status: 'success', data: [] });
    }

    const sellerIds = topSellersAgg.map(agg => agg.seller_id as string);
    
    const sellersProfiles = await prisma.sellerProfile.findMany({
      where: { id: { in: sellerIds } },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        ref_code: true
      }
    });

    const leaderboard = topSellersAgg.map(agg => {
      const profile = sellersProfiles.find(p => p.id === agg.seller_id);
      const totalSold = Number(agg._sum.total_amount || 0);
      
      let tier = 'Tier 3';
      if (totalSold >= 50000) tier = 'Tier 1 Elite';
      else if (totalSold >= 20000) tier = 'Tier 2 PRO';

      return {
        id: profile?.id,
        name: `${profile?.first_name} ${profile?.last_name}`,
        refCode: profile?.ref_code,
        initials: `${profile?.first_name?.charAt(0) || ''}${profile?.last_name?.charAt(0) || ''}`,
        totalSold,
        tier,
        leadCategory: 'Multi-categoría' 
      };
    });

    await RedisService.set(cacheKey, JSON.stringify(leaderboard), 3600);

    return res.status(200).json({ status: 'success', data: leaderboard });

  } catch (error) {
    console.error('[Dashboard] Error calculando Leaderboard:', error);
    return res.status(500).json({ error: 'Error interno calculando ranking de vendedores.' });
  }
};

export const getOperationalAlerts = async (req: Request, res: Response): Promise<Response> => {
  try {
    const cacheKey = 'admin:metrics:operational-alerts';
    const cachedData = await RedisService.get(cacheKey);

    if (cachedData) {
      return res.status(200).json({ status: 'success', data: JSON.parse(cachedData) });
    }

    const alerts: Array<{
      id: string;
      type: 'INFO' | 'WARNING' | 'CRITICAL';
      category: 'USERS' | 'INVENTORY' | 'FINANCE';
      title: string;
      message: string;
      actionUrl: string;
      actionText: string;
    }> = [];

    const inactiveSellersCount = await prisma.sellerProfile.count({
      where: {
        user: {
          is_active: false
        }
      }
    });

    if (inactiveSellersCount > 0) {
      alerts.push({
        id: 'alert_sellers_pending',
        type: 'INFO',
        category: 'USERS',
        title: 'Cuentas de vendedor inactivas',
        message: `${inactiveSellersCount} perfiles de vendedores se encuentran inactivos o pendientes de alta.`,
        actionUrl: '/admin/team',
        actionText: 'Revisar'
      });
    }

    const lowStockCount = await prisma.product.count({
      where: {
        is_active: true,
        physical_stock: { lte: 5 }
      }
    });

    if (lowStockCount > 0) {
      alerts.push({
        id: 'alert_low_stock',
        type: 'WARNING',
        category: 'INVENTORY',
        title: 'Stock físico crítico',
        message: `${lowStockCount} SKUs tienen 5 o menos unidades físicas disponibles en depósito.`,
        actionUrl: '/admin/inventory/restock',
        actionText: 'Abastecer'
      });
    }

    const payload = {
      activeCount: alerts.length,
      alerts
    };

    await RedisService.set(cacheKey, JSON.stringify(payload), 300);

    return res.status(200).json({ status: 'success', data: payload });

  } catch (error) {
    console.error('[Dashboard] Error generando alertas operativas:', error);
    return res.status(500).json({ error: 'Error interno generando alertas.' });
  }
};

export const getSellerDashboard = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.user.sub) {
      return res.status(401).json({ error: 'No autorizado.' });
    }

    const userId = req.user.sub;

    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { user_id: userId },
      select: { id: true }
    });

    if (!sellerProfile) {
      return res.status(404).json({ error: 'Perfil de vendedor no encontrado.' });
    }

    const sellerProfileId = sellerProfile.id;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    const expirationThreshold = new Date(now.getTime() - (15 * 24 * 60 * 60 * 1000));
    const warningThreshold = new Date(now.getTime() - (13 * 24 * 60 * 60 * 1000));

    const [
      saldoDisponibleAggr, 
      ventasLiquidadasAggr,
      funnelCerrados,
      funnelPendientes,
      funnelVencidos
    ] = await Promise.all([
      prisma.commissionLedger.aggregate({
        where: { seller_id: sellerProfileId, status: 'AVAILABLE' },
        _sum: { amount: true },
      }),
      prisma.order.aggregate({
        where: { seller_id: sellerProfileId, status: 'PAID' },
        _count: { id: true },
      }),
      prisma.order.count({
        where: { 
          seller_id: sellerProfileId, 
          created_at: { gte: thirtyDaysAgo },
          status: { in: ['PAID', 'SHIPPED', 'DELIVERED'] }
        }
      }),
      prisma.order.count({
        where: {
          seller_id: sellerProfileId,
          created_at: { gte: expirationThreshold },
          status: { in: ['PENDING', 'BUDGET'] }
        }
      }),
      prisma.order.count({
        where: {
          seller_id: sellerProfileId,
          created_at: { gte: thirtyDaysAgo, lt: expirationThreshold },
          status: { in: ['PENDING', 'BUDGET'] }
        }
      })
    ]);

    const emitidos = funnelCerrados + funnelPendientes + funnelVencidos;
    const winRate = emitidos > 0 ? Math.round((funnelCerrados / emitidos) * 100) : 0;

    const urgentBudgetsRaw = await prisma.order.findMany({
      where: {
        seller_id: sellerProfileId,
        status: { in: ['PENDING', 'BUDGET'] },
        created_at: {
          gte: expirationThreshold,
          lt: warningThreshold
        }
      },
      include: {
        customer: true
      },
      orderBy: {
        created_at: 'asc'
      },
      take: 5 
    });

    const urgent_actions = urgentBudgetsRaw.map(order => {
      const expiresAt = new Date(order.created_at.getTime() + (15 * 24 * 60 * 60 * 1000));
      const hoursLeft = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60)));

      return {
        id: order.id,
        client: order.customer 
          ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || 'Cliente B2B'
          : 'Cliente B2B',
        cuit: order.customer?.phone || order.customer_id?.substring(0,8) || 'N/A', 
        expires_in: hoursLeft > 24 ? `${Math.floor(hoursLeft/24)} días` : `${hoursLeft} hs`,
        amount: Number(order.total_amount)
      };
    });

    const dashboardPayload = {
      seller_id: sellerProfileId,
      financials: {
        available_balance: Number(saldoDisponibleAggr._sum.amount || 0),
        liquidated_sales_count: ventasLiquidadasAggr._count.id || 0,
      },
      pipeline: {
        emitidos,
        pendientes: funnelPendientes,
        cerrados: funnelCerrados,
        vencidos: funnelVencidos,
        win_rate: winRate
      },
      urgent_actions
    };

    return res.status(200).json(dashboardPayload);

  } catch (error) {
    console.error('[Dashboard Error]:', error);
    return res.status(500).json({ error: 'Error interno al calcular métricas del dashboard' });
  }
};