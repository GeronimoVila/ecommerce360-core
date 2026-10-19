-- CreateIndex
CREATE INDEX "commission_ledger_seller_id_status_idx" ON "commission_ledger"("seller_id", "status");

-- CreateIndex
CREATE INDEX "commission_ledger_clearing_date_idx" ON "commission_ledger"("clearing_date");

-- CreateIndex
CREATE INDEX "orders_seller_id_idx" ON "orders"("seller_id");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");
