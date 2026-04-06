import { Module } from '@nestjs/common';
import { DaemonController } from './daemon.controller';
import { DaemonRepository } from './daemon.repository';
import { DaemonSchedulerService } from './daemon-scheduler.service';
import { GeminiClient } from './gemini.client';
import { OcrDaemonService } from './ocr-daemon.service';

@Module({
  controllers: [DaemonController],
  providers: [
    DaemonRepository,
    DaemonSchedulerService,
    GeminiClient,
    OcrDaemonService,
  ],
  exports: [OcrDaemonService],
})
export class DaemonModule {}
