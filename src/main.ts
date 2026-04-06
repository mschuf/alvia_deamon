import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ALVIA Daemon API')
    .setDescription(
      'Daemon de OCR para procesar documentos pendientes, delegar OCR en alvia_ocr y actualizar lk_documentos.',
    )
    .setVersion('1.0.0')
    .addTag('daemon')
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, swaggerDocument);

  const port = Number(process.env.PORT ?? 3010);
  await app.listen(port);

  Logger.log(`Daemon ejecutándose en puerto ${port}`, 'Bootstrap');
  Logger.log(`Swagger disponible en /api`, 'Bootstrap');
}
void bootstrap();
