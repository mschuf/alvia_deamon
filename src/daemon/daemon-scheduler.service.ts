import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OcrDaemonService } from './ocr-daemon.service';
import { StepLoggerService } from '../logging/step-logger.service';

const INTERVAL_NAME = 'ocr-daemon-interval';

@Injectable()
export class DaemonSchedulerService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly ocrDaemonService: OcrDaemonService,
    private readonly stepLogger: StepLoggerService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.ocrDaemonService.intervalMinutes * 60_000;
    const runOnStartup =
      (this.configService.get<string>('OCR_DAEMON_RUN_ON_STARTUP') ??
        'true') === 'true';

    const interval = setInterval(() => {
      void this.ocrDaemonService.runCycle('schedule');
    }, intervalMs);

    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);

    this.stepLogger.info('Scheduler del daemon configurado.', {
      step: 'scheduler.init',
      metadata: {
        intervalMinutes: this.ocrDaemonService.intervalMinutes,
        runOnStartup,
      },
    });

    if (runOnStartup) {
      void this.ocrDaemonService.runCycle('startup');
    }
  }

  onModuleDestroy(): void {
    try {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    } catch {
      // Si no existe el intervalo, no hacemos nada.
    }
  }
}
