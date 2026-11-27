import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { NotificationType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

const mpClient = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || '', 
    options: { timeout: 5000 } 
});

export interface MpItem {
    id: string;
    title: string;
    quantity: number;
    unit_price: number;
}

export const createMpPreference = async (
    orderId: string,
    items: MpItem[],
    customerEmail?: string,
    installments?: number
) => {
    try {
        const preference = new Preference(mpClient);

        const rawFrontendUrl = process.env.FRONTEND_B2C_URL?.trim().replace(/\/$/, '');
        const frontendUrl = (rawFrontendUrl && rawFrontendUrl.startsWith('http')) 
            ? rawFrontendUrl 
            : 'http://localhost:3000';

        const rawWebhookUrl = process.env.WEBHOOK_URL?.trim().replace(/\/$/, '');
        const hasPublicWebhook = Boolean(rawWebhookUrl && rawWebhookUrl.startsWith('https://'));
        const isFrontendLocal = frontendUrl.includes('localhost') || frontendUrl.includes('127.0.0.1');

        const returnEntrypoint = (isFrontendLocal && hasPublicWebhook)
            ? `${rawWebhookUrl}/api/v1/checkout/mp-bridge`
            : `${frontendUrl}/checkout/success`;

        const returnBaseUrl = `${returnEntrypoint}?orderId=${encodeURIComponent(orderId)}&gateway=MP`;

        const body: any = {
            items: items.map(item => ({
                id: String(item.id).substring(0, 256),
                title: item.title || 'Producto Sin Nombre',
                quantity: Number(item.quantity),
                unit_price: Number(item.unit_price),
                currency_id: 'ARS'
            })),
            payer: {
                email: customerEmail || 'guest@ecommerce.com',
            },
            back_urls: {
                success: `${returnBaseUrl}&outcome=approved`,
                failure: `${returnBaseUrl}&outcome=failure`,
                pending: `${returnBaseUrl}&outcome=pending`
            },
            external_reference: String(orderId)
        };

        const normalizedInstallments = Number(installments);
        if (Number.isFinite(normalizedInstallments) && normalizedInstallments > 1) {
            body.payment_methods = {
                installments: normalizedInstallments,
                default_installments: normalizedInstallments,
            };
        }

        if (returnEntrypoint.startsWith('https://')) {
            body.auto_return = 'approved';
        }

        if (rawWebhookUrl && rawWebhookUrl.startsWith('http')) {
            body.notification_url = `${rawWebhookUrl}/api/v1/checkout/budget/webhook/mp`;
        }

        const result = await preference.create({ body });

        return {
            preferenceId: result.id,
            initPoint: result.init_point, 
            sandboxInitPoint: result.sandbox_init_point
        };
    } catch (error: any) {
        console.error('[MP Service] Error detallado:', JSON.stringify(error.cause || error, null, 2));

        await NotificationsService.notifyAdmins({
            type: NotificationType.INTEGRATION_FAILURE,
            title: 'Error creando preferencia en Mercado Pago',
            message: `Fallo al generar checkout de Mercado Pago para la orden #${orderId.slice(0, 8).toUpperCase()}: ${error?.message || 'Error de conexión'}`,
            actionUrl: '/settings/payments',
            metadata: {
                gateway: 'MP',
                order_id: orderId,
                error: error?.message || 'Unknown MP error'
            },
            baseDedupKey: `mp_pref_err:${orderId}`
        });

        throw new Error('Fallo en la integración con la pasarela de pagos.');
    }
};

export const getMpPaymentById = async (paymentId: string | number) => {
    try {
        const payment = new Payment(mpClient);
        const result = await payment.get({ id: Number(paymentId) });
        return result;
    } catch (error: any) {
        console.error('[MP Service] Error al consultar pago:', error);

        await NotificationsService.notifyAdmins({
            type: NotificationType.INTEGRATION_FAILURE,
            title: 'Error consultando pago en Mercado Pago',
            message: `No se pudo verificar el pago ${paymentId} contra la API de Mercado Pago.`,
            actionUrl: '/settings/payments',
            metadata: {
                gateway: 'MP',
                payment_id: String(paymentId),
                error: error?.message || 'Unknown MP error'
            },
            baseDedupKey: `mp_get_err:${paymentId}`
        });

        throw new Error('No se pudo verificar la transacción en Mercado Pago.');
    }
};