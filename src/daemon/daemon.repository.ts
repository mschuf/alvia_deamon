import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import {
  DocumentToProcess,
  PreparedOcrPayload,
  PromptRow,
} from './daemon.types';

interface PersistResult {
  partnerCreated: boolean;
  partnerId: number | null;
}

interface IdRow {
  sn_id: unknown;
}

interface ColumnNameRow {
  column_name: string;
}

@Injectable()
export class DaemonRepository {
  private readonly schema: string;
  private readonly columnsCacheMs: number;
  private documentColumnsCache: string[] = [];
  private documentColumnsCacheAt = 0;

  private readonly protectedColumns = new Set<string>([
    'id',
    'emp_id',
    'usr_id',
    'doc_documento',
    'doc_estado',
    'doc_fecha_carga',
    'fecha_creacion',
    'fecha_modificacion',
  ]);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    const configuredSchema =
      this.configService.get<string>('DB_SCHEMA') ?? 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(configuredSchema)) {
      throw new Error(`DB_SCHEMA inválido: ${configuredSchema}`);
    }
    this.schema = configuredSchema;

    const configuredCacheMs = Number(
      this.configService.get<string>('OCR_DOCUMENT_COLUMNS_CACHE_MS') ??
        300000,
    );
    this.columnsCacheMs =
      Number.isFinite(configuredCacheMs) && configuredCacheMs >= 0
        ? Math.floor(configuredCacheMs)
        : 300000;
  }

  async fetchPendingDocuments(limit: number): Promise<DocumentToProcess[]> {
    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT id, emp_id, doc_documento
      FROM ${this.schema}.v_documentos_a_procesar
      ORDER BY id ASC
      LIMIT $1
      `,
      [limit],
    );

    return this.asArray<DocumentToProcess>(rawRows);
  }

  async findActivePromptByCompany(
    companyId: number,
  ): Promise<PromptRow | null> {
    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT id, lk_empresa_id, prompt, active
      FROM ${this.schema}.lk_prompts
      WHERE active = true
        AND lk_empresa_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [companyId],
    );

    const rows = this.asArray<PromptRow>(rawRows);
    return rows[0] ?? null;
  }

  async findPromptById(promptId: number): Promise<PromptRow | null> {
    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT id, lk_empresa_id, prompt, active
      FROM ${this.schema}.lk_prompts
      WHERE id = $1
      LIMIT 1
      `,
      [promptId],
    );

    const rows = this.asArray<PromptRow>(rawRows);
    return rows[0] ?? null;
  }

  async getDocumentUpdatableColumns(): Promise<Set<string>> {
    const now = Date.now();
    const canReuseCache =
      this.documentColumnsCache.length > 0 &&
      now - this.documentColumnsCacheAt <= this.columnsCacheMs;

    if (canReuseCache) {
      return new Set(this.documentColumnsCache);
    }

    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'lk_documentos'
      ORDER BY ordinal_position ASC
      `,
      [this.schema],
    );
    const rows = this.asArray<ColumnNameRow>(rawRows);

    const columns = rows
      .map((row) => String(row.column_name || '').trim())
      .filter(
        (columnName) =>
          columnName.length > 0 && !this.protectedColumns.has(columnName),
      );

    this.documentColumnsCache = columns;
    this.documentColumnsCacheAt = now;

    return new Set(columns);
  }

  async persistProcessedDocument(
    documentId: number,
    ocrData: PreparedOcrPayload,
  ): Promise<PersistResult> {
    return this.dataSource.transaction(async (manager) => {
      const updateEntries = Object.entries(ocrData.documentUpdates).filter(
        ([, value]) => value !== undefined,
      );

      if (updateEntries.length === 0) {
        throw new Error('No hay campos OCR validos para actualizar.');
      }

      const businessPartner = await this.ensureBusinessPartner(
        manager,
        ocrData.providerFiscalId,
        ocrData.providerName,
      );

      const assignments: string[] = [];
      const values: unknown[] = [];

      for (const [columnName, value] of updateEntries) {
        values.push(value);
        assignments.push(
          `${this.quoteIdentifier(columnName)} = $${values.length}`,
        );
      }

      assignments.push(`doc_estado = 'OCR_PROCESADO'`);
      assignments.push(`fecha_modificacion = NOW()`);
      values.push(documentId);

      const updatedRawRows: unknown = await manager.query(
        `
        UPDATE ${this.schema}.lk_documentos
        SET ${assignments.join(', ')}
        WHERE id = $${values.length}
        RETURNING id
        `,
        values,
      );
      const updatedRows = this.asArray<{ id: unknown }>(updatedRawRows);

      if (updatedRows.length === 0) {
        throw new Error(`No existe lk_documentos.id=${documentId}`);
      }

      return businessPartner;
    });
  }

  async setDocumentStatus(documentId: number, status: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE ${this.schema}.lk_documentos
      SET doc_estado = $1,
          fecha_modificacion = NOW()
      WHERE id = $2
      `,
      [status, documentId],
    );
  }

  private async ensureBusinessPartner(
    manager: EntityManager,
    fiscalId: string | null,
    providerName: string | null,
  ): Promise<PersistResult> {
    const normalizedFiscalId = (fiscalId ?? '').trim();
    if (!normalizedFiscalId) {
      return {
        partnerCreated: false,
        partnerId: null,
      };
    }

    const existingRawRows: unknown = await manager.query(
      `
      SELECT sn_id
      FROM ${this.schema}.lk_socios_negocios
      WHERE sn_id_fiscal = $1
      LIMIT 1
      `,
      [normalizedFiscalId],
    );
    const existingRows = this.asArray<IdRow>(existingRawRows);

    const existingPartnerId = this.toNumericId(existingRows[0]?.sn_id);
    if (existingPartnerId !== null) {
      return {
        partnerCreated: false,
        partnerId: existingPartnerId,
      };
    }

    const insertedRawRows: unknown = await manager.query(
      `
      INSERT INTO ${this.schema}.lk_socios_negocios
      (
        sn_nombre,
        sn_id_fiscal,
        sn_tipo,
        sn_activo,
        sn_fecha_creacion,
        sn_fecha_modificacion
      )
      VALUES
      (
        $1,
        $2,
        'P',
        true,
        NOW(),
        NOW()
      )
      RETURNING sn_id
      `,
      [this.resolveProviderName(providerName, normalizedFiscalId), normalizedFiscalId],
    );
    const insertedRows = this.asArray<IdRow>(insertedRawRows);
    const insertedPartnerId = this.toNumericId(insertedRows[0]?.sn_id);

    return {
      partnerCreated: true,
      partnerId: insertedPartnerId,
    };
  }

  private asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  private resolveProviderName(
    providerName: string | null,
    fallbackFiscalId: string,
  ): string {
    const cleanedName = (providerName ?? '').trim();
    return cleanedName.length > 0 ? cleanedName : fallbackFiscalId;
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private toNumericId(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }
}
