import { Request, Response } from 'express';
import { NotificationType, Role } from '@prisma/client';
import { prismaGlobal } from '../config/prisma';
import { createMpPreference, getMpPaymentById } from './mercadopago.service';
import { generateMobbexSessionForOrder } from '../mobbex/mobbex.controller';
import { RedisService } from '../redis/redis.service';
import { PricingEngine } from '../products/pricing.engine';
import { NotificationsService } from '../notifications/notifications.service';

const BUDGET_EXPIRATION_HOURS = 48;

function getAvailableStockForProduct(product: {
  is_combo: boolean;
  physical_stock: number;
  combo_parts?: Array<{
    quantity: number;
    product: { physical_stock: number };
  }>;
}): number {
  if (!product.is_combo) {
    return product.physical_stock;
  }

  if (!product.combo_parts || product.combo_parts.length === 0) {
    return 0;
  }

  const maxAssemblies = product.combo_parts.map((part) =>
    part.quantity > 0 ? Math.floor(part.product.physical_stock / part.quantity) : 0
  );

  return Math.min(...maxAssemblies);
}

export const createBudget = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.sub;

    if (!userId) {
      return res.status(401).json({ error: 'Token inválido o malformado: No se encontró el claim sub.' });
    }

    const { items, customerId, paymentMethod, installments = 1 } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El presupuesto debe contener al menos un producto.' });
    }

    const sellerProfile = await req.prisma.sellerProfile.findUnique({
      where: { user_id: userId },
    });

    if (!sellerProfile) {
      return res.status(403).json({ error: 'Perfil de vendedor no encontrado o inactivo.' });
    }

    let validCustomerId: string | null = null;
    let validCustomerUserId: string | null = null;

    if (customerId && typeof customerId === 'string' && customerId.trim() !== '') {
      const cleanCustomerId = customerId.trim();

      const customerProfile = await req.prisma.customerProfile.findFirst({
        where: {
          OR: [{ id: cleanCustomerId }, { user_id: cleanCustomerId }],
        },
        select: { id: true, user_id: true },
      });

      if (!customerProfile) {
        return res.status(400).json({
          error: 'Cliente no válido.',
          details: `No se encontró un CustomerProfile con el ID enviado: ${cleanCustomerId}`,
        });
      }

      validCustomerId = customerProfile.id;
      validCustomerUserId = customerProfile.user_id;
    }

    const productIds = items.map((i: { productId: string }) => i.productId);
    const dbProducts = await prismaGlobal.product.findMany({
      where: {
        id: { in: productIds },
        is_active: true,
      },
      include: {
        category: {
          select: { id: true, path: true },
        },
        combo_parts: {
          include: {
            product: {
              select: { physical_stock: true },
            },
          },
        },
      },
    });

    if (dbProducts.length !== items.length) {
      return res.status(400).json({ error: 'Discrepancia en catálogo: Productos inactivos o inexistentes.' });
    }

    for (const frontendItem of items) {
      const dbProduct = dbProducts.find((p) => p.id === frontendItem.productId)!;
      const available = getAvailableStockForProduct(dbProduct);
      const requestedQty = Number(frontendItem.quantity);

      if (available < requestedQty) {
        return res.status(409).json({
          error: 'Quiebre de stock.',
          details: `Stock insuficiente para "${dbProduct.name}" (disponible: ${available}, solicitado: ${requestedQty}).`,
        });
      }
    }

    const activePaymentMethod = paymentMethod || 'MP';
    const effectiveInstallments = Number(installments) || 1;
    const activeRules = await RedisService.getActivePaymentRules();

    let totalAmount = 0;
    const orderItemsToCreate = items.map((frontendItem: any) => {
      const dbProduct = dbProducts.find((p) => p.id === frontendItem.productId)!;
      const pureBasePrice = Number(dbProduct.base_price);
      const pricing = PricingEngine.calculateEffectiveUnitPrice(
        dbProduct,
        activeRules,
        activePaymentMethod,
        effectiveInstallments
      );
      const unitPrice = pricing.unitPrice;
      const quantity = Number(frontendItem.quantity);

      totalAmount += unitPrice * quantity;

      return {
        product_id: dbProduct.id,
        quantity,
        unit_price: unitPrice,
        pure_base_price: pureBasePrice,
        applied_commission_rate: Number(dbProduct.commission_rate || 0),
      };
    });

    totalAmount = Math.round(totalAmount * 100) / 100;

    const budgetOrder = await req.prisma.order.create({
      data: {
        seller_id: sellerProfile.id,
        customer_id: validCustomerId,
        status: 'BUDGET',
        total_amount: totalAmount,
        payment_method: activePaymentMethod,
        items: { create: orderItemsToCreate },
      },
    });

    if (validCustomerUserId) {
      const sellerName = `${sellerProfile.first_name} ${sellerProfile.last_name}`.trim();
      const shortBudgetId = budgetOrder.id.slice(0, 8).toUpperCase();

      await NotificationsService.notify({
        userId: validCustomerUserId,
        role: Role.CUSTOMER,
        type: NotificationType.ASSISTED_BUDGET_READY,
        title: `Tenés una cotización lista (#${shortBudgetId})`,
        message: `${sellerName} armó un carrito asistido por $${Number(budgetOrder.total_amount).toFixed(2)}. Revisalo y completá el pago antes de las 48 hs.`,
        actionUrl: `/budget/${budgetOrder.id}`,
        metadata: {
          order_id: budgetOrder.id,
          seller_id: sellerProfile.id,
          seller_name: sellerName,
          total_amount: Number(budgetOrder.total_amount),
        },
        dedupKey: `assisted_budget:${budgetOrder.id}`,
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Presupuesto creado con éxito.',
      budget: {
        id: budgetOrder.id,
        total_amount: budgetOrder.total_amount,
        expires_at: new Date(Date.now() + BUDGET_EXPIRATION_HOURS * 3600 * 1000),
      },
    });
  } catch (error) {
    console.error('[BudgetController.createBudget] Error:', error);
    return res.status(500).json({ error: 'Fallo al generar el presupuesto.' });
  }
};

export const payBudget = async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ error: 'Debes iniciar sesión como cliente para abonar este presupuesto.' });
    }

    const customerProfile = await prismaGlobal.customerProfile.findUnique({
      where: { user_id: userId },
      select: { id: true, user_id: true },
    });

    if (!customerProfile) {
      return res.status(403).json({
        error: 'Perfil de cliente no encontrado.',
        details: 'Solo las cuentas con rol de cliente pueden abonar presupuestos.',
      });
    }

    const id = req.params.id as string;
    const requestedMethod = req.body?.paymentMethod as 'MP' | 'MOBBEX' | 'TRANSFERENCIA' | undefined;
    const requestedInstallments = Number(req.body?.installments) || 1;

    const order = await prismaGlobal.order.findUnique({
      where: { id },
      include: {
        seller: { select: { user_id: true } },
        items: {
          include: {
            product: {
              include: {
                category: { select: { id: true, path: true } },
                combo_parts: {
                  include: {
                    product: {
                      select: { physical_stock: true, name: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!order || (order.status !== 'BUDGET' && order.status !== 'PENDING')) {
      return res.status(404).json({ error: 'Presupuesto no encontrado o ya pagado.' });
    }

    if (order.seller?.user_id && order.seller.user_id === userId) {
      return res.status(403).json({
        error: 'Operación no permitida.',
        details: 'No puedes abonar un presupuesto generado desde tu propia cuenta de vendedor.',
      });
    }

    if (order.customer_id && order.customer_id !== customerProfile.id) {
      return res.status(403).json({
        error: 'Acceso denegado.',
        details: 'Este presupuesto fue emitido para otro cliente registrado.',
      });
    }

    const hoursSinceCreation = Math.abs(Date.now() - new Date(order.created_at).getTime()) / 36e5;
    if (hoursSinceCreation > BUDGET_EXPIRATION_HOURS) {
      return res.status(410).json({ error: 'El presupuesto ha expirado (48h). Solicite uno nuevo.' });
    }

    const stockAlreadyReserved = order.status === 'PENDING' && order.payment_method === 'TRANSFERENCIA';

    if (!stockAlreadyReserved) {
      for (const item of order.items) {
        if (!item.product) continue;
        const availableStock = getAvailableStockForProduct(item.product);

        if (availableStock < item.quantity) {
          return res.status(409).json({
            error: 'Quiebre de stock.',
            details: `Stock insuficiente para "${item.product.name}" (disponible: ${availableStock}, requerido: ${item.quantity}).`,
          });
        }
      }
    }

    const activePaymentMethod = requestedMethod || order.payment_method;
    const activeRules = await RedisService.getActivePaymentRules();

    let recalculatedTotal = 0;
    const updatedItemPrices = order.items.map((item) => {
      if (!item.product) {
        const fallbackUnit = Number(item.unit_price);
        recalculatedTotal += fallbackUnit * item.quantity;
        return { id: item.id, unit_price: fallbackUnit };
      }
      const pricing = PricingEngine.calculateEffectiveUnitPrice(
        item.product,
        activeRules,
        activePaymentMethod,
        requestedInstallments
      );
      recalculatedTotal += pricing.unitPrice * item.quantity;
      return { id: item.id, unit_price: pricing.unitPrice };
    });

    recalculatedTotal = Math.round(recalculatedTotal * 100) / 100;
    const touchedProductIds: string[] = [];

    try {
      await prismaGlobal.$transaction(async (tx) => {
        for (const itemUpdate of updatedItemPrices) {
          await tx.orderItem.update({
            where: { id: itemUpdate.id },
            data: { unit_price: itemUpdate.unit_price },
          });
        }

        if (activePaymentMethod === 'TRANSFERENCIA' && !stockAlreadyReserved) {
          for (const item of order.items) {
            if (!item.product_id || !item.product) continue;

            if (item.product.is_combo && item.product.combo_parts.length > 0) {
              for (const part of item.product.combo_parts) {
                const requiredQty = part.quantity * item.quantity;
                const decResult = await tx.product.updateMany({
                  where: {
                    id: part.product_id,
                    physical_stock: { gte: requiredQty },
                  },
                  data: {
                    physical_stock: { decrement: requiredQty },
                    version: { increment: 1 },
                  },
                });

                if (decResult.count === 0) {
                  throw new Error(`STOCK_SHORTAGE:${item.product.name}`);
                }
                touchedProductIds.push(part.product_id);
              }
            } else {
              const decResult = await tx.product.updateMany({
                where: {
                  id: item.product_id,
                  physical_stock: { gte: item.quantity },
                },
                data: {
                  physical_stock: { decrement: item.quantity },
                  version: { increment: 1 },
                },
              });

              if (decResult.count === 0) {
                throw new Error(`STOCK_SHORTAGE:${item.product.name}`);
              }
              touchedProductIds.push(item.product_id);
            }
          }
        }

        await tx.order.update({
          where: { id: order.id },
          data: {
            customer_id: customerProfile.id,
            payment_method: activePaymentMethod,
            total_amount: recalculatedTotal,
            ...(activePaymentMethod === 'TRANSFERENCIA' ? { status: 'PENDING' } : {}),
          },
        });
      });
    } catch (txError: any) {
      if (typeof txError?.message === 'string' && txError.message.startsWith('STOCK_SHORTAGE:')) {
        const productName = txError.message.replace('STOCK_SHORTAGE:', '');
        return res.status(409).json({
          error: 'Quiebre de stock.',
          details: `Stock insuficiente para "${productName}" al reservar el presupuesto.`,
        });
      }
      throw txError;
    }

    if (touchedProductIds.length > 0) {
      await NotificationsService.checkAndNotifyLowStock(touchedProductIds);
    }

    if (activePaymentMethod === 'TRANSFERENCIA') {
      const shortOrderId = order.id.slice(0, 8).toUpperCase();
      await NotificationsService.notify({
        userId: customerProfile.user_id,
        role: Role.CUSTOMER,
        type: NotificationType.ORDER_CREATED,
        title: `Pedido #${shortOrderId} confirmado por transferencia (Stock reservado por 7 días)`,
        message: `Tu orden por $${recalculatedTotal.toFixed(2)} fue registrada y el stock quedó reservado por 7 días.`,
        actionUrl: `/orders/${order.id}`,
        metadata: {
          order_id: order.id,
          total_amount: recalculatedTotal,
          payment_method: 'TRANSFERENCIA',
        },
        dedupKey: `order_created:${order.id}`,
      });

      return res.status(200).json({
        success: true,
        gateway: 'TRANSFERENCIA',
        orderId: order.id,
      });
    }

    let checkoutUrl = '';
    let gatewayTxnId = '';

    if (activePaymentMethod === 'MP') {
      const mpItems = order.items.map((i: any) => {
        const updatedItem = updatedItemPrices.find((u) => u.id === i.id);
        return {
          id: i.product_id || 'N/A',
          title: i.product?.name || 'Producto Presupuestado',
          quantity: i.quantity,
          unit_price: updatedItem ? updatedItem.unit_price : Number(i.unit_price),
        };
      });

      const mpResponse = await createMpPreference(
        order.id,
        mpItems,
        undefined,
        requestedInstallments
      );
      checkoutUrl = mpResponse.sandboxInitPoint || mpResponse.initPoint || '';
      gatewayTxnId = mpResponse.preferenceId || '';

      await prismaGlobal.order.update({
        where: { id: order.id },
        data: {
          status: 'PENDING',
          gateway_txn_id: gatewayTxnId,
        },
      });
    } else if (activePaymentMethod === 'MOBBEX') {
      const mobbexSession = await generateMobbexSessionForOrder(order.id, requestedInstallments);
      checkoutUrl = mobbexSession.checkoutUrl;
      gatewayTxnId = mobbexSession.checkoutId;

      await prismaGlobal.order.update({
        where: { id: order.id },
        data: {
          status: 'PENDING',
          gateway_txn_id: gatewayTxnId,
        },
      });
    } else {
      return res.status(400).json({
        error: `El método de pago ${activePaymentMethod} no soporta checkout automático online.`,
      });
    }

    return res.status(200).json({
      success: true,
      gateway: activePaymentMethod,
      checkoutUrl,
    });
  } catch (error: any) {
    console.error('[BudgetController.payBudget] Error:', error);
    return res.status(500).json({
      error: 'Fallo al procesar el pago del presupuesto.',
      details: process.env.NODE_ENV !== 'production' ? error?.message : undefined,
    });
  }
};

export const getBudgetById = async (req: Request<{ id: string }>, res: Response): Promise<Response | void> => {
  try {
    const id = req.params.id;

    const order = await prismaGlobal.order.findUnique({
      where: { id: id },
      include: {
        items: {
          include: { product: { select: { name: true, sku: true } } },
        },
      },
    });

    if (!order || (order.status !== 'BUDGET' && order.status !== 'PENDING')) {
      return res.status(404).json({ error: 'Presupuesto no encontrado, expirado o ya procesado.' });
    }

    const expiresAt = new Date(new Date(order.created_at).getTime() + BUDGET_EXPIRATION_HOURS * 3600 * 1000);

    return res.status(200).json({
      success: true,
      budget: {
        id: order.id,
        total_amount: order.total_amount,
        payment_method: order.payment_method,
        expires_at: expiresAt,
        items: order.items,
      },
    });
  } catch (error) {
    console.error('[BudgetController.getBudgetById] Error:', error);
    return res.status(500).json({ error: 'Fallo al consultar el detalle del presupuesto.' });
  }
};

export const mercadopagoWebhookHandler = async (req: Request, res: Response): Promise<Response | void> => {
  const type = req.query.topic || req.body.type || req.body.action;
  const paymentId = req.query.id || req.body.data?.id;

  if (!paymentId || (type !== 'payment' && type !== 'payment.created' && type !== 'payment.updated')) {
    return res.status(200).send('Evento ignorado');
  }

  const txId = String(paymentId);
  const lockKey = `lock:mp:budget:tx:${txId}`;
  const processedKey = `idempotency:mp:budget:tx:${txId}`;

  const alreadyProcessed = await RedisService.get(processedKey);
  if (alreadyProcessed) {
    return res.status(200).send('Webhook ya procesado');
  }

  const acquired = await RedisService.acquireLock(lockKey, 60);
  if (!acquired) {
    return res.status(200).send('Procesamiento concurrente en curso');
  }

  try {
    const paymentData = await getMpPaymentById(txId);

    if (paymentData.status === 'rejected' || paymentData.status === 'cancelled') {
      const failedOrderId = paymentData.external_reference;
      if (failedOrderId) {
        const failedOrder = await prismaGlobal.order.findUnique({
          where: { id: failedOrderId },
          select: {
            id: true,
            customer: { select: { user_id: true } },
          },
        });

        if (failedOrder?.customer?.user_id) {
          await NotificationsService.notify({
            userId: failedOrder.customer.user_id,
            role: Role.CUSTOMER,
            type: NotificationType.PAYMENT_ACTION_REQUIRED,
            title: 'Tu pago no pudo procesarse',
            message: `El pago de tu pedido #${failedOrder.id.slice(0, 8).toUpperCase()} fue rechazado. Reintenta con otro medio de pago.`,
            actionUrl: `/orders/${failedOrder.id}`,
            metadata: {
              order_id: failedOrder.id,
              gateway: 'MP',
              payment_id: txId,
              status: paymentData.status,
            },
            dedupKey: `mp_payment_failed:${txId}`,
          });
        }
      }
      await RedisService.set(processedKey, '1', 86400);
      return res.status(200).send('Pago rechazado notificado');
    }

    if (paymentData.status === 'approved') {
      const orderId = paymentData.external_reference;
      if (!orderId) {
        return res.status(200).send('Pago aprobado pero sin external_reference. Ignorando.');
      }

      let didTransition = false;
      let createdCommissionAmount = 0;
      const touchedProductIds: string[] = [];

      await prismaGlobal.$transaction(async (tx) => {
        const transitioned = await tx.order.updateMany({
          where: {
            id: orderId,
            status: { in: ['PENDING', 'BUDGET'] },
          },
          data: {
            status: 'PAID',
            gateway_txn_id: txId,
          },
        });

        if (transitioned.count === 0) return;
        didTransition = true;

        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            items: {
              include: {
                product: {
                  include: { combo_parts: true },
                },
              },
            },
            seller: { select: { user_id: true } },
            customer: { select: { user_id: true } },
          },
        });

        if (!order) return;

        if (order.coupon_id) {
          await tx.coupon.update({
            where: { id: order.coupon_id },
            data: { used_count: { increment: 1 } },
          });
        }

        let totalCommission = 0;

        for (const item of order.items) {
          if (!item.product_id || !item.product) continue;

          if (item.product.is_combo && item.product.combo_parts.length > 0) {
            for (const part of item.product.combo_parts) {
              const requiredQty = part.quantity * item.quantity;
              const decResult = await tx.product.updateMany({
                where: {
                  id: part.product_id,
                  physical_stock: { gte: requiredQty },
                },
                data: {
                  physical_stock: { decrement: requiredQty },
                  version: { increment: 1 },
                },
              });

              if (decResult.count === 0) {
                throw new Error(`Stock insuficiente para componente de combo (${part.product_id}).`);
              }
              touchedProductIds.push(part.product_id);
            }
          } else {
            const decResult = await tx.product.updateMany({
              where: {
                id: item.product_id,
                physical_stock: { gte: item.quantity },
              },
              data: {
                physical_stock: { decrement: item.quantity },
                version: { increment: 1 },
              },
            });

            if (decResult.count === 0) {
              throw new Error(`Stock insuficiente para ${item.product.name}. Sobreventa abortada.`);
            }
            touchedProductIds.push(item.product_id);
          }

          const rate =
            Number(item.applied_commission_rate) > 0
              ? Number(item.applied_commission_rate)
              : Number(item.product.commission_rate || 0);

          if (rate > 0) {
            totalCommission += Number(item.unit_price) * item.quantity * (rate / 100);
          }
        }

        if (order.seller_id && totalCommission > 0) {
          const isSelfPurchase =
            order.seller?.user_id && order.customer?.user_id && order.seller.user_id === order.customer.user_id;

          if (!isSelfPurchase) {
            const sanitizedCommission = Math.round(totalCommission * 100) / 100;
            const clearingDate = new Date();
            clearingDate.setDate(clearingDate.getDate() + 15);

            await tx.commissionLedger.create({
              data: {
                order_id: order.id,
                seller_id: order.seller_id,
                amount: sanitizedCommission,
                status: 'PENDING_CLEARANCE',
                clearing_date: clearingDate,
              },
            });

            createdCommissionAmount = sanitizedCommission;
          } else {
            console.warn(`[FRAUD PREVENTED] Auto-compra detectada. Orden: ${order.id}. No se liquidó comisión.`);
          }
        }
      });

      await RedisService.set(processedKey, '1', 86400);

      if (didTransition) {
        const approvedOrder = await prismaGlobal.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            total_amount: true,
            seller_id: true,
            seller: { select: { user_id: true } },
            customer: { select: { user_id: true } },
          },
        });

        if (approvedOrder?.seller_id && createdCommissionAmount > 0 && approvedOrder.seller?.user_id) {
          await NotificationsService.notify({
            userId: approvedOrder.seller.user_id,
            role: Role.SELLER,
            type: NotificationType.COMMISSION_EARNED,
            title: `Nueva comisión atribuida: +$${createdCommissionAmount.toFixed(2)}`,
            message: `Pedido #${approvedOrder.id.slice(0, 8).toUpperCase()} confirmado. La comisión entra en período de garantía.`,
            actionUrl: '/commissions',
            metadata: {
              order_id: approvedOrder.id,
              amount: createdCommissionAmount,
              gateway: 'MP',
            },
            dedupKey: `commission_earned:${approvedOrder.id}`,
          });
        }

        if (approvedOrder?.customer?.user_id) {
          await NotificationsService.notify({
            userId: approvedOrder.customer.user_id,
            role: Role.CUSTOMER,
            type: NotificationType.ORDER_PAID,
            title: '¡Pago aprobado!',
            message: `Confirmamos el pago de tu pedido #${approvedOrder.id.slice(0, 8).toUpperCase()} por $${Number(approvedOrder.total_amount).toFixed(2)}. Ya estamos preparando tu compra.`,
            actionUrl: `/orders/${approvedOrder.id}`,
            metadata: {
              order_id: approvedOrder.id,
              amount: Number(approvedOrder.total_amount),
              gateway: 'MP',
              payment_id: String(paymentId),
            },
            dedupKey: `order_paid:${approvedOrder.id}`,
          });
        }

        await NotificationsService.checkAndNotifyLowStock(touchedProductIds);
      }
    }

    return res.status(200).send('Webhook procesado con éxito');
  } catch (error) {
    console.error('[Webhook Controller] Error crítico procesando Webhook:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    await RedisService.releaseLock(lockKey);
  }
};