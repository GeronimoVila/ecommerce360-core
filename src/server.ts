import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './auth/auth.routes';
import usersRoutes from './users/users.routes';

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
    retryStrategy(times) {
        if (times > 2) {
            return null;
        }
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

const allowedOrigins = [
    process.env.FRONTEND_B2C_URL || 'http://localhost:3000',
    process.env.FRONTEND_B2B_URL || 'http://localhost:5173'
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Bloqueado por CORS - Origen no autorizado'));
        }
    },
    credentials: true
}));

app.use(express.json()); 
app.use(cookieParser()); 
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: "Core Engine Operativo", version: "1.0.1" });
});

async function bootstrap() {
    try {
        await prisma.$connect();
        console.log("✅ Conexión exitosa al SSOT (Neon Tech - PostgreSQL).");

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
        });
    } catch (error) {
        console.error("❌ Fallo crítico en infraestructura principal:", error);
        process.exit(1);
    }
}
bootstrap();