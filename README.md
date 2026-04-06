# ALVIA Daemon (NestJS)

Daemon OCR para ALVIA que:

- Busca documentos pendientes en `public.v_documentos_a_procesar`.
- Obtiene prompt activo por empresa desde `public.lk_prompts`.
- Envía el documento a Gemini OCR.
- Normaliza la respuesta JSON.
- Actualiza `public.lk_documentos`.
- Si el RUC del proveedor no existe en `public.lk_socios_negocios`, crea un registro básico.
- Registra todo paso a paso en consola y archivo de log.

## Flujo funcional

1. Scheduler ejecuta el daemon cada `OCR_DAEMON_INTERVAL_MINUTES`.
2. Se consultan documentos pendientes:
   - `doc_numero` nulo/vacío.
   - `doc_fecha_emision` nula.
3. Por cada documento:
   - Busca prompt activo por `emp_id`.
   - Si no hay prompt: `doc_estado = OCR_NO_PROMPT` y log de error.
   - Parsea `doc_documento` (soporta `data:...base64`, URL, path local o base64 directo).
   - Envía OCR a Gemini.
   - Valida y normaliza salida.
   - Si faltan campos mínimos (`doc_numero` o `doc_fecha_emision`): `doc_estado = OCR_INCOMPLETO`.
   - Si está completo:
     - Upsert básico de socio de negocio por `sn_id_fiscal`.
     - Update de `lk_documentos` con los datos OCR.
     - `doc_estado = OCR_PROCESADO`.

## Endpoints

- `GET /`
  - Información básica del servicio.
- `GET /daemon/health`
  - Estado actual del daemon y resumen de última corrida.
- `POST /daemon/run`
  - Ejecuta una corrida manual.
  - Body opcional:
    ```json
    {
      "limit": 20
    }
    ```
  - Si `DAEMON_CONTROL_TOKEN` está definido, requiere header `x-daemon-token`.

## Swagger

- URL: `http://localhost:<PORT>/api`

## Variables de entorno

Usar `.env.example` como base.

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

# Gemini OCR
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.1-flash
GEMINI_API_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_TIMEOUT_MS=60000

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

## Logs paso a paso

Los logs se escriben en:

- Consola.
- Archivo diario: `logs/daemon-YYYY-MM-DD.log`.

Formato JSON por línea, con contexto:

- `runId`
- `documentId`
- `companyId`
- `step`
- `message`
- `metadata`

Ejemplos de `step`:

- `cycle.start`
- `cycle.fetch_pending`
- `doc.start`
- `doc.prompt`
- `doc.prepare`
- `doc.gemini_response`
- `doc.persist`
- `doc.error`
- `cycle.finish`

## Instalación y ejecución

```bash
npm install
npm run start:dev
```

Build:

```bash
npm run build
```

## Estados de documento usados por el daemon

- `OCR_PROCESADO`
- `OCR_NO_PROMPT`
- `OCR_SIN_ARCHIVO`
- `OCR_INCOMPLETO`
- `OCR_ERROR`

## Notas de diseño

- El daemon usa `v_documentos_a_procesar` para seleccionar pendientes.
- El campo fiscal de socio de negocio se maneja con `sn_id_fiscal`.
- El insert en `lk_socios_negocios` es básico:
  - `sn_nombre`
  - `sn_id_fiscal`
  - `sn_tipo = 'P'`
  - `sn_activo = true`
- Se consulta `OCR_DEFAULT_PROMPT_ID` (por defecto `1`) como referencia adicional al prompt por empresa.

## Git inicial

Proyecto preparado para repositorio independiente en `alvia_daemon/`:

```bash
git init
```

