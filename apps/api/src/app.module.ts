import { Module } from '@nestjs/common';
import { DatabaseModule } from './infra/database.module.js';
import { API_CONTROLLERS, API_PROVIDERS } from './modules/health.module.js';

@Module({
  imports: [DatabaseModule],
  controllers: API_CONTROLLERS,
  providers: API_PROVIDERS,
})
export class AppModule {}
