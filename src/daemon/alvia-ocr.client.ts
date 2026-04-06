import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ProcessWithOcrRequest {
  documento: string;
  empresaId: number;
  prompt: string;
  documentId: number;
}

@Injectable()
export class AlviaOcrClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiToken: string | null;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl =
      this.configService.get<string>('ALVIA_OCR_BASE_URL') ??
      'http://localhost:3000';
    this.timeoutMs = Number(
      this.configService.get<string>('ALVIA_OCR_TIMEOUT_MS') ?? 120000,
    );
    const configuredToken = this.configService.get<string>(
      'ALVIA_OCR_API_TOKEN',
    );
    this.apiToken =
      configuredToken && configuredToken.trim().length > 0
        ? configuredToken.trim()
        : null;
  }

  async processDocument(
    request: ProcessWithOcrRequest,
  ): Promise<Record<string, unknown>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/ocr/process-daemon`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiToken) {
        headers['x-ocr-token'] = this.apiToken;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          documento: request.documento,
          empresaId: request.empresaId,
          prompt: request.prompt,
          documentId: request.documentId,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `alvia_ocr respondió ${response.status}: ${errorBody.slice(0, 500)}`,
        );
      }

      return (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }
}
