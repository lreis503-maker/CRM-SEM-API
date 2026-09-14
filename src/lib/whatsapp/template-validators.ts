/**
 * Pure validators for message templates, run BEFORE the Meta submit
 * call so a misconfigured template fails at save time (with a specific
 * field-level error) rather than at the Meta API boundary (where the
 * error is a generic 400 + opaque rejection_reason hours later).
 *
 * Every validator throws `Error(message)` — callers catch and surface
 * to the UI. Caps follow Meta's published limits for the Cloud API
 * template surface (v21.0):
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * Per-element button validation lives here rather than as a JSONB CHECK
 * because Postgres CHECK constraints can't contain subqueries, and
 * generic CHECK violations don't give users an actionable error
 * ("button #3 has no `text`" beats "constraint violated").
 */

import type {
  MessageTemplate,
  TemplateButton,
  TemplateSampleValues,
} from '@/types';

export const TEMPLATE_LIMITS = {
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
  buttonTextMaxLength: 25,
  maxButtonsTotal: 10,
  maxUrlButtons: 2,
  maxPhoneButtons: 1,
  maxCopyCodeButtons: 1,
  /** Meta: lowercase a-z, digits, underscore. Up to 512 chars. */
  nameRegex: /^[a-z0-9_]{1,512}$/,
} as const;

export interface TemplatePayload {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  header_type?: MessageTemplate['header_type'];
  header_content?: string;
  header_media_url?: string;
  header_handle?: string;
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  sample_values?: TemplateSampleValues;
}

export function validateTemplateName(name: string): void {
  if (!name) throw new Error("O nome do modelo é obrigatório.");
  if (!TEMPLATE_LIMITS.nameRegex.test(name)) {
    throw new Error(
      "O nome do modelo deve conter apenas letras minúsculas, números e sublinhados, de 1 a 512 caracteres.",
    );
  }
}

/**
 * Extract sorted, deduplicated {{N}} indices from a string. Returns
 * `[1, 2, 4]` for `"Hi {{1}} {{2}}, item {{4}}"`.
 */
export function extractVariableIndices(text: string): number[] {
  const matches = text.matchAll(/\{\{(\d+)\}\}/g);
  const set = new Set<number>();
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Meta requires contiguous, 1-indexed variables. `{{1}} {{3}}` is
 * invalid — it must be `{{1}} {{2}}`.
 */
function assertContiguous(indices: number[], where: string): void {
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i + 1) {
      throw new Error(
        `${where}: as variáveis devem ser consecutivas a partir de {{1}}. Encontradas: ${indices
          .map((n) => `{{${n}}}`)
          .join(', ')}.`,
      );
    }
  }
}

export function validateBody(bodyText: string): number[] {
  if (!bodyText.trim()) throw new Error("O texto da mensagem é obrigatório.");
  if (bodyText.length > TEMPLATE_LIMITS.bodyMaxLength) {
    throw new Error(
      `O texto da mensagem excede ${TEMPLATE_LIMITS.bodyMaxLength} caracteres (informados: ${bodyText.length}).`,
    );
  }
  const indices = extractVariableIndices(bodyText);
  assertContiguous(indices, 'Body');
  return indices;
}

export function validateFooter(footerText: string | undefined): void {
  if (!footerText) return;
  if (footerText.length > TEMPLATE_LIMITS.footerMaxLength) {
    throw new Error(
      `O texto do rodapé excede ${TEMPLATE_LIMITS.footerMaxLength} caracteres (informados: ${footerText.length}).`,
    );
  }
  if (extractVariableIndices(footerText).length > 0) {
    throw new Error("O rodapé não pode conter variáveis {{N}}, conforme a regra da Meta.");
  }
}

export interface HeaderValidationResult {
  /** number of {{N}} placeholders in a TEXT header — 0 or 1. */
  variableCount: number;
}

export function validateHeader(
  payload: Pick<
    TemplatePayload,
    'header_type' | 'header_content' | 'header_media_url' | 'header_handle'
  >,
): HeaderValidationResult {
  const { header_type, header_content, header_media_url, header_handle } = payload;
  if (!header_type) return { variableCount: 0 };

  if (header_type === 'text') {
    if (!header_content || !header_content.trim()) {
      throw new Error("O cabeçalho de texto exige header_content.");
    }
    if (header_content.length > TEMPLATE_LIMITS.headerTextMaxLength) {
      throw new Error(
        `O texto do cabeçalho excede ${TEMPLATE_LIMITS.headerTextMaxLength} caracteres (informados: ${header_content.length}).`,
      );
    }
    const indices = extractVariableIndices(header_content);
    if (indices.length > 1) {
      throw new Error(
        `O cabeçalho de texto permite no máximo uma variável. Encontradas: ${indices.length} (regra da Meta).`,
      );
    }
    if (indices.length === 1 && indices[0] !== 1) {
      throw new Error("A variável do cabeçalho de texto deve ser {{1}}, conforme a regra da Meta.");
    }
    return { variableCount: indices.length };
  }

  // image / video / document need either a public URL or a Resumable
  // Upload handle. Either one — Meta accepts both example forms.
  if (!header_media_url && !header_handle) {
    throw new Error(
      `${header_type}: o cabeçalho exige uma URL pública de exemplo (header_media_url) ou um identificador de envio retomável (header_handle).`,
    );
  }
  if (header_media_url) {
    try {
      const u = new URL(header_media_url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error("header_media_url deve usar http ou https.");
      }
    } catch {
      throw new Error("header_media_url deve ser uma URL válida.");
    }
  }
  return { variableCount: 0 };
}

function countButtonsByType(
  buttons: TemplateButton[],
): Record<TemplateButton['type'], number> {
  const counts: Record<TemplateButton['type'], number> = {
    QUICK_REPLY: 0,
    URL: 0,
    PHONE_NUMBER: 0,
    COPY_CODE: 0,
  };
  for (const b of buttons) counts[b.type]++;
  return counts;
}

export function validateButtons(buttons: TemplateButton[] | undefined): void {
  if (!buttons || buttons.length === 0) return;
  if (buttons.length > TEMPLATE_LIMITS.maxButtonsTotal) {
    throw new Error(
      `Os modelos podem ter no máximo ${TEMPLATE_LIMITS.maxButtonsTotal} botões (informados: ${buttons.length}).`,
    );
  }

  const counts = countButtonsByType(buttons);
  if (counts.URL > TEMPLATE_LIMITS.maxUrlButtons) {
    throw new Error(
      `São permitidos no máximo ${TEMPLATE_LIMITS.maxUrlButtons} botões de URL (informados: ${counts.URL}).`,
    );
  }
  if (counts.PHONE_NUMBER > TEMPLATE_LIMITS.maxPhoneButtons) {
    throw new Error(
      `São permitidos no máximo ${TEMPLATE_LIMITS.maxPhoneButtons} botões de telefone (informados: ${counts.PHONE_NUMBER}).`,
    );
  }
  if (counts.COPY_CODE > TEMPLATE_LIMITS.maxCopyCodeButtons) {
    throw new Error(
      `São permitidos no máximo ${TEMPLATE_LIMITS.maxCopyCodeButtons} botões de copiar código (informados: ${counts.COPY_CODE}).`,
    );
  }

  // Meta rule: QUICK_REPLY buttons must be contiguous — they can't be
  // interleaved with CTA buttons. Easiest check: walk the array; once
  // we leave the QUICK_REPLY block, we must not see another.
  let sawNonQR = false;
  for (const b of buttons) {
    if (b.type === 'QUICK_REPLY') {
      if (sawNonQR) {
        throw new Error(
          "Agrupe os botões de resposta rápida no início, sem intercalá-los com botões de URL, telefone ou copiar código.",
        );
      }
    } else {
      sawNonQR = true;
    }
  }

  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    if (!b.text?.trim()) {
      throw new Error(`Botão nº ${i + 1} (${b.type}) está sem texto.`);
    }
    if (b.text.length > TEMPLATE_LIMITS.buttonTextMaxLength) {
      throw new Error(
        `Botão nº ${i + 1}: o texto excede ${TEMPLATE_LIMITS.buttonTextMaxLength} caracteres.`,
      );
    }
    switch (b.type) {
      case 'URL': {
        if (!b.url?.trim()) {
          throw new Error(`Botão de URL nº ${i + 1} está sem URL.`);
        }
        try {
          new URL(b.url);
        } catch {
          throw new Error(`Botão de URL nº ${i + 1} tem uma URL inválida.`);
        }
        const urlVars = extractVariableIndices(b.url);
        if (urlVars.length > 1) {
          throw new Error(
            `Botão de URL nº ${i + 1} pode conter no máximo uma variável, conforme a regra da Meta.`,
          );
        }
        if (urlVars.length === 1) {
          if (urlVars[0] !== 1) {
            throw new Error(
              `Botão de URL nº ${i + 1}: a variável deve ser {{1}}, conforme a regra da Meta.`,
            );
          }
          if (!b.example?.trim()) {
            throw new Error(
              `Botão de URL nº ${i + 1} usa {{1}}. A Meta exige um valor de exemplo.`,
            );
          }
        }
        break;
      }
      case 'PHONE_NUMBER':
        if (!b.phone_number?.trim()) {
          throw new Error(
            `Botão de telefone nº ${i + 1} está sem número de telefone.`,
          );
        }
        break;
      case 'COPY_CODE':
        if (!b.example?.trim()) {
          throw new Error(
            `Botão de copiar código nº ${i + 1} está sem valor de exemplo.`,
          );
        }
        break;
    }
  }
}

/**
 * Sample values must be supplied 1:1 with the variables in the body
 * (and header, if it has one). Meta uses these for human review.
 */
export function validateSampleValues(
  payload: TemplatePayload,
  bodyVarCount: number,
  headerVarCount: number,
): void {
  const samples = payload.sample_values ?? {};
  const body = samples.body ?? [];
  const header = samples.header ?? [];

  if (body.length !== bodyVarCount) {
    throw new Error(
      `A mensagem tem ${bodyVarCount} variável(is). Informe exatamente ${bodyVarCount} valor(es) de exemplo (informados: ${body.length}).`,
    );
  }
  if (header.length !== headerVarCount) {
    throw new Error(
      `O cabeçalho tem ${headerVarCount} variável(is). Informe exatamente ${headerVarCount} valor(es) de exemplo (informados: ${header.length}).`,
    );
  }
  for (let i = 0; i < body.length; i++) {
    if (!body[i] || !body[i].trim()) {
      throw new Error(`Valor de exemplo da mensagem nº ${i + 1} está vazio.`);
    }
  }
  for (let i = 0; i < header.length; i++) {
    if (!header[i] || !header[i].trim()) {
      throw new Error(`Valor de exemplo do cabeçalho nº ${i + 1} está vazio.`);
    }
  }
}

/**
 * Run every validator. Throws on the first failure with a specific,
 * field-level message. Returns the variable counts so callers can
 * reuse them when building the Meta components payload.
 */
export function validateTemplatePayload(payload: TemplatePayload): {
  bodyVarCount: number;
  headerVarCount: number;
} {
  validateTemplateName(payload.name);
  if (!payload.language?.trim()) {
    throw new Error("O idioma é obrigatório.");
  }
  const bodyVars = validateBody(payload.body_text);
  validateFooter(payload.footer_text);
  const headerResult = validateHeader(payload);
  validateButtons(payload.buttons);
  validateSampleValues(payload, bodyVars.length, headerResult.variableCount);
  return {
    bodyVarCount: bodyVars.length,
    headerVarCount: headerResult.variableCount,
  };
}
