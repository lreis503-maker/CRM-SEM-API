import { describe, expect, it } from 'vitest';

import {
  UazapiClientError,
  classifyUazapiHttpStatus,
  isUazapiClientError,
  sanitizeUazapiError,
} from './uazapi-errors';

describe('sanitizeUazapiError', () => {
  it('never includes tokens or QR data in an error payload', () => {
    const error = sanitizeUazapiError({
      token: 'secret',
      qrcode: 'base64-secret',
      error: 'bad',
    });

    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error).toMatchObject({ error: 'bad' });
  });

  it('redacts every credential-shaped key at any depth', () => {
    const sanitized = sanitizeUazapiError({
      instance: {
        admintoken: 'a',
        Authorization: 'Bearer b',
        webhook_secret: 'c',
        paircode: 'd',
        base64Data: 'e',
        binaryData: 'f',
        apikey: 'g',
        status: 'connected',
      },
    }) as { instance: Record<string, unknown> };

    for (const key of [
      'admintoken',
      'Authorization',
      'webhook_secret',
      'paircode',
      'base64Data',
      'binaryData',
      'apikey',
    ]) {
      expect(sanitized.instance[key]).toBe('[redacted]');
    }
    expect(sanitized.instance.status).toBe('connected');
  });

  it('redacts token-shaped values kept under harmless keys', () => {
    const sanitized = sanitizeUazapiError({
      error: 'invalid token 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c',
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    }) as { error: string; image: string };

    expect(sanitized.error).toContain('invalid token');
    expect(sanitized.error).not.toContain('9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c');
    expect(sanitized.image).toBe('[redacted]');
  });

  it('truncates long strings instead of copying whole payloads', () => {
    const sanitized = sanitizeUazapiError({
      error: 'x y '.repeat(500),
    }) as { error: string };

    expect(sanitized.error.length).toBeLessThanOrEqual(260);
  });

  it('limits depth, array length and survives circular references', () => {
    const circular: Record<string, unknown> = { status: 'error' };
    circular.self = circular;

    const sanitized = sanitizeUazapiError({
      circular,
      list: Array.from({ length: 100 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
    }) as {
      circular: { self: unknown };
      list: unknown[];
      deep: { a: { b: { c: unknown } } };
    };

    expect(sanitized.circular.self).toBe('[circular]');
    expect(sanitized.list.length).toBeLessThanOrEqual(20);
    expect(sanitized.deep.a.b.c).toBe('[truncated]');
  });

  it('keeps primitives and drops values that cannot be serialized', () => {
    expect(sanitizeUazapiError('plain')).toBe('plain');
    expect(sanitizeUazapiError(42)).toBe(42);
    expect(sanitizeUazapiError(null)).toBeNull();
    expect(sanitizeUazapiError(() => undefined)).toBe('[unserializable]');
  });
});

describe('classifyUazapiHttpStatus', () => {
  it('maps documented UAZAPI statuses to stable kinds', () => {
    expect(classifyUazapiHttpStatus(400)).toBe('invalid_request');
    expect(classifyUazapiHttpStatus(401)).toBe('authentication');
    expect(classifyUazapiHttpStatus(403)).toBe('authentication');
    expect(classifyUazapiHttpStatus(404)).toBe('not_found');
    expect(classifyUazapiHttpStatus(409)).toBe('conflict');
    expect(classifyUazapiHttpStatus(429)).toBe('rate_limited');
    expect(classifyUazapiHttpStatus(500)).toBe('upstream_unavailable');
    expect(classifyUazapiHttpStatus(503)).toBe('upstream_unavailable');
  });

  it('treats any other status as an unusable upstream response', () => {
    expect(classifyUazapiHttpStatus(418)).toBe('invalid_response');
  });
});

describe('UazapiClientError', () => {
  it('exposes a stable diagnostic shape without secrets', () => {
    const error = new UazapiClientError({
      operation: 'instance.create',
      kind: 'authentication',
      httpStatus: 401,
      details: { error: 'Invalid token', token: 'admin-secret' },
    });

    expect(error.name).toBe('UazapiClientError');
    expect(error.code).toBe('uazapi_request_failed');
    expect(error.kind).toBe('authentication');
    expect(error.operation).toBe('instance.create');
    expect(error.httpStatus).toBe(401);
    expect(error.details).toMatchObject({
      error: 'Invalid token',
      token: '[redacted]',
    });
    expect(error.message).not.toContain('admin-secret');
    expect(JSON.stringify(error)).not.toContain('admin-secret');
  });

  it('marks a retryable kind on an idempotent operation as retryable', () => {
    const error = new UazapiClientError({
      operation: 'instance.status',
      kind: 'rate_limited',
      httpStatus: 429,
      idempotent: true,
    });

    expect(error.retryable).toBe(true);
    expect(error.ambiguous).toBe(false);
  });

  it('never marks a send as retryable, even when the upstream is down', () => {
    const error = new UazapiClientError({
      operation: 'send.text',
      kind: 'upstream_unavailable',
      httpStatus: null,
      idempotent: false,
      ambiguous: true,
    });

    expect(error.retryable).toBe(false);
    expect(error.ambiguous).toBe(true);
  });

  it('never marks an authentication failure as retryable', () => {
    const error = new UazapiClientError({
      operation: 'instance.status',
      kind: 'authentication',
      httpStatus: 401,
      idempotent: true,
    });

    expect(error.retryable).toBe(false);
  });

  it('is recognizable across module boundaries', () => {
    const error = new UazapiClientError({
      operation: 'instance.status',
      kind: 'not_found',
      httpStatus: 404,
    });

    expect(isUazapiClientError(error)).toBe(true);
    expect(isUazapiClientError(new Error('other'))).toBe(false);
  });
});
