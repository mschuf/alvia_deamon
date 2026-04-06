# ALVIA Daemon (NestJS)

`alvia_daemon` es el orquestador de OCR.
No ejecuta OCR ni habla con Gemini directamente.

Responsabilidades:

- Buscar pendientes en `public.v_documentos_a_procesar`.
- Buscar prompt activo por empresa en `public.lk_prompts`.
- Enviar a `alvia_ocr`:
  - `empresaId` (obligatorio),
  - `prompt`,
  - `documento` (`doc_documento` crudo).
- Recibir JSON OCR desde `alvia_ocr`.
- Normalizar datos y actualizar `public.lk_documentos`.
- Crear socio de negocio basico si no existe por `sn_id_fiscal`.
- Registrar cada paso en logs estructurados.

## Flujo

1. Scheduler ejecuta cada `OCR_DAEMON_INTERVAL_MINUTES`.
2. Lee pendientes desde la vista.
3. Por documento:
   - valida que exista `doc_documento`.
   - obtiene prompt activo de la empresa.
   - compone prompt final.
   - llama `POST {ALVIA_OCR_BASE_URL}/ocr/process-daemon`.
   - valida respuesta OCR minima.
   - actualiza `lk_documentos`.
   - inserta socio de negocio si el RUC no existe.

## Endpoints del daemon

- `GET /`
  - info base del servicio.
- `GET /daemon/health`
  - estado actual + ultimo resumen.
- `POST /daemon/run`
  - corrida manual opcional con `limit`.

Swagger:

- `http://localhost:<PORT>/api`

## Variables de entorno

```env
# Server
PORT=3010

# PostgreSQL
POSTGRES_HOST=172.19.0.201
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change_me
POSTGRES_DB=ALVIA_BACK
DB_SCHEMA=public
TYPEORM_LOGGING=false

# ALVIA OCR service (daemon delegates OCR here)
ALVIA_OCR_BASE_URL=http://localhost:3000
ALVIA_OCR_TIMEOUT_MS=120000
ALVIA_OCR_API_TOKEN=

# Daemon behavior
OCR_DAEMON_INTERVAL_MINUTES=5
OCR_DAEMON_BATCH_SIZE=20
OCR_DAEMON_RUN_ON_STARTUP=true
OCR_DEFAULT_PROMPT_ID=1

# Manual run security (optional)
DAEMON_CONTROL_TOKEN=

# Logging
LOG_LEVEL=debug
LOG_TO_FILE=true
LOG_DIR=logs
```

## Logs

Destino:

- consola
- `logs/daemon-YYYY-MM-DD.log`

Campos de contexto:

- `runId`
- `documentId`
- `companyId`
- `step`
- `metadata`

Pasos principales:

- `cycle.start`
- `cycle.fetch_pending`
- `doc.start`
- `doc.prompt`
- `doc.send_ocr`
- `doc.ocr_response`
- `doc.persist`
- `doc.error`
- `cycle.finish`

## Estados de documento

- `OCR_PROCESADO`
- `OCR_NO_PROMPT`
- `OCR_SIN_ARCHIVO`
- `OCR_INCOMPLETO`
- `OCR_ERROR`

## Run

```bash
npm install
npm run start:dev
```

Build:

```bash
npm run build
```

