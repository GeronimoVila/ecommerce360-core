/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `products` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "products_name_key" ON "products"("name");

-- Índices únicos funcionales insensibles a mayúsculas y espacios laterales
CREATE UNIQUE INDEX "products_sku_lower_trim_unique" ON "products" (LOWER(TRIM("sku")));
CREATE UNIQUE INDEX "products_name_lower_trim_unique" ON "products" (LOWER(TRIM("name")));