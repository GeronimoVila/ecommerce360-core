import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import express, { Request, Response } from 'express';
import cors from 'cors';

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// 1. Estrategia de Resiliencia (Fault Tolerance) para la Caché
const redis = new Redis(redisUrl, {
    retryStrategy(times) {
        if (times > 2) {
            return null; // Aborta reintentos tras 2 fallos para evitar el bucle ECONNREFUSED
        }
        return Math.min(times * 100, 2000); // Backoff exponencial
    },
    maxRetriesPerRequest: 1
});

// Interceptor para silenciar el spam de errores de red en el entorno local
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

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: "Core Engine Operativo", version: "1.0.1" });
});

async function bootstrap() {
    try {
        await prisma.$connect();
        console.log("✅ Conexión exitosa al SSOT (Neon Tech - PostgreSQL).");

        // 2. Aislamiento del Cuello de Botella
        // Evita que la falta de Redis local detenga el arranque del servidor transaccional
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