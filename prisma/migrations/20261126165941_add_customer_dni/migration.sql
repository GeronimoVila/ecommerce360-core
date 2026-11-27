/*
  Warnings:

  - A unique constraint covering the columns `[dni]` on the table `customer_profiles` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "dni" VARCHAR(20);

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_dni_key" ON "customer_profiles"("dni");
