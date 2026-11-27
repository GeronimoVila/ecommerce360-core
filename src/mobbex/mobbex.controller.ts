import { Request, Response } from 'express';
import { CommissionStatus, NotificationType, Role } from '@prisma/client';
import prisma from '../config/prisma';
import { RedisService } from '../redis/redis.service';
import { resolveMobbexCredentials, encryptToken } from './mobbexAuth.service';
import { NotificationsService } from '../notifications/notifications.service';

const DEFAULT_TENANT = 'DEFAULT_STORE';
const FALLBACK_MOBBEX_IMAGE = 'https://via.placeholder.com/150';

export const getMobbexStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const config = await prisma.paymentGatewayConfig.findUnique({
      where: { tenantId_provider: { tenantId: DEFAULT_TENANT, provider: 'MOBBEX' } },
      select: {
        status: true,
        merchantCuit: true,
        merchantName: true,
        isTestMode: true,
        connectedAt: true,
      },
    });

    if (!config || config.status !== 'CONNECTED') {
      res.json({
        status: config?.status || 'DISCONNECTED',
        mode: 'DEMO_SANDBOX',
        merchant: null,
      });
      return;
    }

    res.json({
      status: config.status,
      mode: config.isTestMode ? 'CLIENT_SANDBOX' : 'PRODUCTION',
      merchant: {
        name: config.merchantName,
        cuit: config.merchantCuit,
        connectedAt: config.connectedAt,
      },
    });
  } catch (error) {
    console.error('[Mobbex Status Error]:', error);
    res.status(500).json({ error: 'Error al consultar el estado de Mobbex' });
  }
};

export const initMobbexConnect = async (req: Request, res: Response): Promise<void> => {
  try {
    const returnUrl = `${process.env.WEBHOOK_URL}/api/mobbex/oauth-bridge`;

    const response = await fetch('https://api.mobbex.com/p/developer/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.MOBBEX_APP_API_KEY!,
      },
      body: JSON.stringify({ return_url: returnUrl }),
    });

    const data = await response.json();

    if (!data.result || !data.data?.url) {
      res.status(400).json({ error: 'Mobbex rechazó la solicitud Dev Connect', details: data });
      return;
    }

    await prisma.paymentGatewayConfig.upsert({
      where: { tenantId_provider: { tenantId: DEFAULT_TENANT, provider: 'MOBBEX' } },
      update: { connectId: data.data.id, status: 'PENDING' },
      create: {
        tenantId: DEFAULT_TENANT,
        provider: 'MOBBEX',
        connectId: data.data.id,
        status: 'PENDING',
      },
    });

    res.json({ connectUrl: data.data.url, connectId: data.data.id });
  } catch (error) {
    console.error('[Mobbex Connect Error]:', error);
    res.status(500).json({ error: 'Error interno al iniciar vinculación con Mobbex' });
  }
};

export const mobbexOAuthBridge = (req: Request, res: Response): void => {
  const { connectStatus } = req.query;
  const status = typeof connectStatus === 'string' ? connectStatus : 'cancelled';
  res.redirect(`${process.env.FRONTEND_B2B_URL}/settings/payments?mobbexStatus=${status}`);
};

export const finalizeMobbexConnect = async (req: Request, res: Response): Promise<void> => {
  try {
    const config = await prisma.paymentGatewayConfig.findUnique({
      where: { tenantId_provider: { tenantId: DEFAULT_TENANT, provider: 'MOBBEX' } },
    });

    if (!config?.connectId) {
      res.status(404).json({ error: 'No existe una solicitud de conexión pendiente' });
      return;
    }

    const response = await fetch(
      `https://api.mobbex.com/p/developer/connect/${config.connectId}/credentials`,
      {
        method: 'GET',
        headers: { 'x-api-key': process.env.MOBBEX_APP_API_KEY! },
      }
    );

    const cred = await response.json();

    if (!cred.result || !cred.data?.access_token) {
      res.status(400).json({ error: 'Fallo al obtener credenciales del comercio', details: cred });
      return;
    }

    await prisma.paymentGatewayConfig.update({
      where: { id: config.id },
      data: {
        accessTokenEncrypted: encryptToken(cred.data.access_token),
        merchantCuit: cred.data.entity?.tax_id || cred.data.entity?.identification || null,
        merchantName: cred.data.entity?.name || null,
        status: 'CONNECTED',
        isTestMode: true,
        connectedAt: new Date(),
      },
    });

    res.json({
      connected: true,
      merchant: {
        name: cred.data.entity?.name,
        cuit: cred.data.entity?.tax_id,
      },
    });
  } catch (error) {
    console.error('[Mobbex Finalize Error]:', error);
    res.status(500).json({ error: 'Error al finalizar vinculación con Mobbex' });
  }
};

export const toggleMobbexMode = async (req: Request, res: Response): Promise<void> => {
  try {
    const { isTestMode } = req.body;

    if (typeof isTestMode !== 'boolean') {
      res.status(400).json({ error: 'El campo isTestMode debe ser un valor booleano (true | false).' });
      return;
    }

    const config = await prisma.paymentGatewayConfig.findUnique({
      where: { tenantId_provider: { tenantId: DEFAULT_TENANT, provider: 'MOBBEX' } },
    });

    if (!config || config.status !== 'CONNECTED' || !config.accessTokenEncrypted) {
      res.status(409).json({
        error: 'No se puede activar modo Producción sin vincular primero la cuenta comercial de Mobbex.',
        currentStatus: config?.status || 'DISCONNECTED',
      });
      return;
    }

    const updated = await prisma.paymentGatewayConfig.update({
      where: { id: config.id },
      data: { isTestMode },
    });

    res.json({
      success: true,
      status: updated.status,
      isTestMode: updated.isTestMode,
      mode: updated.isTestMode ? 'CLIENT_SANDBOX' : 'PRODUCTION',
      merchant: {
        name: updated.merchantName,
        cuit: updated.merchantCuit,
      },
    });
  } catch (error) {
    console.error('[Mobbex Toggle Mode Error]:', error);
    res.status(500).json({ error: 'Error al cambiar el entorno de operación de Mobbex.' });
  }
};

export async function generateMobbexSessionForOrder(orderId: string, installments?: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: {
          product: {
            include: {
              images: {
                orderBy: [
                  { is_primary: 'desc' },
                  { position: 'asc' },
                ],
                take: 1,
                select: { url: true },
              },
            },
          },
        },
      },
      customer: { include: { user: true } },
    },
  });

  if (!order) {
    throw new Error('ORDEN_NO_ENCONTRADA');
  }

  if (order.status === 'PAID' || order.status === 'SHIPPED' || order.status === 'DELIVERED') {
    throw new Error('ORDEN_YA_PAGADA');
  }

  const auth = await resolveMobbexCredentials(DEFAULT_TENANT);
  const reference = auth.isDemoFallback ? `E360_DEV_${order.id}_${Date.now()}` : order.id;
  const orderTotal = Number(order.total_amount);
  const normalizedInstallments = Number(installments);
  const hasCustomInstallments = Number.isFinite(normalizedInstallments) && normalizedInstallments > 1;

  const mobbexItems = order.items.map((item) => {
    const productImageUrl = item.product?.images?.[0]?.url;
    const validHttpsImage =
      productImageUrl && productImageUrl.startsWith('https://')
        ? productImageUrl
        : FALLBACK_MOBBEX_IMAGE;

    return {
      image: validHttpsImage,
      quantity: item.quantity,
      description: item.product ? `${item.product.name} (${item.product.sku})` : 'Producto Ecommerce 360',
      total: Number(item.unit_price) * item.quantity,
    };
  });

  const customerEmail = order.customer?.user?.email || 'cliente@ecommerce360.com';
  const customerFullName =
    [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Cliente Ecommerce 360';

  const baseWebhookUrl = (process.env.WEBHOOK_URL || '').trim().replace(/\/$/, '');

  const checkoutPayload: Record<string, any> = {
    total: orderTotal,
    currency: 'ARS',
    reference,
    description: `Orden #${order.id.slice(0, 8).toUpperCase()} - Ecommerce 360`,
    test: auth.isTest,
    timeout: 15,
    return_url: `${baseWebhookUrl}/api/mobbex/checkout-bridge?orderId=${order.id}`,
    webhook: `${baseWebhookUrl}/api/mobbex/webhook?options=final&internalOrderId=${order.id}`,
    customer: {
      email: customerEmail,
      name: customerFullName,
      identification: '11111111',
    },
    items: mobbexItems,
  };

  if (hasCustomInstallments) {
    checkoutPayload.installments = [normalizedInstallments];
  }

  const response = await fetch('https://api.mobbex.com/p/checkout', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Ecommerce360-Backend/1.0 (Node.js)',
      'x-api-key': auth.apiKey,
      'x-access-token': auth.accessToken,
    },
    body: JSON.stringify(checkoutPayload),
  });

  const rawBody = await response.text();
  let payload: any = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    payload = { rawText: rawBody };
  }

  if (!response.ok || !payload?.result || !payload?.data?.url) {
    if (auth.isDemoFallback && (response.status === 401 || response.status === 403)) {
      const mockId = `MOCK_CHK_${Date.now()}`;
      await prisma.order.update({
        where: { id: order.id },
        data: { gateway_txn_id: mockId, payment_method: 'MOBBEX' },
      });
      const installmentsParam = hasCustomInstallments ? `&installments=${normalizedInstallments}` : '';
      return {
        checkoutUrl: `${baseWebhookUrl}/api/mobbex/mock-gateway?orderId=${order.id}&total=${orderTotal}${installmentsParam}`,
        checkoutId: mockId,
        orderId: order.id,
        amountCharged: orderTotal,
        isTestMode: true,
        isSimulated: true,
      };
    }

    await NotificationsService.notifyAdmins({
      type: NotificationType.INTEGRATION_FAILURE,
      title: 'Error creando checkout en Mobbex',
      message: `Mobbex rechazó la generación de pago para la orden #${order.id.slice(0, 8).toUpperCase()} (HTTP ${response.status}).`,
      actionUrl: '/settings/payments',
      metadata: {
        gateway: 'MOBBEX',
        order_id: order.id,
        http_status: response.status,
        details: payload,
      },
      baseDedupKey: `mobbex_chk_err:${order.id}`,
    });

    const err: any = new Error('MOBBEX_API_REJECTED');
    err.status = response.status;
    err.details = payload;
    throw err;
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      gateway_txn_id: payload.data.id,
      payment_method: 'MOBBEX',
    },
  });

  return {
    checkoutUrl: payload.data.url,
    checkoutId: payload.data.id,
    orderId: order.id,
    amountCharged: orderTotal,
    isTestMode: auth.isTest,
  };
}

export const createMobbexCheckout = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId, installments } = req.body;
    const authenticatedUserId = (req as any).user?.id;

    if (!orderId) {
      res.status(400).json({ error: 'El campo orderId es obligatorio' });
      return;
    }

    const orderOwnerCheck = await prisma.order.findUnique({
      where: { id: String(orderId) },
      include: { customer: true },
    });

    if (!orderOwnerCheck) {
      res.status(404).json({ error: 'Orden no encontrada en la base de datos' });
      return;
    }

    if (
      authenticatedUserId &&
      orderOwnerCheck.customer?.user_id &&
      orderOwnerCheck.customer.user_id !== authenticatedUserId
    ) {
      res.status(403).json({ error: 'No tienes autorización para pagar esta orden' });
      return;
    }

    const session = await generateMobbexSessionForOrder(String(orderId), installments);
    res.json(session);
  } catch (error: any) {
    if (error.message === 'ORDEN_YA_PAGADA') {
      res.status(400).json({ error: 'Esta orden ya se encuentra pagada' });
      return;
    }
    if (error.message === 'MOBBEX_API_REJECTED') {
      res.status(error.status >= 400 ? error.status : 400).json({
        error: 'Mobbex rechazó la creación del checkout',
        details: error.details,
      });
      return;
    }
    console.error('[Mobbex Checkout Error]:', error);
    res.status(500).json({
      error: 'Error interno al generar checkout de pago',
      detail: process.env.NODE_ENV !== 'production' ? error?.message : undefined,
    });
  }
};

export const mobbexCheckoutBridge = (req: Request, res: Response): void => {
  const { orderId, status } = req.query;
  const frontendUrl = (process.env.FRONTEND_B2C_URL || 'http://localhost:3000').trim().replace(/\/$/, '');
  const outcome = status === '200' || status === 'approved' ? 'approved' : String(status || 'returned');

  res.redirect(
    `${frontendUrl}/checkout/success?orderId=${encodeURIComponent(String(orderId || ''))}&gateway=MOBBEX&outcome=${encodeURIComponent(outcome)}`
  );
};

export const simulateMobbexGateway = async (req: Request, res: Response): Promise<void> => {
  const { orderId, total, action, confirm } = req.query;
  const safeOrderId = String(orderId || '');
  const numericTotal = Number(total || 0);
  const baseWebhookUrl = (process.env.WEBHOOK_URL || '').trim().replace(/\/$/, '');
  const frontendUrl = (process.env.FRONTEND_B2C_URL || 'http://localhost:3000').trim().replace(/\/$/, '');

  if (confirm !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Mobbex Checkout Sandbox</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #111827; }
          .card { background: #fff; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); max-width: 420px; width: 100%; overflow: hidden; border: 1px solid #e5e7eb; }
          .header { background: #6b21a8; color: #fff; padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; }
          .badge { background: rgba(255,255,255,0.2); padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; }
          .body { padding: 24px; }
          .row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px; color: #4b5563; }
          .total { font-size: 26px; font-weight: 800; color: #111827; margin: 16px 0 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: baseline; }
          .btn { display: block; width: 100%; text-align: center; padding: 14px; border-radius: 10px; font-weight: 700; font-size: 15px; text-decoration: none; margin-bottom: 10px; box-sizing: border-box; }
          .btn-approve { background: #6b21a8; color: #fff; }
          .btn-approve:hover { background: #581c87; }
          .btn-reject { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; font-size: 13px; }
          .btn-reject:hover { background: #e5e7eb; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <strong style="font-size:18px;">mobbex</strong>
            <span class="badge">SANDBOX DEMO</span>
          </div>
          <div class="body">
            <div class="row"><span>Comercio</span><strong>Ecommerce 360</strong></div>
            <div class="row"><span>Referencia</span><span style="font-family:monospace;">#${safeOrderId.slice(0, 8).toUpperCase()}</span></div>
            <div class="row"><span>Medio seleccionado</span><span>Tarjeta de Crédito / Débito</span></div>
            <div class="total">
              <span style="font-size:14px;font-weight:600;color:#6b7280;">Total a pagar</span>
              <span>$${numericTotal.toLocaleString('es-AR')} ARS</span>
            </div>
            <a class="btn btn-approve" href="${baseWebhookUrl}/api/mobbex/mock-gateway?orderId=${encodeURIComponent(safeOrderId)}&total=${numericTotal}&action=approve&confirm=1">
              Confirmar y Pagar $${numericTotal.toLocaleString('es-AR')}
            </a>
            <a class="btn btn-reject" href="${baseWebhookUrl}/api/mobbex/mock-gateway?orderId=${encodeURIComponent(safeOrderId)}&total=${numericTotal}&action=reject&confirm=1">
              Simular Rechazo / Cancelar Pago
            </a>
          </div>
        </div>
      </body>
      </html>`);
    return;
  }

  const statusCode = action === 'reject' ? '400' : '200';
  const statusText = action === 'reject' ? 'Rechazada (Simulación)' : 'Aprobada (Simulación)';

  await fetch(`${baseWebhookUrl}/api/mobbex/webhook?options=final&internalOrderId=${encodeURIComponent(safeOrderId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'checkout',
      data: {
        payment: {
          id: `SIM_TX_${Date.now()}`,
          status: { code: statusCode, text: statusText, message: statusText },
          requestedTotal: numericTotal,
          total: numericTotal,
        },
      },
    }),
  });

  const outcome = action === 'reject' ? 'failure' : 'approved';
  res.redirect(
    `${frontendUrl}/checkout/success?orderId=${encodeURIComponent(safeOrderId)}&gateway=MOBBEX&outcome=${outcome}&simulated=true`
  );
};

export const handleMobbexWebhook = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ received: true, gateway: 'MOBBEX' });

  const { type, data } = req.body;
  const internalOrderId = req.query.internalOrderId as string;

  if (type !== 'checkout' || !data?.payment || !internalOrderId) return;

  const transactionId = String(data.payment.id);
  const webhookStatusCode = Number(data.payment.status.code);

  const lockKey = `lock:mobbex:tx:${transactionId}`;
  const processedKey = `idempotency:mobbex:tx:${transactionId}`;

  const alreadyProcessed = await RedisService.get(processedKey);
  if (alreadyProcessed) {
    console.warn(`🛡️ [Webhook Mobbex - Redis Idempotency] Tx ya procesada -> ${transactionId}`);
    return;
  }

  const acquired = await RedisService.acquireLock(lockKey, 60);
  if (!acquired) {
    console.warn(`🛡️ [Webhook Mobbex - Redis Lock] Concurrencia bloqueada -> Tx: ${transactionId}`);
    return;
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id: internalOrderId },
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

    if (!order) {
      console.error(`❌ [Webhook Mobbex] Orden ${internalOrderId} no encontrada en PostgreSQL.`);
      return;
    }

    const auth = await resolveMobbexCredentials(DEFAULT_TENANT);
    let verifiedStatusCode = webhookStatusCode;
    let verifiedData = data;

    const isLocalMockTx = transactionId.startsWith('SIM_TX_') || transactionId.startsWith('TX_');
    const mustVerifyS2S = !auth.isDemoFallback || process.env.NODE_ENV === 'production' || !isLocalMockTx;

    if (mustVerifyS2S) {
      const verifyRes = await fetch(`https://api.mobbex.com/p/operations/${encodeURIComponent(transactionId)}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Ecommerce360-Backend/1.0 (Node.js)',
          'x-api-key': auth.apiKey,
          'x-access-token': auth.accessToken,
        },
      });

      const verifyPayload = await verifyRes.json().catch(() => null);

      if (!verifyRes.ok || !verifyPayload?.result || !verifyPayload?.data) {
        console.error(
          `🚨 [Security Alert - Spoofing] Tx ${transactionId} inexistente o rechazada por API oficial Mobbex.`
        );
        return;
      }

      const officialOp = verifyPayload.data;
      const paymentNode = officialOp.payment || officialOp;

      verifiedStatusCode = Number(paymentNode.status?.code ?? officialOp.status?.code);
      verifiedData = officialOp;

      const officialRef = String(
        officialOp.context?.reference ||
          officialOp.context?.checkout?.reference ||
          paymentNode.reference ||
          officialOp.reference ||
          ''
      );

      const officialCheckoutUid = String(
        officialOp.checkout?.uid || officialOp.context?.checkout?.uid || ''
      );

      let isOwnerMatch =
        (officialRef !== '' && officialRef.includes(internalOrderId)) ||
        (officialCheckoutUid !== '' && officialCheckoutUid === order.gateway_txn_id);

      if (!isOwnerMatch && order.gateway_txn_id?.startsWith('CHK:')) {
        const chkRes = await fetch(
          `https://api.mobbex.com/p/checkout/${encodeURIComponent(order.gateway_txn_id)}`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'x-api-key': auth.apiKey,
              'x-access-token': auth.accessToken,
            },
          }
        );
        const chkPayload = await chkRes.json().catch(() => null);
        const chkPayments: any[] = chkPayload?.data?.payments || [];
        isOwnerMatch = chkPayments.some((p) => String(p.id) === transactionId);
      }

      if (!isOwnerMatch) {
        console.error(
          `🚨 [Security Alert - Replay] Tx ${transactionId} (ref: "${officialRef}", chk: "${officialCheckoutUid}") no pertenece a Orden ${internalOrderId}.`
        );
        return;
      }

      if (verifiedStatusCode === 200) {
        const officialBaseAmount = Number(
          paymentNode.requestedTotal ?? paymentNode.total ?? officialOp.requestedTotal ?? officialOp.total ?? 0
        );
        const expectedOrderAmount = Number(order.total_amount);

        if (Math.abs(officialBaseAmount - expectedOrderAmount) > 1) {
          console.error(
            `🚨 [Security Alert - Amount Mismatch] Orden ${internalOrderId}: esperado $${expectedOrderAmount}, verificado en Mobbex $${officialBaseAmount}.`
          );
          return;
        }
      }
    }

    if (verifiedStatusCode === 200) {
      if (order.status === 'PAID') {
        console.warn(`🛡️ [Webhook Mobbex - DB Guard] Orden ${internalOrderId} ya estaba PAID. Ignorando.`);
        await RedisService.set(processedKey, '1', 86400);
        return;
      }

      let createdCommissionAmount = 0;
      const touchedProductIds: string[] = [];

      await prisma.$transaction(async (tx) => {
        const updatedOrder = await tx.order.updateMany({
          where: {
            id: internalOrderId,
            status: { in: ['PENDING', 'BUDGET'] },
          },
          data: {
            status: 'PAID',
            gateway_txn_id: transactionId,
            gateway_metadata: verifiedData,
          },
        });

        if (updatedOrder.count === 0) {
          throw new Error('La orden ya fue procesada previamente.');
        }

        if (order.coupon_id) {
          await tx.coupon.update({
            where: { id: order.coupon_id },
            data: { used_count: { increment: 1 } },
          });
        }

        let totalCommissionAmount = 0;

        for (const item of order.items) {
          if (!item.product_id || !item.product) continue;

          if (item.product.is_combo && item.product.combo_parts.length > 0) {
            for (const part of item.product.combo_parts) {
              const requiredQty = part.quantity * item.quantity;
              const updateResult = await tx.product.updateMany({
                where: {
                  id: part.product_id,
                  physical_stock: { gte: requiredQty },
                },
                data: {
                  physical_stock: { decrement: requiredQty },
                  version: { increment: 1 },
                },
              });

              if (updateResult.count === 0) {
                throw new Error(`Stock insuficiente para componente del combo ${item.product.name}. Sobreventa abortada.`);
              }
              touchedProductIds.push(part.product_id);
            }
          } else {
            const updateResult = await tx.product.updateMany({
              where: {
                id: item.product_id,
                physical_stock: { gte: item.quantity },
              },
              data: {
                physical_stock: { decrement: item.quantity },
                version: { increment: 1 },
              },
            });

            if (updateResult.count === 0) {
              throw new Error(`Stock insuficiente para ${item.product.name}. Sobreventa abortada.`);
            }
            touchedProductIds.push(item.product_id);
          }

          const itemTotal = Number(item.unit_price) * item.quantity;
          const rate =
            Number(item.applied_commission_rate) > 0
              ? Number(item.applied_commission_rate)
              : Number(item.product.commission_rate);
          totalCommissionAmount += itemTotal * (rate / 100);
        }

        if (order.seller_id && totalCommissionAmount > 0) {
          const isSelfPurchase =
            order.seller?.user_id && order.customer?.user_id && order.seller.user_id === order.customer.user_id;

          if (!isSelfPurchase) {
            const sanitizedCommission = Math.round(totalCommissionAmount * 100) / 100;
            const clearingDate = new Date();
            clearingDate.setDate(clearingDate.getDate() + 15);

            await tx.commissionLedger.create({
              data: {
                order_id: internalOrderId,
                seller_id: order.seller_id,
                amount: sanitizedCommission,
                status: CommissionStatus.PENDING_CLEARANCE,
                clearing_date: clearingDate,
              },
            });

            createdCommissionAmount = sanitizedCommission;
          } else {
            console.warn(`🛡️ [Fraud Prevented] Auto-compra de vendedor bloqueada en Orden ${internalOrderId}.`);
          }
        }
      });

      await RedisService.set(processedKey, '1', 86400);
      console.log(`✅ [Webhook Mobbex] Orden ${internalOrderId} PAID y verificada S2S (Tx: ${transactionId}).`);

      if (order.seller_id && createdCommissionAmount > 0 && order.seller?.user_id) {
        await NotificationsService.notify({
          userId: order.seller.user_id,
          role: Role.SELLER,
          type: NotificationType.COMMISSION_EARNED,
          title: `Nueva comisión atribuida: +$${createdCommissionAmount.toFixed(2)}`,
          message: `Pedido #${internalOrderId.slice(0, 8).toUpperCase()} confirmado. La comisión entra en período de garantía.`,
          actionUrl: '/commissions',
          metadata: {
            order_id: internalOrderId,
            amount: createdCommissionAmount,
            gateway: 'MOBBEX',
          },
          dedupKey: `commission_earned:${internalOrderId}`,
        });
      }

      if (order.customer?.user_id) {
        await NotificationsService.notify({
          userId: order.customer.user_id,
          role: Role.CUSTOMER,
          type: NotificationType.ORDER_PAID,
          title: '¡Pago aprobado!',
          message: `Confirmamos el pago de tu pedido #${internalOrderId.slice(0, 8).toUpperCase()} por $${Number(order.total_amount).toFixed(2)}. Ya estamos preparando tu compra.`,
          actionUrl: `/orders/${internalOrderId}`,
          metadata: {
            order_id: internalOrderId,
            amount: Number(order.total_amount),
            gateway: 'MOBBEX',
            transaction_id: transactionId,
          },
          dedupKey: `order_paid:${internalOrderId}`,
        });
      }

      await NotificationsService.checkAndNotifyLowStock(touchedProductIds);
    }

    else if (verifiedStatusCode >= 400 && verifiedStatusCode < 600) {
      const reason =
        verifiedData?.payment?.status?.message ||
        verifiedData?.status?.message ||
        data.payment.status.message ||
        'Pago rechazado';

      await prisma.order.update({
        where: { id: internalOrderId },
        data: {
          gateway_metadata: {
            lastFailureCode: verifiedStatusCode,
            lastFailureReason: reason,
            failedAt: new Date().toISOString(),
          },
        },
      });
      console.log(`⚠️ [Webhook Mobbex] Rechazo (${verifiedStatusCode}) registrado en Orden ${internalOrderId}: ${reason}`);

      if (order.customer?.user_id) {
        await NotificationsService.notify({
          userId: order.customer.user_id,
          role: Role.CUSTOMER,
          type: NotificationType.PAYMENT_ACTION_REQUIRED,
          title: 'Tu pago no pudo procesarse',
          message: `El pago de tu pedido #${internalOrderId.slice(0, 8).toUpperCase()} fue rechazado (${reason}). Reintenta con otro medio de pago.`,
          actionUrl: `/orders/${internalOrderId}`,
          metadata: {
            order_id: internalOrderId,
            gateway: 'MOBBEX',
            transaction_id: transactionId,
            failure_code: verifiedStatusCode,
            reason,
          },
          dedupKey: `mobbex_payment_failed:${transactionId}`,
        });
      }
    }

    else if (verifiedStatusCode >= 600) {
      let canceledCount = 0;

      await prisma.$transaction(async (tx) => {
        const canceledResult = await tx.commissionLedger.updateMany({
          where: {
            order_id: internalOrderId,
            status: { in: [CommissionStatus.PENDING_CLEARANCE, CommissionStatus.AVAILABLE] },
          },
          data: { status: CommissionStatus.CANCELED },
        });
        canceledCount = canceledResult.count;

        if (order.status === 'PAID') {
          for (const item of order.items) {
            if (!item.product_id || !item.product) continue;

            if (item.product.is_combo && item.product.combo_parts.length > 0) {
              for (const part of item.product.combo_parts) {
                await tx.product.update({
                  where: { id: part.product_id },
                  data: {
                    physical_stock: { increment: part.quantity * item.quantity },
                    version: { increment: 1 },
                  },
                });
              }
            } else {
              await tx.product.update({
                where: { id: item.product_id },
                data: {
                  physical_stock: { increment: item.quantity },
                  version: { increment: 1 },
                },
              });
            }
          }

          await tx.order.update({
            where: { id: internalOrderId },
            data: {
              status: 'PENDING',
              gateway_metadata: { refundedTx: transactionId, refundedAt: new Date().toISOString() },
            },
          });
        }
      });

      await RedisService.set(processedKey, '1', 86400);
      console.log(`🔄 [Webhook Mobbex] Devolución (${verifiedStatusCode}) verificada: stock reingresado y comisión CANCELED.`);

      if (canceledCount > 0 && order.seller?.user_id) {
        await NotificationsService.notify({
          userId: order.seller.user_id,
          role: Role.SELLER,
          type: NotificationType.COMMISSION_REVERSED,
          title: 'Comisión revertida por reembolso',
          message: `La comisión del pedido #${internalOrderId.slice(0, 8).toUpperCase()} fue cancelada por devolución o contracargo.`,
          actionUrl: '/commissions',
          metadata: {
            order_id: internalOrderId,
            transaction_id: transactionId,
            status_code: verifiedStatusCode,
          },
          dedupKey: `commission_reversed:${internalOrderId}:${transactionId}`,
        });
      }

      if (order.status === 'PAID' && order.customer?.user_id) {
        await NotificationsService.notify({
          userId: order.customer.user_id,
          role: Role.CUSTOMER,
          type: NotificationType.ORDER_CANCELLED,
          title: 'Reembolso procesado y pedido cancelado',
          message: `Se procesó la devolución de $${Number(order.total_amount).toFixed(2)} correspondiente a tu pedido #${internalOrderId.slice(0, 8).toUpperCase()}.`,
          actionUrl: `/orders/${internalOrderId}`,
          metadata: {
            order_id: internalOrderId,
            transaction_id: transactionId,
            refunded_amount: Number(order.total_amount),
            status_code: verifiedStatusCode,
          },
          dedupKey: `order_refunded:${internalOrderId}:${transactionId}`,
        });
      }
    }
  } catch (error: any) {
    console.error(`❌ [Webhook Mobbex] Error procesando Orden ${internalOrderId}:`, error.message);

    const knownGuards = ['La orden ya fue procesada previamente.', 'Stock insuficiente'];
    const isSecurityBlock = knownGuards.some((msg) => error.message?.includes(msg));

    if (!isSecurityBlock) {
      await NotificationsService.notifyAdmins({
        type: NotificationType.INTEGRATION_FAILURE,
        title: 'Fallo técnico en webhook Mobbex',
        message: `Error procesando transacción ${transactionId} de la orden #${internalOrderId.slice(0, 8).toUpperCase()}: ${error.message}`,
        actionUrl: '/settings/payments',
        metadata: {
          gateway: 'MOBBEX',
          order_id: internalOrderId,
          transaction_id: transactionId,
          error: error.message,
        },
        baseDedupKey: `mobbex_webhook_err:${transactionId}`,
      });
    }
  } finally {
    await RedisService.releaseLock(lockKey);
  }
};