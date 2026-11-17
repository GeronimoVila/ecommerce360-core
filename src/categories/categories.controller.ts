import { Request, Response } from 'express';
import { prismaGlobal } from '../config/prisma';
import { RedisService } from '../redis/redis.service';
import { triggerB2CRevalidation } from '../utils/revalidate.util';
import crypto from 'crypto';

function generateSlug(text: string): string {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const createCategory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, parent_id, is_active } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'El nombre de la categoría es obligatorio.' });
      return;
    }

    const newId = crypto.randomUUID();
    const baseSlug = generateSlug(name);
    let path = `/${newId}/`;
    let depth = 0;

    if (parent_id) {
      const parent = await req.prisma.category.findUnique({
        where: { id: parent_id },
        include: { _count: { select: { products: true } } }
      });

      if (!parent) {
        res.status(404).json({ error: 'La categoría padre especificada no existe.' });
        return;
      }

      if (parent._count.products > 0) {
        res.status(409).json({
          error: `No se puede crear una subcategoría dentro de "${parent.name}" porque ya tiene ${parent._count.products} producto(s) asignado(s). Reasigna esos productos primero.`
        });
        return;
      }

      path = `${parent.path}${newId}/`;
      depth = parent.depth + 1;
    }

    const category = await req.prisma.category.create({
      data: {
        id: newId,
        name: name.trim(),
        slug: baseSlug,
        parent_id: parent_id || null,
        path,
        depth,
        is_active: is_active !== undefined ? Boolean(is_active) : true
      }
    });

    await RedisService.invalidateCategoriesTree();
    triggerB2CRevalidation('categories');

    res.status(201).json({
      message: 'Categoría creada exitosamente.',
      data: category
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe una categoría con un slug idéntico. Usa un nombre más específico.' });
      return;
    }
    console.error('[CategoriesController] Error en createCategory:', error);
    res.status(500).json({ error: 'Error interno al crear la categoría.' });
  }
};

export const getCategoryTree = async (req: Request, res: Response): Promise<void> => {
  try {
    const includeInactive = req.query.include_inactive === 'true' && (req as any).user?.role === 'ADMIN';

    if (!includeInactive) {
      const cachedTree = await RedisService.getCategoriesTree();
      if (cachedTree) {
        res.status(200).json({ data: cachedTree });
        return;
      }
    }

    const categories = await prismaGlobal.category.findMany({
      where: includeInactive ? {} : { is_active: true },
      orderBy: [{ depth: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { products: true } }
      }
    });

    const map = new Map<string, any>();
    const roots: any[] = [];

    for (const cat of categories) {
      map.set(cat.id, {
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        parent_id: cat.parent_id,
        path: cat.path,
        depth: cat.depth,
        is_active: cat.is_active,
        products_count: cat._count.products,
        is_leaf: true,
        children: []
      });
    }

    for (const node of map.values()) {
      if (node.parent_id && map.has(node.parent_id)) {
        const parentNode = map.get(node.parent_id);
        parentNode.children.push(node);
        parentNode.is_leaf = false;
      } else {
        roots.push(node);
      }
    }

    if (!includeInactive) {
      await RedisService.setCategoriesTree(roots, 3600);
    }

    res.status(200).json({ data: roots });
  } catch (error) {
    console.error('[CategoriesController] Error en getCategoryTree:', error);
    res.status(500).json({ error: 'Error al construir el árbol de categorías.' });
  }
};

export const updateCategory = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { name, parent_id, is_active } = req.body;

    const existing = await req.prisma.category.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Categoría no encontrada.' });
      return;
    }

    const dataToUpdate: any = {};
    if (name !== undefined && name.trim()) {
      dataToUpdate.name = name.trim();
      dataToUpdate.slug = generateSlug(name);
    }
    if (is_active !== undefined) {
      dataToUpdate.is_active = Boolean(is_active);
    }

    if (parent_id !== undefined && parent_id !== existing.parent_id) {
      if (parent_id === id) {
        res.status(400).json({ error: 'Una categoría no puede ser padre de sí misma.' });
        return;
      }

      let newParentPath = '/';
      let newDepth = 0;

      if (parent_id !== null) {
        const newParent = await req.prisma.category.findUnique({
          where: { id: parent_id },
          include: { _count: { select: { products: true } } }
        });

        if (!newParent) {
          res.status(404).json({ error: 'La nueva categoría padre no existe.' });
          return;
        }
        if (newParent.path.includes(`/${id}/`)) {
          res.status(400).json({ error: 'Ciclo detectado: No puedes mover una categoría dentro de uno de sus propios descendientes.' });
          return;
        }
        if (newParent._count.products > 0) {
          res.status(409).json({ error: `La categoría destino "${newParent.name}" tiene productos directos y no puede recibir subcategorías.` });
          return;
        }

        newParentPath = newParent.path;
        newDepth = newParent.depth + 1;
      }

      const oldPath = existing.path;
      const newPath = `${newParentPath}${id}/`;
      const depthDiff = newDepth - existing.depth;

      const updated = await req.prisma.$transaction(async (tx) => {
        const descendants = await tx.category.findMany({
          where: { path: { startsWith: oldPath }, id: { not: id } }
        });

        for (const desc of descendants) {
          await tx.category.update({
            where: { id: desc.id },
            data: {
              path: desc.path.replace(oldPath, newPath),
              depth: desc.depth + depthDiff
            }
          });
        }

        return await tx.category.update({
          where: { id },
          data: {
            ...dataToUpdate,
            parent_id,
            path: newPath,
            depth: newDepth
          }
        });
      });

      await RedisService.invalidateCategoriesTree();
      triggerB2CRevalidation('categories');
      res.status(200).json({ message: 'Categoría y subárbol actualizados.', data: updated });
      return;
    }

    const updated = await req.prisma.category.update({
      where: { id },
      data: dataToUpdate
    });

    await RedisService.invalidateCategoriesTree();
    triggerB2CRevalidation('categories');

    res.status(200).json({ message: 'Categoría actualizada exitosamente.', data: updated });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'El slug generado ya está en uso por otra categoría.' });
      return;
    }
    console.error('[CategoriesController] Error en updateCategory:', error);
    res.status(500).json({ error: 'Error interno al actualizar la categoría.' });
  }
};

export const deleteCategory = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const category = await req.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { children: true, products: true } } }
    });

    if (!category) {
      res.status(404).json({ error: 'Categoría no encontrada.' });
      return;
    }

    if (category._count.children > 0) {
      res.status(409).json({ error: 'No se puede eliminar una categoría que tiene subcategorías activas o inactivas.' });
      return;
    }

    if (category._count.products > 0) {
      res.status(409).json({
        error: `No se puede eliminar "${category.name}" porque tiene ${category._count.products} producto(s) asociado(s). Reasígnalos primero.`
      });
      return;
    }

    await req.prisma.category.delete({ where: { id } });

    await RedisService.invalidateCategoriesTree();
    triggerB2CRevalidation('categories');

    res.status(200).json({ message: 'Categoría eliminada permanentemente.' });
  } catch (error) {
    console.error('[CategoriesController] Error en deleteCategory:', error);
    res.status(500).json({ error: 'Error interno al eliminar la categoría.' });
  }
};