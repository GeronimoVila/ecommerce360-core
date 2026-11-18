import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prismaGlobal } from '../config/prisma';
import { R2Service } from './r2.service';
import { triggerB2CRevalidation } from '../utils/revalidate.util';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_PRODUCT = 8;

export const requestPresignedUpload = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!R2Service.isConfigured()) {
      res.status(503).json({ error: 'El almacenamiento Cloudflare R2 no está configurado en el servidor.' });
      return;
    }

    const { contentType, fileSize, altText } = req.body;

    if (!contentType || !ALLOWED_MIME_TYPES[contentType]) {
      res.status(400).json({
        error: 'Formato de imagen no permitido. Solo se aceptan WebP, JPEG o PNG.',
      });
      return;
    }

    const parsedSize = Number(fileSize);
    if (!Number.isFinite(parsedSize) || parsedSize <= 0 || parsedSize > MAX_FILE_SIZE_BYTES) {
      res.status(400).json({
        error: 'El tamaño del archivo debe ser mayor a 0 bytes y no superar los 5 MB.',
      });
      return;
    }

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const extension = ALLOWED_MIME_TYPES[contentType];
    const fileUuid = randomUUID();
    const storageKey = `products/${year}/${month}/${fileUuid}.${extension}`;

    const { uploadUrl, publicUrl } = await R2Service.createPresignedUploadUrl({
      storageKey,
      contentType,
      contentLength: parsedSize,
    });

    const db = req.prisma || prismaGlobal;

    const draftImage = await db.productImage.create({
      data: {
        url: publicUrl,
        storage_key: storageKey,
        alt_text: typeof altText === 'string' ? altText.trim().slice(0, 180) : null,
        is_committed: false,
      },
    });

    res.status(201).json({
      imageId: draftImage.id,
      uploadUrl,
      publicUrl,
      storageKey,
    });
  } catch (error) {
    console.error('[MediaController.requestPresignedUpload] Error:', error);
    res.status(500).json({ error: 'No se pudo generar la URL de subida hacia R2.' });
  }
};

export const syncProductImages = async (req: Request, res: Response): Promise<void> => {
  try {
    const productId = req.params.productId as string;
    const { images } = req.body as {
      images?: Array<{ id: string; alt_text?: string; is_primary?: boolean }>;
    };

    if (!UUID_REGEX.test(productId)) {
      res.status(400).json({ error: 'Formato de productId inválido.' });
      return;
    }

    if (!Array.isArray(images)) {
      res.status(400).json({ error: 'El campo "images" debe ser un arreglo.' });
      return;
    }

    if (images.length > MAX_IMAGES_PER_PRODUCT) {
      res.status(400).json({
        error: `Se permite un máximo de ${MAX_IMAGES_PER_PRODUCT} imágenes por producto.`,
      });
      return;
    }

    const db = req.prisma || prismaGlobal;

    const product = await db.product.findUnique({
      where: { id: productId },
      include: { images: true },
    });

    if (!product) {
      res.status(404).json({ error: 'Producto no encontrado.' });
      return;
    }

    const incomingIds = images.map((img) => img.id);

    const removedImages = product.images.filter((existing) => !incomingIds.includes(existing.id));

    const explicitPrimaryIndex = images.findIndex((img) => img.is_primary === true);
    const resolvedPrimaryIndex = explicitPrimaryIndex >= 0 ? explicitPrimaryIndex : 0;

    const updatedGallery = await db.$transaction(async (tx) => {
      if (removedImages.length > 0) {
        await tx.productImage.deleteMany({
          where: { id: { in: removedImages.map((r) => r.id) } },
        });
      }

      for (let idx = 0; idx < images.length; idx++) {
        const item = images[idx];
        if (!UUID_REGEX.test(item.id)) continue;

        await tx.productImage.updateMany({
          where: {
            id: item.id,
            OR: [{ product_id: null }, { product_id: productId }],
          },
          data: {
            product_id: productId,
            position: idx,
            is_primary: idx === resolvedPrimaryIndex,
            is_committed: true,
            alt_text:
              typeof item.alt_text === 'string' && item.alt_text.trim() !== ''
                ? item.alt_text.trim().slice(0, 180)
                : product.name,
          },
        });
      }

      return tx.productImage.findMany({
        where: { product_id: productId },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          url: true,
          alt_text: true,
          position: true,
          is_primary: true,
        },
      });
    });

    if (removedImages.length > 0) {
      await Promise.allSettled(
        removedImages.map((img) => R2Service.deleteObject(img.storage_key))
      );
    }

    triggerB2CRevalidation('products');

    res.status(200).json({
      message: 'Galería de producto sincronizada correctamente.',
      images: updatedGallery,
    });
  } catch (error) {
    console.error('[MediaController.syncProductImages] Error:', error);
    res.status(500).json({ error: 'Error interno al sincronizar la galería del producto.' });
  }
};

export const deleteProductImage = async (req: Request, res: Response): Promise<void> => {
  try {
    const imageId = req.params.imageId as string;

    if (!UUID_REGEX.test(imageId)) {
      res.status(400).json({ error: 'Formato de imageId inválido.' });
      return;
    }

    const db = req.prisma || prismaGlobal;

    const image = await db.productImage.findUnique({ where: { id: imageId } });
    if (!image) {
      res.status(404).json({ error: 'Imagen no encontrada.' });
      return;
    }

    await R2Service.deleteObject(image.storage_key);

    await db.$transaction(async (tx) => {
      await tx.productImage.delete({ where: { id: imageId } });

      if (image.product_id && image.is_primary) {
        const nextImage = await tx.productImage.findFirst({
          where: { product_id: image.product_id },
          orderBy: { position: 'asc' },
        });

        if (nextImage) {
          await tx.productImage.update({
            where: { id: nextImage.id },
            data: { is_primary: true },
          });
        }
      }
    });

    if (image.product_id) {
      triggerB2CRevalidation('products');
    }

    res.status(200).json({ message: 'Imagen eliminada de R2 y del catálogo.' });
  } catch (error) {
    console.error('[MediaController.deleteProductImage] Error:', error);
    res.status(500).json({ error: 'Error interno al eliminar la imagen.' });
  }
};