import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DaemonRepository } from './daemon.repository';
import {
  DaemonCycleSummary,
  DocumentToProcess,
  PromptRow,
} from './daemon.types';
import { GeminiClient } from './gemini.client';
import { normalizeOcrPayload } from './ocr-normalizer';
import { StepLoggerService } from '../logging/step-logger.service';

interface RunCycleOptions {
  limit?: number;
}

interface ParsedDocumentData {
  mimeType: string;
  base64Data: string;
  source: 'data_uri' | 'url' | 'file_path' | 'base64_text';
}

type ProcessResultStatus = 'updated' | 'failed' | 'skipped';

interface ProcessResult {
  status: ProcessResultStatus;
  partnerCreated: boolean;
}

@Injectable()
export class OcrDaemonService {
  private isRunning = false;
  private lastSummary: DaemonCycleSummary | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly daemonRepository: DaemonRepository,
    private readonly geminiClient: GeminiClient,
    private readonly stepLogger: StepLoggerService,
  ) {}

  getStatus(): Record<string, unknown> {
    return {
      service: 'alvia_daemon',
      running: this.isRunning,
      intervalMinutes: this.intervalMinutes,
      defaultBatchSize: this.defaultBatchSize,
      lastSummary: this.lastSummary,
      timestamp: new Date().toISOString(),
    };
  }

  async runCycle(
    trigger: 'startup' | 'schedule' | 'manual',
    options: RunCycleOptions = {},
  ): Promise<DaemonCycleSummary> {
    if (this.isRunning) {
      const activeRunId = this.lastSummary?.runId ?? 'run-in-progress';
      this.stepLogger.warn('Se omite ciclo porque ya hay otro en ejecución.', {
        runId: activeRunId,
        step: 'cycle.guard',
        metadata: {
          trigger,
        },
      });

      return this.lastSummary ?? this.emptySummary(trigger);
    }

    const runId = randomUUID();
    this.isRunning = true;
    const startedAt = new Date().toISOString();

    const summary: DaemonCycleSummary = {
      runId,
      trigger,
      startedAt,
      totalFound: 0,
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      partnersCreated: 0,
    };

    this.lastSummary = summary;

    this.stepLogger.info('Iniciando ciclo de daemon OCR.', {
      runId,
      step: 'cycle.start',
      metadata: {
        trigger,
        limitOverride: options.limit ?? null,
      },
    });

    try {
      const limit = this.resolveBatchLimit(options.limit);
      const defaultPrompt = await this.loadDefaultPrompt(runId);
      const pendingDocuments =
        await this.daemonRepository.fetchPendingDocuments(limit);
      summary.totalFound = pendingDocuments.length;

      this.stepLogger.info('Documentos pendientes obtenidos.', {
        runId,
        step: 'cycle.fetch_pending',
        metadata: {
          count: pendingDocuments.length,
          limit,
        },
      });

      for (const document of pendingDocuments) {
        summary.processed += 1;
        const result = await this.processDocument(
          runId,
          document,
          defaultPrompt,
        );

        if (result.status === 'updated') {
          summary.updated += 1;
        } else if (result.status === 'skipped') {
          summary.skipped += 1;
        } else {
          summary.failed += 1;
        }

        if (result.partnerCreated) {
          summary.partnersCreated += 1;
        }
      }
    } catch (error) {
      summary.failed += 1;
      this.stepLogger.error(
        'Error general durante el ciclo del daemon.',
        {
          runId,
          step: 'cycle.error',
        },
        error,
      );
    } finally {
      summary.finishedAt = new Date().toISOString();
      this.lastSummary = summary;
      this.isRunning = false;

      this.stepLogger.info('Ciclo del daemon finalizado.', {
        runId,
        step: 'cycle.finish',
        metadata: summary,
      });
    }

    return summary;
  }

  validateControlToken(token: string | undefined): void {
    const controlToken = this.configService.get<string>('DAEMON_CONTROL_TOKEN');
    if (!controlToken) {
      return;
    }

    if (!token || token !== controlToken) {
      throw new UnauthorizedException(
        'Token de control inválido para ejecución manual del daemon.',
      );
    }
  }

  get intervalMinutes(): number {
    const configuredValue = Number(
      this.configService.get<string>('OCR_DAEMON_INTERVAL_MINUTES') ?? 5,
    );
    return Number.isFinite(configuredValue) && configuredValue >= 1
      ? configuredValue
      : 5;
  }

  get defaultBatchSize(): number {
    const configuredValue = Number(
      this.configService.get<string>('OCR_DAEMON_BATCH_SIZE') ?? 20,
    );

    if (!Number.isFinite(configuredValue)) {
      return 20;
    }

    return Math.max(1, Math.min(200, Math.floor(configuredValue)));
  }

  private async processDocument(
    runId: string,
    document: DocumentToProcess,
    defaultPrompt: PromptRow | null,
  ): Promise<ProcessResult> {
    const contextBase = {
      runId,
      documentId: document.id,
      companyId: document.emp_id,
    };

    try {
      this.stepLogger.info('Iniciando procesamiento de documento.', {
        ...contextBase,
        step: 'doc.start',
      });

      if (!document.doc_documento) {
        await this.safeSetDocumentStatus(
          document.id,
          'OCR_SIN_ARCHIVO',
          contextBase,
        );
        this.stepLogger.error('Documento sin contenido para OCR.', {
          ...contextBase,
          step: 'doc.validate_content',
        });
        return {
          status: 'skipped',
          partnerCreated: false,
        };
      }

      const companyPrompt =
        await this.daemonRepository.findActivePromptByCompany(document.emp_id);
      if (!companyPrompt) {
        await this.safeSetDocumentStatus(
          document.id,
          'OCR_NO_PROMPT',
          contextBase,
        );
        this.stepLogger.error(
          'No existe prompt activo para la empresa del documento.',
          {
            ...contextBase,
            step: 'doc.prompt',
          },
        );
        return {
          status: 'skipped',
          partnerCreated: false,
        };
      }

      const composedPrompt = this.composePrompt(
        companyPrompt.prompt,
        defaultPrompt,
      );
      const parsedDocument = await this.parseDocumentData(
        document.doc_documento,
      );

      this.stepLogger.debug('Documento preparado para envío a Gemini.', {
        ...contextBase,
        step: 'doc.prepare',
        metadata: {
          source: parsedDocument.source,
          mimeType: parsedDocument.mimeType,
          base64Length: parsedDocument.base64Data.length,
          promptId: companyPrompt.id,
        },
      });

      const rawOcrData = await this.geminiClient.extractStructuredData({
        prompt: composedPrompt,
        mimeType: parsedDocument.mimeType,
        base64Data: parsedDocument.base64Data,
      });

      this.stepLogger.debug('Respuesta OCR recibida de Gemini.', {
        ...contextBase,
        step: 'doc.gemini_response',
        metadata: {
          responseKeys: Object.keys(rawOcrData),
        },
      });

      const normalizedData = normalizeOcrPayload(rawOcrData);

      if (!normalizedData.doc_numero || !normalizedData.doc_fecha_emision) {
        await this.safeSetDocumentStatus(
          document.id,
          'OCR_INCOMPLETO',
          contextBase,
        );
        this.stepLogger.error(
          'OCR incompleto: faltan campos mínimos (doc_numero o doc_fecha_emision).',
          {
            ...contextBase,
            step: 'doc.validate_output',
            metadata: {
              doc_numero: normalizedData.doc_numero,
              doc_fecha_emision: normalizedData.doc_fecha_emision,
            },
          },
        );

        return {
          status: 'failed',
          partnerCreated: false,
        };
      }

      const persistResult =
        await this.daemonRepository.persistProcessedDocument(
          document.id,
          normalizedData,
        );

      this.stepLogger.info(
        'Documento actualizado correctamente en base de datos.',
        {
          ...contextBase,
          step: 'doc.persist',
          metadata: {
            partnerCreated: persistResult.partnerCreated,
            partnerId: persistResult.partnerId,
            doc_numero: normalizedData.doc_numero,
            doc_fecha_emision: normalizedData.doc_fecha_emision,
          },
        },
      );

      return {
        status: 'updated',
        partnerCreated: persistResult.partnerCreated,
      };
    } catch (error) {
      await this.safeSetDocumentStatus(document.id, 'OCR_ERROR', contextBase);
      this.stepLogger.error(
        'Error procesando documento.',
        {
          ...contextBase,
          step: 'doc.error',
        },
        error,
      );

      return {
        status: 'failed',
        partnerCreated: false,
      };
    }
  }

  private async safeSetDocumentStatus(
    documentId: number,
    status: string,
    context: { runId: string; documentId: number; companyId: number },
  ): Promise<void> {
    try {
      await this.daemonRepository.setDocumentStatus(documentId, status);
    } catch (error) {
      this.stepLogger.warn('No se pudo actualizar doc_estado tras error.', {
        ...context,
        step: 'doc.set_status_error',
        metadata: {
          attemptedStatus: status,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private composePrompt(
    companyPrompt: string,
    defaultPrompt: PromptRow | null,
  ): string {
    const strictOutputInstructions = `
INSTRUCCIONES OBLIGATORIAS DE SALIDA:
- Responde exclusivamente con JSON válido.
- No incluyas markdown, ni explicaciones, ni texto adicional.
- Usa exactamente estos campos:
  sn_ruc, sn_name, doc_numero, doc_fecha_emision, doc_timbrado, doc_vence_timbrado, doc_periodo, doc_cdc, doc_monto_10, doc_iva_10, doc_monto_5, doc_iva_5, doc_monto_exento, doc_monto_total.
`;

    if (!defaultPrompt) {
      return `${companyPrompt}\n\n${strictOutputInstructions}`;
    }

    return `${companyPrompt}\n\n${strictOutputInstructions}\nReferencia adicional:\n${defaultPrompt.prompt}`;
  }

  private async parseDocumentData(
    documentValue: string,
  ): Promise<ParsedDocumentData> {
    const trimmed = documentValue.trim();

    const dataUriMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
    if (dataUriMatch) {
      const [, mimeType, data] = dataUriMatch;
      return {
        mimeType,
        base64Data: sanitizeBase64(data),
        source: 'data_uri',
      };
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const response = await fetch(trimmed);
      if (!response.ok) {
        throw new Error(
          `No se pudo descargar documento URL (${response.status}).`,
        );
      }

      const mimeType =
        response.headers.get('content-type') ?? 'application/pdf';
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        mimeType: mimeType.split(';')[0],
        base64Data: buffer.toString('base64'),
        source: 'url',
      };
    }

    if (await this.pathExists(trimmed)) {
      const buffer = await readFile(trimmed);
      return {
        mimeType: guessMimeTypeFromPath(trimmed),
        base64Data: buffer.toString('base64'),
        source: 'file_path',
      };
    }

    if (looksLikeBase64(trimmed)) {
      return {
        mimeType: 'application/pdf',
        base64Data: sanitizeBase64(trimmed),
        source: 'base64_text',
      };
    }

    throw new Error('Formato de doc_documento no soportado.');
  }

  private async pathExists(pathValue: string): Promise<boolean> {
    try {
      await access(pathValue, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private resolveBatchLimit(limitOverride: number | undefined): number {
    if (typeof limitOverride === 'number' && Number.isFinite(limitOverride)) {
      return Math.max(1, Math.min(200, Math.floor(limitOverride)));
    }

    return this.defaultBatchSize;
  }

  private async loadDefaultPrompt(runId: string): Promise<PromptRow | null> {
    const promptId = Number(
      this.configService.get<string>('OCR_DEFAULT_PROMPT_ID') ?? 1,
    );
    if (!Number.isFinite(promptId) || promptId <= 0) {
      return null;
    }

    const prompt = await this.daemonRepository.findPromptById(promptId);
    if (!prompt) {
      this.stepLogger.warn(
        'No se encontró el prompt base por ID configurado.',
        {
          runId,
          step: 'cycle.default_prompt',
          metadata: {
            promptId,
          },
        },
      );
    }

    return prompt;
  }

  private emptySummary(
    trigger: 'startup' | 'schedule' | 'manual',
  ): DaemonCycleSummary {
    return {
      runId: randomUUID(),
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      totalFound: 0,
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      partnersCreated: 0,
    };
  }
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 32) {
    return false;
  }

  return /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function sanitizeBase64(value: string): string {
  return value.replace(/\s/g, '');
}

function guessMimeTypeFromPath(pathValue: string): string {
  const extension = extname(pathValue).toLowerCase();
  if (extension === '.pdf') {
    return 'application/pdf';
  }
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }

  return 'application/octet-stream';
}
