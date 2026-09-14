import { APP_LANGUAGE } from './locale';

/** As mensagens do serviço de autenticação chegam em inglês. */
export function translateAuthError(error: { code?: string; message: string }): string {
  if (APP_LANGUAGE.catalogue !== 'pt') return error.message;
  const byCode: Record<string, string> = {
    invalid_credentials: 'E-mail ou senha incorretos.',
    email_not_confirmed: 'Confirme seu e-mail antes de entrar.',
    user_already_exists: 'Já existe uma conta com este e-mail.',
    email_exists: 'Este e-mail já está cadastrado.',
    signup_disabled: 'O cadastro de novas contas está desativado.',
    over_email_send_rate_limit: 'Aguarde alguns instantes antes de solicitar outro e-mail.',
    over_request_rate_limit: 'Muitas tentativas. Aguarde alguns instantes e tente novamente.',
    weak_password: 'Escolha uma senha mais forte, com pelo menos 6 caracteres.',
    same_password: 'A nova senha deve ser diferente da senha atual.',
    email_address_invalid: 'Informe um endereço de e-mail válido.',
    session_expired: 'Sua sessão expirou. Entre novamente.',
    captcha_failed: 'Não foi possível validar a verificação de segurança. Tente novamente.',
  };
  const byMessage: Record<string, string> = {
    'Invalid login credentials': byCode.invalid_credentials,
    'Email not confirmed': byCode.email_not_confirmed,
    'User already registered': byCode.user_already_exists,
    'Email rate limit exceeded': byCode.over_email_send_rate_limit,
    'New password should be different from the old password.': byCode.same_password,
    'Failed to fetch': 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
  };
  return byCode[error.code ?? ''] ?? byMessage[error.message]
    ?? 'Não foi possível concluir a solicitação. Verifique os dados e tente novamente.';
}
