import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('AdminSecure123!', 10);
  
  const admin = await prisma.user.upsert({
    where: { email: 'admin@ecommerce360.com' },
    update: {},
    create: {
      email: 'admin@ecommerce360.com',
      password_hash: hashedPassword,
      role: 'ADMIN',
      is_active: true
    }
  });

  console.log('✅ Admin raíz creado:', admin.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });