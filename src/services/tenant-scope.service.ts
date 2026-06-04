import { prisma } from '../utils/prisma';

/**
 * Devuelve los hubIds permitidos para un usuario dado.
 * - ADMIN: null (acceso total, sin filtro).
 * - Otros roles: array de hubIds asignados a sus clientes vinculados.
 *   Si el array es vacio, el usuario no ve nada (esto es intencional).
 */
export async function getAllowedHubIds(userId: string, role: string): Promise<string[] | null> {
  if (role === 'ADMIN') return null;
  // Para no-admins: derivar hubs desde sus clientes asignados
  const access = await prisma.userClientAccess.findMany({
    where: { userId },
    select: { client: { select: { hubLinks: { select: { hubId: true } } } } },
  });
  const hubIds = new Set<string>();
  for (const a of access) {
    for (const link of a.client?.hubLinks || []) {
      if (link.hubId) hubIds.add(link.hubId);
    }
  }
  return Array.from(hubIds);
}

/**
 * Helper para WHERE de Prisma. Si null = sin filtro. Si array vacio = condicion imposible.
 */
export function hubIdsToWhere(hubIds: string[] | null): { hubId?: { in: string[] } } | { hubId: { in: [] } } {
  if (hubIds === null) return {};
  if (hubIds.length === 0) return { hubId: { in: [] } };
  return { hubId: { in: hubIds } };
}
