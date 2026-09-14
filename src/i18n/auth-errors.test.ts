import { describe, expect, it } from 'vitest';
import { translateAuthError } from './auth-errors';

describe('mensagens de autenticação em português', () => {
  it('usa o código do serviço mesmo quando a mensagem muda', () => {
    expect(translateAuthError({ code: 'invalid_credentials', message: 'Changed provider message' }))
      .toBe('E-mail ou senha incorretos.');
  });

  it('traduz mensagens conhecidas sem código', () => {
    expect(translateAuthError({ message: 'Email not confirmed' }))
      .toBe('Confirme seu e-mail antes de entrar.');
  });

  it('explica erros de conexão', () => {
    expect(translateAuthError({ message: 'Failed to fetch' }))
      .toBe('Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.');
  });

  it('mostra uma orientação em português para erros desconhecidos', () => {
    expect(translateAuthError({ code: 'unknown_error', message: 'Unknown provider error' }))
      .toBe('Não foi possível concluir a solicitação. Verifique os dados e tente novamente.');
  });
});
