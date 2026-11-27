import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { BannerLinkType } from '@prisma/client';
import { prismaGlobal } from '../config/prisma';
import { R2Service } from '../media/r2.service';
import { RedisService } from '../redis/redis.service';
import { PricingEngine } from '../products/pricing.engine';
import { triggerB2CRevalidation } from '../utils/revalidate.util';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const MAX_BANNER_BYTES = 5 * 1024 * 1024;

function computeComboVirtualStock(parts?: Array<{ quantity: number; product: { physical_stock: number; is_active?: boolean } }>): number {
  if (!parts || parts.length === 0) return 0;
  let minStock = Infinity;
  for (const part of parts) {
    if (part.product.is_active === false) return 0;
    const qty = Number(part.quantity) || 0;
    if (qty <= 0) continue;
    const available = Math.floor((Number(part.product.physical_stock) || 0) / qty);
    if (available < minStock) minStock = available;
  }
  return minStock === Infinity ? 0 : minStock;
}

export const getPublicStorefrontHome = async (_req: Request, res: Response): Promise<void> => {
  try {
    const banners = await prismaGlobal.storefrontBanner.findMany({
      where: { is_active: true },
      orderBy: [{ position: 'asc' }, { created_at: 'desc' }],
    });

    const selectFields = {
      id: true,
      sku: true,
      name: true,
      base_price: true,
      physical_stock: true,
      is_combo: true,
      is_featured: true,
      featured_order: true,
      category_id: true,
      category: {
        select: { id: true, name: true, slug: true, path: true, depth: true },
      },
      images: {
        orderBy: { position: 'asc' as const },
        select: { id: true, url: true, alt_text: true, position: true, is_primary: true },
      },
      combo_parts: {
        include: {
          product: {
            select: { id: true, sku: true, name: true, physical_stock: true, is_active: true },
          },
        },
      },
    };

    let rawProducts = await prismaGlobal.product.findMany({
      where: { is_active: true, is_featured: true },
      orderBy: [{ featured_order: 'asc' }, { updated_at: 'desc' }],
      take: 12,
      select: selectFields,
    });

    if (rawProducts.length === 0) {
      rawProducts = await prismaGlobal.product.findMany({
        where: { is_active: true },
        orderBy: [{ is_combo: 'desc' }, { created_at: 'desc' }],
        take: 8,
        select: selectFields,
      });
    }

    const comboIds = rawProducts.filter((p) => p.is_combo).map((p) => p.id);
    const comboStocks =
      comboIds.length > 0 ? await RedisService.getMultipleComboStocks(comboIds) : {};

    const hydrated = rawProducts.map((product) => {
      if (product.is_combo) {
        const virtualStock =
          comboStocks[product.id] !== null && comboStocks[product.id] !== undefined
            ? Number(comboStocks[product.id])
            : computeComboVirtualStock(product.combo_parts);
        return { ...product, physical_stock: virtualStock };
      }
      return product;
    });

    const availableProducts = hydrated.filter((p) => p.physical_stock > 0);
    const activeRules = await RedisService.getActivePaymentRules();
    const featuredProducts = PricingEngine.applyDynamicPricing(availableProducts, activeRules);

    res.status(200).json({
      banners,
      featured_products: featuredProducts,
    });
  } catch (error) {
    console.error('[StorefrontController.getPublicStorefrontHome] Error:', error);
    res.status(500).json({ error: 'Error al cargar la portada de la tienda.' });
  }
};

export const getAdminStorefrontConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    const db = req.prisma || prismaGlobal;

    const [banners, featuredProducts] = await Promise.all([
      db.storefrontBanner.findMany({
        orderBy: [{ position: 'asc' }, { created_at: 'desc' }],
      }),
      db.product.findMany({
        where: { is_active: true, is_featured: true },
        orderBy: [{ featured_order: 'asc' }, { updated_at: 'desc' }],
        select: {
          id: true,
          sku: true,
          name: true,
          base_price: true,
          is_combo: true,
          featured_order: true,
          category: { select: { id: true, name: true, slug: true } },
          images: {
            where: { is_primary: true },
            take: 1,
            select: { url: true },
          },
        },
      }),
    ]);

    res.status(200).json({
      banners,
      featured_products: featuredProducts,
    });
  } catch (error) {
    console.error('[StorefrontController.getAdminStorefrontConfig] Error:', error);
    res.status(500).json({ error: 'Error al obtener la configuración de vidriera.' });
  }
};

export const requestBannerPresignedUpload = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!R2Service.isConfigured()) {
      res.status(503).json({ error: 'Cloudflare R2 no está configurado en el servidor.' });
      return;
    }

    const { contentType, fileSize } = req.body;
    if (!contentType || !ALLOWED_MIME_TYPES[contentType]) {
      res.status(400).json({ error: 'Formato inválido. Solo se aceptan WebP, JPEG o PNG.' });
      return;
    }

    const parsedSize = Number(fileSize);
    if (!Number.isFinite(parsedSize) || parsedSize <= 0 || parsedSize > MAX_BANNER_BYTES) {
      res.status(400).json({ error: 'El tamaño de la imagen debe ser menor a 5 MB.' });
      return;
    }

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const extension = ALLOWED_MIME_TYPES[contentType];
    const storageKey = `banners/${year}/${month}/${randomUUID()}.${extension}`;

    const { uploadUrl, publicUrl } = await R2Service.createPresignedUploadUrl({
      storageKey,
      contentType,
      contentLength: parsedSize,
    });

    res.status(201).json({ uploadUrl, publicUrl, storageKey });
  } catch (error) {
    console.error('[StorefrontController.requestBannerPresignedUpload] Error:', error);
    res.status(500).json({ error: 'Error generando URL de subida para banner.' });
  }
};

export const createStorefrontBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      badge_text,
      title,
      highlight_text,
      subtitle,
      cta_text,
      payment_note,
      image_url,
      storage_key,
      image_badge_text,
      link_type,
      link_target,
      is_active,
    } = req.body;

    if (!title || !String(title).trim()) {
      res.status(400).json({ error: 'El título principal del banner es obligatorio.' });
      return;
    }

    if (!image_url || !storage_key) {
      res.status(400).json({ error: 'La imagen del banner es obligatoria.' });
      return;
    }

    const validLinkTypes: BannerLinkType[] = ['PRODUCT', 'CATEGORY', 'OFFERS'];
    const resolvedLinkType: BannerLinkType = validLinkTypes.includes(link_type)
      ? link_type
      : 'OFFERS';

    const db = req.prisma || prismaGlobal;
    const count = await db.storefrontBanner.count();

    const banner = await db.storefrontBanner.create({
      data: {
        badge_text: badge_text ? String(badge_text).trim().slice(0, 80) : null,
        title: String(title).trim().slice(0, 140),
        highlight_text: highlight_text ? String(highlight_text).trim().slice(0, 80) : null,
        subtitle: subtitle ? String(subtitle).trim() : null,
        cta_text: cta_text ? String(cta_text).trim().slice(0, 60) : 'Ver Promociones',
        payment_note: payment_note ? String(payment_note).trim().slice(0, 80) : 'Visa, Mastercard & MP',
        image_url: String(image_url).trim(),
        storage_key: String(storage_key).trim(),
        image_badge_text: image_badge_text ? String(image_badge_text).trim().slice(0, 60) : null,
        link_type: resolvedLinkType,
        link_target: link_target ? String(link_target).trim().slice(0, 150) : null,
        position: count,
        is_active: is_active !== undefined ? Boolean(is_active) : true,
      },
    });

    triggerB2CRevalidation('products');

    res.status(201).json({ message: 'Banner promocional creado.', banner });
  } catch (error) {
    console.error('[StorefrontController.createStorefrontBanner] Error:', error);
    res.status(500).json({ error: 'Error al crear el banner promocional.' });
  }
};

export const updateStorefrontBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'ID de banner inválido.' });
      return;
    }

    const db = req.prisma || prismaGlobal;
    const existing = await db.storefrontBanner.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Banner no encontrado.' });
      return;
    }

    const {
      badge_text,
      title,
      highlight_text,
      subtitle,
      cta_text,
      payment_note,
      image_url,
      storage_key,
      image_badge_text,
      link_type,
      link_target,
      position,
      is_active,
    } = req.body;

    const updated = await db.storefrontBanner.update({
      where: { id },
      data: {
        ...(badge_text !== undefined && { badge_text: badge_text ? String(badge_text).trim().slice(0, 80) : null }),
        ...(title !== undefined && { title: String(title).trim().slice(0, 140) }),
        ...(highlight_text !== undefined && { highlight_text: highlight_text ? String(highlight_text).trim().slice(0, 80) : null }),
        ...(subtitle !== undefined && { subtitle: subtitle ? String(subtitle).trim() : null }),
        ...(cta_text !== undefined && { cta_text: String(cta_text).trim().slice(0, 60) }),
        ...(payment_note !== undefined && { payment_note: payment_note ? String(payment_note).trim().slice(0, 80) : null }),
        ...(image_url !== undefined && { image_url: String(image_url).trim() }),
        ...(storage_key !== undefined && { storage_key: String(storage_key).trim() }),
        ...(image_badge_text !== undefined && { image_badge_text: image_badge_text ? String(image_badge_text).trim().slice(0, 60) : null }),
        ...(link_type !== undefined && { link_type }),
        ...(link_target !== undefined && { link_target: link_target ? String(link_target).trim().slice(0, 150) : null }),
        ...(position !== undefined && { position: Number(position) }),
        ...(is_active !== undefined && { is_active: Boolean(is_active) }),
      },
    });

    if (storage_key && storage_key !== existing.storage_key) {
      await R2Service.deleteObject(existing.storage_key).catch(() => null);
    }

    triggerB2CRevalidation('products');

    res.status(200).json({ message: 'Banner actualizado.', banner: updated });
  } catch (error) {
    console.error('[StorefrontController.updateStorefrontBanner] Error:', error);
    res.status(500).json({ error: 'Error al actualizar el banner.' });
  }
};

export const deleteStorefrontBanner = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'ID de banner inválido.' });
      return;
    }

    const db = req.prisma || prismaGlobal;
    const banner = await db.storefrontBanner.findUnique({ where: { id } });
    if (!banner) {
      res.status(404).json({ error: 'Banner no encontrado.' });
      return;
    }

    await db.storefrontBanner.delete({ where: { id } });
    await R2Service.deleteObject(banner.storage_key).catch(() => null);

    triggerB2CRevalidation('products');

    res.status(200).json({ message: 'Banner eliminado.' });
  } catch (error) {
    console.error('[StorefrontController.deleteStorefrontBanner] Error:', error);
    res.status(500).json({ error: 'Error al eliminar el banner.' });
  }
};

export const syncFeaturedProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    const { product_ids } = req.body as { product_ids?: string[] };
    if (!Array.isArray(product_ids)) {
      res.status(400).json({ error: 'Se esperaba un arreglo "product_ids".' });
      return;
    }

    const validIds = product_ids.filter((id) => UUID_REGEX.test(id));
    const db = req.prisma || prismaGlobal;

    await db.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { is_featured: true },
        data: { is_featured: false, featured_order: 0 },
      });

      for (let idx = 0; idx < validIds.length; idx++) {
        await tx.product.updateMany({
          where: { id: validIds[idx] },
          data: { is_featured: true, featured_order: idx },
        });
      }
    });

    triggerB2CRevalidation('products');

    res.status(200).json({
      message: 'Productos destacados de portada actualizados.',
      count: validIds.length,
    });
  } catch (error) {
    console.error('[StorefrontController.syncFeaturedProducts] Error:', error);
    res.status(500).json({ error: 'Error al sincronizar productos destacados.' });
  }
};