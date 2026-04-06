import { NormalizedOcrData } from './daemon.types';

const DEFAULT_RUC = '0000000-0';
const DEFAULT_PROVIDER_NAME = 'PROVEEDOR SIN NOMBRE';

export function normalizeOcrPayload(
  payload: Record<string, unknown>,
): NormalizedOcrData {
  const docFechaEmision = normalizeDate(
    firstValue(payload, ['doc_fecha_emision', 'fecha_emision']),
  );
  const docPeriodo =
    normalizePeriod(firstValue(payload, ['doc_periodo', 'periodo'])) ??
    derivePeriodFromDate(docFechaEmision);

  const normalized: NormalizedOcrData = {
    sn_ruc: normalizeRuc(
      firstString(payload, ['sn_ruc', 'ruc', 'ruc_proveedor']),
    ),
    sn_nombre:
      firstString(payload, [
        'sn_name',
        'sn_nombre',
        'proveedor',
        'nombre_proveedor',
      ]) ?? DEFAULT_PROVIDER_NAME,
    doc_numero:
      firstString(payload, [
        'doc_numero',
        'numero_documento',
        'numero_factura',
      ]) ?? null,
    doc_fecha_emision: docFechaEmision,
    doc_timbrado: normalizeTimbrado(
      firstValue(payload, ['doc_timbrado', 'timbrado']),
    ),
    doc_vence_timbrado: normalizeDate(
      firstValue(payload, ['doc_vence_timbrado', 'vence_timbrado']),
    ),
    doc_periodo: docPeriodo,
    doc_cdc: firstString(payload, ['doc_cdc', 'cdc']) ?? '',
    doc_monto_10: normalizeNumber(
      firstValue(payload, ['doc_monto_10', 'monto_10']),
    ),
    doc_iva_10: normalizeNumber(firstValue(payload, ['doc_iva_10', 'iva_10'])),
    doc_monto_5: normalizeNumber(
      firstValue(payload, ['doc_monto_5', 'monto_5']),
    ),
    doc_iva_5: normalizeNumber(firstValue(payload, ['doc_iva_5', 'iva_5'])),
    doc_monto_exento: normalizeNumber(
      firstValue(payload, ['doc_monto_exento', 'monto_exento']),
    ),
    doc_monto_total: normalizeNumber(
      firstValue(payload, ['doc_monto_total', 'monto_total']),
    ),
  };

  return normalized;
}

function firstValue(payload: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in payload && payload[key] != null) {
      return payload[key];
    }
  }

  return undefined;
}

function firstString(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  const value = firstValue(payload, keys);
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRuc(value: string | null): string {
  if (!value) {
    return DEFAULT_RUC;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.length < 2) {
    return DEFAULT_RUC;
  }

  const body = digits.slice(0, -1).slice(-7).padStart(7, '0');
  const verifier = digits.slice(-1);

  return `${body}-${verifier}`;
}

function normalizeDate(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    const slashDateMatch = trimmed.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (slashDateMatch) {
      const [, day, month, year] = slashDateMatch;
      return `${year}-${month}-${day}`;
    }

    const asDate = new Date(trimmed);
    if (!Number.isNaN(asDate.getTime())) {
      return asDate.toISOString().slice(0, 10);
    }
  }

  return null;
}

function normalizePeriod(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const primitiveValue = toPrimitiveString(value);
  if (!primitiveValue) {
    return null;
  }

  const str = primitiveValue.replace(/\D/g, '');
  if (/^\d{6}$/.test(str)) {
    return str;
  }

  return null;
}

function derivePeriodFromDate(date: string | null): string | null {
  if (!date) {
    return null;
  }

  return date.slice(0, 4) + date.slice(5, 7);
}

function normalizeTimbrado(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const primitiveValue = toPrimitiveString(value);
  if (!primitiveValue) {
    return null;
  }

  const cleaned = primitiveValue.trim().replace(/\D/g, '');
  if (!cleaned) {
    return null;
  }

  return cleaned;
}

function normalizeNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const sanitized = trimmed.replace(/[^\d,.-]/g, '');
    let normalized = sanitized;

    const hasDot = normalized.includes('.');
    const hasComma = normalized.includes(',');

    if (hasDot && hasComma) {
      if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
        normalized = normalized.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = normalized.replace(/,/g, '');
      }
    } else if (hasComma && !hasDot) {
      normalized = normalized.replace(',', '.');
    }

    const numeric = Number(normalized);
    if (Number.isNaN(numeric)) {
      return null;
    }

    return Number(numeric.toFixed(2));
  }

  return null;
}

function toPrimitiveString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return null;
}
