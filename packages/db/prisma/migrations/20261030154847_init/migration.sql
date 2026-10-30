-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('COMPRA', 'VENTA', 'DEVOLUCION', 'AJUSTE', 'IMPORTACION', 'TRASLADO_ENTRADA', 'TRASLADO_SALIDA', 'RESERVA', 'LIBERACION', 'INVENTARIO_FISICO');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('SOLICITADO', 'ENVIADO', 'RECIBIDO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "PartCondition" AS ENUM ('NUEVO', 'USADO', 'REMANUFACTURADO');

-- CreateEnum
CREATE TYPE "PartStatus" AS ENUM ('ACTIVO', 'ARCHIVADO');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDIENTE', 'PROCESANDO', 'COMPLETADA', 'PARCIAL', 'FALLIDA');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('ABIERTO', 'EN_PREPARACION', 'LISTO', 'ENTREGADO', 'PARCIAL', 'CANCELADO');

-- CreateEnum
CREATE TYPE "LineStatus" AS ENUM ('PENDIENTE', 'EN_PREPARACION', 'LISTO', 'ENTREGADO', 'SIN_STOCK', 'CANCELADO');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('MOSTRADOR', 'TELEFONO', 'WHATSAPP', 'CATALOGO', 'MOVIL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'CREDITO', 'MIXTO');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "phone" TEXT,
    "role" TEXT DEFAULT 'user',
    "banned" BOOLEAN DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "twoFactorEnabled" BOOLEAN DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,
    "impersonatedBy" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twoFactor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN DEFAULT true,
    "failedVerificationCount" INTEGER DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "twoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "aaguid" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "taxId" TEXT,
    "country" TEXT NOT NULL DEFAULT 'GT',
    "currency" TEXT NOT NULL DEFAULT 'GTQ',
    "locale" TEXT NOT NULL DEFAULT 'es-GT',
    "timezone" TEXT NOT NULL DEFAULT 'America/Guatemala',
    "phone" TEXT,
    "whatsapp" TEXT,
    "address" TEXT,
    "logoUrl" TEXT,
    "brandPrimary" TEXT NOT NULL DEFAULT '#16324F',
    "brandAccent" TEXT NOT NULL DEFAULT '#B4703A',
    "taxRateBps" INTEGER NOT NULL DEFAULT 1200,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true,
    "orderPrefix" TEXT NOT NULL DEFAULT 'PD',
    "orderSeq" INTEGER NOT NULL DEFAULT 0,
    "receiptPrefix" TEXT NOT NULL DEFAULT 'R',
    "receiptSeq" INTEGER NOT NULL DEFAULT 0,
    "catalogEnabled" BOOLEAN NOT NULL DEFAULT false,
    "catalogTagline" TEXT,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "warehouseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "warehouseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_job" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 4,
    "singletonKey" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,

    CONSTRAINT "vehicle_brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_model" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bodyType" TEXT,

    CONSTRAINT "vehicle_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "yearStart" INTEGER NOT NULL,
    "yearEnd" INTEGER NOT NULL,
    "engine" TEXT,
    "bodyStyle" TEXT,
    "trim" TEXT,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_term" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'es-GT',

    CONSTRAINT "part_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sellsOnline" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_level" (
    "tenantId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "reorderPoint" INTEGER,
    "binLocation" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_level_pkey" PRIMARY KEY ("variantId","warehouseId")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "type" "MovementType" NOT NULL,
    "reason" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "fromWarehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'SOLICITADO',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "stock_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_item" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "stock_transfer_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_category" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "part_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "categoryId" TEXT,
    "brand" TEXT,
    "condition" "PartCondition" NOT NULL DEFAULT 'NUEVO',
    "unit" TEXT NOT NULL DEFAULT 'UNIDAD',
    "warrantyDays" INTEGER,
    "description" TEXT,
    "isUniversal" BOOLEAN NOT NULL DEFAULT false,
    "status" "PartStatus" NOT NULL DEFAULT 'ACTIVO',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "searchText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_variant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "partNumber" TEXT,
    "oemNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "barcode" TEXT,
    "title" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "part_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_image" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "part_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_compatibility" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "part_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDIENTE',
    "mapping" JSONB NOT NULL,
    "payload" JSONB,
    "warehouseId" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "successRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "createdParts" INTEGER NOT NULL DEFAULT 0,
    "createdVariants" INTEGER NOT NULL DEFAULT 0,
    "updatedVariants" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row_error" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "field" TEXT,
    "message" TEXT NOT NULL,
    "raw" JSONB,

    CONSTRAINT "import_row_error_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "taxId" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerTaxId" TEXT,
    "channel" "OrderChannel" NOT NULL DEFAULT 'MOSTRADOR',
    "status" "OrderStatus" NOT NULL DEFAULT 'ABIERTO',
    "sellerId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "sales_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_item" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "status" "LineStatus" NOT NULL DEFAULT 'PENDIENTE',
    "reservedUntil" TIMESTAMP(3),
    "preparedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "sales_order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_event" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT,
    "type" TEXT NOT NULL,
    "detail" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reference" TEXT,
    "receivedCents" INTEGER,
    "changeCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "pdfKey" TEXT,
    "snapshot" JSONB NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_category" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "expense_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "title" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_metric" (
    "tenantId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "cogsCents" INTEGER NOT NULL DEFAULT 0,
    "expensesCents" INTEGER NOT NULL DEFAULT 0,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "missedSearches" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "daily_metric_pkey" PRIMARY KEY ("tenantId","day")
);

-- CreateTable
CREATE TABLE "search_event" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rawQuery" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'MOSTRADOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demand_daily" (
    "tenantId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "term" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "withResults" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "demand_daily_pkey" PRIMARY KEY ("tenantId","day","term")
);

-- CreateTable
CREATE TABLE "stock_watch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partId" TEXT,
    "variantId" TEXT,
    "rawQuery" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_grant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'FREE',
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor"("userId");

-- CreateIndex
CREATE INDEX "passkey_userId_idx" ON "passkey"("userId");

-- CreateIndex
CREATE INDEX "passkey_credentialID_idx" ON "passkey"("credentialID");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "member_tenantId_userId_key" ON "member"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "role_tenantId_idx" ON "role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenantId_key_key" ON "role"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_key" ON "invitation"("token");

-- CreateIndex
CREATE INDEX "invitation_tenantId_email_idx" ON "invitation"("tenantId", "email");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_createdAt_idx" ON "audit_log"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_entity_entityId_idx" ON "audit_log"("tenantId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "notification_tenantId_userId_readAt_idx" ON "notification"("tenantId", "userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "push_token_token_key" ON "push_token"("token");

-- CreateIndex
CREATE INDEX "push_token_tenantId_userId_idx" ON "push_token"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "background_job_status_runAt_idx" ON "background_job"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "background_job_queue_singletonKey_key" ON "background_job"("queue", "singletonKey");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_brand_name_key" ON "vehicle_brand"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_model_brandId_name_key" ON "vehicle_model"("brandId", "name");

-- CreateIndex
CREATE INDEX "vehicle_yearStart_yearEnd_idx" ON "vehicle"("yearStart", "yearEnd");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_modelId_yearStart_yearEnd_engine_bodyStyle_key" ON "vehicle"("modelId", "yearStart", "yearEnd", "engine", "bodyStyle");

-- CreateIndex
CREATE UNIQUE INDEX "part_term_term_key" ON "part_term"("term");

-- CreateIndex
CREATE INDEX "part_term_canonical_idx" ON "part_term"("canonical");

-- CreateIndex
CREATE INDEX "warehouse_tenantId_idx" ON "warehouse"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_tenantId_code_key" ON "warehouse"("tenantId", "code");

-- CreateIndex
CREATE INDEX "inventory_level_tenantId_warehouseId_idx" ON "inventory_level"("tenantId", "warehouseId");

-- CreateIndex
CREATE INDEX "inventory_level_tenantId_binLocation_idx" ON "inventory_level"("tenantId", "binLocation");

-- CreateIndex
CREATE INDEX "stock_movement_tenantId_variantId_createdAt_idx" ON "stock_movement"("tenantId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movement_tenantId_warehouseId_createdAt_idx" ON "stock_movement"("tenantId", "warehouseId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movement_tenantId_refType_refId_idx" ON "stock_movement"("tenantId", "refType", "refId");

-- CreateIndex
CREATE INDEX "stock_transfer_tenantId_status_idx" ON "stock_transfer"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_tenantId_number_key" ON "stock_transfer"("tenantId", "number");

-- CreateIndex
CREATE INDEX "stock_transfer_item_tenantId_transferId_idx" ON "stock_transfer_item"("tenantId", "transferId");

-- CreateIndex
CREATE UNIQUE INDEX "part_category_tenantId_slug_key" ON "part_category"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "part_tenantId_status_idx" ON "part"("tenantId", "status");

-- CreateIndex
CREATE INDEX "part_tenantId_categoryId_idx" ON "part"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "part_tenantId_slug_key" ON "part"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "part_variant_partId_idx" ON "part_variant"("partId");

-- CreateIndex
CREATE INDEX "part_variant_tenantId_partNumber_idx" ON "part_variant"("tenantId", "partNumber");

-- CreateIndex
CREATE UNIQUE INDEX "part_variant_tenantId_sku_key" ON "part_variant"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "part_variant_tenantId_barcode_key" ON "part_variant"("tenantId", "barcode");

-- CreateIndex
CREATE INDEX "part_image_partId_idx" ON "part_image"("partId");

-- CreateIndex
CREATE INDEX "part_compatibility_tenantId_vehicleId_idx" ON "part_compatibility"("tenantId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "part_compatibility_partId_vehicleId_key" ON "part_compatibility"("partId", "vehicleId");

-- CreateIndex
CREATE INDEX "import_job_tenantId_createdAt_idx" ON "import_job"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "import_row_error_jobId_rowNumber_idx" ON "import_row_error"("jobId", "rowNumber");

-- CreateIndex
CREATE INDEX "customer_tenantId_name_idx" ON "customer"("tenantId", "name");

-- CreateIndex
CREATE INDEX "customer_tenantId_phone_idx" ON "customer"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "sales_order_tenantId_status_createdAt_idx" ON "sales_order"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "sales_order_tenantId_sellerId_idx" ON "sales_order"("tenantId", "sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_tenantId_number_key" ON "sales_order"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_tenantId_idempotencyKey_key" ON "sales_order"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sales_order_item_tenantId_orderId_idx" ON "sales_order_item"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "sales_order_item_tenantId_status_idx" ON "sales_order_item"("tenantId", "status");

-- CreateIndex
CREATE INDEX "order_event_tenantId_orderId_createdAt_idx" ON "order_event"("tenantId", "orderId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_tenantId_orderId_idx" ON "payment"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_token_key" ON "receipt"("token");

-- CreateIndex
CREATE INDEX "receipt_tenantId_orderId_idx" ON "receipt"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_tenantId_folio_key" ON "receipt"("tenantId", "folio");

-- CreateIndex
CREATE UNIQUE INDEX "expense_category_tenantId_name_key" ON "expense_category"("tenantId", "name");

-- CreateIndex
CREATE INDEX "expense_tenantId_paidAt_idx" ON "expense"("tenantId", "paidAt");

-- CreateIndex
CREATE INDEX "search_event_tenantId_createdAt_idx" ON "search_event"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "search_event_tenantId_normalized_idx" ON "search_event"("tenantId", "normalized");

-- CreateIndex
CREATE INDEX "demand_daily_tenantId_day_idx" ON "demand_daily"("tenantId", "day");

-- CreateIndex
CREATE INDEX "stock_watch_tenantId_notifiedAt_idx" ON "stock_watch"("tenantId", "notifiedAt");

-- CreateIndex
CREATE INDEX "stock_watch_tenantId_variantId_idx" ON "stock_watch"("tenantId", "variantId");

-- CreateIndex
CREATE INDEX "plan_grant_tenantId_idx" ON "plan_grant"("tenantId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_model" ADD CONSTRAINT "vehicle_model_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "vehicle_brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "vehicle_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "part_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "part_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_category" ADD CONSTRAINT "part_category_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part" ADD CONSTRAINT "part_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part" ADD CONSTRAINT "part_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "part_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_variant" ADD CONSTRAINT "part_variant_partId_fkey" FOREIGN KEY ("partId") REFERENCES "part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_image" ADD CONSTRAINT "part_image_partId_fkey" FOREIGN KEY ("partId") REFERENCES "part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibility" ADD CONSTRAINT "part_compatibility_partId_fkey" FOREIGN KEY ("partId") REFERENCES "part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibility" ADD CONSTRAINT "part_compatibility_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row_error" ADD CONSTRAINT "import_row_error_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "import_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "sales_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "sales_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "sales_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "sales_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_category" ADD CONSTRAINT "expense_category_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_metric" ADD CONSTRAINT "daily_metric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_event" ADD CONSTRAINT "search_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demand_daily" ADD CONSTRAINT "demand_daily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_watch" ADD CONSTRAINT "stock_watch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
