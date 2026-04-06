import { PreparedOcrPayload } from './daemon.types';

const LEGACY_KEY_ALIASES: Record<string, string> = {
  sn_ruc: 'sn_id_fiscal',
  ruc: 'sn_id_fiscal',
  ruc_proveedor: 'sn_id_fiscal',
  numero_documento: 'doc_numero',
  numero_factura: 'doc_numero',
  fecha_emision: 'doc_fecha_emision',
  timbrado: 'doc_timbrado',
  vence_timbrado: 'doc_vence_timbrado',
  periodo: 'doc_periodo',
  cdc: 'doc_cdc',
  monto_10: 'doc_monto_10',
  iva_10: 'doc_iva_10',
  monto_5: 'doc_monto_5',
  iva_5: 'doc_iva_5',
  monto_exento: 'doc_monto_exento',
  monto_total: 'doc_monto_total',
};

const PROVIDER_NAME_KEYS = [
  'sn_name',
  'sn_nombre',
  'proveedor',
  'nombre_proveedor',
];

const PROVIDER_FISCAL_ID_KEYS = [
  'sn_id_fiscal',
  'sn_ruc',
  'ruc',
  'ruc_proveedor',
];

export function normalizeOcrPayload(
  rawPayload: Record<string, unknown>,
  updatableColumns: Set<string>,
): PreparedOcrPayload {
  const payload = unwrapPayload(rawPayload);
  const documentUpdates: Record<string, unknown> = {};
  const ignoredFields: string[] = [];
  const aliasesApplied: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(payload)) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }

    if (value === undefined) {
      continue;
    }

    const resolvedColumn = resolveDocumentColumnKey(key, updatableColumns);
    if (!resolvedColumn) {
      ignoredFields.push(key);
      continue;
    }

    // No pisar el valor real si ya vino con el nombre canonico.
    if (
      key !== resolvedColumn &&
      Object.prototype.hasOwnProperty.call(documentUpdates, resolvedColumn)
    ) {
      continue;
    }

    documentUpdates[resolvedColumn] = value;

    if (key !== resolvedColumn) {
      aliasesApplied[key] = resolvedColumn;
    }
  }

  const providerFiscalId =
    toNonEmptyString(documentUpdates.sn_id_fiscal) ??
    firstNonEmptyFromPayload(payload, PROVIDER_FISCAL_ID_KEYS);

  const providerName = firstNonEmptyFromPayload(payload, PROVIDER_NAME_KEYS);

  return {
    documentUpdates,
    providerFiscalId,
    providerName,
    ignoredFields,
    aliasesApplied,
  };
}

function unwrapPayload(
  rawPayload: Record<string, unknown>,
): Record<string, unknown> {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return {};
  }

  const direct = asRecord(rawPayload);
  if (!direct || Object.keys(direct).length === 0) {
    return {};
  }

  const nestedData = tryParseNestedRecord(direct.data);
  if (nestedData) {
    return nestedData;
  }

  const nestedResult = tryParseNestedRecord(direct.result);
  if (nestedResult) {
    return nestedResult;
  }

  return direct;
}

function tryParseNestedRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return asRecord(parsed);
    } catch {
      return null;
    }
  }

  return asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveDocumentColumnKey(
  key: string,
  updatableColumns: Set<string>,
): string | null {
  if (updatableColumns.has(key)) {
    return key;
  }

  const legacyAlias = LEGACY_KEY_ALIASES[key];
  if (legacyAlias && updatableColumns.has(legacyAlias)) {
    return legacyAlias;
  }

  return null;
}

function firstNonEmptyFromPayload(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = toNonEmptyString(payload[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return null;
}
