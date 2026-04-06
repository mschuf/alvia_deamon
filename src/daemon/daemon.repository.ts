import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import {
  DocumentToProcess,
  NormalizedOcrData,
  PromptRow,
} from './daemon.types';

interface PersistResult {
  partnerCreated: boolean;
  partnerId: number | null;
}

interface IdRow {
  sn_id: unknown;
}

@Injectable()
export class DaemonRepository {
  private readonly schema: string;

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

  async persistProcessedDocument(
    documentId: number,
    ocrData: NormalizedOcrData,
  ): Promise<PersistResult> {
    return this.dataSource.transaction(async (manager) => {
      const businessPartner = await this.ensureBusinessPartner(
        manager,
        ocrData.sn_ruc,
        ocrData.sn_nombre,
      );

      await manager.query(
        `
        UPDATE ${this.schema}.lk_documentos
        SET sn_id_fiscal = $1,
            doc_numero = $2,
            doc_fecha_emision = $3,
            doc_timbrado = $4,
            doc_vence_timbrado = $5,
            doc_periodo = $6,
            doc_cdc = $7,
            doc_monto_10 = $8,
            doc_iva_10 = $9,
            doc_monto_5 = $10,
            doc_iva_5 = $11,
            doc_monto_exento = $12,
            doc_monto_total = $13,
            doc_estado = 'OCR_PROCESADO',
            fecha_modificacion = NOW()
        WHERE id = $14
        `,
        [
          ocrData.sn_ruc,
          ocrData.doc_numero,
          ocrData.doc_fecha_emision,
          ocrData.doc_timbrado,
          ocrData.doc_vence_timbrado,
          ocrData.doc_periodo,
          ocrData.doc_cdc,
          ocrData.doc_monto_10,
          ocrData.doc_iva_10,
          ocrData.doc_monto_5,
          ocrData.doc_iva_5,
          ocrData.doc_monto_exento,
          ocrData.doc_monto_total,
          documentId,
        ],
      );

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
    ruc: string,
    providerName: string,
  ): Promise<PersistResult> {
    if (ruc === '0000000-0') {
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
      [ruc],
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
      [providerName, ruc],
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
