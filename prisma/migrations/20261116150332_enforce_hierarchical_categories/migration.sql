-- 1. Agregar columnas jerárquicas a categories (parent_id y depth permiten default)
ALTER TABLE "categories" ADD COLUMN "parent_id" UUID;
ALTER TABLE "categories" ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "categories" ADD COLUMN "path" TEXT;

-- 2. Backfill del path para categorías existentes (si las hubiera)
UPDATE "categories" SET "path" = '/' || "id"::text || '/' WHERE "path" IS NULL;
ALTER TABLE "categories" ALTER COLUMN "path" SET NOT NULL;

-- 3. Crear categoría fallback "General" solo si existen productos sin categoría
DO $$
DECLARE
    default_cat_id UUID := gen_random_uuid();
BEGIN
    IF EXISTS (SELECT 1 FROM "products" WHERE "category_id" IS NULL) THEN
        INSERT INTO "categories" ("id", "name", "slug", "parent_id", "path", "depth", "is_active", "created_at", "updated_at")
        VALUES (default_cat_id, 'General', 'general', NULL, '/' || default_cat_id::text || '/', 0, true, NOW(), NOW())
        ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name"
        RETURNING "id" INTO default_cat_id;

        UPDATE "products" SET "category_id" = default_cat_id WHERE "category_id" IS NULL;
    END IF;
END $$;

-- 4. Endurecer restricción NOT NULL y cambiar ON DELETE SET NULL -> RESTRICT
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_category_id_fkey";
ALTER TABLE "products" ALTER COLUMN "category_id" SET NOT NULL;

ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" 
    FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" 
    FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Índices para búsquedas de subárboles (LIKE '/uuid/%')
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");
CREATE INDEX "categories_path_idx" ON "categories" USING btree ("path" text_pattern_ops);
CREATE INDEX "products_category_id_idx" ON "products"("category_id");