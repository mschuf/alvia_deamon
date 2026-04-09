import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { StepLoggerService } from '../logging/step-logger.service';
import { AlviaOcrClient } from './alvia-ocr.client';
import { DaemonRepository } from './daemon.repository';
import {
  DaemonCycleSummary,
  DocumentToProcess,
  PromptRow,
} from './daemon.types';
import { normalizeOcrPayload } from './ocr-normalizer';

interface RunCycleOptions {
  limit?: number;
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
    private readonly alviaOcrClient: AlviaOcrClient,
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
      this.stepLogger.warn('Se omite ciclo porque ya hay otro en ejecucion.', {
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
      const updatableColumns =
        await this.daemonRepository.getDocumentUpdatableColumns();
      const pendingDocuments =
        await this.daemonRepository.fetchPendingDocuments(limit);
      summary.totalFound = pendingDocuments.length;

      this.stepLogger.info('Documentos pendientes obtenidos.', {
        runId,
        step: 'cycle.fetch_pending',
        metadata: {
          count: pendingDocuments.length,
          limit,
          updatableColumnsCount: updatableColumns.size,
        },
      });

      for (const document of pendingDocuments) {
        summary.processed += 1;
        const result = await this.processDocument(
          runId,
          document,
          defaultPrompt,
          updatableColumns,
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
        'Token de control invalido para ejecucion manual del daemon.',
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
    updatableColumns: Set<string>,
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

      const promptText = companyPrompt?.prompt ?? null;

      if (!promptText && !defaultPrompt) {
        this.stepLogger.warn(
          'No existe prompt activo para la empresa ni prompt default. Se usara prompt hardcoded.',
          {
            ...contextBase,
            step: 'doc.prompt',
          },
        );
      } else if (!promptText) {
        this.stepLogger.info(
          'No existe prompt activo para la empresa. Se usara el prompt default.',
          {
            ...contextBase,
            step: 'doc.prompt',
          },
        );
      }

      const composedPrompt = this.composePrompt(
        promptText,
        defaultPrompt,
      );

      this.stepLogger.debug('Enviando documento a alvia_ocr.', {
        ...contextBase,
        step: 'doc.send_ocr',
        metadata: {
          documentLength: document.doc_documento.length,
          promptId: companyPrompt?.id ?? 'default',
        },
      });

      const rawOcrData = await this.alviaOcrClient.processDocument({
        documento: document.doc_documento,
        empresaId: document.emp_id,
        prompt: composedPrompt,
        documentId: document.id,
      });

      this.stepLogger.debug('Respuesta OCR recibida desde alvia_ocr.', {
        ...contextBase,
        step: 'doc.ocr_response',
        metadata: {
          responseKeys: Object.keys(rawOcrData),
        },
      });

      const normalizedData = normalizeOcrPayload(rawOcrData, updatableColumns);
      const updateFields = Object.keys(normalizedData.documentUpdates);

      if (updateFields.length === 0) {
        await this.safeSetDocumentStatus(
          document.id,
          'OCR_INCOMPLETO',
          contextBase,
        );
        this.stepLogger.error(
          'OCR sin campos validos para actualizar lk_documentos.',
          {
            ...contextBase,
            step: 'doc.validate_output',
            metadata: {
              ignoredFields: normalizedData.ignoredFields,
              responseKeys: Object.keys(rawOcrData),
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
            updatedFields: updateFields,
            providerFiscalId: normalizedData.providerFiscalId,
            aliasesApplied: normalizedData.aliasesApplied,
            ignoredFields: normalizedData.ignoredFields,
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

  private static readonly HARDCODED_DEFAULT_PROMPT = `Eres un experto en procesamiento de facturas paraguayas. Tu tarea es corregir errores de OCR y devolver datos estructurados en formato JSON que correspondan a la tabla lk_documentos.

REGLAS DE IVA:
- DIESEL/NAFTA/COMBUSTIBLE → doc_monto_exento
- "10%" o columna "10" → doc_monto_10 (y calcular doc_iva_10)
- "5%" o columna "5" → doc_monto_5 (y calcular doc_iva_5)
- Sin porcentaje explícito → doc_monto_exento

CÁLCULO DE IVA:
- doc_iva_10 = doc_monto_10 / 11
- doc_iva_5 = doc_monto_5 / 21
- doc_monto_total = doc_monto_10 + doc_monto_5 + doc_monto_exento

IMPORTANTE - TOTALES CONSOLIDADOS:
- NO incluir array de detalles/items
- Sumar TODOS los montos de la factura en los campos correspondientes
- Si hay múltiples items con IVA 10%, sumar todos en doc_monto_10
- Si hay múltiples items con IVA 5%, sumar todos en doc_monto_5
- Si hay múltiples items exentos, sumar todos en doc_monto_exento

RUC DEL PROVEEDOR:
- sn_ruc: RUC del emisor/proveedor de la factura
- sn_name: Nombre del emisor/proveedor de la factura
- Formato: #######-# (7 dígitos, guion, 1 dígito)
- Si NO se encuentra el RUC en la factura → usar "0000000-0"

FECHAS:
- doc_fecha_emision: formato YYYY-MM-DD
- doc_vence_timbrado: formato YYYY-MM-DD
- doc_periodo: formato YYYYMM (ejemplo: "202502" para febrero 2025)

NÚMERO DE FACTURA:
- doc_numero: formato completo "establecimiento-punto-número" (ejemplo: "004-001-0005551")

TIMBRADO:
- doc_timbrado: número de timbrado (8 dígitos)

CDC (para facturas electrónicas):
- doc_cdc: código de control de 44 caracteres si existe, sino vacío ""

MONEDA:
- PYG → sin decimales (números enteros)

ESTRUCTURA JSON A DEVOLVER (PLANA, SIN ARRAYS):
{
  "sn_id_fiscal": "80075646-0",
  "sn_name": "Comercial Villalba",
  "doc_numero": "004-001-0005551",
  "doc_fecha_emision": "2025-09-04",
  "doc_timbrado": 18181496,
  "doc_vence_timbrado": "2025-12-31",
  "doc_periodo": "202509",
  "doc_cdc": "",
  "doc_monto_10": 181818,
  "doc_iva_10": 18182,
  "doc_monto_5": 0,
  "doc_iva_5": 0,
  "doc_monto_exento": 0,
  "doc_monto_total": 200000
}

INSTRUCCIONES CRÍTICAS:
1. Devuelve ÚNICAMENTE JSON VÁLIDO
2. NO incluyas arrays como "detalles", "items" o "DocumentLines"
3. TODOS los montos deben estar consolidados en los campos principales
4. Sin explicaciones, sin texto adicional, sin markdown, sin comentarios
5. La estructura debe ser completamente PLANA (un solo nivel de objetos)
6. Incluye SOLAMENTE los campos mostrados en el ejemplo`;

  private composePrompt(
    companyPrompt: string | null,
    defaultPrompt: PromptRow | null,
  ): string {
    const strictOutputInstructions = `
INSTRUCCIONES OBLIGATORIAS DE SALIDA:
- Responde exclusivamente con JSON valido.
- No incluyas markdown, ni explicaciones, ni texto adicional.
- Usa nombres de campos que existan en la tabla lk_documentos.
- Si no detectas un dato, omite la clave (no inventes valores).
- Puedes incluir sn_name para indicar el nombre del proveedor cuando se deba crear el socio de negocio.
`;

    const effectivePrompt =
      companyPrompt ??
      defaultPrompt?.prompt ??
      OcrDaemonService.HARDCODED_DEFAULT_PROMPT;

    if (!companyPrompt && !defaultPrompt) {
      return `${effectivePrompt}\n\n${strictOutputInstructions}`;
    }

    if (!defaultPrompt) {
      return `${effectivePrompt}\n\n${strictOutputInstructions}`;
    }

    const referenceSection = companyPrompt
      ? `\nReferencia adicional:\n${defaultPrompt.prompt}`
      : '';

    return `${effectivePrompt}\n\n${strictOutputInstructions}${referenceSection}`;
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
        'No se encontro el prompt base por ID configurado.',
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
