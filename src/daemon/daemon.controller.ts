import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RunDaemonDto } from './dto/run-daemon.dto';
import { DaemonCycleSummary } from './daemon.types';
import { OcrDaemonService } from './ocr-daemon.service';

@ApiTags('daemon')
@Controller('daemon')
export class DaemonController {
  constructor(private readonly ocrDaemonService: OcrDaemonService) {}

  @Get('health')
  @ApiOperation({
    summary: 'Estado del daemon',
    description:
      'Devuelve estado actual, último resumen de corrida y configuración activa.',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado actual del daemon.',
  })
  getHealth(): Record<string, unknown> {
    return this.ocrDaemonService.getStatus();
  }

  @Post('run')
  @ApiOperation({
    summary: 'Ejecutar daemon manualmente',
    description:
      'Dispara una corrida manual del daemon. Si DAEMON_CONTROL_TOKEN está configurado, se requiere el header x-daemon-token.',
  })
  @ApiHeader({
    name: 'x-daemon-token',
    required: false,
    description:
      'Token de control opcional para ejecución manual (obligatorio solo si DAEMON_CONTROL_TOKEN está configurado).',
  })
  @ApiBody({
    type: RunDaemonDto,
    required: false,
  })
  @ApiResponse({
    status: 201,
    description: 'Resumen de ejecución manual.',
  })
  async runNow(
    @Headers('x-daemon-token') daemonToken: string | undefined,
    @Body() body: RunDaemonDto,
  ): Promise<DaemonCycleSummary> {
    this.ocrDaemonService.validateControlToken(daemonToken);
    return this.ocrDaemonService.runCycle('manual', {
      limit: body?.limit,
    });
  }
}
