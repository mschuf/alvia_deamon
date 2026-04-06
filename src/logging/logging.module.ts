import { Global, Module } from '@nestjs/common';
import { StepLoggerService } from './step-logger.service';

@Global()
@Module({
  providers: [StepLoggerService],
  exports: [StepLoggerService],
})
export class LoggingModule {}
