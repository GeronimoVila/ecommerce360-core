import { MercadoPagoConfig, Preference } from 'mercadopago';

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

export const createMpPreference = async (orderId: string, items: MpItem[], customerEmail?: string) => {
    try {
        const preference = new Preference(mpClient);

        const rawFrontendUrl = process.env.FRONTEND_B2C_URL?.trim();
        const baseUrl = (rawFrontendUrl && rawFrontendUrl.startsWith('http')) 
            ? rawFrontendUrl 
            : 'http://localhost:3000';

        const isLocalhost = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');

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
                success: `${baseUrl}/checkout/success`,
                failure: `${baseUrl}/checkout/failure`,
                pending: `${baseUrl}/checkout/pending`
            },
            external_reference: String(orderId)
        };

        if (!isLocalhost) {
            body.auto_return = 'approved';
        }

        if (process.env.WEBHOOK_URL && process.env.WEBHOOK_URL.startsWith('http')) {
            const baseWebhookUrl = process.env.WEBHOOK_URL.replace(/\/$/, '');
            body.notification_url = `${baseWebhookUrl}/api/v1/checkout/webhook/mp`;
        }

        const result = await preference.create({ body });

        return {
            preferenceId: result.id,
            initPoint: result.init_point, 
            sandboxInitPoint: result.sandbox_init_point
        };
    } catch (error: any) {
        console.error('[MP Service] Error detallado:', JSON.stringify(error.cause || error, null, 2));
        throw new Error('Fallo en la integración con la pasarela de pagos.');
    }
};