import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { InvitationController, MeController } from './auth/me.controller.js';
import { DatabaseModule } from './infra/database.module.js';
import { MaintenanceService } from './infra/maintenance.service.js';
import { PushService } from './infra/push.service.js';
import { RealtimeGateway } from './infra/realtime.gateway.js';
import { RealtimeService } from './infra/realtime.service.js';
import { StorageService } from './infra/storage.service.js';
import { MailModule } from './mail/mail.module.js';
import { CatalogController } from './modules/catalog/catalog.controller.js';
import { CatalogService } from './modules/catalog/catalog.service.js';
import { ImagesService } from './modules/catalog/images.service.js';
import { MediaController } from './modules/catalog/media.controller.js';
import { PartsController } from './modules/catalog/parts.controller.js';
import { DemandController, StockWatchController } from './modules/demand/demand.controller.js';
import { DemandService } from './modules/demand/demand.service.js';
import { StockWatchService } from './modules/demand/stock-watch.service.js';
import { DispatchController, RealtimeController } from './modules/dispatch/dispatch.controller.js';
import { DispatchNotifier } from './modules/dispatch/dispatch.notifier.js';
import { DispatchService } from './modules/dispatch/dispatch.service.js';
import { FinanceController } from './modules/finance/finance.controller.js';
import { FinanceExportService } from './modules/finance/finance.export.js';
import { FinanceService } from './modules/finance/finance.service.js';
import { API_CONTROLLERS, API_PROVIDERS } from './modules/health.module.js';
import { ImporterController } from './modules/importer/importer.controller.js';
import { ImporterService } from './modules/importer/importer.service.js';
import { InventoryController } from './modules/inventory/inventory.controller.js';
import { InventoryQueryService } from './modules/inventory/inventory.query.service.js';
import { InventoryService } from './modules/inventory/inventory.service.js';
import { TransferService } from './modules/inventory/transfer.service.js';
import { OnboardingController } from './modules/onboarding/onboarding.controller.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
import { OrdersController } from './modules/orders/orders.controller.js';
import { OrdersService } from './modules/orders/orders.service.js';
import { PublicCatalogController } from './modules/public-catalog/public-catalog.controller.js';
import { PublicCatalogService } from './modules/public-catalog/public-catalog.service.js';
import { PublicGuardService } from './modules/public-catalog/public-guard.service.js';
import { PublicReceiptsController, ReceiptsController } from './modules/receipts/receipts.controller.js';
import { ReceiptsService } from './modules/receipts/receipts.service.js';
import { SearchController } from './modules/search/search.controller.js';
import { SearchService } from './modules/search/search.service.js';
import { SettingsController } from './modules/settings/settings.controller.js';
import { TeamController } from './modules/team/team.controller.js';
import { TeamService } from './modules/team/team.service.js';

@Module({
  imports: [DatabaseModule, MailModule],
  controllers: [
    ...API_CONTROLLERS,
    AuthController,
    MeController,
    InvitationController,
    OnboardingController,
    TeamController,
    SettingsController,
    SearchController,
    CatalogController,
    PartsController,
    MediaController,
    InventoryController,
    ImporterController,
    OrdersController,
    DispatchController,
    RealtimeController,
    ReceiptsController,
    PublicReceiptsController,
    PublicCatalogController,
    DemandController,
    StockWatchController,
    FinanceController,
  ],
  providers: [
    ...API_PROVIDERS,
    AuthService,
    OnboardingService,
    TeamService,
    SearchService,
    StorageService,
    ImagesService,
    InventoryService,
    InventoryQueryService,
    TransferService,
    CatalogService,
    ImporterService,
    RealtimeService,
    RealtimeGateway,
    PushService,
    DispatchNotifier,
    OrdersService,
    DispatchService,
    ReceiptsService,
    PublicCatalogService,
    PublicGuardService,
    StockWatchService,
    DemandService,
    FinanceService,
    FinanceExportService,
    MaintenanceService,
    // Global: toda ruta es privada salvo que se marque `@Public()`. Al revés —privado por
    // omisión— un endpoint nuevo olvidado queda expuesto; así, un endpoint nuevo olvidado queda
    // cerrado y se nota en la primera prueba, no en la primera fuga.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AppModule {}
