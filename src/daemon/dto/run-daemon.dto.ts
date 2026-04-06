import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class RunDaemonDto {
  @ApiPropertyOptional({
    description:
      'Cantidad máxima de documentos a procesar en esta corrida manual.',
    minimum: 1,
    maximum: 200,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
