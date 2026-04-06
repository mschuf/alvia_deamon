export interface DocumentToProcess {
  id: number;
  emp_id: number;
  doc_documento: string | null;
}

export interface PromptRow {
  id: number;
  lk_empresa_id: number;
  prompt: string;
  active: boolean;
}

export interface NormalizedOcrData {
  sn_ruc: string;
  sn_nombre: string;
  doc_numero: string | null;
  doc_fecha_emision: string | null;
  doc_timbrado: string | null;
  doc_vence_timbrado: string | null;
  doc_periodo: string | null;
  doc_cdc: string | null;
  doc_monto_10: number | null;
  doc_iva_10: number | null;
  doc_monto_5: number | null;
  doc_iva_5: number | null;
  doc_monto_exento: number | null;
  doc_monto_total: number | null;
}

export interface DaemonCycleSummary {
  runId: string;
  trigger: 'startup' | 'schedule' | 'manual';
  startedAt: string;
  finishedAt?: string;
  totalFound: number;
  processed: number;
  updated: number;
  failed: number;
  skipped: number;
  partnersCreated: number;
}
