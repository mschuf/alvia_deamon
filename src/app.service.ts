import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getInfo(): Record<string, string> {
    return {
      service: 'alvia_daemon',
      status: 'ok',
      docs: '/api',
      health: '/daemon/health',
    };
  }
}
