import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('daemon')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: 'Información básica del servicio',
  })
  @ApiResponse({
    status: 200,
    description: 'Metadatos del daemon.',
  })
  getInfo(): Record<string, string> {
    return this.appService.getInfo();
  }
}
