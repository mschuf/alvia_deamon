import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DaemonModule } from './daemon/daemon.module';
import { LoggingModule } from './logging/logging.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      expandVariables: true,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.getOrThrow<string>('POSTGRES_HOST'),
        port: Number(configService.get<string>('POSTGRES_PORT') ?? 5432),
        username: configService.getOrThrow<string>('POSTGRES_USER'),
        password: configService.getOrThrow<string>('POSTGRES_PASSWORD'),
        database: configService.getOrThrow<string>('POSTGRES_DB'),
        schema: configService.get<string>('DB_SCHEMA') ?? 'public',
        synchronize: false,
        logging:
          (configService.get<string>('TYPEORM_LOGGING') ?? 'false') === 'true',
        autoLoadEntities: false,
      }),
    }),
    ScheduleModule.forRoot(),
    LoggingModule,
    DaemonModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
