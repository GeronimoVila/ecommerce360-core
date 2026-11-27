import Redis from 'ioredis';
import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { connectDatabase } from './config/prisma';
import authRoutes from './auth/auth.routes';
import usersRoutes from './users/users.routes';
import productsRoutes from './products/products.routes';
import paymentRulesRoutes from './payment-rules/payment-rules.routes';
import checkoutRoutes from './checkout/checkout.routes';
import budgetRoutes from './checkout/budget.routes';
import suppliersRoutes from './suppliers/suppliers.routes';
import { startMaturationCron } from './commissions/maturation.cron';
import { startTransferExpirationCron } from './orders/transferExpiration.cron';
import commissionsRoutes from './commissions/commissions.routes';
import ordersRoutes from './orders/orders.routes';
import dashboardRoutes from './dashboard/dashboard.routes';
import mobbexRoutes from './mobbex/mobbex.routes';
import categoriesRoutes from './categories/categories.routes';
import mediaRoutes from './media/media.routes';
import { startMediaCleanupCron } from './media/media.cron';
import { initMediaCleanupJob } from './jobs/mediaCleanup.job';
import notificationsRoutes from './notifications/notifications.routes';
import couponsRoutes from './coupons/coupons.routes';
import storefrontRoutes from './storefront/storefront.routes';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
    retryStrategy(times) {
        if (times > 2) return null;
        return Math.min(times * 100, 2000);
    },
    maxRetriesPerRequest: 1
});

redis.on('error', (err: any) => {
    if (err.code !== 'ECONNREFUSED') {
        console.error("Redis Error:", err);
    }
});

const app = express();

const normalizeOrigin = (value?: string) => value?.trim().replace(/\/+$/, '');

const allowedOrigins = [
    process.env.FRONTEND_B2C_URL || 'http://localhost:3000',
    process.env.FRONTEND_B2B_URL || 'http://localhost:5173',
    process.env.RENDER_EXTERNAL_URL,
    process.env.API_PUBLIC_URL,
]
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin));

app.set('trust proxy', 1);

app.use(cors({
    origin: function(origin, callback) {
        const normalizedOrigin = normalizeOrigin(origin);
        if (!normalizedOrigin || allowedOrigins.includes(normalizedOrigin)) {
            callback(null, true);
        } else {
            callback(new Error(`Bloqueado por CORS - Origen no autorizado: ${origin}`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/products', productsRoutes);
app.use('/api/v1/payment-rules', paymentRulesRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/checkout/budget', budgetRoutes);
app.use('/api/v1/suppliers', suppliersRoutes);
app.use('/api/v1/commissions', commissionsRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/mobbex', mobbexRoutes);
app.use('/api/v1/categories', categoriesRoutes);
app.use('/api/v1/media', mediaRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/coupons', couponsRoutes);
app.use('/api/v1/storefront', storefrontRoutes);

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: "Core Engine Operativo", version: "1.0.1" });
});

async function bootstrap() {
    try {
        await connectDatabase(); 

        try {
            const ping = await redis.ping();
            if (ping === 'PONG') {
                console.log("✅ Conexión exitosa a la Caché (Redis).");
            }
        } catch (cacheError) {
            console.warn("⚠️ Operando con caché degradada: Redis no detectado localmente o inalcanzable.");
        }
        
        const port = process.env.PORT || 8080;
        
        app.listen(port, () => {
            console.log(`🚀 API Gateway escuchando en el puerto ${port}`);
            startMaturationCron();
            startTransferExpirationCron();
            startMediaCleanupCron();
            initMediaCleanupJob();
        });
    } catch (error) {
        console.error("❌ Fallo crítico en infraestructura principal:", error);
        process.exit(1);
    }
}
bootstrap();