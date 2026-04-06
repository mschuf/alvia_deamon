import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ExtractRequest {
  prompt: string;
  mimeType: string;
  base64Data: string;
}

@Injectable()
export class GeminiClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.apiUrl =
      this.configService.get<string>('GEMINI_API_URL') ??
      'https://generativelanguage.googleapis.com/v1beta';
    this.apiKey = this.configService.getOrThrow<string>('GEMINI_API_KEY');
    this.model =
      this.configService.get<string>('GEMINI_MODEL') ?? 'gemini-3.1-flash';
    this.timeoutMs = Number(
      this.configService.get<string>('GEMINI_TIMEOUT_MS') ?? 60000,
    );
  }

  async extractStructuredData({
    prompt,
    mimeType,
    base64Data,
  }: ExtractRequest): Promise<Record<string, unknown>> {
    const endpoint = `${this.apiUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: prompt,
                },
                {
                  inlineData: {
                    mimeType,
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
          },
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Gemini respondió ${response.status}: ${errorBody.slice(0, 500)}`,
        );
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const text = this.extractTextFromResponse(payload);
      return this.parseJson(text);
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractTextFromResponse(payload: Record<string, unknown>): string {
    const candidates = payload.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('Gemini no devolvió candidatos.');
    }

    const firstCandidate = candidates[0] as Record<string, unknown>;
    const content = firstCandidate.content as
      | Record<string, unknown>
      | undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('Gemini no devolvió partes de contenido.');
    }

    const text = parts
      .map((part) => (part as Record<string, unknown>).text)
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      .join('\n')
      .trim();

    if (!text) {
      throw new Error('Gemini devolvió contenido vacío.');
    }

    return text;
  }

  private parseJson(text: string): Record<string, unknown> {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = cleaned.slice(firstBrace, lastBrace + 1);
        return JSON.parse(candidate) as Record<string, unknown>;
      }

      throw new Error(
        `La respuesta no es JSON válido: ${cleaned.slice(0, 500)}`,
      );
    }
  }
}
