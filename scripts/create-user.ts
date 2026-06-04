/**
 * CLI para crear/actualizar usuarios. Uso:
 *
 *   npx tsx scripts/create-user.ts <email> <password> <ADMIN|OPERATOR|VIEWER> [fullName]
 *
 * Ejemplos:
 *   npx tsx scripts/create-user.ts admin@ies.com.uy SuperPass123 ADMIN "IES Admin"
 *   npx tsx scripts/create-user.ts ops@ies.com.uy abc12345 OPERATOR
 *
 * Si el email ya existe, solo actualiza pass + role.
 */
import 'dotenv/config';
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

async function main() {
  const [email, password, roleArg, ...nameParts] = process.argv.slice(2);
  if (!email || !password || !roleArg) {
    console.error('Uso: npx tsx scripts/create-user.ts <email> <password> <ADMIN|OPERATOR|VIEWER> [fullName]');
    process.exit(1);
  }
  const role = roleArg.toUpperCase() as UserRole;
  if (!['ADMIN', 'OPERATOR', 'VIEWER'].includes(role)) {
    console.error('Role debe ser ADMIN, OPERATOR o VIEWER');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password muy corta (minimo 8 chars)');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(password, 10);
  const fullName = nameParts.join(' ') || null;

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    create: {
      email: email.toLowerCase(),
      passwordHash,
      fullName,
      role,
      active: true,
    },
    update: {
      passwordHash,
      role,
      fullName: fullName ?? undefined,
      active: true,
    },
  });

  console.log('Usuario listo:');
  console.log(`  id     : ${user.id}`);
  console.log(`  email  : ${user.email}`);
  console.log(`  role   : ${user.role}`);
  console.log(`  active : ${user.active}`);
  console.log(`  name   : ${user.fullName ?? '(sin nombre)'}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
