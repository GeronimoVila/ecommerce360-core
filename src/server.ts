import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import http from 'http';

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

async function bootstrap() {
    try {
        console.log("Iniciando Core Engine de E-Commerce 360...");

        await prisma.$connect();
        console.log("✅ Conexión exitosa al SSOT (Neon Tech - PostgreSQL).");

        const ping = await redis.ping();
        if (ping === 'PONG') {
            console.log("✅ Conexión exitosa a la Caché (Redis).");
        }

        const port = process.env.PORT || 8080;
        http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: "Core Engine Operativo", version: "1.0.0" }));
        }).listen(port, () => {
            console.log(`🚀 Orquestador escuchando en el puerto ${port}`);
        });

    } catch (error) {
        console.error("❌ Fallo crítico en la infraestructura:", error);
        process.exit(1);
    }
}

bootstrap();